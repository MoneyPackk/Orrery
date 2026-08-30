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

  it("registers only list, get, and review handlers and delegates validated values", async () => {
    const handlers = new Map<string, (event: never, value?: unknown) => unknown>();
    const ipcMain = {
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
      handle: vi.fn((channel: string, handler: (event: never, value?: unknown) => unknown) => handlers.set(channel, handler)),
    };
    const host = {
      requestContext: vi.fn(() => ({ reviewAndPromote: vi.fn(async (input) => ({ decision: input.decision })) })),
      list: vi.fn(async () => []),
      getSnapshot: vi.fn(async (input) => ({ id: input.missionId })),
    };

    registerMissionControlHostIpc(ipcMain as never, host as never);
    expect([...handlers.keys()]).toEqual(["mission:v1:list", "mission:v1:get-snapshot", "mission:v1:promote", "mission:v1:host-ready"]);
    await handlers.get("mission:v1:list")!(event("file:///theia/index.html") as never);
    await handlers.get("mission:v1:get-snapshot")!(event("file:///theia/index.html") as never, { missionId: "mission-1" });
    await handlers.get("mission:v1:promote")!(event("file:///theia/index.html") as never, { intentId: "intent-1", missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" });
    await handlers.get("mission:v1:host-ready")!(event("file:///theia/index.html") as never);
    expect(host.list).toHaveBeenCalledOnce();
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
});
