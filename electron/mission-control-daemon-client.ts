import { MissionControlClient, TcpLineTransport } from "@orrery/mission-control-client";
import { spawn } from "node:child_process";
import type { BrowserWindow } from "electron";
import { TrustedApprovalService } from "../packages/mission-control-daemon/src/promotion-approval";
import { acquireDaemonLock, createRuntimeDirectory, endpointPaths, ensureDaemon, readPrivateStateFile, stopOwnedDaemon, type EnsuredDaemon } from "../scripts/daemon-lifecycle";
import type { MissionIpcService, MissionSnapshotIntent } from "./mission-ipc";
import type { ProposeRepositoryInput } from "./contract";
import { confirmTrustedRepository } from "./trusted-repository";
import { confirmTrustedReview } from "./trusted-review";
import { completeParentBootstrap } from "../scripts/daemon-bootstrap";
import { IntelligenceStore, MAX_MESSAGE_LENGTH } from "./intelligence-store";
import { requestIntelligenceReply, type FetchLike } from "./intelligence-provider";
import type { IntelligenceClearInput, IntelligenceSendInput, IntelligenceSendResult, IntelligenceSettingsInput, IntelligenceSettingsStatus, IntelligenceThreadInput, IntelligenceTranscript } from "./intelligence-contract";
import { basename } from "node:path";
import { McpPolicyStore, MAX_TOOL_CONTENT_LENGTH, requiresConsentEveryTime, effectiveRisk, assertServerInput, type McpToolRecord } from "./mcp-policy";
import { callTool, createTransport, discoverTools, type McpFetchLike, type McpTransport } from "./mcp-client";
import { confirmTrustedToolCall, type TrustedToolCallTarget } from "./trusted-tool-call";
import { confirmTrustedDecision, confirmTrustedServerRegistration, type TrustedDecisionTarget, type TrustedServerRegistrationTarget } from "./trusted-mcp-consent";
import { digestToolArguments, ToolApprovalService } from "./tool-approval";
import type { McpActivity, McpCatalog, McpInvokeInput, McpInvokeResult, McpRegisterInput, McpRemoveServerInput, McpSetDecisionInput } from "./mcp-contract";

