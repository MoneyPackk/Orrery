import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { assertLoopbackOrHttps } from "./intelligence-store";
import { classifyToolRisk, MAX_TOOLS_PER_SERVER, type McpServerRecord, type McpToolRecord } from "./mcp-policy";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 1_000_000;
const MAX_BUFFER_BYTES = 4 * 1_000_000;

/** Minimal fetch surface, mirroring the chat provider so tests can inject a double. */
export type McpFetchLike = (url: string, init: {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
  readonly redirect: "manual";
}) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface McpTransport {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * JSON-RPC over a spawned server's stdio.
 *
 * The child is launched with a fixed argument vector, never through a shell, and
 * its output is bounded so a hostile or broken server cannot exhaust memory.
 */
export class StdioMcpTransport implements McpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingCall>();
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private failure?: Error;

  constructor(command: string, args: ReadonlyArray<string>, spawnImpl: typeof spawn = spawn) {
    this.child = spawnImpl(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" },
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => this.consume(String(chunk)));
    // Server diagnostics must never be parsed as protocol or surfaced as tool output.
    this.child.stderr.resume();
    this.child.once("error", error => this.fail(error instanceof Error ? error : new Error("Server failed to start.")));
    this.child.once("exit", code => this.fail(new Error(`Server exited with code ${code ?? "unknown"}.`)));
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("Server connection is closed.");
    const id = this.nextId++;
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) throw new Error("Request exceeds the supported size.");
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Server did not respond within ${REQUEST_TIMEOUT_MS}ms.`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(frame, error => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.closed || this.failure) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, () => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("Server connection is closed."));
    this.child.stdin.end();
    this.child.kill();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.fail(new Error("Server output exceeds the supported size."));
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.id !== "number") return;
    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id);
    clearTimeout(call.timer);
    if (isRecord(message.error)) {
      const detail = typeof message.error.message === "string" ? message.error.message : "unknown error";
      call.reject(new Error(`Server reported an error: ${detail.slice(0, 500)}`));
      return;
    }
    call.resolve(message.result);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(error);
      this.pending.delete(id);
    }
  }
}

/**
 * JSON-RPC over Streamable HTTP.
 *
 * Redirects are refused so a server cannot bounce a request (and its session id)
 * to another host, and responses are size-capped before buffering.
 */
export class HttpMcpTransport implements McpTransport {
  private nextId = 1;
  private sessionId?: string;

  constructor(private readonly endpoint: string, private readonly fetchImpl: McpFetchLike) {
    assertLoopbackOrHttps(endpoint);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        signal: controller.signal,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) throw new Error("Server attempted a redirect, which is refused.");
      const session = response.headers.get("mcp-session-id");
      if (session && /^[A-Za-z0-9_-]{1,256}$/.test(session)) this.sessionId = session;
      if (!response.ok) throw new Error(`Server responded with status ${response.status}.`);
      const declared = Number(response.headers.get("content-length") ?? Number.NaN);
      if (Number.isFinite(declared) && declared > MAX_FRAME_BYTES) throw new Error("Server response exceeds the supported size.");
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > MAX_FRAME_BYTES) throw new Error("Server response exceeds the supported size.");
      return parseHttpPayload(body);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.sessionId = undefined;
  }
}

/** Streamable HTTP may answer with a JSON object or an SSE stream of them. */
export function parseHttpPayload(body: string): unknown {
  const direct = tryParse(body);
  const message = direct ?? parseEventStream(body);
  if (!isRecord(message)) throw new Error("Server returned a malformed response.");
  if (isRecord(message.error)) {
    const detail = typeof message.error.message === "string" ? message.error.message : "unknown error";
    throw new Error(`Server reported an error: ${detail.slice(0, 500)}`);
  }
  return message.result;
}

function parseEventStream(body: string): unknown {
  // Take the last complete data payload, which carries the response to our request.
  const payloads = body
    .split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim())
    .filter(line => line.length > 0);
  for (const payload of payloads.reverse()) {
    const parsed = tryParse(payload);
    if (isRecord(parsed) && (Object.hasOwn(parsed, "result") || Object.hasOwn(parsed, "error"))) return parsed;
  }
  return undefined;
}

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** Opens a transport for a registered server. */
export function createTransport(
  server: McpServerRecord,
  dependencies: { readonly spawnImpl?: typeof spawn; readonly fetchImpl?: McpFetchLike } = {},
): McpTransport {
  if (server.transport === "stdio") {
    if (!server.command) throw new Error("A stdio server requires a command.");
    return new StdioMcpTransport(server.command, server.args ?? [], dependencies.spawnImpl);
  }
  if (!server.endpoint) throw new Error("An http server requires an endpoint.");
  const fetchImpl = dependencies.fetchImpl ?? (globalThis.fetch as unknown as McpFetchLike | undefined);
  if (!fetchImpl) throw new Error("No HTTP client is available.");
  return new HttpMcpTransport(server.endpoint, fetchImpl);
}

/** Performs the initialize handshake and returns the server's classified tools. */
export async function discoverTools(transport: McpTransport): Promise<ReadonlyArray<McpToolRecord>> {
  await transport.request("initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "Orrery", version: "1.0.0" },
  });
  if (transport instanceof StdioMcpTransport) transport.notify("notifications/initialized");
  const result = await transport.request("tools/list", {});
  const tools = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
  return tools
    .filter(isRecord)
    .filter(tool => typeof tool.name === "string" && tool.name.length > 0)
    .slice(0, MAX_TOOLS_PER_SERVER)
    .map(tool => {
      const name = String(tool.name);
      const description = boundedString(tool.description, 2_000);
      const annotations = isRecord(tool.annotations) ? tool.annotations : {};
      return {
        name,
        title: boundedString(tool.title, 200) || name,
        description,
        risk: classifyToolRisk({ name, description, annotations }),
        inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : {},
      } satisfies McpToolRecord;
    });
}

/** Calls one tool and flattens its content blocks into bounded plain text. */
export async function callTool(
  transport: McpTransport,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<{ readonly content: string; readonly isError: boolean }> {
  const result = await transport.request("tools/call", { name, arguments: args });
  if (!isRecord(result)) throw new Error("Server returned a malformed tool result.");
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .filter(isRecord)
    .map(block => {
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (typeof block.type === "string") return `[${block.type} content omitted]`;
      return "";
    })
    .filter(part => part.length > 0)
    .join("\n");
  return { content: text, isError: result.isError === true };
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
