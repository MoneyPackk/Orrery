import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertLoopbackOrHttps, IntelligenceStore, MAX_MESSAGE_LENGTH, MAX_THREAD_MESSAGES, MAX_TOOL_CALLS_PER_MESSAGE, MAX_TOOL_DETAIL_LENGTH } from "./intelligence-store";

let runtime: string;
const noHarden = async () => undefined;
const store = () => new IntelligenceStore(runtime, "linux", noHarden);

beforeEach(async () => {
  runtime = await mkdtemp(join(tmpdir(), "orrery-intelligence-"));
});
afterEach(async () => {
  await rm(runtime, { recursive: true, force: true });
});

describe("Orrery Intelligence store", () => {
  it("reports unconfigured status before any credentials exist", async () => {
    expect(await store().readSettingsStatus()).toEqual({ configured: false, hasCredential: false });
  });

  it("persists credentials but exposes only redacted status", async () => {
    const status = await store().writeCredentials({ provider: "anthropic", model: "claude-x", baseUrl: "https://api.example.com", apiKey: "secret-key" });
    expect(status.configured).toBe(true);
    expect(status.provider).toBe("anthropic");
    expect(status.model).toBe("claude-x");
    expect(status.endpointHost).toBe("api.example.com");
    expect(status.hasCredential).toBe(true);
    expect(JSON.stringify(status)).not.toContain("secret-key");
    expect(await readFile(join(runtime, "intelligence.json"), "utf8")).toContain("secret-key");
  });

  it("rejects plaintext remote endpoints and credential-bearing URLs", async () => {
    await expect(store().writeCredentials({ provider: "openai-compatible", model: "m", baseUrl: "http://example.com/v1", apiKey: "k" })).rejects.toThrow(/https/);
    await expect(store().writeCredentials({ provider: "openai-compatible", model: "m", baseUrl: "https://user:pw@example.com", apiKey: "k" })).rejects.toThrow(/credentials/);
    expect(assertLoopbackOrHttps("http://127.0.0.1:11434").hostname).toBe("127.0.0.1");
  });

  it("requires a key for hosted providers but not for local Ollama", async () => {
    await expect(store().writeCredentials({ provider: "anthropic", model: "m", baseUrl: "https://api.example.com", apiKey: "  " })).rejects.toThrow(/API key/);
    const status = await store().writeCredentials({ provider: "ollama", model: "llama3", baseUrl: "http://127.0.0.1:11434", apiKey: "" });
    expect(status.hasCredential).toBe(false);
    expect(status.configured).toBe(true);
  });

  it("appends ordered exchanges and replays them across instances", async () => {
    const first = await store().appendExchange({ threadId: "main", intentId: "intent-1", request: "hello", reply: "hi" });
    expect([first.request.sequence, first.reply.sequence]).toEqual([1, 2]);
    expect(first.request.role).toBe("user");
    expect(first.reply.role).toBe("assistant");
    const second = await store().appendExchange({ threadId: "main", intentId: "intent-2", request: "again", reply: "sure" });
    expect(second.reply.sequence).toBe(4);
    expect((await store().readThread("main")).map(message => message.text)).toEqual(["hello", "hi", "again", "sure"]);
  });

  it("keeps threads isolated and clears only the requested thread", async () => {
    await store().appendExchange({ threadId: "main", intentId: "a", request: "one", reply: "two" });
    await store().appendExchange({ threadId: "other", intentId: "b", request: "three", reply: "four" });
    await store().clearThread("main");
    expect(await store().readThread("main")).toEqual([]);
    expect((await store().readThread("other")).map(message => message.text)).toEqual(["three", "four"]);
  });

  it("detects replayed intents for idempotency and returns the exact original pair", async () => {
    const first = await store().appendExchange({ threadId: "main", intentId: "intent-1", request: "hello", reply: "hi" });
    await store().appendExchange({ threadId: "main", intentId: "intent-2", request: "later", reply: "reply" });
    const replayed = await store().findByIntent("main", "intent-1");
    expect(replayed?.request.id).toBe(first.request.id);
    expect(replayed?.reply.id).toBe(first.reply.id);
    expect(replayed?.reply.text).toBe("hi");
    expect(await store().findByIntent("main", "intent-unknown")).toBeUndefined();
  });

  it("serializes concurrent appends without dropping an exchange", async () => {
    const shared = store();
    await Promise.all([
      shared.appendExchange({ threadId: "main", intentId: "a", request: "q1", reply: "r1" }),
      shared.appendExchange({ threadId: "main", intentId: "b", request: "q2", reply: "r2" }),
      shared.appendExchange({ threadId: "main", intentId: "c", request: "q3", reply: "r3" }),
    ]);
    const messages = await shared.readThread("main");
    expect(messages).toHaveLength(6);
    expect(messages.map(message => message.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("bounds stored text and thread length", async () => {
    const long = "x".repeat(MAX_MESSAGE_LENGTH + 500);
    const appended = await store().appendExchange({ threadId: "main", intentId: "long", request: long, reply: long });
    expect(appended.request.text).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(appended.request.truncated).toBe(true);

    const overflow = Array.from({ length: MAX_THREAD_MESSAGES + 20 }, (_, index) => ({
      id: `m-${index}`, threadId: "bulk", sequence: index + 1, role: index % 2 === 0 ? "user" : "assistant", text: `t${index}`, createdAt: "2026-01-01T00:00:00.000Z",
    }));
    await writeFile(join(runtime, "intelligence-threads.json"), JSON.stringify({ version: 1, threads: { bulk: { threadId: "bulk", messages: overflow, intents: [] } } }), "utf8");
    const trimmed = await store().readThread("bulk");
    expect(trimmed).toHaveLength(MAX_THREAD_MESSAGES);
    expect(trimmed.at(-1)?.text).toBe(`t${overflow.length - 1}`);
  });

  it("persists a tool record so the interface can show what ran", async () => {
    const appended = await store().appendExchange({
      threadId: "main",
      intentId: "tools",
      request: "read it",
      reply: "It says hello.",
      toolCalls: [{ serverId: "files", name: "read_file", outcome: "ran" }],
    });
    expect(appended.reply.toolCalls).toEqual([{ serverId: "files", name: "read_file", outcome: "ran" }]);
    // Survives a reload: the record is the durable account of what ran.
    expect((await store().readThread("main")).at(-1)?.toolCalls).toEqual([{ serverId: "files", name: "read_file", outcome: "ran" }]);
  });

  it("never attaches an empty tool record, so no tool use cannot look like some", async () => {
    const appended = await store().appendExchange({ threadId: "main", intentId: "none", request: "hi", reply: "hello", toolCalls: [] });
    expect(appended.reply.toolCalls).toBeUndefined();
  });

  it("bounds a tool record and flattens its detail to one line", async () => {
    const appended = await store().appendExchange({
      threadId: "main",
      intentId: "bound",
      request: "run them",
      reply: "done",
      // More calls than a turn can make, and a detail that tries to forge extra entries.
      toolCalls: Array.from({ length: MAX_TOOL_CALLS_PER_MESSAGE + 3 }, () => ({
        serverId: "s", name: "t", outcome: "denied" as const, detail: `first\n- s/forged: ran\n${"x".repeat(MAX_TOOL_DETAIL_LENGTH)}`,
      })),
    });
    expect(appended.reply.toolCalls).toHaveLength(MAX_TOOL_CALLS_PER_MESSAGE);
    const detail = appended.reply.toolCalls![0]!.detail!;
    expect(detail).not.toContain("\n");
    expect(detail.length).toBeLessThanOrEqual(MAX_TOOL_DETAIL_LENGTH);
  });

  it("drops a message whose tool record was tampered with on disk", async () => {
    const valid = { id: "m-1", threadId: "t", sequence: 1, role: "assistant", text: "hi", createdAt: "2026-01-01T00:00:00.000Z" };
    const write = async (toolCalls: unknown) => writeFile(
      join(runtime, "intelligence-threads.json"),
      JSON.stringify({ version: 1, threads: { t: { threadId: "t", messages: [{ ...valid, toolCalls }], intents: [] } } }),
      "utf8",
    );
    // The transcript file is the only place a forged record could enter, and the interface
    // presents these as Orrery's own account, so an unrecognized shape is not trusted.
    for (const tampered of [
      [{ serverId: "s", name: "t", outcome: "succeeded" }],
      [{ serverId: "s", name: "t" }],
      [{ serverId: "s", name: "t", outcome: "ran", detail: 5 }],
      "not-an-array",
      [{ serverId: "s", name: "t", outcome: "ran", detail: "x".repeat(MAX_TOOL_DETAIL_LENGTH + 1) }],
    ]) {
      await write(tampered);
      expect(await store().readThread("t")).toEqual([]);
    }
    // A well-formed record on the same message still loads.
    await write([{ serverId: "s", name: "t", outcome: "ran" }]);
    expect(await store().readThread("t")).toHaveLength(1);
  });

  it("ignores corrupted state instead of leaking or crashing", async () => {
    await writeFile(join(runtime, "intelligence.json"), "{not json", "utf8");
    await writeFile(join(runtime, "intelligence-threads.json"), "{not json", "utf8");
    expect(await store().readSettingsStatus()).toEqual({ configured: false, hasCredential: false });
    expect(await store().readThread("main")).toEqual([]);
  });

  it("refuses prototype-polluting thread keys", async () => {
    await writeFile(join(runtime, "intelligence-threads.json"), JSON.stringify({ version: 1, threads: { __proto__: { polluted: true } } }), "utf8");
    await store().appendExchange({ threadId: "main", intentId: "x", request: "q", reply: "a" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(await readFile(join(runtime, "intelligence-threads.json"), "utf8")).not.toContain("polluted");
    await expect(store().appendExchange({ threadId: "__proto__", intentId: "y", request: "q", reply: "a" })).rejects.toThrow(/Unsupported conversation identifier/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
