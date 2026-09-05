import { inject, injectable, optional } from "@theia/core/shared/inversify";
import type { ElectronMainApplication, ElectronMainApplicationContribution } from "@theia/core/lib/electron-main/electron-main-application";
import { app, BrowserWindow, Menu, ipcMain, type IpcMain, type IpcMainInvokeEvent } from "@theia/core/electron-shared/electron";
import {
  MissionControlHostService,
  MISSION_INTAKE_REPOSITORY_CHANNEL, MISSION_CREATE_CHANNEL, MISSION_RUN_CHANNEL, MISSION_CANCEL_CHANNEL, MISSION_INSPECT_CHANNEL,
  MISSION_GET_SNAPSHOT_CHANNEL,
  MISSION_LIST_CHANNEL,
  MISSION_REVIEW_CHANNEL,
  INTELLIGENCE_GET_SETTINGS_CHANNEL, INTELLIGENCE_SET_SETTINGS_CHANNEL, INTELLIGENCE_LIST_MESSAGES_CHANNEL, INTELLIGENCE_SEND_MESSAGE_CHANNEL, INTELLIGENCE_CLEAR_THREAD_CHANNEL, INTELLIGENCE_TURN_STATUS_CHANNEL, INTELLIGENCE_CANCEL_TURN_CHANNEL,
  MCP_LIST_CATALOG_CHANNEL, MCP_REGISTER_SERVER_CHANNEL, MCP_REMOVE_SERVER_CHANNEL, MCP_SET_DECISION_CHANNEL, MCP_INVOKE_TOOL_CHANNEL, MCP_LIST_ACTIVITY_CHANNEL,
  type MissionReviewInput,
  type MissionPromotionResult,
  type MissionSnapshotInput,
  type RepositoryIntakeInput, type MissionCreateInput, type MissionRunInput, type MissionCancelInput, type MissionInspectInput,
  type IntelligenceSettingsInput, type IntelligenceThreadInput, type IntelligenceSendInput, type IntelligenceClearInput, type IntelligenceProviderKind,
  type McpRegisterInput, type McpRemoveServerInput, type McpSetDecisionInput, type McpInvokeInput, type McpInvokeResult, type McpCatalog, type McpTransportKind, type McpToolDecision,
} from "../common/mission-control-contracts";
import { describeSmokeProbe, findMissingMenuLabels, runSmokeRenderProbe, smokeProbePassed, SMOKE_PROBE_VIEWS, MENUBAR_TITLES_SCRIPT } from "./mission-control-smoke-probe";

/**
 * Printed only after every Mission Control view has rendered in the real renderer.
 *
 * The smoke waits for this rather than for preload readiness, so a passing smoke now means the
 * widgets actually appeared instead of merely that the preload script ran.
 */
export const SMOKE_RENDER_MARKER = "ORRERY_THEIA_RENDERED";

export interface MissionControlHostRequestContext {
  intakeRepository(input: RepositoryIntakeInput): Promise<import("../common/mission-control-contracts").RepositoryIntakeResult>;
  reviewAndPromote(input: MissionReviewInput): Promise<MissionPromotionResult>;
  registerMcpServer(input: McpRegisterInput): Promise<McpCatalog>;
  setMcpToolDecision(input: McpSetDecisionInput): Promise<McpCatalog>;
  invokeMcpTool(input: McpInvokeInput): Promise<McpInvokeResult>;
  /** Window-bound because the model may request a tool call, which raises a native confirmation. */
  sendIntelligenceMessage(input: IntelligenceSendInput): Promise<import("../common/mission-control-contracts").IntelligenceSendResult>;
}

export interface ElectronMainMissionControlHostService extends MissionControlHostService {
  requestContext(sender: object, senderFrame: object | null): MissionControlHostRequestContext | null;
}
const HOST_READY_CHANNEL = "mission:v1:host-ready";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 200;
// Reject prototype-bearing keys at the boundary so a hostile thread id cannot spend the user's key before the store refuses it.
const FORBIDDEN_THREAD_IDS = new Set(["__proto__", "constructor", "prototype"]);
const isThreadId = (value: unknown): value is string => isId(value) && !FORBIDDEN_THREAD_IDS.has(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 8192;

function exactRecord(value: unknown, keys: ReadonlyArray<string>): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || !keys.every((key) => key in value)) {
    throw new Error("Invalid mission IPC payload");
  }
  return value;
}

