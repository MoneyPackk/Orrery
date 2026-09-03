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
