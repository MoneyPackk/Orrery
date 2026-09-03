export type MissionMode = "explore" | "plan" | "build" | "delegate";
export type MissionStatus = "draft" | "planning" | "awaiting_approval" | "queued" | "running" | "paused" | "blocked" | "ready_for_review" | "revision_requested" | "accepted" | "rejected" | "failed" | "cancelled";
export type ReviewDecision = "accepted" | "rejected" | "revision_requested";

export const MISSION_LIST_CHANNEL = "mission:v1:list";
export const MISSION_GET_SNAPSHOT_CHANNEL = "mission:v1:get-snapshot";
export const MISSION_REVIEW_CHANNEL = "mission:v1:promote";
export const MISSION_INTAKE_REPOSITORY_CHANNEL = "mission:v1:intake-repository";
export const MISSION_CREATE_CHANNEL = "mission:v1:create";
export const MISSION_RUN_CHANNEL = "mission:v1:run";
export const MISSION_CANCEL_CHANNEL = "mission:v1:cancel";
export const MISSION_INSPECT_CHANNEL = "mission:v1:inspect";
export const INTELLIGENCE_GET_SETTINGS_CHANNEL = "intelligence:v1:get-settings";
export const INTELLIGENCE_SET_SETTINGS_CHANNEL = "intelligence:v1:set-settings";
export const INTELLIGENCE_LIST_MESSAGES_CHANNEL = "intelligence:v1:list-messages";
export const INTELLIGENCE_SEND_MESSAGE_CHANNEL = "intelligence:v1:send-message";
export const INTELLIGENCE_CLEAR_THREAD_CHANNEL = "intelligence:v1:clear-thread";
export const MCP_LIST_CATALOG_CHANNEL = "mcp:v1:list-catalog";
export const MCP_REGISTER_SERVER_CHANNEL = "mcp:v1:register-server";
export const MCP_REMOVE_SERVER_CHANNEL = "mcp:v1:remove-server";
export const MCP_SET_DECISION_CHANNEL = "mcp:v1:set-decision";
export const MCP_INVOKE_TOOL_CHANNEL = "mcp:v1:invoke-tool";
export const MCP_LIST_ACTIVITY_CHANNEL = "mcp:v1:list-activity";

/** How Orrery reaches a server. Local servers are spawned; remote servers are called over HTTPS. */
export type McpTransportKind = "stdio" | "http";
/** What a tool can do, worst case, as classified by Orrery from the server's declaration. */
export type McpToolRisk = "read" | "write" | "destructive" | "network" | "spend";
export type McpToolDecision = "ask" | "allow" | "deny";

/** A registered server as shown to the renderer. Commands, argument vectors, and full URLs stay in main. */
export interface McpServerStatus {
  readonly serverId: string;
  readonly label: string;
  readonly transport: McpTransportKind;
  /** stdio: the executable basename. http: the endpoint host. */
  readonly origin: string;
  readonly enabled: boolean;
  readonly toolCount: number;
  readonly registeredAt: string;
}

export interface McpToolStatus {
  readonly serverId: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly risk: McpToolRisk;
  readonly decision: McpToolDecision;
  /** True when consent for this tool can never be remembered. */
  readonly alwaysAsk: boolean;
}

export interface McpCatalog {
  readonly servers: ReadonlyArray<McpServerStatus>;
  readonly tools: ReadonlyArray<McpToolStatus>;
}

export interface McpRegisterInput {
  readonly intentId: string;
  readonly serverId: string;
  readonly label: string;
  readonly transport: McpTransportKind;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly endpoint?: string;
}

export interface McpRemoveServerInput {
  readonly intentId: string;
  readonly serverId: string;
}

export interface McpSetDecisionInput {
  readonly intentId: string;
  readonly serverId: string;
  readonly name: string;
  readonly decision: McpToolDecision;
}