function parseSnapshot(value: unknown): MissionSnapshotInput {
  const input = exactRecord(value, ["missionId"]);
  if (!isId(input.missionId)) throw new Error("Invalid mission IPC payload");
  return { missionId: input.missionId };
}
function parseIntake(value: unknown): RepositoryIntakeInput {
  const input = exactRecord(value, ["intentId", "localPath"]);
  if (!isId(input.intentId) || !isText(input.localPath)) throw new Error("Invalid mission IPC payload");
  return { intentId: input.intentId, localPath: input.localPath };
}
function parseCreate(value: unknown): MissionCreateInput {
  const input = exactRecord(value, ["intentId", "repositoryId", "title", "goal", "mode", "plan"]);
  if (!isId(input.intentId) || !isId(input.repositoryId) || !isText(input.title) || !isText(input.goal) || !["explore", "plan", "build", "delegate"].includes(input.mode as string)) throw new Error("Invalid mission IPC payload");
  const plan = exactRecord(input.plan, ["scope", "actions", "acceptanceCriteria"]);
  if (!isText(plan.scope) || !isStringArray(plan.actions) || !isStringArray(plan.acceptanceCriteria)) throw new Error("Invalid mission IPC payload");
  return input as unknown as MissionCreateInput;
}
function parseRun(value: unknown): MissionRunInput {
  const input = exactRecord(value, ["intentId", "missionId", "planRevisionId"]);
  if (!isId(input.intentId) || !isId(input.missionId) || !isId(input.planRevisionId)) throw new Error("Invalid mission IPC payload");
  return input as unknown as MissionRunInput;
}
function parseCancel(value: unknown): MissionCancelInput {
  const input = exactRecord(value, ["intentId", "missionId", "runId"]);
  if (!isId(input.intentId) || !isId(input.missionId) || !isId(input.runId)) throw new Error("Invalid mission IPC payload");
  return input as unknown as MissionCancelInput;
}
function parseInspect(value: unknown): MissionInspectInput {
  const input = exactRecord(value, ["missionId", "planRevisionId"]);
  if (!isId(input.missionId) || !isId(input.planRevisionId)) throw new Error("Invalid mission IPC payload");
  return input as unknown as MissionInspectInput;
}
function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 8192);
}

const INTELLIGENCE_PROVIDERS: ReadonlyArray<IntelligenceProviderKind> = ["openai-compatible", "anthropic", "ollama"];
const isChatText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 8000;

function parseIntelligenceSettings(value: unknown): IntelligenceSettingsInput {
  const input = exactRecord(value, ["intentId", "provider", "model", "baseUrl", "apiKey"]);
  if (!isId(input.intentId)
    || !INTELLIGENCE_PROVIDERS.includes(input.provider as IntelligenceProviderKind)
    || !isId(input.model)
    || typeof input.baseUrl !== "string" || input.baseUrl.trim().length === 0 || input.baseUrl.length > 2048
    || typeof input.apiKey !== "string" || input.apiKey.length > 4096) {
    throw new Error("Invalid mission IPC payload");
  }
  return input as unknown as IntelligenceSettingsInput;
}
function parseIntelligenceThread(value: unknown): IntelligenceThreadInput {
  const input = exactRecord(value, ["threadId"]);
  if (!isThreadId(input.threadId)) throw new Error("Invalid mission IPC payload");
  return { threadId: input.threadId };
}
function parseIntelligenceClear(value: unknown): IntelligenceClearInput {
  const input = exactRecord(value, ["intentId", "threadId"]);
  if (!isId(input.intentId) || !isThreadId(input.threadId)) throw new Error("Invalid mission IPC payload");
  return { intentId: input.intentId, threadId: input.threadId };
}
function parseIntelligenceSend(value: unknown): IntelligenceSendInput {
  if (!isRecord(value)) throw new Error("Invalid mission IPC payload");
  const hasMission = "missionId" in value;
  const input = exactRecord(value, hasMission ? ["intentId", "threadId", "text", "missionId"] : ["intentId", "threadId", "text"]);
  if (!isId(input.intentId) || !isThreadId(input.threadId) || !isChatText(input.text) || (hasMission && !isId(input.missionId))) {
    throw new Error("Invalid mission IPC payload");
  }
  return input as unknown as IntelligenceSendInput;
}

