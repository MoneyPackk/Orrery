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

export interface IntelligenceMessage {
  readonly id: string;
  readonly threadId: string;
  readonly sequence: number;
  readonly role: IntelligenceRole;
  readonly text: string;
  readonly createdAt: string;
  readonly missionId?: string;
  readonly truncated?: boolean;
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
