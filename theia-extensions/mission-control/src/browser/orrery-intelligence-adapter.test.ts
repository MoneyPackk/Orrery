import { describe, expect, it, vi } from "vitest";
import { OrreryIntelligenceDesktopAdapter } from "./orrery-intelligence-adapter";

const transcript = (messages: ReadonlyArray<{ text: string; role: "user" | "assistant" }> = []) => ({
  threadId: "main",
  messages: messages.map((message, index) => ({ id: `m-${index}`, threadId: "main", sequence: index + 1, role: message.role, text: message.text, createdAt: "now" })),
  settings: { configured: true, hasCredential: true, provider: "anthropic" as const, model: "claude-x", endpointHost: "api.example.com" },
});

function withApi(api: Record<string, unknown>): OrreryIntelligenceDesktopAdapter {
  Object.defineProperty(globalThis, "window", { value: { orreryMissionControl: api }, configurable: true, writable: true });
  Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => "intent-fixed" }, configurable: true, writable: true });
  return new OrreryIntelligenceDesktopAdapter();
}

describe("Orrery Intelligence desktop adapter", () => {
  it("loads the transcript and redacted settings", async () => {
    const listIntelligenceMessages = vi.fn().mockResolvedValue(transcript([{ role: "user", text: "hi" }]));
    const state = await withApi({ listIntelligenceMessages }).load("main");
    expect(listIntelligenceMessages).toHaveBeenCalledWith({ threadId: "main" });
    expect(state.messages).toHaveLength(1);
    expect(state.settings.model).toBe("claude-x");
    expect(JSON.stringify(state)).not.toMatch(/apiKey|baseUrl/);
  });

  it("sends with a generated intent and reloads the thread", async () => {
    const sendIntelligenceMessage = vi.fn().mockResolvedValue({});
    const listIntelligenceMessages = vi.fn().mockResolvedValue(transcript([{ role: "user", text: "q" }, { role: "assistant", text: "a" }]));
    const state = await withApi({ sendIntelligenceMessage, listIntelligenceMessages }).send("main", "q", "mission-1");
    expect(sendIntelligenceMessage).toHaveBeenCalledWith({ intentId: "intent-fixed", threadId: "main", text: "q", missionId: "mission-1" });
    expect(state.messages.map(message => message.text)).toEqual(["q", "a"]);
  });

  it("omits missionId when no mission is selected", async () => {
    const sendIntelligenceMessage = vi.fn().mockResolvedValue({});
    await withApi({ sendIntelligenceMessage, listIntelligenceMessages: vi.fn().mockResolvedValue(transcript()) }).send("main", "q");
    expect(sendIntelligenceMessage).toHaveBeenCalledWith({ intentId: "intent-fixed", threadId: "main", text: "q" });
  });

  it("clears and configures through the narrow API", async () => {
    const clearIntelligenceThread = vi.fn().mockResolvedValue(transcript());
    const setIntelligenceSettings = vi.fn().mockResolvedValue({});
    const listIntelligenceMessages = vi.fn().mockResolvedValue(transcript());
    const adapter = withApi({ clearIntelligenceThread, setIntelligenceSettings, listIntelligenceMessages });
    expect((await adapter.clear("main")).messages).toEqual([]);
    expect(clearIntelligenceThread).toHaveBeenCalledWith({ intentId: "intent-fixed", threadId: "main" });
    await adapter.configure({ provider: "anthropic", model: "claude-x", baseUrl: "https://api.example.com", apiKey: "key" });
    expect(setIntelligenceSettings).toHaveBeenCalledWith({ intentId: "intent-fixed", provider: "anthropic", model: "claude-x", baseUrl: "https://api.example.com", apiKey: "key" });
  });

  it("fails clearly when the desktop capability is absent", async () => {
    Object.defineProperty(globalThis, "window", { value: {}, configurable: true, writable: true });
    await expect(new OrreryIntelligenceDesktopAdapter().load("main")).rejects.toThrow(/unavailable/);
  });
});
