import { MissionControlClient, TcpLineTransport } from "@orrery/mission-control-client";
import { spawn } from "node:child_process";
import type { BrowserWindow } from "electron";
import { TrustedApprovalService } from "../packages/mission-control-daemon/src/promotion-approval";
import { acquireDaemonLock, createRuntimeDirectory, endpointPaths, ensureDaemon, readPrivateStateFile, stopOwnedDaemon, type EnsuredDaemon } from "../scripts/daemon-lifecycle";
import type { MissionIpcService, MissionSnapshotIntent } from "./mission-ipc";
import { confirmTrustedReview } from "./trusted-review";
import { completeParentBootstrap } from "../scripts/daemon-bootstrap";

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
  acquireLock?: () => ReturnType<typeof acquireDaemonLock>;
  parentWindow?: () => BrowserWindow | null;
  daemonEntryPath?: string;
  stopDaemon?: typeof stopOwnedDaemon;
}
export class MissionControlDaemonClient implements MissionIpcService {
  private client: SharedClient | undefined;
  private connectingClient: SharedClient | undefined;
  private connecting: Promise<SharedClient> | undefined;
  private connectionAbort?: AbortController;
  private readonly approvals = new TrustedApprovalService();
  private daemon?: EnsuredDaemon;
  private lifecycle = 0;
  private disconnecting?: Promise<void>;
  private shuttingDown = false;
  constructor(private readonly dependencies: MissionControlDaemonClientDependencies = {}) {}
  proposeRepository: MissionIpcService["proposeRepository"] = async (input) => this.mutate((client) => client.proposeRepository(input));
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
      const disconnectClients = Promise.all([...new Set([active, connecting].filter((client): client is SharedClient => client !== undefined))]
        .map(client => client.disconnect()));
      const stop = daemon
        ? (this.dependencies.stopDaemon ?? stopOwnedDaemon)(daemon).then(() => {
          if (this.daemon === daemon) this.daemon = undefined;
        })
        : Promise.resolve();
      const stopFailure = await stop.then(() => undefined, error => error);
      if (stopFailure) {
        void disconnectClients.catch(() => undefined);
        throw stopFailure;
      }
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
        const child = spawn(process.execPath, [this.dependencies.daemonEntryPath, "--electron-promotion-bootstrap"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ORRERY_DAEMON_MANAGED: "1", ORRERY_DAEMON_HANDOFF_NONCE: handoff?.nonce }, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
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