interface SharedClient {
  connect(endpoint: { host: string; port: number; version: string }, token: string): Promise<void>;
  disconnect(): Promise<void>;
  proposeRepository: MissionIpcService["proposeRepository"];
  approveRepository(input: import("./contract").ApproveRepositoryInput): Promise<unknown>;
  createMission: MissionIpcService["create"];
  runMission: MissionIpcService["run"];
  cancelMission: MissionIpcService["cancel"];
  listMissions(): ReturnType<MissionIpcService["list"]>;
  getMission(id: string): ReturnType<MissionIpcService["getSnapshot"]>;
  inspectMission: MissionIpcService["inspect"];
  promoteMission(input: import("./contract").PromoteMissionInput): ReturnType<MissionIpcService["reviewAndPromote"]>;
}
export interface MissionControlDaemonClientDependencies {
  createRuntimeDirectory?: typeof createRuntimeDirectory;
  endpointPaths?: typeof endpointPaths;
  ensureDaemon?: typeof ensureDaemon;
  readToken?: (path: string) => Promise<string>;
  createClient?: () => SharedClient;
  confirmReview?: (input: { decision: "accepted" | "rejected"; missionId: string; planRevisionId: string; changeRevision: string; contentDigest: string; review: import("@orrery/mission-control-protocol").MissionReviewContent }, parent: BrowserWindow) => Promise<boolean>;
  confirmRepository?: (input: { canonicalRoot: string; fingerprint: string; expiresAt: string }, parent: BrowserWindow) => Promise<boolean>;
  acquireLock?: () => ReturnType<typeof acquireDaemonLock>;
  parentWindow?: () => BrowserWindow | null;
  daemonEntryPath?: string;
  stopDaemon?: typeof stopOwnedDaemon;
  createIntelligenceStore?: (runtimeDirectory: string) => IntelligenceStore;
  requestIntelligenceReply?: typeof requestIntelligenceReply;
  fetchImpl?: FetchLike;
  createMcpPolicyStore?: (runtimeDirectory: string) => McpPolicyStore;
  createMcpTransport?: typeof createTransport;
  discoverMcpTools?: (transport: McpTransport) => Promise<ReadonlyArray<McpToolRecord>>;
  callMcpTool?: typeof callTool;
  confirmToolCall?: (target: TrustedToolCallTarget, parent: BrowserWindow) => Promise<boolean>;
  confirmServerRegistration?: (target: TrustedServerRegistrationTarget, parent: BrowserWindow) => Promise<boolean>;
  confirmDecision?: (target: TrustedDecisionTarget, parent: BrowserWindow) => Promise<boolean>;
  spawnImpl?: typeof spawn;
  mcpFetchImpl?: McpFetchLike;
}
export class MissionControlDaemonClient implements MissionIpcService {
  private client: SharedClient | undefined;
  private connectingClient: SharedClient | undefined;
  private connecting: Promise<SharedClient> | undefined;
  private connectionAbort?: AbortController;
  private readonly approvals = new TrustedApprovalService();
  private readonly toolApprovals = new ToolApprovalService();
  private daemon?: EnsuredDaemon;
  private lifecycle = 0;
  private disconnecting?: Promise<void>;
  private shuttingDown = false;
  private intelligenceStore?: Promise<IntelligenceStore>;
  private intelligenceCalls: number[] = [];
  private mcpStore?: Promise<McpPolicyStore>;
  private toolCalls: number[] = [];
  private readonly registrationCalls: number[] = [];
  constructor(private readonly dependencies: MissionControlDaemonClientDependencies = {}) {}
  proposeRepository: MissionIpcService["proposeRepository"] = async (input) => this.mutate((client) => client.proposeRepository(input));
  async intakeRepository(input: ProposeRepositoryInput, parent: BrowserWindow): Promise<{ repositoryId: string; canonicalRoot: string; fingerprint: string }> {
    const proposal = await this.mutate((client) => client.proposeRepository(input));
    const confirm = this.dependencies.confirmRepository ?? confirmTrustedRepository;
    if (!await confirm(proposal, parent)) throw new Error("Repository approval cancelled.");
    const approved = await this.mutate((client) => client.approveRepository({ intentId: input.intentId, proposalId: proposal.proposalId, fingerprint: proposal.fingerprint, approvalNonce: proposal.approvalNonce })) as { repositoryId: string; fingerprint: string };
    return { repositoryId: approved.repositoryId, canonicalRoot: proposal.canonicalRoot, fingerprint: approved.fingerprint };
  }
  create: MissionIpcService["create"] = async (input) => this.mutate((client) => client.createMission(input));
  run: MissionIpcService["run"] = async (input) => this.mutate((client) => client.runMission(input));
  cancel: MissionIpcService["cancel"] = async (input) => this.mutate((client) => client.cancelMission(input));
  list = async () => (await this.connected()).listMissions();
  getSnapshot = async (input: MissionSnapshotIntent) => (await this.connected()).getMission(input.missionId);
  inspect: MissionIpcService["inspect"] = async (input) => (await this.connected()).inspectMission(input);
  reviewAndPromote: MissionIpcService["reviewAndPromote"] = async (input) => {
    const parent = this.dependencies.parentWindow?.();
    if (!parent) throw new Error("Trusted review requires the Electron main window.");
    return this.reviewAndPromoteInWindow(input, parent);
  };
  async reviewAndPromoteInWindow(input: Parameters<MissionIpcService["reviewAndPromote"]>[0], parent: BrowserWindow): ReturnType<MissionIpcService["reviewAndPromote"]> {
    const inspection = await this.inspect({ missionId: input.missionId, planRevisionId: input.planRevisionId });
    if (inspection.mission.id !== input.missionId || inspection.planRevisionId !== input.planRevisionId) throw new Error("The inspected mission is stale.");
    const target = { ...input, changeRevision: inspection.changeRevision, contentDigest: inspection.contentDigest, review: inspection.review };
    const confirm = this.dependencies.confirmReview ?? confirmTrustedReview;
    if (!await confirm(target, parent)) throw new Error("Mission review cancelled.");
    const approvalInput = { missionId: input.missionId, planRevisionId: input.planRevisionId, changeRevision: inspection.changeRevision, contentDigest: inspection.contentDigest, decision: input.decision };
    const approvalCapability = this.approvals.issue(approvalInput);
    return (await this.connected()).promoteMission({ ...approvalInput, intentId: input.intentId, approvalCapability });
  }
  async getIntelligenceSettings(): Promise<IntelligenceSettingsStatus> {
    return (await this.intelligence()).readSettingsStatus();
  }

