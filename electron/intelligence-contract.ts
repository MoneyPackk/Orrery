export type IntelligenceProviderKind = "openai-compatible" | "anthropic" | "ollama";
export type IntelligenceRole = "user" | "assistant";

/** Redacted provider status. Credentials never leave the Electron main process. */
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
 * What Orrery is doing right now in an in-flight turn.
 *
 * A tool call raises a native confirmation, and a modal that appears with no in-app explanation
 * trains people to click through it, which is exactly what the per-turn call budget exists to
 * prevent. This is read by the chat surface while a turn runs so the modal is expected rather
 * than unexplained. It is status only: nothing here authorizes anything.
 */
export interface IntelligenceTurnStatus {
  readonly threadId: string;
  readonly active: boolean;
  /** The tool awaiting confirmation or running, when there is one. */
  readonly pendingTool?: { readonly serverId: string; readonly name: string; readonly risk: string };
  /** Calls already resolved in this turn, so progress is visible before the reply lands. */
  readonly completed: ReadonlyArray<IntelligenceToolCall>;
  /** Tool calls still available in this turn, so an unusually busy turn is visible. */
  readonly remainingCalls: number;
  /** True once the operator has asked this turn to stop. Work already confirmed still runs. */
  readonly stopping?: boolean;
}

/**
 * One tool the model requested during a turn, recorded as data rather than prose.
 *
 * These live beside the assistant's text, never inside it, so the interface can render them
 * in a region the model cannot write into. That is what makes a fabricated tool record
 * impossible rather than merely detectable: the model authors `text`, Orrery authors this.
 */
export interface IntelligenceToolCall {
  readonly serverId: string;
  readonly name: string;
  /** Orrery-classified. `denied` covers a declined confirmation and a policy refusal. */
  readonly outcome: "ran" | "error" | "denied" | "skipped";
  /**
   * Short explanation for a non-`ran` outcome.
   *
   * May be influenced by server-reported error text, because a transport or JSON-RPC failure
   * carries the server's message. Bounded and single-line here, and must be rendered as plain
   * text by any consumer.
   */
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
