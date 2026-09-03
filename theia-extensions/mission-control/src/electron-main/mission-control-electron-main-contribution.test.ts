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
    expect([...handlers.keys()]).toEqual(["mission:v1:intake-repository", "mission:v1:create", "mission:v1:run", "mission:v1:cancel", "mission:v1:list", "mission:v1:get-snapshot", "mission:v1:inspect", "intelligence:v1:get-settings", "intelligence:v1:set-settings", "intelligence:v1:list-messages", "intelligence:v1:clear-thread", "mcp:v1:list-catalog", "mcp:v1:remove-server", "mcp:v1:list-activity", "intelligence:v1:send-message", "mcp:v1:register-server", "mcp:v1:set-decision", "mcp:v1:invoke-tool", "mission:v1:promote", "mission:v1:host-ready"]);
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
    const contextSend = vi.fn(async () => ({ request: {}, reply: {} }));
    const host = {
      requestContext: () => ({ reviewAndPromote: vi.fn(), intakeRepository: vi.fn(), sendIntelligenceMessage: contextSend }),
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
    // Sending goes through the window-bound context, because a tool call it triggers needs a parent window.
    expect(contextSend).toHaveBeenCalledWith({ intentId: "i-2", threadId: "main", text: "hello", missionId: "mission-1" });
    expect(host.sendIntelligenceMessage).not.toHaveBeenCalled();
    expect(host.clearIntelligenceThread).toHaveBeenCalledWith({ intentId: "c-1", threadId: "main" });
  });

  it("delegates validated MCP payloads to the host and binds every consenting operation to the sending window", async () => {
    const handlers = new Map<string, (event: never, ...values: unknown[]) => unknown>();
    const ipcMain = { removeHandler: vi.fn(), handle: (name: string, handler: (event: never, ...values: unknown[]) => unknown) => handlers.set(name, handler) };
    const catalog = { servers: [], tools: [] };
    const context = {
      reviewAndPromote: vi.fn(),
      intakeRepository: vi.fn(),
      registerMcpServer: vi.fn(async () => catalog),
      setMcpToolDecision: vi.fn(async () => catalog),
      invokeMcpTool: vi.fn(async () => ({ serverId: "files", name: "read_file", risk: "read", content: "ok", isError: false, truncated: false, invokedAt: "now", sequence: 1 })),
    };
    const host = {
      requestContext: () => context,
      listMcpCatalog: vi.fn(async () => catalog),
      removeMcpServer: vi.fn(async () => catalog),
      listMcpActivity: vi.fn(async () => ({ entries: [] })),
      registerMcpServer: vi.fn(),
      setMcpToolDecision: vi.fn(),
      invokeMcpTool: vi.fn(),
    };
    registerMissionControlHostIpc(ipcMain as never, host as never);
    const trusted = () => event("file:///theia/index.html") as never;
    await handlers.get("mcp:v1:list-catalog")!(trusted());
    await handlers.get("mcp:v1:list-activity")!(trusted());
    await handlers.get("mcp:v1:register-server")!(trusted(), { intentId: "r-1", serverId: "files", label: "Files", transport: "stdio", command: "/usr/bin/mcp", args: ["--root"] });
    await handlers.get("mcp:v1:register-server")!(trusted(), { intentId: "r-2", serverId: "remote", label: "Remote", transport: "http", endpoint: "https://tools.example.com/mcp" });
    await handlers.get("mcp:v1:remove-server")!(trusted(), { intentId: "x-1", serverId: "files" });
    await handlers.get("mcp:v1:set-decision")!(trusted(), { intentId: "d-1", serverId: "files", name: "read_file", decision: "allow" });
    await handlers.get("mcp:v1:invoke-tool")!(trusted(), { intentId: "i-1", serverId: "files", name: "read_file", args: { path: "a" } });
    expect(host.listMcpCatalog).toHaveBeenCalledTimes(1);
    expect(host.removeMcpServer).toHaveBeenCalledWith({ intentId: "x-1", serverId: "files" });
    // Registration, permission grants, and invocation each show a modal, so all three must
    // travel through the window-bound context rather than the context-free host methods.
    expect(context.registerMcpServer).toHaveBeenCalledWith({ intentId: "r-2", serverId: "remote", label: "Remote", transport: "http", endpoint: "https://tools.example.com/mcp" });
    expect(context.setMcpToolDecision).toHaveBeenCalledWith({ intentId: "d-1", serverId: "files", name: "read_file", decision: "allow" });
    expect(context.invokeMcpTool).toHaveBeenCalledWith({ intentId: "i-1", serverId: "files", name: "read_file", args: { path: "a" } });
    expect(host.registerMcpServer).not.toHaveBeenCalled();
    expect(host.setMcpToolDecision).not.toHaveBeenCalled();
    expect(host.invokeMcpTool).not.toHaveBeenCalled();
  });

  it("refuses an argument graph that would expand enormously under serialization", async () => {
    const handlers = new Map<string, (event: never, ...values: unknown[]) => unknown>();
    const ipcMain = { removeHandler: vi.fn(), handle: (name: string, handler: (event: never, ...values: unknown[]) => unknown) => handlers.set(name, handler) };
    const invokeMcpTool = vi.fn(async () => undefined);
    const host = { requestContext: () => ({ reviewAndPromote: vi.fn(), intakeRepository: vi.fn(), invokeMcpTool, registerMcpServer: vi.fn(), setMcpToolDecision: vi.fn() }) };
    registerMissionControlHostIpc(ipcMain as never, host as never);
    // Structured clone preserves shared references, so a tiny payload can explode when
    // serialized. Each level doubles, giving 2^20 leaves from 20 objects.
    let shared: Record<string, unknown> = { leaf: "x" };
    for (let depth = 0; depth < 20; depth += 1) shared = { a: shared, b: shared };
    await expect(handlers.get("mcp:v1:invoke-tool")!(event("file:///theia/index.html") as never, { intentId: "i", serverId: "s", name: "t", args: shared })).rejects.toThrow("Invalid mission IPC payload");
    expect(invokeMcpTool).not.toHaveBeenCalled();
    // A reasonable nested payload is still accepted.
    await handlers.get("mcp:v1:invoke-tool")!(event("file:///theia/index.html") as never, { intentId: "i", serverId: "s", name: "t", args: { a: { b: { c: "ok" } } } });
    expect(invokeMcpTool).toHaveBeenCalledTimes(1);
  });

  it("refuses every consenting MCP operation from an untrusted frame", async () => {
    const handlers = new Map<string, (event: never, ...values: unknown[]) => unknown>();
    const ipcMain = { removeHandler: vi.fn(), handle: (name: string, handler: (event: never, ...values: unknown[]) => unknown) => handlers.set(name, handler) };
    const host = { requestContext: () => null, invokeMcpTool: vi.fn(), registerMcpServer: vi.fn(), setMcpToolDecision: vi.fn(), listMcpCatalog: vi.fn() };
    registerMissionControlHostIpc(ipcMain as never, host as never);
    const untrusted = () => event("file:///theia/index.html", true) as never;
    await expect(handlers.get("mcp:v1:invoke-tool")!(untrusted(), { intentId: "i", serverId: "s", name: "t", args: {} })).rejects.toThrow(/untrusted/i);
    await expect(handlers.get("mcp:v1:register-server")!(untrusted(), { intentId: "r", serverId: "s", label: "L", transport: "stdio", command: "/usr/bin/x", args: [] })).rejects.toThrow(/untrusted/i);
    await expect(handlers.get("mcp:v1:set-decision")!(untrusted(), { intentId: "d", serverId: "s", name: "t", decision: "allow" })).rejects.toThrow(/untrusted/i);
    await expect(handlers.get("mcp:v1:list-catalog")!(untrusted())).rejects.toThrow(/untrusted/i);
    expect(host.invokeMcpTool).not.toHaveBeenCalled();
    expect(host.registerMcpServer).not.toHaveBeenCalled();
    expect(host.setMcpToolDecision).not.toHaveBeenCalled();
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
    ["mcp:v1:register-server", { intentId: "r", serverId: "__proto__", label: "L", transport: "stdio", command: "/usr/bin/x", args: [] }],
    ["mcp:v1:register-server", { intentId: "r", serverId: "s", label: "L", transport: "ftp", command: "/usr/bin/x", args: [] }],
    ["mcp:v1:register-server", { intentId: "r", serverId: "s", label: "L", transport: "stdio", command: "/usr/bin/x", args: [1] }],
    ["mcp:v1:register-server", { intentId: "r", serverId: "s", label: "L", transport: "stdio", command: "", args: [] }],
    ["mcp:v1:register-server", { intentId: "r", serverId: "s", label: "L", transport: "stdio", command: "/usr/bin/x", args: [], endpoint: "https://e.com" }],
    ["mcp:v1:register-server", { intentId: "r", serverId: "s", label: "L", transport: "http", endpoint: "https://e.com", command: "/usr/bin/x" }],
    ["mcp:v1:register-server", { intentId: "r", serverId: "s", label: "L", transport: "http" }],
    ["mcp:v1:remove-server", { serverId: "files" }],
    ["mcp:v1:remove-server", { intentId: "x", serverId: "../escape" }],
    ["mcp:v1:set-decision", { intentId: "d", serverId: "files", name: "read_file", decision: "maybe" }],
    ["mcp:v1:set-decision", { intentId: "d", serverId: "files", name: "__proto__", decision: "allow" }],
    ["mcp:v1:invoke-tool", { intentId: "i", serverId: "files", name: "read_file" }],
    ["mcp:v1:invoke-tool", { intentId: "i", serverId: "files", name: "read_file", args: "not an object" }],
    ["mcp:v1:invoke-tool", { intentId: "i", serverId: "files", name: "read_file", args: [] }],
    ["mcp:v1:invoke-tool", { intentId: "i", serverId: "__proto__", name: "read_file", args: {} }],
    ["mcp:v1:invoke-tool", { intentId: "i", serverId: "files", name: "read_file", args: {}, extra: 1 }],
  ])("rejects invalid %s payloads", async (channel, value) => {
    const handlers = new Map<string, (event: never, ...values: unknown[]) => unknown>();
    const ipcMain = { removeHandler: vi.fn(), handle: (name: string, handler: (event: never, ...values: unknown[]) => unknown) => handlers.set(name, handler) };
    const host = {
      requestContext: () => ({ reviewAndPromote: vi.fn(), intakeRepository: vi.fn(), invokeMcpTool: vi.fn(), registerMcpServer: vi.fn(), setMcpToolDecision: vi.fn() }),
      setIntelligenceSettings: vi.fn(), listIntelligenceMessages: vi.fn(), sendIntelligenceMessage: vi.fn(), clearIntelligenceThread: vi.fn(),
      registerMcpServer: vi.fn(), removeMcpServer: vi.fn(), setMcpToolDecision: vi.fn(), invokeMcpTool: vi.fn(),
    };
    registerMissionControlHostIpc(ipcMain as never, host as never);
    await expect(handlers.get(channel)!(event("file:///theia/index.html") as never, value)).rejects.toThrow("Invalid mission IPC payload");
    expect(host.setIntelligenceSettings).not.toHaveBeenCalled();
    expect(host.sendIntelligenceMessage).not.toHaveBeenCalled();
    expect(host.registerMcpServer).not.toHaveBeenCalled();
    expect(host.setMcpToolDecision).not.toHaveBeenCalled();
    expect(host.invokeMcpTool).not.toHaveBeenCalled();
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