function parseReview(value: unknown): MissionReviewInput {
  const input = exactRecord(value, ["intentId", "missionId", "planRevisionId", "decision"]);
  if (!isId(input.intentId) || !isId(input.missionId) || !isId(input.planRevisionId) || (input.decision !== "accepted" && input.decision !== "rejected")) {
    throw new Error("Invalid mission IPC payload");
  }
  return { intentId: input.intentId, missionId: input.missionId, planRevisionId: input.planRevisionId, decision: input.decision };
}

const MCP_TRANSPORTS: ReadonlyArray<McpTransportKind> = ["stdio", "http"];
const MCP_DECISIONS: ReadonlyArray<McpToolDecision> = ["ask", "allow", "deny"];
// Tool and server identifiers become object keys in the policy store, so the same
// prototype-bearing names are refused here as for conversation identifiers.
const isMcpId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value) && !FORBIDDEN_THREAD_IDS.has(value);

function parseMcpRegister(value: unknown): McpRegisterInput {
  if (!isRecord(value)) throw new Error("Invalid mission IPC payload");
  const transport = value.transport;
  if (!MCP_TRANSPORTS.includes(transport as McpTransportKind)) throw new Error("Invalid mission IPC payload");
  if (transport === "stdio") {
    const input = exactRecord(value, ["intentId", "serverId", "label", "transport", "command", "args"]);
    const args = input.args;
    if (
      !isId(input.intentId) || !isMcpId(input.serverId) || !isText(input.label)
      || typeof input.command !== "string" || input.command.trim().length === 0 || input.command.length > 1_024
      || !Array.isArray(args) || args.length > 50
      || !args.every(argument => typeof argument === "string" && argument.length <= 1_024)
    ) {
      throw new Error("Invalid mission IPC payload");
    }
    return { intentId: input.intentId, serverId: input.serverId, label: input.label, transport: "stdio", command: input.command, args: [...args] as ReadonlyArray<string> };
  }
  const input = exactRecord(value, ["intentId", "serverId", "label", "transport", "endpoint"]);
  if (!isId(input.intentId) || !isMcpId(input.serverId) || !isText(input.label) || typeof input.endpoint !== "string" || input.endpoint.trim().length === 0 || input.endpoint.length > 2_048) {
    throw new Error("Invalid mission IPC payload");
  }
  return { intentId: input.intentId, serverId: input.serverId, label: input.label, transport: "http", endpoint: input.endpoint };
}

function parseMcpRemoveServer(value: unknown): McpRemoveServerInput {
  const input = exactRecord(value, ["intentId", "serverId"]);
  if (!isId(input.intentId) || !isMcpId(input.serverId)) throw new Error("Invalid mission IPC payload");
  return { intentId: input.intentId, serverId: input.serverId };
}

function parseMcpSetDecision(value: unknown): McpSetDecisionInput {
  const input = exactRecord(value, ["intentId", "serverId", "name", "decision"]);
  if (!isId(input.intentId) || !isMcpId(input.serverId) || !isMcpId(input.name) || !MCP_DECISIONS.includes(input.decision as McpToolDecision)) {
    throw new Error("Invalid mission IPC payload");
  }
  return { intentId: input.intentId, serverId: input.serverId, name: input.name, decision: input.decision as McpToolDecision };
}

function parseMcpInvoke(value: unknown): McpInvokeInput {
  const input = exactRecord(value, ["intentId", "serverId", "name", "args"]);
  if (!isId(input.intentId) || !isMcpId(input.serverId) || !isMcpId(input.name) || !isRecord(input.args)) {
    throw new Error("Invalid mission IPC payload");
  }
  // Bound by traversal, not by serializing first: structured clone preserves shared
  // references, so a small payload can expand enormously under JSON.stringify.
  assertBoundedGraph(input.args);
  return { intentId: input.intentId, serverId: input.serverId, name: input.name, args: input.args };
}

/** Rejects argument graphs too large or too deep to process, before any serialization. */
function assertBoundedGraph(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (depth > 8 || (budget.nodes += 1) > 5_000) throw new Error("Invalid mission IPC payload");
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && value.length > 100_000) throw new Error("Invalid mission IPC payload");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error("Invalid mission IPC payload");
    for (const item of value) assertBoundedGraph(item, depth + 1, budget);
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (key.length > 200) throw new Error("Invalid mission IPC payload");
    assertBoundedGraph((value as Record<string, unknown>)[key], depth + 1, budget);
  }
}

function trustedContext(event: IpcMainInvokeEvent, host: ElectronMainMissionControlHostService): MissionControlHostRequestContext {
  const sameFrame = event.senderFrame === event.sender.mainFrame;
  const context = sameFrame ? host.requestContext(event.sender, event.senderFrame) : null;
  if (!context) {
    throw new Error("Rejected untrusted mission IPC request");
  }
  return context;
}

