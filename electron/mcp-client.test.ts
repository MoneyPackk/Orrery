import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { callTool, createTransport, discoverTools, HttpMcpTransport, parseHttpPayload, StdioMcpTransport, type McpFetchLike } from "./mcp-client";
import type { McpServerRecord } from "./mcp-policy";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding(encoding: string): void };
    stderr: EventEmitter & { resume(): void };
    stdin: { write(value: string, callback?: (error?: Error) => void): void; end(): void };
    kill(): void;
    written: string[];
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  child.stderr = Object.assign(new EventEmitter(), { resume: () => undefined });
  child.written = [];
  child.stdin = {
    write: (value: string, callback?: (error?: Error) => void) => {
      child.written.push(value);
      callback?.();
    },
    end: () => undefined,
  };
  child.kill = () => undefined;
  return child;
}

function stdioTransport() {
  const child = fakeChild();
  const spawnImpl = vi.fn(() => child) as never;
  const transport = new StdioMcpTransport("/usr/bin/mcp", ["--flag"], spawnImpl);
  return { child, transport, spawnImpl: spawnImpl as unknown as ReturnType<typeof vi.fn> };
}

const reply = (id: number, result: unknown) => `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;

const httpResponse = (body: string, headers: Record<string, string> = {}, status = 200): Awaited<ReturnType<McpFetchLike>> => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  text: async () => body,
});

describe("MCP stdio transport", () => {
  it("spawns without a shell and with a fixed argument vector", () => {
    const { spawnImpl } = stdioTransport();
    const [command, args, options] = spawnImpl.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe("/usr/bin/mcp");
    expect(args).toEqual(["--flag"]);
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
    // The child must not inherit the full environment, which can carry credentials.
    expect(Object.keys(options.env as Record<string, string>).sort()).toEqual(["PATH", "SYSTEMROOT"]);
  });

  it("resolves a request when the matching response arrives", async () => {
    const { child, transport } = stdioTransport();
    const pending = transport.request("tools/list");
    child.stdout.emit("data", reply(1, { tools: [] }));
    await expect(pending).resolves.toEqual({ tools: [] });
  });

  it("reassembles a response split across chunks and ignores interleaved noise", async () => {
    const { child, transport } = stdioTransport();
    const pending = transport.request("tools/list");
    child.stdout.emit("data", "not json\n");
    child.stdout.emit("data", '{"jsonrpc":"2.0","id":1,');
    child.stdout.emit("data", '"result":{"tools":[]}}\n');
    await expect(pending).resolves.toEqual({ tools: [] });
  });

  it("does not resolve a request with a response for a different id", async () => {
    const { child, transport } = stdioTransport();
    const first = transport.request("a");
    const second = transport.request("b");
    child.stdout.emit("data", reply(2, "second"));
    await expect(second).resolves.toBe("second");
    child.stdout.emit("data", reply(1, "first"));
    await expect(first).resolves.toBe("first");
  });

  it("rejects when the server reports a JSON-RPC error", async () => {
    const { child, transport } = stdioTransport();
    const pending = transport.request("tools/call");
    child.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "nope" } })}\n`);
    await expect(pending).rejects.toThrow(/reported an error: nope/);
  });

  it("fails pending requests when the child dies", async () => {
    const { child, transport } = stdioTransport();
    const pending = transport.request("tools/list");
    child.emit("exit", 1);
    await expect(pending).rejects.toThrow(/exited with code 1/);
    await expect(transport.request("tools/list")).rejects.toThrow(/exited with code 1/);
  });

  it("fails closed when the server floods stdout beyond the buffer cap", async () => {
    const { child, transport } = stdioTransport();
    const pending = transport.request("tools/list");
    // No newline, so nothing can be dispatched and the buffer must be capped.
    child.stdout.emit("data", "x".repeat(4_000_001));
    await expect(pending).rejects.toThrow(/exceeds the supported size/);
  });

  it("refuses to send an oversized request", async () => {
    const { transport } = stdioTransport();
    await expect(transport.request("tools/call", { blob: "x".repeat(1_000_001) })).rejects.toThrow(/exceeds the supported size/);
  });

  it("rejects further requests after close", async () => {
    const { transport } = stdioTransport();
    await transport.close();
    await expect(transport.request("tools/list")).rejects.toThrow(/closed/);
  });

  it("never parses stderr as protocol output", async () => {
    const { child, transport } = stdioTransport();
    const pending = transport.request("tools/list");
    child.stderr.emit("data", reply(1, { tools: [{ name: "injected" }] }));
    child.stdout.emit("data", reply(1, { tools: [] }));
    await expect(pending).resolves.toEqual({ tools: [] });
  });
});

