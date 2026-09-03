import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MissionControlDaemonClient } from "./mission-control-daemon-client";
import { McpPolicyStore } from "./mcp-policy";
import { callTool, createTransport, discoverTools, StdioMcpTransport } from "./mcp-client";
import { MAX_TOOL_CALLS_PER_TURN } from "./intelligence-tools";
import type { IntelligenceToolCall } from "./intelligence-contract";

/**
 * End-to-end verification against a real MCP server process.
 *
 * Everything else exercising this path injects a fake transport, so these are the only
 * tests that prove Orrery's client speaks the actual protocol: a real child process, real
 * newline-delimited JSON-RPC, a real handshake, and real tool results. They exist because
 * a mock can only confirm the assumptions that were written into it.
 */

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/mcp-stdio-server.mjs");
const NODE = process.execPath;

const serverRecord = {
  serverId: "fixture",
  label: "Fixture",
  transport: "stdio" as const,
  command: NODE,
  args: [FIXTURE],
  enabled: true,
  registeredAt: "now",
  tools: [],
  decisions: {},
};

describe("real stdio MCP server", () => {
  it("completes the handshake and lists tools over a real child process", async () => {
    const transport = new StdioMcpTransport(NODE, [FIXTURE]);
    try {
      const tools = await discoverTools(transport);
      expect(tools.map(tool => tool.name)).toContain("read_note");
      expect(tools.find(tool => tool.name === "read_note")?.title).toBe("Read note");
    } finally {
      await transport.close();
    }
  }, 30_000);

  it("classifies risk from the server's own annotations", async () => {
    const transport = new StdioMcpTransport(NODE, [FIXTURE]);
    try {
      const tools = await discoverTools(transport);
      const risk = (name: string) => tools.find(tool => tool.name === name)?.risk;
      expect(risk("read_note")).toBe("read");
      expect(risk("purge_everything")).toBe("destructive");
      expect(risk("reach_out")).toBe("network");
    } finally {
      await transport.close();
    }
  }, 30_000);

  it("sends the initialized notification without expecting a reply to it", async () => {
    const transport = new StdioMcpTransport(NODE, [FIXTURE]);
    try {
      await discoverTools(transport);
      // The fixture reports whether it observed the notification, so a missing or
      // mis-shaped notification is visible rather than silently tolerated.
      const outcome = await callTool(transport, "purge_everything", {});
      expect(outcome.content).toContain("initialized notification seen: true");
    } finally {
      await transport.close();
    }
  }, 30_000);

  it("round-trips tool arguments unchanged", async () => {
    const transport = new StdioMcpTransport(NODE, [FIXTURE]);
    try {
      await discoverTools(transport);
      const outcome = await callTool(transport, "echo_args", { value: "hello", nested: { a: 1 } });
      expect(JSON.parse(outcome.content)).toEqual({ nested: { a: 1 }, value: "hello" });
    } finally {
      await transport.close();
    }
  }, 30_000);

  it("surfaces a tool-level error as isError rather than throwing", async () => {
    const transport = new StdioMcpTransport(NODE, [FIXTURE]);
    try {
      await discoverTools(transport);
      const outcome = await callTool(transport, "fail_loudly", {});
      expect(outcome.isError).toBe(true);
      expect(outcome.content).toContain("the tool failed");
    } finally {
      await transport.close();
    }
  }, 30_000);

  it("omits non-text content instead of leaking raw payloads", async () => {
    const transport = new StdioMcpTransport(NODE, [FIXTURE]);
    try {
      await discoverTools(transport);
      const outcome = await callTool(transport, "binary_blob", {});
      expect(outcome.content).toBe("[image content omitted]");
      expect(outcome.content).not.toContain("AAAA");
    } finally {
      await transport.close();
    }
  }, 30_000);

  it("rejects an unknown tool with the server's JSON-RPC error", async () => {
    const transport = new StdioMcpTransport(NODE, [FIXTURE]);
    try {
      await discoverTools(transport);
      await expect(callTool(transport, "not_a_tool", {})).rejects.toThrow(/Unknown tool/i);
    } finally {
      await transport.close();
    }
  }, 30_000);

  it("builds the same working transport through createTransport", async () => {
    const transport = createTransport(serverRecord, {});
    try {
      expect((await discoverTools(transport)).length).toBeGreaterThan(0);
    } finally {
      await transport.close();
    }
  }, 30_000);
});