export function registerMissionControlHostIpc(target: Pick<IpcMain, "handle" | "removeHandler">, host: ElectronMainMissionControlHostService): void {
  const trusted = (invoke: () => unknown) => async (event: IpcMainInvokeEvent, ...values: unknown[]) => {
    trustedContext(event, host);
    if (values.length !== 0) throw new Error("Invalid mission IPC payload");
    return invoke();
  };
  const guarded = <T>(parse: (value: unknown) => T, invoke: (input: T) => unknown) => async (event: IpcMainInvokeEvent, ...values: unknown[]) => {
    trustedContext(event, host);
    if (values.length !== 1) throw new Error("Invalid mission IPC payload");
    return invoke(parse(values[0]));
  };
  const handlers = [
    [MISSION_INTAKE_REPOSITORY_CHANNEL, async (event: IpcMainInvokeEvent, ...values: unknown[]) => { const context = trustedContext(event, host); if (values.length !== 1) throw new Error("Invalid mission IPC payload"); return context.intakeRepository(parseIntake(values[0])); }],
    [MISSION_CREATE_CHANNEL, guarded(parseCreate, input => host.create(input))],
    [MISSION_RUN_CHANNEL, guarded(parseRun, input => host.run(input))],
    [MISSION_CANCEL_CHANNEL, guarded(parseCancel, input => host.cancel(input))],
    [MISSION_LIST_CHANNEL, trusted(() => host.list())],
    [MISSION_GET_SNAPSHOT_CHANNEL, guarded(parseSnapshot, (input) => host.getSnapshot(input))],
    [MISSION_INSPECT_CHANNEL, guarded(parseInspect, input => host.inspect(input))],
    [INTELLIGENCE_GET_SETTINGS_CHANNEL, trusted(() => host.getIntelligenceSettings())],
    [INTELLIGENCE_SET_SETTINGS_CHANNEL, guarded(parseIntelligenceSettings, input => host.setIntelligenceSettings(input))],
    [INTELLIGENCE_LIST_MESSAGES_CHANNEL, guarded(parseIntelligenceThread, input => host.listIntelligenceMessages(input))],
    [INTELLIGENCE_CLEAR_THREAD_CHANNEL, guarded(parseIntelligenceClear, input => host.clearIntelligenceThread(input))],
    // A status read: no effect, no confirmation, so it needs no window binding.
    [INTELLIGENCE_TURN_STATUS_CHANNEL, guarded(parseIntelligenceThread, input => host.getIntelligenceTurnStatus(input))],
    // Stopping is a withdrawal of work, not an authorization, so it needs no window binding.
    [INTELLIGENCE_CANCEL_TURN_CHANNEL, guarded(parseIntelligenceThread, input => host.cancelIntelligenceTurn(input))],
    [MCP_LIST_CATALOG_CHANNEL, trusted(() => host.listMcpCatalog())],
    [MCP_REMOVE_SERVER_CHANNEL, guarded(parseMcpRemoveServer, input => host.removeMcpServer(input))],
    [MCP_LIST_ACTIVITY_CHANNEL, trusted(() => host.listMcpActivity())],
    // Registering a server, granting a standing permission, and running a tool all
    // require native confirmation, so each is bound to the exact originating window.
    // Sending a chat message is here too: the model may request a tool call, which
    // raises the same confirmation and therefore needs a parent window.
    [INTELLIGENCE_SEND_MESSAGE_CHANNEL, async (event: IpcMainInvokeEvent, ...values: unknown[]) => {
      const context = trustedContext(event, host);
      if (values.length !== 1) throw new Error("Invalid mission IPC payload");
      return context.sendIntelligenceMessage(parseIntelligenceSend(values[0]));
    }],
    [MCP_REGISTER_SERVER_CHANNEL, async (event: IpcMainInvokeEvent, ...values: unknown[]) => {
      const context = trustedContext(event, host);
      if (values.length !== 1) throw new Error("Invalid mission IPC payload");
      return context.registerMcpServer(parseMcpRegister(values[0]));
    }],
    [MCP_SET_DECISION_CHANNEL, async (event: IpcMainInvokeEvent, ...values: unknown[]) => {
      const context = trustedContext(event, host);
      if (values.length !== 1) throw new Error("Invalid mission IPC payload");
      return context.setMcpToolDecision(parseMcpSetDecision(values[0]));
    }],
    [MCP_INVOKE_TOOL_CHANNEL, async (event: IpcMainInvokeEvent, ...values: unknown[]) => {
      const context = trustedContext(event, host);
      if (values.length !== 1) throw new Error("Invalid mission IPC payload");
      return context.invokeMcpTool(parseMcpInvoke(values[0]));
    }],
    [MISSION_REVIEW_CHANNEL, async (event: IpcMainInvokeEvent, ...values: unknown[]) => {
      const context = trustedContext(event, host);
      if (values.length !== 1) throw new Error("Invalid mission IPC payload");
      return context.reviewAndPromote(parseReview(values[0]));
    }],
    [HOST_READY_CHANNEL, async (event: IpcMainInvokeEvent, ...values: unknown[]) => {
      const context = trustedContext(event, host);
      if (values.length !== 0) throw new Error("Invalid mission IPC payload");
      await host.list();
      if (process.env.ORRERY_THEIA_SMOKE === "1") {
        // This channel fires from the preload, before the Theia frontend has started, so it
        // proves only that the trusted preload ran. Quitting here would mean the smoke never
        // rendered a single widget. Instead, drive the real views and check the real DOM.
        const sender = event.sender;
        // Theia finishes startup inside an animation frame, and Chromium neither schedules frames
        // nor routes input for a window that is hidden or throttled: the frontend otherwise stops
        // at 'started_contributions' forever and no widget can render.
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.webContents !== sender) continue;
          window.webContents.setBackgroundThrottling(false);
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
          window.moveTop();
          window.webContents.focus();
        }
        // With the custom title bar this application uses, Theia never pushes a menu over the
        // `SetMenu` IPC channel; the menubar is a Lumino widget rendered in the page, and the
        // probe reads its rendered titles directly.
        void runSmokeRenderProbe(sender).then(async outcome => {
          console.log(describeSmokeProbe(outcome));
          // The views are also checked for menu reachability, because a view that can only be
          // opened by an unadvertised keybinding is not really reachable. The menubar populates
          // after the preferences are ready, so poll briefly before concluding it is missing.
          const expected: string[] = SMOKE_PROBE_VIEWS.map(view => view.region);
          // The opener stashes the View submenu's model labels on the window — the
          // renderer-side truth Theia builds the submenu from — because Lumino only renders open
          // submenus in the DOM. The menubar itself is polled until it populates, which confirms
          // the preference service initialized and the real menu widget rendered; both must hold,
          // since a populated model with an empty bar would still leave the user with no menu.
          let missing = expected;
          for (let attempt = 0; attempt < 40 && missing.length > 0; attempt += 1) {
            const [barRead, modelRead] = await Promise.all([
              sender.executeJavaScript(MENUBAR_TITLES_SCRIPT).catch(() => null),
              sender.executeJavaScript("window.__orreryViewModelLabels ?? null").catch(() => null),
            ]);
            const titles = typeof barRead === "string" ? (JSON.parse(barRead) as { titles: string[] }).titles : [];
            const modelLabels = Array.isArray(modelRead) ? (modelRead as string[]) : null;
            if (titles.length > 0 && modelLabels) {
              missing = findMissingMenuLabels(modelLabels, expected);
            }
            if (missing.length > 0) await new Promise(resolve => setTimeout(resolve, 500));
          }
          for (const label of missing) console.log(`FAIL no menu entry opens "${label}"`);
          if (smokeProbePassed(outcome) && missing.length === 0) console.log(SMOKE_RENDER_MARKER);
          setTimeout(() => app.quit(), 50);
        }).catch(error => {
          console.log(`FAIL smoke render probe: ${error instanceof Error ? error.message : "unknown failure"}`);
          setTimeout(() => app.quit(), 50);
        });
      }
    }],
  ] as const;
  for (const [channel, handler] of handlers) {
    target.removeHandler(channel);
    target.handle(channel, handler);
  }
}

@injectable()
export class MissionControlElectronMainContribution implements ElectronMainApplicationContribution {
  constructor(@inject(MissionControlHostService) @optional() private readonly host?: ElectronMainMissionControlHostService) {}

  onStart(_application: ElectronMainApplication): void {
    if (!this.host) {
      throw new Error("Mission Control requires the assembled Theia host to bind MissionControlHostService before Electron main startup.");
    }
    registerMissionControlHostIpc(ipcMain, this.host);
  }
}