describe("MCP http transport", () => {
  it("refuses a plaintext remote endpoint at construction", () => {
    expect(() => new HttpMcpTransport("http://evil.example.com/mcp", vi.fn() as never)).toThrow(/https/);
    expect(() => new HttpMcpTransport("https://tools.example.com/mcp", vi.fn() as never)).not.toThrow();
  });

  it("refuses redirects so a session cannot be bounced to another host", async () => {
    const fetchImpl = vi.fn(async () => httpResponse("", { location: "https://attacker.invalid/mcp" }, 302)) as unknown as McpFetchLike;
    const transport = new HttpMcpTransport("https://tools.example.com/mcp", fetchImpl);
    await expect(transport.request("tools/list")).rejects.toThrow(/redirect/i);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.redirect).toBe("manual");
  });

  it("rejects an oversized declared response before buffering the body", async () => {
    const text = vi.fn(async () => "{}");
    const fetchImpl = (async () => ({ ok: true, status: 200, headers: { get: (name: string) => (name === "content-length" ? "99999999" : null) }, text })) as unknown as McpFetchLike;
    const transport = new HttpMcpTransport("https://tools.example.com/mcp", fetchImpl);
    await expect(transport.request("tools/list")).rejects.toThrow(/exceeds the supported size/);
    expect(text).not.toHaveBeenCalled();
  });

  it("carries a well-formed session id but ignores a malformed one", async () => {
    const calls: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
      calls.push(init.headers);
      return httpResponse(JSON.stringify({ jsonrpc: "2.0", id: calls.length, result: "ok" }), { "mcp-session-id": calls.length === 1 ? "session-1" : "bad session!" });
    }) as unknown as McpFetchLike;
    const transport = new HttpMcpTransport("https://tools.example.com/mcp", fetchImpl);
    await transport.request("initialize");
    await transport.request("tools/list");
    await transport.request("tools/list");
    expect(calls[0]["mcp-session-id"]).toBeUndefined();
    expect(calls[1]["mcp-session-id"]).toBe("session-1");
    expect(calls[2]["mcp-session-id"]).toBe("session-1");
  });

  it("reads a result from either a JSON body or an SSE stream", () => {
    expect(parseHttpPayload(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "direct" }))).toBe("direct");
    expect(parseHttpPayload('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":"streamed"}\n\n')).toBe("streamed");
    expect(() => parseHttpPayload("garbage")).toThrow(/malformed/);
    expect(() => parseHttpPayload('data: {"jsonrpc":"2.0","id":1,"error":{"message":"bad"}}\n')).toThrow(/reported an error: bad/);
  });
});

describe("MCP discovery and invocation", () => {
  const transportFor = (responses: Record<string, unknown>) => ({
    request: vi.fn(async (method: string) => responses[method]),
    close: vi.fn(async () => undefined),
  });

  it("classifies discovered tools and bounds their metadata", async () => {
    const transport = transportFor({
      initialize: { protocolVersion: "2025-06-18" },
      "tools/list": {
        tools: [
          { name: "read_file", description: "Reads a file.", inputSchema: { type: "object" } },
          { name: "delete_file", description: "Deletes a file." },
          { name: "charge_card", description: "Charges a card." },
          { name: "no_schema", title: "x".repeat(500), description: "y".repeat(5_000) },
          { notAName: true },
        ],
      },
    });
    const tools = await discoverTools(transport);
    expect(tools.map(tool => tool.risk)).toEqual(["read", "destructive", "spend", "write"]);
    expect(tools[3].title.length).toBe(200);
    expect(tools[3].description.length).toBe(2_000);
    expect(tools[1].inputSchema).toEqual({});
  });

  it("flattens tool content into plain text and marks non-text blocks", async () => {
    const transport = transportFor({ "tools/call": { content: [{ type: "text", text: "line one" }, { type: "image", data: "..." }, { type: "text", text: "line two" }] } });
    const result = await callTool(transport, "read_file", { path: "a" });
    expect(result.content).toBe("line one\n[image content omitted]\nline two");
    expect(result.isError).toBe(false);
  });

  it("reports a tool error without throwing, so the outcome can be audited", async () => {
    const transport = transportFor({ "tools/call": { content: [{ type: "text", text: "failed" }], isError: true } });
    await expect(callTool(transport, "read_file", {})).resolves.toMatchObject({ isError: true, content: "failed" });
  });

  it("rejects a malformed tool result", async () => {
    const transport = transportFor({ "tools/call": "not an object" });
    await expect(callTool(transport, "read_file", {})).rejects.toThrow(/malformed tool result/);
  });

  it("creates the transport that matches a server's declaration", () => {
    const stdio: McpServerRecord = { serverId: "s", label: "S", transport: "stdio", command: "/usr/bin/mcp", args: [], enabled: true, registeredAt: "now", tools: [], decisions: {} };
    const child = fakeChild();
    expect(createTransport(stdio, { spawnImpl: (() => child) as never })).toBeInstanceOf(StdioMcpTransport);

    const http: McpServerRecord = { serverId: "r", label: "R", transport: "http", endpoint: "https://tools.example.com/mcp", enabled: true, registeredAt: "now", tools: [], decisions: {} };
    expect(createTransport(http, { fetchImpl: vi.fn() as never })).toBeInstanceOf(HttpMcpTransport);

    expect(() => createTransport({ ...stdio, command: undefined }, {})).toThrow(/requires a command/);
    expect(() => createTransport({ ...http, endpoint: undefined }, { fetchImpl: vi.fn() as never })).toThrow(/requires an endpoint/);
  });
});
