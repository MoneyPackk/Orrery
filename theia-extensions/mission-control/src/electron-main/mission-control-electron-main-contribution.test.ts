import { Container } from "@theia/core/shared/inversify";
import { describe, expect, it, vi } from "vitest";
import { MissionControlHostService } from "../common/mission-control-contracts";
import electronMainModule from "./mission-control-electron-main-module";
import { MissionControlElectronMainContribution, registerMissionControlHostIpc } from "./mission-control-electron-main-contribution";

const frame = (url: string) => ({ url });
const event = (url: string, nested = false, sender = { mainFrame: frame(url) }) => {
  const mainFrame = sender.mainFrame;
  return { sender, senderFrame: nested ? frame(url) : mainFrame };
};

describe("Mission Control Theia Electron main contribution", () => {
  it("refuses composition when the assembled host does not inject its service", () => {
    const container = new Container();
    container.load(electronMainModule);
    expect(() => container.get(MissionControlElectronMainContribution).onStart({} as never)).toThrow(/requires the assembled Theia host to bind MissionControlHostService/);
  });

  it("registers only bounded mission handlers and delegates validated values", async () => {
    const handlers = new Map<string, (event: never, value?: unknown) => unknown>();
    const ipcMain = {
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
      handle: vi.fn((channel: string, handler: (event: never, value?: unknown) => unknown) => handlers.set(channel, handler)),
    };
    const host = {
      requestContext: vi.fn(() => ({ intakeRepository: vi.fn(), reviewAndPromote: vi.fn(async (input) => ({ decision: input.decision })) })),
      create: vi.fn(), run: vi.fn(), cancel: vi.fn(), inspect: vi.fn(),
      list: vi.fn(async () => []),
      getSnapshot: vi.fn(async (input) => ({ id: input.missionId })),
    };

    registerMissionControlHostIpc(ipcMain as never, host as never);
    expect([...handlers.keys()]).toEqual(["mission:v1:intake-repository", "mission:v1:create", "mission:v1:run", "mission:v1:cancel", "mission:v1:list", "mission:v1:get-snapshot", "mission:v1:inspect", "intelligence:v1:get-settings", "intelligence:v1:set-settings", "intelligence:v1:list-messages", "intelligence:v1:send-message", "intelligence:v1:clear-thread", "mission:v1:promote", "mission:v1:host-ready"]);
    await handlers.get("mission:v1:list")!(event("file:///theia/index.html") as never);
    await handlers.get("mission:v1:get-snapshot")!(event("file:///theia/index.html") as never, { missionId: "mission-1" });
    await handlers.get("mission:v1:promote")!(event("file:///theia/index.html") as never, { intentId: "intent-1", missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" });
    await handlers.get("mission:v1:host-ready")!(event("file:///theia/index.html") as never);
    expect(host.list).toHaveBeenCalledTimes(2);
    expect(host.getSnapshot).toHaveBeenCalledWith({ missionId: "mission-1" });
    expect(host.requestContext).toHaveBeenCalledWith(expect.anything(), expect.anything());
  });

  it("rejects a same-URL WebContents that is not the tracked renderer", async () => {
    const handlers = new Map<string, (event: never) => unknown>();
    const ipcMain = { removeHandler: vi.fn(), handle: (channel: string, handler: (event: never) => unknown) => handlers.set(channel, handler) };
    const trustedSender = { mainFrame: frame("file:///theia/index.html") };
    const host = { requestContext: (sender: unknown) => sender === trustedSender ? {} : null, list: vi.fn(), getSnapshot: vi.fn() };
    registerMissionControlHostIpc(ipcMain as never, host as never);
    await expect(handlers.get("mission:v1:list")!(event("file:///theia/index.html") as never)).rejects.toThrow(/untrusted/i);
    expect(host.list).not.toHaveBeenCalled();
  });

  it.each([
    ["an untrusted URL", event("https://attacker.invalid"), undefined],
    ["a nested frame", event("file:///theia/index.html", true), undefined],
    ["extra snapshot keys", event("file:///theia/index.html"), { missionId: "mission-1", path: "C:/repo" }],
    ["invalid review decisions", event("file:///theia/index.html"), { intentId: "intent-1", missionId: "mission-1", planRevisionId: "plan-1", decision: "revision_requested" }],
  ])("rejects %s", async (_name, ipcEvent, value) => {
    const handlers = new Map<string, (event: never, value?: unknown) => unknown>();
    const ipcMain = { removeHandler: vi.fn(), handle: (channel: string, handler: (event: never, value?: unknown) => unknown) => handlers.set(channel, handler) };
    const host = { requestContext: (_sender: unknown, senderFrame: { url: string }) => senderFrame.url === "file:///theia/index.html" && ipcEvent.senderFrame === ipcEvent.sender.mainFrame ? { reviewAndPromote: vi.fn() } : null, list: vi.fn(), getSnapshot: vi.fn() };
    registerMissionControlHostIpc(ipcMain as never, host as never);
    const channel = value && "decision" in value ? "mission:v1:promote" : value ? "mission:v1:get-snapshot" : "mission:v1:list";
    await expect(handlers.get(channel)!(ipcEvent as never, value)).rejects.toThrow(/Rejected untrusted|Invalid mission IPC payload/);
    expect(host.list).not.toHaveBeenCalled();
    expect(host.getSnapshot).not.toHaveBeenCalled();
  });

  it("rejects unexpected list payloads", async () => {
    const handlers = new Map<string, (event: never, value?: unknown) => unknown>();
    const ipcMain = { removeHandler: vi.fn(), handle: (channel: string, handler: (event: never, value?: unknown) => unknown) => handlers.set(channel, handler) };
    const host = { requestContext: () => ({ reviewAndPromote: vi.fn() }), list: vi.fn(), getSnapshot: vi.fn() };
    registerMissionControlHostIpc(ipcMain as never, host as never);
    await expect(handlers.get("mission:v1:list")!(event("file:///theia/index.html") as never, {})).rejects.toThrow("Invalid mission IPC payload");
    expect(host.list).not.toHaveBeenCalled();
  });

  it.each([
    ["mission:v1:get-snapshot", { missionId: "mission-1" }],
    ["mission:v1:promote", { intentId: "intent-1", missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" }],
  ])("rejects trailing arguments on %s", async (channel, value) => {
    const handlers = new Map<string, (event: never, ...values: unknown[]) => unknown>();
    const ipcMain = { removeHandler: vi.fn(), handle: (name: string, handler: (event: never, ...values: unknown[]) => unknown) => handlers.set(name, handler) };
    const host = { requestContext: () => ({ reviewAndPromote: vi.fn() }), list: vi.fn(), getSnapshot: vi.fn() };
    registerMissionControlHostIpc(ipcMain as never, host as never);
    await expect(handlers.get(channel)!(event("file:///theia/index.html") as never, value, "trailing")).rejects.toThrow("Invalid mission IPC payload");
    expect(host.getSnapshot).not.toHaveBeenCalled();
  });

  it("delegates validated Orrery Intelligence payloads to the host", async () => {
    const handlers = new Map<string, (event: never, ...values: unknown[]) => unknown>();
    const ipcMain = { removeHandler: vi.fn(), handle: (name: string, handler: (event: never, ...values: unknown[]) => unknown) => handlers.set(name, handler) };
    const host = {
      requestContext: () => ({ reviewAndPromote: vi.fn(), intakeRepository: vi.fn() }),
      getIntelligenceSettings: vi.fn(async () => ({ configured: false, hasCredential: false })),
      setIntelligenceSettings: vi.fn(async () => ({ configured: true, hasCredential: true })),
      listIntelligenceMessages: vi.fn(async () => ({ threadId: "main", messages: [], settings: { configured: true, hasCredential: true } })),
      sendIntelligenceMessage: vi.fn(async () => ({ request: {}, reply: {} })),
      clearIntelligenceThread: vi.fn(async () => ({ threadId: "main", messages: [], settings: { configured: true, hasCredential: true } })),
    };
    registerMissionControlHostIpc(ipcMain as never, host as never);
    const trusted = () => event("file:///theia/index.html") as never;
    await handlers.get("intelligence:v1:get-settings")!(trusted());
    await handlers.get("intelligence:v1:set-settings")!(trusted(), { intentId: "s-1", provider: "anthropic", model: "claude-x", baseUrl: "https://api.example.com", apiKey: "key" });
    await handlers.get("intelligence:v1:list-messages")!(trusted(), { threadId: "main" });
    await handlers.get("intelligence:v1:send-message")!(trusted(), { intentId: "i-1", threadId: "main", text: "hello" });
    await handlers.get("intelligence:v1:send-message")!(trusted(), { intentId: "i-2", threadId: "main", text: "hello", missionId: "mission-1" });
    await handlers.get("intelligence:v1:clear-thread")!(trusted(), { intentId: "c-1", threadId: "main" });
    expect(host.getIntelligenceSettings).toHaveBeenCalledTimes(1);
    expect(host.setIntelligenceSettings).toHaveBeenCalledWith({ intentId: "s-1", provider: "anthropic", model: "claude-x", baseUrl: "https://api.example.com", apiKey: "key" });
    expect(host.sendIntelligenceMessage).toHaveBeenCalledWith({ intentId: "i-2", threadId: "main", text: "hello", missionId: "mission-1" });
    expect(host.clearIntelligenceThread).toHaveBeenCalledWith({ intentId: "c-1", threadId: "main" });
  });

  it.each([
    ["intelligence:v1:set-settings", { intentId: "s", provider: "unknown-provider", model: "m", baseUrl: "https://api.example.com", apiKey: "k" }],
    ["intelligence:v1:set-settings", { intentId: "s", provider: "anthropic", model: "m", baseUrl: "https://api.example.com", apiKey: "x".repeat(5000) }],
    ["intelligence:v1:set-settings", { intentId: "s", provider: "anthropic", model: "m", baseUrl: "https://api.example.com", apiKey: "k", extra: true }],
    ["intelligence:v1:send-message", { intentId: "i", threadId: "main", text: "" }],
    ["intelligence:v1:send-message", { intentId: "i", threadId: "main", text: "x".repeat(9000) }],
    ["intelligence:v1:send-message", { intentId: "i", threadId: "main", text: "hi", missionId: "" }],
    ["intelligence:v1:send-message", { intentId: "i", threadId: "main", text: "hi", unexpected: 1 }],
    ["intelligence:v1:list-messages", { threadId: "" }],
    ["intelligence:v1:list-messages", { threadId: "__proto__" }],
    ["intelligence:v1:list-messages", { threadId: "constructor" }],
    ["intelligence:v1:list-messages", { threadId: "prototype" }],
    ["intelligence:v1:send-message", { intentId: "i", threadId: "__proto__", text: "hi" }],
    ["intelligence:v1:clear-thread", { intentId: "c", threadId: "__proto__" }],
    ["intelligence:v1:clear-thread", { threadId: "main" }],
  ])("rejects invalid %s payloads", async (channel, value) => {
    const handlers = new Map<string, (event: never, ...values: unknown[]) => unknown>();
    const ipcMain = { removeHandler: vi.fn(), handle: (name: string, handler: (event: never, ...values: unknown[]) => unknown) => handlers.set(name, handler) };
    const host = {
      requestContext: () => ({ reviewAndPromote: vi.fn(), intakeRepository: vi.fn() }),
      setIntelligenceSettings: vi.fn(), listIntelligenceMessages: vi.fn(), sendIntelligenceMessage: vi.fn(), clearIntelligenceThread: vi.fn(),
    };
    registerMissionControlHostIpc(ipcMain as never, host as never);
    await expect(handlers.get(channel)!(event("file:///theia/index.html") as never, value)).rejects.toThrow("Invalid mission IPC payload");
    expect(host.setIntelligenceSettings).not.toHaveBeenCalled();
    expect(host.sendIntelligenceMessage).not.toHaveBeenCalled();
    expect(host.listIntelligenceMessages).not.toHaveBeenCalled();
    expect(host.clearIntelligenceThread).not.toHaveBeenCalled();
  });

  it("refuses Orrery Intelligence requests from untrusted frames", async () => {
    const handlers = new Map<string, (event: never, ...values: unknown[]) => unknown>();
    const ipcMain = { removeHandler: vi.fn(), handle: (name: string, handler: (event: never, ...values: unknown[]) => unknown) => handlers.set(name, handler) };
    const host = { requestContext: () => null, getIntelligenceSettings: vi.fn(), sendIntelligenceMessage: vi.fn() };
    registerMissionControlHostIpc(ipcMain as never, host as never);
    await expect(handlers.get("intelligence:v1:get-settings")!(event("https://attacker.invalid") as never)).rejects.toThrow(/untrusted/i);
    await expect(handlers.get("intelligence:v1:send-message")!(event("file:///theia/index.html", true) as never, { intentId: "i", threadId: "main", text: "hi" })).rejects.toThrow(/untrusted/i);
    expect(host.getIntelligenceSettings).not.toHaveBeenCalled();
    expect(host.sendIntelligenceMessage).not.toHaveBeenCalled();
  });
});
