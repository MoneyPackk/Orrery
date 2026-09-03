import { describe, expect, it, vi } from "vitest";
import { OrreryToolsDesktopAdapter } from "./orrery-tools-adapter";

const catalog = () => ({
  servers: [{ serverId: "s1", label: "Files", transport: "stdio" as const, origin: "server.exe", enabled: true, toolCount: 1, registeredAt: "now" }],
  tools: [{ serverId: "s1", name: "read_file", title: "Read file", description: "Reads a file.", risk: "read" as const, decision: "ask" as const, alwaysAsk: false }],
});

const activity = () => ({
  entries: [{ sequence: 1, serverId: "s1", name: "read_file", risk: "read" as const, outcome: "allowed" as const, at: "now" }],
});

function withApi(api: Record<string, unknown>): OrreryToolsDesktopAdapter {
  Object.defineProperty(globalThis, "window", { value: { orreryMissionControl: api }, configurable: true, writable: true });
  Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => "intent-fixed" }, configurable: true, writable: true });
  return new OrreryToolsDesktopAdapter();
}

function baseApi(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listMcpCatalog: vi.fn().mockResolvedValue(catalog()),
    listMcpActivity: vi.fn().mockResolvedValue(activity()),
    ...overrides,
  };
}

describe("Orrery Tools desktop adapter", () => {
  it("loads the catalog and the audit log together", async () => {
    const api = baseApi();
    const state = await withApi(api).load();
    expect(api.listMcpCatalog).toHaveBeenCalledWith();
    expect(api.listMcpActivity).toHaveBeenCalledWith();
    expect(state.servers).toHaveLength(1);
    expect(state.tools[0]!.name).toBe("read_file");
    expect(state.activity).toHaveLength(1);
  });

  it("never receives a command, argument vector, or endpoint for a server", async () => {
    const state = await withApi(baseApi()).load();
    expect(JSON.stringify(state)).not.toMatch(/command|endpoint|"args"/);
    expect(state.servers[0]!.origin).toBe("server.exe");
  });

  it("registers a stdio server with a generated intent and reloads", async () => {
    const registerMcpServer = vi.fn().mockResolvedValue(catalog());
    const state = await withApi(baseApi({ registerMcpServer }))
      .register({ serverId: "s1", label: "Files", transport: "stdio", command: "C:\\tools\\server.exe", args: ["--stdio"] });
    expect(registerMcpServer).toHaveBeenCalledWith({ intentId: "intent-fixed", serverId: "s1", label: "Files", transport: "stdio", command: "C:\\tools\\server.exe", args: ["--stdio"] });
    expect(state.servers).toHaveLength(1);
  });

  it("removes a server and changes a permission through the narrow API", async () => {
    const removeMcpServer = vi.fn().mockResolvedValue(catalog());
    const setMcpToolDecision = vi.fn().mockResolvedValue(catalog());
    const adapter = withApi(baseApi({ removeMcpServer, setMcpToolDecision }));
    await adapter.remove("s1");
    expect(removeMcpServer).toHaveBeenCalledWith({ intentId: "intent-fixed", serverId: "s1" });
    await adapter.decide("s1", "read_file", "allow");
    expect(setMcpToolDecision).toHaveBeenCalledWith({ intentId: "intent-fixed", serverId: "s1", name: "read_file", decision: "allow" });
  });

  it("invokes a tool and keeps the result alongside a refreshed audit log", async () => {
    const invokeMcpTool = vi.fn().mockResolvedValue({ serverId: "s1", name: "read_file", risk: "read", content: "file body", isError: false, truncated: false, invokedAt: "now", sequence: 2 });
    const state = await withApi(baseApi({ invokeMcpTool })).invoke("s1", "read_file", { path: "a.txt" });
    expect(invokeMcpTool).toHaveBeenCalledWith({ intentId: "intent-fixed", serverId: "s1", name: "read_file", args: { path: "a.txt" } });
    expect(state.lastResult?.content).toBe("file body");
    expect(state.activity).toHaveLength(1);
  });

  it("surfaces a denied invocation as a rejection rather than a silent success", async () => {
    const invokeMcpTool = vi.fn().mockRejectedValue(new Error("The tool run was not approved."));
    await expect(withApi(baseApi({ invokeMcpTool })).invoke("s1", "read_file", {})).rejects.toThrow(/not approved/);
  });

  it("reports a completed invocation as stale rather than failed when the refresh fails", async () => {
    const invokeMcpTool = vi.fn().mockResolvedValue({ serverId: "s1", name: "delete_file", risk: "destructive", content: "gone", isError: false, truncated: false, invokedAt: "now", sequence: 3 });
    const api = baseApi({ invokeMcpTool, listMcpCatalog: vi.fn().mockRejectedValue(new Error("catalog unreadable")) });
    // The tool already ran, so rejecting here would invite the user to run a destructive effect twice.
    const state = await withApi(api).invoke("s1", "delete_file", {});
    expect(state.lastResult?.content).toBe("gone");
    expect(state.stale).toBe(true);
  });

  it("reports a completed registration as stale rather than failed when the refresh fails", async () => {
    const registerMcpServer = vi.fn().mockResolvedValue(catalog());
    const api = baseApi({ registerMcpServer, listMcpActivity: vi.fn().mockRejectedValue(new Error("activity unreadable")) });
    const state = await withApi(api).register({ serverId: "s1", label: "Files", transport: "stdio", command: "C:\\tools\\server.exe", args: [] });
    expect(registerMcpServer).toHaveBeenCalled();
    expect(state.stale).toBe(true);
  });

  it("still rejects when the load that precedes any effect fails", async () => {
    const api = baseApi({ listMcpCatalog: vi.fn().mockRejectedValue(new Error("catalog unreadable")) });
    await expect(withApi(api).load()).rejects.toThrow(/catalog unreadable/);
  });

  it("fails clearly when the desktop capability is absent", async () => {
    Object.defineProperty(globalThis, "window", { value: {}, configurable: true, writable: true });
    await expect(new OrreryToolsDesktopAdapter().load()).rejects.toThrow(/unavailable/);
  });
});