  async setIntelligenceSettings(input: IntelligenceSettingsInput): Promise<IntelligenceSettingsStatus> {
    if (input.apiKey.length > 4_096) throw new Error("Provider credential is too long.");
    return (await this.intelligence()).writeCredentials({ provider: input.provider, model: input.model, baseUrl: input.baseUrl, apiKey: input.apiKey });
  }

  async listIntelligenceMessages(input: IntelligenceThreadInput): Promise<IntelligenceTranscript> {
    const store = await this.intelligence();
    const [messages, settings] = await Promise.all([store.readThread(input.threadId), store.readSettingsStatus()]);
    return { threadId: input.threadId, messages, settings };
  }

  async clearIntelligenceThread(input: IntelligenceClearInput): Promise<IntelligenceTranscript> {
    const store = await this.intelligence();
    await store.clearThread(input.threadId);
    return { threadId: input.threadId, messages: [], settings: await store.readSettingsStatus() };
  }

  async sendIntelligenceMessage(input: IntelligenceSendInput): Promise<IntelligenceSendResult> {
    if (input.text.length > MAX_MESSAGE_LENGTH) throw new Error("Message exceeds the supported length.");
    const store = await this.intelligence();
    const replayed = await store.findByIntent(input.threadId, input.intentId);
    if (replayed) return replayed;
    this.assertIntelligenceRate();
    const credentials = await store.readCredentials();
    if (!credentials) throw new Error("Orrery Intelligence is not configured. Add your provider key and model first.");
    const history = await store.readThread(input.threadId);
    const reply = await (this.dependencies.requestIntelligenceReply ?? requestIntelligenceReply)(
      { credentials, history: history.map(message => ({ role: message.role, text: message.text })), prompt: input.text },
      this.dependencies.fetchImpl,
    );
    const appended = await store.appendExchange({ threadId: input.threadId, intentId: input.intentId, missionId: input.missionId, request: input.text, reply });
    return { request: appended.request, reply: appended.reply };
  }

  /** Bounds provider spend and abuse from a compromised renderer: 20 requests per rolling minute. */
  private assertIntelligenceRate(now = Date.now()): void {
    const windowMs = 60_000;
    this.intelligenceCalls = this.intelligenceCalls.filter(stamp => now - stamp < windowMs);
    if (this.intelligenceCalls.length >= 20) throw new Error("Too many Orrery Intelligence requests. Wait a moment and try again.");
    this.intelligenceCalls.push(now);
  }

  async listMcpCatalog(): Promise<McpCatalog> {
    return (await this.mcp()).readCatalog();
  }

  async listMcpActivity(): Promise<McpActivity> {
    return { entries: await (await this.mcp()).readActivity() };
  }

  /**
   * Registers a server after native confirmation, then discovers its tools.
   *
   * Registration is an execution primitive, so it requires the same human confirmation
   * as promotion: a renderer alone can never introduce a command that Orrery will run.
   * Discovery failure is not fatal — the server stays registered with zero tools so the
   * human can see and remove it.
   */
  async registerMcpServer(input: McpRegisterInput, parent: BrowserWindow): Promise<McpCatalog> {
    const store = await this.mcp();
    // Validate before charging the budget, so malformed payloads cannot deny a legitimate
    // registration; the budget still bounds accepted ones, each of which spawns a process.
    const definition = assertServerInput(input);
    this.assertRate(this.registrationCalls, 10, "Too many server registrations. Wait a moment and try again.");
    const existing = await store.findServer(definition.serverId);
    const confirm = this.dependencies.confirmServerRegistration ?? confirmTrustedServerRegistration;
    const approved = await confirm({
      serverId: definition.serverId,
      label: definition.label,
      transport: definition.transport,
      command: definition.command,
      args: definition.args,
      endpoint: definition.endpoint,
      replacesExisting: existing !== undefined,
    }, parent);
    if (!approved) throw new Error("Server registration cancelled.");
    await store.registerServer(definition);
    return this.refreshMcpTools(definition.serverId);
  }