describe("real MCP server through the gated invocation path", () => {
  const parent = {} as never;

  async function adapter(options: { confirm?: () => Promise<boolean> } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "orrery-real-mcp-"));
    const confirmToolCall = vi.fn(options.confirm ?? (async () => true));
    const client = new MissionControlDaemonClient({
      createRuntimeDirectory: async () => directory,
      createMcpPolicyStore: (runtime: string) => new McpPolicyStore(runtime, process.platform === "win32" ? "win32" : "linux", async () => undefined),
      confirmToolCall: confirmToolCall as never,
      confirmServerRegistration: (async () => true) as never,
      confirmDecision: (async () => true) as never,
    });
    return { client, confirmToolCall, directory };
  }

  const register = { intentId: "r1", serverId: "fixture", label: "Fixture", transport: "stdio" as const, command: NODE, args: [FIXTURE] };

  it("registers a real server, discovers its tools, and never exposes the command", async () => {
    const { client } = await adapter();
    const catalog = await client.registerMcpServer(register, parent);
    expect(catalog.tools.map(tool => tool.name)).toContain("read_note");
    // `origin` is the executable basename only; the full path stays in main.
    expect(JSON.stringify(catalog)).not.toContain(FIXTURE);
    expect(catalog.servers[0]!.origin).not.toContain("\\");
  }, 60_000);

  it("invokes a real tool after confirmation and audits the result", async () => {
    const { client, confirmToolCall } = await adapter();
    await client.registerMcpServer(register, parent);
    const result = await client.invokeMcpTool({ intentId: "i1", serverId: "fixture", name: "read_note", args: {} }, parent);
    expect(confirmToolCall).toHaveBeenCalledTimes(1);
    expect(result.content).toContain("the note says hello");
    expect(result.isError).toBe(false);
    const activity = await client.listMcpActivity();
    expect(activity.entries.some(entry => entry.name === "read_note" && entry.outcome === "allowed")).toBe(true);
  }, 60_000);

  it("does not run a real tool when the operator declines", async () => {
    const { client } = await adapter({ confirm: async () => false });
    await client.registerMcpServer(register, parent);
    await expect(client.invokeMcpTool({ intentId: "i2", serverId: "fixture", name: "read_note", args: {} }, parent))
      .rejects.toThrow(/cancelled/i);
    const activity = await client.listMcpActivity();
    expect(activity.entries.some(entry => entry.outcome === "denied")).toBe(true);
  }, 60_000);

  it("truncates oversized real output at the documented cap", async () => {
    const { client } = await adapter();
    await client.registerMcpServer(register, parent);
    const result = await client.invokeMcpTool({ intentId: "i3", serverId: "fixture", name: "flood", args: {} }, parent);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(20_000);
  }, 60_000);

  it("refuses a standing allow for a real destructive tool", async () => {
    const { client } = await adapter();
    await client.registerMcpServer(register, parent);
    await expect(client.setMcpToolDecision({ intentId: "d1", serverId: "fixture", name: "purge_everything", decision: "allow" }, parent))
      .rejects.toThrow(/confirmed every time/i);
  }, 60_000);

  it("confirms every call to a real destructive tool", async () => {
    const { client, confirmToolCall } = await adapter();
    await client.registerMcpServer(register, parent);
    for (const intentId of ["p1", "p2"]) {
      await client.invokeMcpTool({ intentId, serverId: "fixture", name: "purge_everything", args: {} }, parent);
    }
    expect(confirmToolCall).toHaveBeenCalledTimes(2);
  }, 60_000);
});

