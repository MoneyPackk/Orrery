import type { IntelligenceProviderKind } from "./intelligence-contract";
import { assertLoopbackOrHttps, MAX_MESSAGE_LENGTH, type IntelligenceCredentials } from "./intelligence-store";
import { toolsForProvider, type ToolDeclaration } from "./intelligence-tools";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_HISTORY = 20;

export interface IntelligenceTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface IntelligenceRequest {
  readonly credentials: IntelligenceCredentials;
  readonly history: ReadonlyArray<IntelligenceTurn>;
  readonly prompt: string;
  readonly systemPrompt?: string;
  /** Tools offered to the model. Omitted or empty means a text-only turn. */
  readonly tools?: ReadonlyArray<ToolDeclaration>;
}

export type FetchLike = (input: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  redirect: "manual";
}) => Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }>;

export const ORRERY_SYSTEM_PROMPT = [
  "You are Orrery Intelligence, the assistant inside the Orrery mission cockpit.",
  "Be direct, technically accurate, and concise. Prefer concrete steps over praise.",
  "You cannot edit files, run commands, or promote changes. Missions perform those actions after human approval.",
  "If information is missing, say so and state what you would need.",
].join(" ");

/** Calls the user's own model endpoint. Runs only in Electron main; the renderer never sees keys or URLs. */
export async function requestIntelligenceReply(
  request: IntelligenceRequest,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<string> {
  const { body } = await requestIntelligenceRaw(request, fetchImpl);
  const reply = extractReply(request.credentials.provider, body);
  if (!reply.trim()) throw new Error("Orrery Intelligence returned an empty response.");
  return reply.slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * Same call, returning the raw body so a caller can inspect requested tool calls.
 *
 * The tool loop needs both the text and any tool_use blocks from one response, and a
 * second parse of an already-fetched body is far cheaper than a second billed request.
 */
export async function requestIntelligenceRaw(
  request: IntelligenceRequest,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<{ readonly body: string; readonly text: string }> {
  const { credentials } = request;
  const endpoint = resolveEndpoint(credentials.provider, credentials.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: buildHeaders(credentials),
      body: JSON.stringify(buildBody(request)),
      signal: controller.signal,
      // Never follow redirects: a 3xx must not replay credential headers to another host.
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Orrery Intelligence endpoint attempted a redirect, which is refused to protect your credential.");
    }
    const declaredLength = Number(response.headers?.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error("Orrery Intelligence response exceeded the supported size.");
    }
    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) throw new Error("Orrery Intelligence response exceeded the supported size.");
    if (!response.ok) throw new Error(`Orrery Intelligence request failed with status ${response.status}.`);
    // A tool-calling turn legitimately carries no text, so emptiness is not an error here.
    return { body, text: safeExtractReply(credentials.provider, body).slice(0, MAX_MESSAGE_LENGTH) };
  } finally {
    clearTimeout(timeout);
  }
}

function safeExtractReply(provider: IntelligenceProviderKind, body: string): string {
  try {
    return extractReply(provider, body);
  } catch {
    return "";
  }
}

function resolveEndpoint(provider: IntelligenceProviderKind, baseUrl: string): string {
  const url = assertLoopbackOrHttps(baseUrl);
  const base = url.href.replace(/\/+$/, "");
  if (provider === "anthropic") return `${base}/v1/messages`;
  if (provider === "ollama") return `${base}/api/chat`;
  return `${base}/chat/completions`;
}

function buildHeaders(credentials: IntelligenceCredentials): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (credentials.provider === "anthropic") {
    headers["x-api-key"] = credentials.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (credentials.apiKey.trim().length > 0) {
    headers.authorization = `Bearer ${credentials.apiKey}`;
  }
  return headers;
}

function buildBody(request: IntelligenceRequest): Record<string, unknown> {
  const { credentials, prompt, systemPrompt = ORRERY_SYSTEM_PROMPT } = request;
  const history = request.history.slice(-MAX_HISTORY).map(turn => ({ role: turn.role, content: turn.text }));
  const tools = toolsForProvider(credentials.provider, request.tools ?? []);
  // Omit the field entirely when empty: some endpoints reject an empty tools array.
  const withTools = tools.length > 0 ? { tools } : {};
  if (credentials.provider === "anthropic") {
    return { model: credentials.model, max_tokens: 2_048, system: systemPrompt, messages: [...history, { role: "user", content: prompt }], ...withTools };
  }
  const messages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: prompt }];
  if (credentials.provider === "ollama") return { model: credentials.model, stream: false, messages, ...withTools };
  return { model: credentials.model, messages, ...withTools };
}

function extractReply(provider: IntelligenceProviderKind, body: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw new Error("Orrery Intelligence returned a malformed response.");
  }
  if (!isRecord(payload)) throw new Error("Orrery Intelligence returned a malformed response.");
  if (provider === "anthropic") {
    const content = payload.content;
    if (!Array.isArray(content)) throw new Error("Orrery Intelligence returned a malformed response.");
    return content
      .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map(part => part.text as string)
      .join("");
  }
  if (provider === "ollama") {
    const message = payload.message;
    if (isRecord(message) && typeof message.content === "string") return message.content;
    throw new Error("Orrery Intelligence returned a malformed response.");
  }
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error("Orrery Intelligence returned a malformed response.");
  const first = choices[0];
  if (isRecord(first) && isRecord(first.message) && typeof first.message.content === "string") return first.message.content;
  throw new Error("Orrery Intelligence returned a malformed response.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
