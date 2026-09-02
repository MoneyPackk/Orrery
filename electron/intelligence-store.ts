import { mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  IntelligenceMessage,
  IntelligenceProviderKind,
  IntelligenceRole,
  IntelligenceSettingsStatus,
} from "./intelligence-contract";
import { hardenPrivatePath } from "../packages/mission-control-daemon/src/auth";

export const MAX_MESSAGE_LENGTH = 8_000;
export const MAX_THREAD_MESSAGES = 200;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const PROVIDERS: ReadonlyArray<IntelligenceProviderKind> = ["openai-compatible", "anthropic", "ollama"];

export interface IntelligenceCredentials {
  readonly provider: IntelligenceProviderKind;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly updatedAt: string;
}

interface StoredThread {
  readonly threadId: string;
  readonly messages: ReadonlyArray<IntelligenceMessage>;
  readonly intents: ReadonlyArray<{ readonly intentId: string; readonly requestId: string; readonly replyId: string }>;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Owns Orrery Intelligence configuration and transcripts on disk.
 * Credentials never leave this process; callers receive redacted status only.
 */
export class IntelligenceStore {
  private readonly settingsPath: string;
  private readonly transcriptPath: string;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    runtimeDirectory: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly harden: (path: string, platform?: NodeJS.Platform) => Promise<void> = hardenPrivatePath,
  ) {
    this.settingsPath = join(runtimeDirectory, "intelligence.json");
    this.transcriptPath = join(runtimeDirectory, "intelligence-threads.json");
  }

  async readCredentials(): Promise<IntelligenceCredentials | undefined> {
    const raw = await this.readJson(this.settingsPath);
    if (!isRecord(raw)) return undefined;
    const { provider, model, baseUrl, apiKey, updatedAt } = raw;
    if (!isProvider(provider) || !isBoundedText(model, 200) || !isBoundedText(baseUrl, 2_048) || typeof apiKey !== "string" || !isBoundedText(updatedAt, 64)) {
      return undefined;
    }
    return { provider, model, baseUrl, apiKey, updatedAt };
  }

  async readSettingsStatus(): Promise<IntelligenceSettingsStatus> {
    const credentials = await this.readCredentials();
    if (!credentials) return { configured: false, hasCredential: false };
    return {
      configured: true,
      provider: credentials.provider,
      model: credentials.model,
      endpointHost: safeHost(credentials.baseUrl),
      hasCredential: credentials.apiKey.length > 0,
      updatedAt: credentials.updatedAt,
    };
  }

  async writeCredentials(input: {
    readonly provider: IntelligenceProviderKind;
    readonly model: string;
    readonly baseUrl: string;
    readonly apiKey: string;
  }): Promise<IntelligenceSettingsStatus> {
    assertLoopbackOrHttps(input.baseUrl);
    if (input.provider !== "ollama" && input.apiKey.trim().length === 0) {
      throw new Error("This provider requires an API key.");
    }
    const record: IntelligenceCredentials = {
      provider: input.provider,
      model: input.model.trim(),
      baseUrl: input.baseUrl.trim(),
      apiKey: input.apiKey,
      updatedAt: new Date().toISOString(),
    };
    await this.writePrivateJson(this.settingsPath, record);
    return this.readSettingsStatus();
  }

  async readThread(threadId: string): Promise<ReadonlyArray<IntelligenceMessage>> {
    return (await this.readStoredThread(threadId)).messages;
  }

  async findByIntent(threadId: string, intentId: string): Promise<{ readonly request: IntelligenceMessage; readonly reply: IntelligenceMessage } | undefined> {
    const thread = await this.readStoredThread(threadId);
    const record = thread.intents.find(entry => entry.intentId === intentId);
    if (!record) return undefined;
    const request = thread.messages.find(message => message.id === record.requestId);
    const reply = thread.messages.find(message => message.id === record.replyId);
    return request && reply ? { request, reply } : undefined;
  }

  async appendExchange(input: {
    readonly threadId: string;
    readonly intentId: string;
    readonly missionId?: string;
    readonly request: string;
    readonly reply: string;
  }): Promise<{ readonly request: IntelligenceMessage; readonly reply: IntelligenceMessage; readonly messages: ReadonlyArray<IntelligenceMessage> }> {
    // Serialize read-modify-write so concurrent sends cannot drop an exchange.
    return this.serialize(async () => {
      const thread = await this.readStoredThread(input.threadId);
      const base = thread.messages.at(-1)?.sequence ?? 0;
      const request = this.createMessage(input.threadId, base + 1, "user", input.request, input.missionId);
      const reply = this.createMessage(input.threadId, base + 2, "assistant", input.reply, input.missionId);
      const messages = [...thread.messages, request, reply].slice(-MAX_THREAD_MESSAGES);
      const intents = [...thread.intents, { intentId: input.intentId, requestId: request.id, replyId: reply.id }].slice(-MAX_THREAD_MESSAGES);
      await this.writeThread({ threadId: input.threadId, messages, intents });
      return { request, reply, messages };
    });
  }