export interface McpInvokeInput {
  readonly intentId: string;
  readonly serverId: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** `content` is untrusted server output: render as plain text, never as markup. */
export interface McpInvokeResult {
  readonly serverId: string;
  readonly name: string;
  readonly risk: McpToolRisk;
  readonly content: string;
  readonly isError: boolean;
  readonly truncated: boolean;
  readonly invokedAt: string;
  readonly sequence: number;
}

export interface McpActivityEntry {
  readonly sequence: number;
  readonly serverId: string;
  readonly name: string;
  readonly risk: McpToolRisk;
  readonly outcome: "allowed" | "denied" | "failed";
  readonly reason?: string;
  readonly at: string;
}

export interface McpActivity {
  readonly entries: ReadonlyArray<McpActivityEntry>;
}

export type IntelligenceProviderKind = "openai-compatible" | "anthropic" | "ollama";
export type IntelligenceRole = "user" | "assistant";

/** Redacted provider status. Keys, endpoints, and transports never reach the renderer. */
export interface IntelligenceSettingsStatus {
  readonly configured: boolean;
  readonly provider?: IntelligenceProviderKind;
  readonly model?: string;
  readonly endpointHost?: string;
  readonly hasCredential: boolean;
  readonly updatedAt?: string;
}

export interface IntelligenceSettingsInput {
  readonly intentId: string;
  readonly provider: IntelligenceProviderKind;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

/**
 * One tool the model requested during a turn.
 *
 * Orrery authors these; the model authors `IntelligenceMessage.text`. Keeping them in separate
 * fields is what lets the interface render a tool record the model cannot forge. `detail` may
 * carry server-reported error text, so render it as plain text.
 */
export interface IntelligenceToolCall {
  readonly serverId: string;
  readonly name: string;
  readonly outcome: "ran" | "error" | "denied" | "skipped";
  readonly detail?: string;
}

export interface IntelligenceMessage {
  readonly id: string;
  readonly threadId: string;
  readonly sequence: number;
  readonly role: IntelligenceRole;
  readonly text: string;
  readonly createdAt: string;
  readonly missionId?: string;
  readonly truncated?: boolean;
  /** Present only on an assistant message whose turn used tools. */
  readonly toolCalls?: ReadonlyArray<IntelligenceToolCall>;
}

export interface IntelligenceThreadInput { readonly threadId: string }
export interface IntelligenceClearInput { readonly intentId: string; readonly threadId: string }
export interface IntelligenceSendInput {
  readonly intentId: string;
  readonly threadId: string;
  readonly text: string;
  readonly missionId?: string;
}
export interface IntelligenceSendResult {
  readonly request: IntelligenceMessage;
  readonly reply: IntelligenceMessage;
}
export interface IntelligenceTranscript {
  readonly threadId: string;
  readonly messages: ReadonlyArray<IntelligenceMessage>;
  readonly settings: IntelligenceSettingsStatus;
}

export interface PlanRevision {
  readonly id: string;
  readonly revision: number;
  readonly approved: boolean;
  readonly createdAt: string;
  readonly scope: string;
  readonly actions: ReadonlyArray<string>;
  readonly acceptanceCriteria: ReadonlyArray<string>;
}

export interface MissionEvent {
  readonly id: string;
  readonly missionId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly kind: string;
  readonly title: string;
  readonly detail: string;
}

export interface FileChange {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly diff: string;
}

export interface Evidence {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly summary: string;
  readonly criterion?: string;
  readonly planRevisionId: string;
  readonly timestamp: string;
}

export interface Mission {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly mode: MissionMode;
  readonly status: MissionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly targetBranch: string;
  readonly missionBranch?: string;
  readonly workspaceId?: string;
  readonly plan: PlanRevision;
  readonly events: ReadonlyArray<MissionEvent>;
  readonly changes: ReadonlyArray<FileChange>;
  readonly evidence: ReadonlyArray<Evidence>;
  readonly completionSummary?: string;
  readonly reviewDecision?: ReviewDecision;
  readonly activeRunId?: string;
}

export interface MissionListItem {
  readonly id: string;
  readonly title: string;
  readonly status: MissionStatus;
  readonly updatedAt: string;
}

export interface MissionSnapshotInput { readonly missionId: string }
export interface RepositoryIntakeInput { readonly intentId: string; readonly localPath: string }
export interface RepositoryIntakeResult { readonly repositoryId: string; readonly canonicalRoot: string; readonly fingerprint: string }
export interface MissionPlanInput { readonly scope: string; readonly actions: ReadonlyArray<string>; readonly acceptanceCriteria: ReadonlyArray<string> }
export interface MissionCreateInput { readonly intentId: string; readonly repositoryId: string; readonly title: string; readonly goal: string; readonly mode: MissionMode; readonly plan: MissionPlanInput }
export interface MissionRunInput { readonly intentId: string; readonly missionId: string; readonly planRevisionId: string }
export interface MissionRunResult { readonly mission: Mission; readonly runId: string }
export interface MissionCancelInput { readonly intentId: string; readonly missionId: string; readonly runId: string }
export interface MissionCancelResult { readonly mission: Mission; readonly runId: string }
export interface MissionInspectInput { readonly missionId: string; readonly planRevisionId: string }
export interface MissionInspectionResult { readonly mission: Mission; readonly planRevisionId: string; readonly changeRevision: string; readonly contentDigest: string; readonly review: MissionReviewContent }
export interface MissionReviewContent { readonly changes: ReadonlyArray<{ readonly path: string; readonly additions: number; readonly deletions: number; readonly binary: boolean; readonly diff: string }>; readonly evidence: ReadonlyArray<Evidence> }
export interface MissionReviewInput {
  readonly intentId: string;
  readonly missionId: string;
  readonly planRevisionId: string;
  readonly decision: Exclude<ReviewDecision, "revision_requested">;
}
export interface MissionPromotionResult {
  readonly mission: Mission;
  readonly planRevisionId: string;
  readonly changeRevision: string;
  readonly decision: Exclude<ReviewDecision, "revision_requested">;
  readonly reviewerId: string;
  readonly result: "promoted" | "rejected" | "conflict";
}

export interface MissionControlPublicApi {
  intakeRepository(input: RepositoryIntakeInput): Promise<RepositoryIntakeResult>;
  create(input: MissionCreateInput): Promise<Mission>;
  run(input: MissionRunInput): Promise<MissionRunResult>;
  cancel(input: MissionCancelInput): Promise<MissionCancelResult>;
  list(): Promise<ReadonlyArray<MissionListItem>>;
  getSnapshot(input: MissionSnapshotInput): Promise<Mission>;
  inspect(input: MissionInspectInput): Promise<MissionInspectionResult>;
  reviewAndPromote(input: MissionReviewInput): Promise<MissionPromotionResult>;
  getIntelligenceSettings(): Promise<IntelligenceSettingsStatus>;
  setIntelligenceSettings(input: IntelligenceSettingsInput): Promise<IntelligenceSettingsStatus>;
  listIntelligenceMessages(input: IntelligenceThreadInput): Promise<IntelligenceTranscript>;
  sendIntelligenceMessage(input: IntelligenceSendInput): Promise<IntelligenceSendResult>;
  clearIntelligenceThread(input: IntelligenceClearInput): Promise<IntelligenceTranscript>;
  listMcpCatalog(): Promise<McpCatalog>;
  registerMcpServer(input: McpRegisterInput): Promise<McpCatalog>;
  removeMcpServer(input: McpRemoveServerInput): Promise<McpCatalog>;
  setMcpToolDecision(input: McpSetDecisionInput): Promise<McpCatalog>;
  invokeMcpTool(input: McpInvokeInput): Promise<McpInvokeResult>;
  listMcpActivity(): Promise<McpActivity>;
}

export const MissionControlHostService = Symbol("MissionControlHostService");
export interface MissionControlHostService extends MissionControlPublicApi {}