describe("real MCP server driven by the chat tool loop", () => {
  const parent = {} as never;

  function chatStore() {
    const messages: Array<{ id: string; threadId: string; sequence: number; role: "user" | "assistant"; text: string; createdAt: string; toolCalls?: ReadonlyArray<IntelligenceToolCall> }> = [];
    return {
      credentials: { provider: "anthropic" as const, model: "m", baseUrl: "https://api.example.com", apiKey: "k", updatedAt: "now" },
      readSettingsStatus: vi.fn(async () => ({ configured: true, hasCredential: true })),
      readCredentials: vi.fn(async function (this: { credentials?: unknown }) { return this.credentials; }),
      writeCredentials: vi.fn(async () => ({ configured: true, hasCredential: true })),
      readThread: vi.fn(async () => messages),
      findByIntent: vi.fn(async () => undefined),
      clearThread: vi.fn(async () => { messages.length = 0; return messages; }),
      appendExchange: vi.fn(async (input: { threadId: string; intentId: string; request: string; reply: string; toolCalls?: ReadonlyArray<IntelligenceToolCall> }) => {
        const request = { id: `u${messages.length}`, threadId: input.threadId, sequence: messages.length + 1, role: "user" as const, text: input.request, createdAt: "now" };
        const reply = { id: `a${messages.length}`, threadId: input.threadId, sequence: messages.length + 2, role: "assistant" as const, text: input.reply, createdAt: "now", ...(input.toolCalls && input.toolCalls.length > 0 ? { toolCalls: input.toolCalls } : {}) };
        messages.push(request, reply);
        return { request, reply, messages };
      }),
    };
  }

  it("lets the model call a real tool and answer from its real output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orrery-real-loop-"));
    const prompts: string[] = [];
    let declaredName = "";
    let turn = 0;
    const client = new MissionControlDaemonClient({
      createRuntimeDirectory: async () => directory,
      createIntelligenceStore: () => chatStore() as never,
      createMcpPolicyStore: (runtime: string) => new McpPolicyStore(runtime, process.platform === "win32" ? "win32" : "linux", async () => undefined),
      confirmToolCall: (async () => true) as never,
      confirmServerRegistration: (async () => true) as never,
      confirmDecision: (async () => true) as never,
      requestIntelligenceRaw: (async (request: { prompt: string; tools?: ReadonlyArray<{ name: string }> }) => {
        prompts.push(request.prompt);
        if (turn++ === 0) {
          // Ask for whichever name Orrery actually declared for read_note.
          declaredName = request.tools!.find(tool => tool.name.includes("read_note"))!.name;
          return { body: JSON.stringify({ content: [{ type: "tool_use", id: "c1", name: declaredName, input: {} }] }), text: "" };
        }
        return { body: JSON.stringify({ content: [{ type: "text", text: "The note greets you." }] }), text: "The note greets you." };
      }) as never,
    });
    await client.registerMcpServer({ intentId: "r1", serverId: "fixture", label: "Fixture", transport: "stdio", command: NODE, args: [FIXTURE] }, parent);

    const result = await client.sendIntelligenceMessage({ intentId: "s1", threadId: "main", text: "what does the note say?" }, parent);

    // The real server's output reached the model, framed as untrusted data.
    expect(prompts[1]).toContain("the note says hello");
    expect(prompts[1]).toContain("untrusted data");
    expect(result.reply.text).toContain("The note greets you.");
    // Orrery's record names the tool that actually ran, as data beside the model's text.
    expect(result.reply.toolCalls).toEqual([{ serverId: "fixture", name: "read_note", outcome: "ran" }]);
  }, 60_000);

  it("bounds real tool calls to the per-turn budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orrery-real-budget-"));
    const confirmToolCall = vi.fn(async () => true);
    let declared = "";
    const client = new MissionControlDaemonClient({
      createRuntimeDirectory: async () => directory,
      createIntelligenceStore: () => chatStore() as never,
      createMcpPolicyStore: (runtime: string) => new McpPolicyStore(runtime, process.platform === "win32" ? "win32" : "linux", async () => undefined),
      confirmToolCall: confirmToolCall as never,
      confirmServerRegistration: (async () => true) as never,
      confirmDecision: (async () => true) as never,
      // A model that only ever asks for tools; only the budget can stop it.
      requestIntelligenceRaw: (async (request: { tools?: ReadonlyArray<{ name: string }> }) => {
        if (request.tools) declared = request.tools.find(tool => tool.name.includes("read_note"))?.name ?? declared;
        return { body: JSON.stringify({ content: [{ type: "tool_use", id: "c", name: declared, input: {} }] }), text: "" };
      }) as never,
    });
    await client.registerMcpServer({ intentId: "r1", serverId: "fixture", label: "Fixture", transport: "stdio", command: NODE, args: [FIXTURE] }, parent);

    const result = await client.sendIntelligenceMessage({ intentId: "s1", threadId: "main", text: "loop forever" }, parent);
    expect(confirmToolCall).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_TURN);
    expect(result.reply.text).toMatch(/tool call limit/i);
  }, 60_000);
});