  async clearThread(threadId: string): Promise<ReadonlyArray<IntelligenceMessage>> {
    return this.serialize(async () => {
      await this.writeThread({ threadId, messages: [], intents: [] });
      return [] as ReadonlyArray<IntelligenceMessage>;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation, operation);
    this.writes = result.catch(() => undefined);
    return result;
  }

  private createMessage(threadId: string, sequence: number, role: IntelligenceRole, text: string, missionId?: string): IntelligenceMessage {
    const trimmed = text.slice(0, MAX_MESSAGE_LENGTH);
    return {
      id: randomUUID(),
      threadId,
      sequence,
      role,
      text: trimmed,
      createdAt: new Date().toISOString(),
      ...(missionId ? { missionId } : {}),
      ...(trimmed.length < text.length ? { truncated: true } : {}),
    };
  }

  private async readStoredThread(threadId: string): Promise<StoredThread> {
    const raw = await this.readJson(this.transcriptPath);
    const threads = isRecord(raw) && isRecord(raw.threads) ? raw.threads : {};
    const stored = Object.prototype.hasOwnProperty.call(threads, threadId) ? threads[threadId] : undefined;
    if (!isRecord(stored)) return { threadId, messages: [], intents: [] };
    const messages = Array.isArray(stored.messages) ? stored.messages.filter(isMessage).slice(-MAX_THREAD_MESSAGES) : [];
    const intents = Array.isArray(stored.intents) ? stored.intents.filter(isIntentRecord).slice(-MAX_THREAD_MESSAGES) : [];
    return { threadId, messages, intents };
  }

  private async writeThread(thread: StoredThread): Promise<void> {
    if (FORBIDDEN_KEYS.has(thread.threadId)) throw new Error("Unsupported conversation identifier.");
    const raw = await this.readJson(this.transcriptPath);
    const existing = isRecord(raw) && isRecord(raw.threads) ? raw.threads : {};
    const threads: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(existing)) {
      if (key !== thread.threadId && !FORBIDDEN_KEYS.has(key)) threads[key] = value;
    }
    threads[thread.threadId] = { threadId: thread.threadId, messages: thread.messages, intents: thread.intents };
    await this.writePrivateJson(this.transcriptPath, { version: 1, threads: { ...threads } });
  }

  private async readJson(path: string): Promise<unknown> {
    const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!metadata) return undefined;
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${path} must be a regular file.`);
    if (metadata.size > MAX_FILE_BYTES) throw new Error(`${path} exceeds the supported size.`);
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      return undefined;
    }
  }

  private async writePrivateJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value), "utf8");
    } finally {
      await file.close();
    }
    try {
      if (this.platform === "win32") await this.harden(temporary, "win32");
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    if (this.platform === "win32") await this.harden(path, "win32");
  }
}

export function assertLoopbackOrHttps(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Provider endpoint must be a valid absolute URL.");
  }
  if (url.username || url.password || url.hash) throw new Error("Provider endpoint must not embed credentials or fragments.");
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && loopback) return url;
  throw new Error("Provider endpoint must use https, or http on loopback only.");
}

function safeHost(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).host;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProvider(value: unknown): value is IntelligenceProviderKind {
  return typeof value === "string" && PROVIDERS.includes(value as IntelligenceProviderKind);
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isMessage(value: unknown): value is IntelligenceMessage {
  if (!isRecord(value)) return false;
  return isBoundedText(value.id, 200)
    && isBoundedText(value.threadId, 200)
    && typeof value.sequence === "number"
    && Number.isSafeInteger(value.sequence)
    && (value.role === "user" || value.role === "assistant")
    && typeof value.text === "string"
    && value.text.length <= MAX_MESSAGE_LENGTH
    && isBoundedText(value.createdAt, 64);
}

function isIntentRecord(value: unknown): value is { intentId: string; requestId: string; replyId: string } {
  return isRecord(value) && isBoundedText(value.intentId, 200) && isBoundedText(value.requestId, 200) && isBoundedText(value.replyId, 200);
}
