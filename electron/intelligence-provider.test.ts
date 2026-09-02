import { describe, expect, it, vi } from "vitest";
import { ORRERY_SYSTEM_PROMPT, requestIntelligenceReply, type FetchLike } from "./intelligence-provider";
import type { IntelligenceCredentials } from "./intelligence-store";

const credentials = (overrides: Partial<IntelligenceCredentials> = {}): IntelligenceCredentials => ({
  provider: "openai-compatible",
  model: "gpt-test",
  baseUrl: "https://api.example.com/v1",
  apiKey: "user-key",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const respond = (body: unknown, ok = true, status = 200): FetchLike => vi.fn(async () => ({ ok, status, headers: { get: () => null }, text: async () => JSON.stringify(body) }));

describe("Orrery Intelligence BYOK provider", () => {
  it("calls an OpenAI-compatible endpoint with the user's bearer key and brand system prompt", async () => {
    const fetchImpl = respond({ choices: [{ message: { content: "answer" } }] });
    const reply = await requestIntelligenceReply({ credentials: credentials(), history: [{ role: "user", text: "old" }, { role: "assistant", text: "prev" }], prompt: "new question" }, fetchImpl);
    expect(reply).toBe("answer");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer user-key");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("gpt-test");
    expect(body.messages[0]).toEqual({ role: "system", content: ORRERY_SYSTEM_PROMPT });
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "new question" });
  });

  it("uses Anthropic headers, system field, and text blocks", async () => {
    const fetchImpl = respond({ content: [{ type: "text", text: "claude reply" }] });
    const reply = await requestIntelligenceReply({ credentials: credentials({ provider: "anthropic", baseUrl: "https://api.anthropic.com" }), history: [], prompt: "hi" }, fetchImpl);
    expect(reply).toBe("claude reply");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("user-key");
    expect(init.headers.authorization).toBeUndefined();
    expect(JSON.parse(init.body).system).toBe(ORRERY_SYSTEM_PROMPT);
  });

  it("supports local Ollama without an authorization header", async () => {
    const fetchImpl = respond({ message: { content: "local reply" } });
    const reply = await requestIntelligenceReply({ credentials: credentials({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", apiKey: "" }), history: [], prompt: "hi" }, fetchImpl);
    expect(reply).toBe("local reply");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    expect(init.headers.authorization).toBeUndefined();
    expect(JSON.parse(init.body).stream).toBe(false);
  });

  it("bounds history sent to the provider", async () => {
    const fetchImpl = respond({ choices: [{ message: { content: "ok" } }] });
    const history = Array.from({ length: 60 }, (_, index) => ({ role: index % 2 === 0 ? "user" as const : "assistant" as const, text: `m${index}` }));
    await requestIntelligenceReply({ credentials: credentials(), history, prompt: "last" }, fetchImpl);
    const body = JSON.parse((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.messages.length).toBeLessThanOrEqual(22);
  });

  it("fails clearly on error status, malformed payloads, and empty replies", async () => {
    await expect(requestIntelligenceReply({ credentials: credentials(), history: [], prompt: "x" }, respond({}, false, 401))).rejects.toThrow(/status 401/);
    await expect(requestIntelligenceReply({ credentials: credentials(), history: [], prompt: "x" }, vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => "not json" })) as unknown as FetchLike)).rejects.toThrow(/malformed/);
    await expect(requestIntelligenceReply({ credentials: credentials(), history: [], prompt: "x" }, respond({ choices: [{ message: { content: "   " } }] }))).rejects.toThrow(/empty/);
  });

  it("refuses plaintext remote endpoints before sending the key", async () => {
    const fetchImpl = respond({ choices: [{ message: { content: "ok" } }] });
    await expect(requestIntelligenceReply({ credentials: credentials({ baseUrl: "http://evil.example.com" }), history: [], prompt: "x" }, fetchImpl)).rejects.toThrow(/https/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aborts requests through a signal so shutdown cannot hang", async () => {
    let captured: AbortSignal | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      captured = init.signal;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
    };
    await requestIntelligenceReply({ credentials: credentials(), history: [], prompt: "x" }, fetchImpl);
    expect(captured).toBeInstanceOf(AbortSignal);
  });

  it("never follows redirects so credential headers cannot be replayed to another host", async () => {
    const redirect: FetchLike = vi.fn(async () => ({ ok: false, status: 302, headers: { get: () => "https://attacker.invalid/v1" }, text: async () => "" }));
    await expect(requestIntelligenceReply({ credentials: credentials({ provider: "anthropic" }), history: [], prompt: "x" }, redirect)).rejects.toThrow(/redirect/i);
    const [, init] = (redirect as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.redirect).toBe("manual");
  });

  it("rejects an oversized declared response before buffering the body", async () => {
    const text = vi.fn(async () => "{}");
    const huge: FetchLike = async () => ({ ok: true, status: 200, headers: { get: (name: string) => (name === "content-length" ? "99999999" : null) }, text });
    await expect(requestIntelligenceReply({ credentials: credentials(), history: [], prompt: "x" }, huge)).rejects.toThrow(/supported size/);
    expect(text).not.toHaveBeenCalled();
  });
});
