/**
 * Model Context Protocol contracts for the Electron main process.
 * Duplicated in the Theia extension's common contracts so the root
 * tsconfig boundary stays intact (the extension must not be imported here).
 */

/** How Orrery reaches a server. Local servers are spawned; remote servers are called over HTTPS. */
export type McpTransportKind = "stdio" | "http";

/**
 * What a tool can do, worst case. Assigned by Orrery from the server's own
 * declaration, then used to decide whether consent may ever be remembered.
 */
export type McpToolRisk = "read" | "write" | "destructive" | "network" | "spend";

/** A stored consent decision for one tool. */
export type McpToolDecision = "ask" | "allow" | "deny";

/** Risks whose consent may never be remembered: every invocation is confirmed by the human. */
export const ALWAYS_ASK_RISKS: ReadonlyArray<McpToolRisk> = ["write", "destructive", "network", "spend"];

export interface McpServerInput {
  readonly serverId: string;
  readonly label: string;
  readonly transport: McpTransportKind;
  /** stdio only: absolute executable path. */
  readonly command?: string;
  /** stdio only: fixed argument vector. Never merged with model output. */
  readonly args?: ReadonlyArray<string>;
  /** http only: absolute https (or loopback http) endpoint. */
  readonly endpoint?: string;
}

/** A registered server as shown to the renderer. Never carries secrets. */
export interface McpServerStatus {
  readonly serverId: string;
  readonly label: string;
  readonly transport: McpTransportKind;
  /** stdio: the executable basename. http: the endpoint host. Full paths and URLs stay in main. */
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
  /** True when this tool's consent can never be remembered, regardless of the stored decision. */
  readonly alwaysAsk: boolean;
}

export interface McpCatalog {
  readonly servers: ReadonlyArray<McpServerStatus>;
  readonly tools: ReadonlyArray<McpToolStatus>;
}

export interface McpSetDecisionInput {
  readonly intentId: string;
  readonly serverId: string;
  readonly name: string;
  readonly decision: McpToolDecision;
}

export interface McpRemoveServerInput {
  readonly intentId: string;
  readonly serverId: string;
}

export interface McpRegisterInput extends McpServerInput {
  readonly intentId: string;
}

export interface McpInvokeInput {
  readonly intentId: string;
  readonly serverId: string;
  readonly name: string;
  /**
   * Tool arguments. Rebuilt as a plain JSON tree, bounded in size and depth, and
   * digested into the consent capability. Not checked against the server's declared
   * schema: the server is responsible for validating its own input.
   */
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * The outcome of one gated invocation. `content` is untrusted server output:
 * it is length-bounded and must be rendered as plain text, never as markup.
 */
export interface McpInvokeResult {
  readonly serverId: string;
  readonly name: string;
  readonly risk: McpToolRisk;
  readonly content: string;
  readonly isError: boolean;
  readonly truncated: boolean;
  readonly invokedAt: string;
  /** Sequence number in the audit log, so the renderer can show tool activity in order. */
  readonly sequence: number;
}

/** One durable audit entry. Written for every decision, allowed or refused. */
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