  async removeMcpServer(input: McpRemoveServerInput): Promise<McpCatalog> {
    return (await this.mcp()).removeServer(input.serverId);
  }

  /**
   * Records a consent decision. Granting a standing `allow` removes the per-call prompt,
   * so it requires native confirmation of its own; `ask` and `deny` only ever tighten
   * policy and need none.
   */
  async setMcpToolDecision(input: McpSetDecisionInput, parent: BrowserWindow): Promise<McpCatalog> {
    const store = await this.mcp();
    if (input.decision === "allow") {
      const server = await store.findServer(input.serverId);
      if (!server) throw new Error("Unknown server.");
      const tool = server.tools.find(entry => entry.name === input.name);
      if (!tool) throw new Error("Unknown tool.");
      const risk = effectiveRisk(tool);
      if (requiresConsentEveryTime(risk)) throw new Error("This tool must be confirmed every time it runs.");
      const confirm = this.dependencies.confirmDecision ?? confirmTrustedDecision;
      if (!await confirm({ serverLabel: server.label, serverId: server.serverId, name: tool.name, risk }, parent)) {
        throw new Error("Permission change cancelled.");
      }
    }
    return store.setDecision(input.serverId, input.name, input.decision);
  }

  async refreshMcpTools(serverId: string): Promise<McpCatalog> {
    const store = await this.mcp();
    const server = await store.findServer(serverId);
    if (!server) throw new Error("Unknown server.");
    let transport: McpTransport | undefined;
    try {
      // Inside the try, so a synchronous spawn failure cannot escape with the path.
      transport = (this.dependencies.createMcpTransport ?? createTransport)(server, {
        spawnImpl: this.dependencies.spawnImpl,
        fetchImpl: this.dependencies.mcpFetchImpl,
      });
      const tools = await (this.dependencies.discoverMcpTools ?? discoverTools)(transport);
      return await store.replaceTools(serverId, tools);
    } catch (error) {
      // Leave the server visible with no tools rather than failing registration outright.
      console.error(`Orrery MCP discovery for ${serverId} failed: ${error instanceof Error ? error.message : String(error)}`);
      return store.readCatalog();
    } finally {
      await transport?.close().catch(() => undefined);
    }
  }

  /**
   * Runs one tool behind the full gate: policy lookup, human consent in a native
   * modal, a signed single-use capability bound to a digest of these exact
   * arguments, and a durable audit entry for every outcome.
   */
  async invokeMcpTool(input: McpInvokeInput, parent: BrowserWindow): Promise<McpInvokeResult> {
    const store = await this.mcp();
    const server = await store.findServer(input.serverId);
    if (!server) throw new Error("Unknown server.");
    if (!server.enabled) throw new Error("This server is disabled.");
    const tool = server.tools.find(entry => entry.name === input.name);
    if (!tool) throw new Error("Unknown tool.");
    this.assertToolRate();

    const args = assertPlainArguments(input.args);
    const argumentsDigest = digestToolArguments(args);
    // Re-derive risk: a tampered stored value must not downgrade an always-ask tool.
    const risk = effectiveRisk(tool);
    const stored = Object.prototype.hasOwnProperty.call(server.decisions, tool.name) ? server.decisions[tool.name] : "ask";
    if (stored === "deny") {
      await store.appendActivity({ serverId: server.serverId, name: tool.name, risk, outcome: "denied", reason: "Denied by policy." });
      throw new Error("This tool is denied by policy.");
    }

    // A remembered allow is honoured only for risks that may be remembered at all.
    const remembered = stored === "allow" && !requiresConsentEveryTime(risk);
    if (!remembered) {
      // Consent is meaningless if the human cannot actually read what they are approving.
      const rendered = JSON.stringify(args, null, 2);
      if (rendered.length > MAX_REVIEWABLE_ARGUMENT_LENGTH) {
        await store.appendActivity({ serverId: server.serverId, name: tool.name, risk, outcome: "denied", reason: "Arguments too large to review." });
        throw new Error("Tool arguments are too large to review. Reduce them and try again.");
      }
      const confirm = this.dependencies.confirmToolCall ?? confirmTrustedToolCall;
      const approved = await confirm({
        serverLabel: server.label,
        serverOrigin: server.transport === "stdio" ? basename(server.command ?? "") : safeHostOf(server.endpoint),
        serverId: server.serverId,
        name: tool.name,
        title: tool.title,
        description: tool.description,
        risk,
        args,
        argumentsDigest,
      }, parent);
      if (!approved) {
        await store.appendActivity({ serverId: server.serverId, name: tool.name, risk, outcome: "denied", reason: "Cancelled by the operator." });
        throw new Error("Tool call cancelled.");
      }
      // Mint and immediately spend a capability bound to exactly what was shown.
      const capability = this.toolApprovals.issue({ serverId: server.serverId, name: tool.name, risk, argumentsDigest });
      this.toolApprovals.verify({ serverId: server.serverId, name: tool.name, risk, argumentsDigest, capability });
    }

    // Audit the intent before dispatch, so a crash mid-call cannot erase the fact that
    // an approved tool was about to run.
    const intent = await store.appendActivity({ serverId: server.serverId, name: tool.name, risk, outcome: "allowed", reason: `dispatching ${argumentsDigest.slice(0, 16)}` });
    let transport: McpTransport | undefined;
    try {
      // Constructed inside the try: a synchronous spawn failure names the absolute path,
      // so it must reach the same redaction and audit path as an async one.
      transport = (this.dependencies.createMcpTransport ?? createTransport)(server, {
        spawnImpl: this.dependencies.spawnImpl,
        fetchImpl: this.dependencies.mcpFetchImpl,
      });
      await (this.dependencies.discoverMcpTools ?? discoverTools)(transport);
      const outcome = await (this.dependencies.callMcpTool ?? callTool)(transport, tool.name, args);
      const content = outcome.content.slice(0, MAX_TOOL_CONTENT_LENGTH);
      if (outcome.isError) {
        await store.appendActivity({ serverId: server.serverId, name: tool.name, risk, outcome: "failed", reason: "The tool reported an error." });
      }
      return {
        serverId: server.serverId,
        name: tool.name,
        risk,
        content,
        isError: outcome.isError,
        truncated: content.length < outcome.content.length,
        invokedAt: intent.at,
        sequence: intent.sequence,
      };
    } catch (error) {
      // Detail can name the server's absolute path, so it is logged in main only and
      // the renderer receives a fixed message.
      console.error(`Orrery MCP tool ${server.serverId}/${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      await store.appendActivity({ serverId: server.serverId, name: tool.name, risk, outcome: "failed", reason: "The tool could not be run." }).catch(() => undefined);
      throw new Error("The tool could not be run.");
    } finally {
      await transport?.close().catch(() => undefined);
    }
  }

  /** Bounds tool invocation independently of chat: 30 calls per rolling minute. */
  private assertToolRate(now = Date.now()): void {
    this.toolCalls = this.assertRate(this.toolCalls, 30, "Too many tool calls. Wait a moment and try again.", now);
  }

  /** Shared rolling-window limiter. Returns the pruned window including the new call. */
  private assertRate(window: number[], limit: number, message: string, now = Date.now()): number[] {
    const recent = window.filter(stamp => now - stamp < 60_000);
    if (recent.length >= limit) throw new Error(message);
    recent.push(now);
    // Callers that pass a field read it back; the registration window is mutated in place.
    window.length = 0;
    window.push(...recent);
    return recent;
  }

  private mcp(): Promise<McpPolicyStore> {
    // Cache the promise so concurrent cold starts share one store and one write lock.
    return this.mcpStore ??= (async () => {
      const runtime = await (this.dependencies.createRuntimeDirectory ?? createRuntimeDirectory)();
      return (this.dependencies.createMcpPolicyStore ?? (directory => new McpPolicyStore(directory)))(runtime);
    })().catch(error => {
      this.mcpStore = undefined;
      throw error;
    });
  }

  private intelligence(): Promise<IntelligenceStore> {
    // Cache the promise, not the awaited value, so concurrent cold starts share one store and one write lock.
    return this.intelligenceStore ??= (async () => {
      const runtime = await (this.dependencies.createRuntimeDirectory ?? createRuntimeDirectory)();
      return (this.dependencies.createIntelligenceStore ?? (directory => new IntelligenceStore(directory)))(runtime);
    })().catch(error => {
      this.intelligenceStore = undefined;
      throw error;
    });
  }

  async disconnect(): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    this.shuttingDown = true;
    const generation = ++this.lifecycle;
    this.connectionAbort?.abort(new Error("Mission Control is shutting down."));
    this.disconnecting = (async () => {
      const active = this.client;
      const connecting = this.connectingClient;
      this.client = undefined;
      const daemon = this.daemon;
      const clients = [...new Set([active, connecting].filter((client): client is SharedClient => client !== undefined))];
      const stop = daemon
        ? (this.dependencies.stopDaemon ?? stopOwnedDaemon)(daemon).then(() => {
          if (this.daemon === daemon) this.daemon = undefined;
        })
        : Promise.resolve();
      const stopFailure = await stop.then(() => undefined, error => error);
      if (stopFailure) {
        void Promise.all(clients.map(client => client.disconnect())).catch(() => undefined);
        throw stopFailure;
      }
      const disconnectClients = Promise.race([
        Promise.all(clients.map(client => client.disconnect())),
        new Promise<void>(resolve => setTimeout(resolve, 2_000)),
      ]);
      const [disconnectResult, stopResult] = await Promise.allSettled([disconnectClients, stop]);
      const disconnectError = disconnectResult.status === "rejected" ? disconnectResult.reason : undefined;
      const stopError = stopResult.status === "rejected" ? stopResult.reason : undefined;
      if (disconnectError && stopError) throw new AggregateError([disconnectError, stopError], "Mission Control cleanup failed.");
      if (disconnectError) throw disconnectError;
      if (stopError) throw stopError;
    })().finally(() => {
      if (this.lifecycle === generation) this.disconnecting = undefined;
    });
    return this.disconnecting;
  }
  private connected(): Promise<SharedClient> {
    if (this.shuttingDown) return Promise.reject(new Error("Mission Control is shutting down."));
    if (this.client) return Promise.resolve(this.client);
    return this.connecting ??= this.connect().finally(() => { this.connecting = undefined; });
  }
  private async mutate<T>(operation: (client: SharedClient) => Promise<T>): Promise<T> {
    const client = await this.connected();
    try {
      return await operation(client);
    } catch (error) {
      if (!isDisconnect(error) || this.client !== client) throw error;
      this.client = undefined;
      await client.disconnect().catch(() => undefined);
      return operation(await this.connected());
    }
  }
  private async connect(): Promise<SharedClient> {
    const generation = this.lifecycle;
    const abort = new AbortController();
    this.connectionAbort = abort;
    const runtime = await (this.dependencies.createRuntimeDirectory ?? createRuntimeDirectory)();
    abort.signal.throwIfAborted();
    const paths = (this.dependencies.endpointPaths ?? endpointPaths)(runtime);
    const daemon = await (this.dependencies.ensureDaemon ?? ensureDaemon)(paths.endpointPath, {
      acquireLock: this.dependencies.acquireLock ?? (() => acquireDaemonLock(paths.lockPath)),
      signal: abort.signal,
      spawn: (handoff) => {
        if (!this.dependencies.daemonEntryPath) throw new Error("Managed daemon resource path is unavailable.");
         const child = spawn(process.execPath, [this.dependencies.daemonEntryPath, "--electron-promotion-bootstrap"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ORRERY_DAEMON_MANAGED: "1", ORRERY_DAEMON_HANDOFF_NONCE: handoff?.nonce }, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"], windowsHide: true });
         child.stdout?.on("data", chunk => { if (process.env.ORRERY_THEIA_SMOKE === "1") console.log(`Managed daemon: ${chunk.toString().trim()}`); });
         child.stderr?.on("data", chunk => {
           if (process.env.ORRERY_THEIA_SMOKE === "1") console.error(`Managed daemon: ${chunk.toString().trim()}`);
         });
         child.once("error", error => console.error(`Managed daemon process error: ${error instanceof Error ? error.message : String(error)}`));
         child.once("exit", (code, signal) => {
           if (code !== 0 && code !== null && process.env.ORRERY_THEIA_SMOKE === "1") console.error(`Managed daemon exited during startup (code ${code}, signal ${signal ?? "none"}).`);
         });
        if (!handoff?.nonce || !child.pid) { child.kill("SIGTERM"); throw new Error("Managed daemon bootstrap pipe is unavailable."); }
        const bootstrapBinding = completeParentBootstrap(child, handoff.nonce, this.approvals.publicKey);
        void bootstrapBinding.catch(() => child.kill("SIGTERM"));
        return Object.assign(child, { bootstrapBinding });
      },
    });
    if (!daemon.owned) throw new Error("Electron requires an Electron-owned daemon; another Orrery daemon is already active.");
    this.daemon = daemon;
    const endpoint = daemon.endpoint;
    const token = (await (this.dependencies.readToken ?? readPrivateStateFile)(endpoint.tokenPath)).trim();
    const client = this.dependencies.createClient?.() ?? new MissionControlClient(new TcpLineTransport());
    this.connectingClient = client;
    try {
      await client.connect({ host: endpoint.host, port: endpoint.port, version: endpoint.protocol }, token);
    } finally {
      if (this.connectingClient === client) this.connectingClient = undefined;
      if (this.connectionAbort === abort) this.connectionAbort = undefined;
    }
    if (generation !== this.lifecycle || this.shuttingDown) {
      if (!this.shuttingDown) await client.disconnect().catch(() => undefined);
      throw new Error("Mission Control is shutting down.");
    }
    this.client = client;
    return client;
  }
}

function isDisconnect(error: unknown): boolean {
  return error instanceof Error && /disconnect|socket|closed|ECONNRESET|EPIPE/i.test(error.message);
}

const FORBIDDEN_ARGUMENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_ARGUMENT_BYTES = 100_000;
const MAX_ARGUMENT_DEPTH = 8;
const MAX_ARGUMENT_NODES = 5_000;
/** Beyond this, a human cannot meaningfully review the arguments in the consent dialog. */
export const MAX_REVIEWABLE_ARGUMENT_LENGTH = 4_000;

/**
 * Accepts only plain JSON argument trees, rebuilt on null-prototype objects.
 *
 * Rebuilding matters: the value that gets digested for consent must be the exact
 * value sent to the server, so a hostile payload cannot smuggle a key past the
 * digest or reparent an object through the prototype chain. Node count is bounded
 * during traversal, so an enormous graph is refused before it is ever serialized.
 */
export function assertPlainArguments(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  const budget = { nodes: 0 };
  const result = rebuild(value as Record<string, unknown>, 0, budget) as Record<string, unknown>;
  if (JSON.stringify(result).length > MAX_ARGUMENT_BYTES) throw new Error("Tool arguments exceed the supported size.");
  return result;
}

function rebuild(value: unknown, depth: number, budget: { nodes: number }): unknown {
  if (depth > MAX_ARGUMENT_DEPTH) throw new Error("Tool arguments are nested too deeply.");
  if ((budget.nodes += 1) > MAX_ARGUMENT_NODES) throw new Error("Tool arguments exceed the supported size.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Tool arguments contain an unsupported value.");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error("Tool arguments contain too many items.");
    return value.map(item => rebuild(item, depth + 1, budget));
  }
  if (typeof value !== "object") throw new Error("Tool arguments contain an unsupported value.");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_ARGUMENT_KEYS.has(key)) throw new Error("Tool arguments contain an unsupported key.");
    if (key.length > 200) throw new Error("Tool arguments contain an unsupported key.");
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined) continue;
    result[key] = rebuild(item, depth + 1, budget);
  }
  return { ...result };
}

function safeHostOf(endpoint: string | undefined): string {
  try {
    return new URL(endpoint ?? "").host;
  } catch {
    return "";
  }
}
