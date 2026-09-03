import { describe, expect, it, vi } from "vitest";
import type { OrreryToolsService, OrreryToolsState } from "../common/mission-control-types";
import { ORRERY_TOOLS_WIDGET_ID, OrreryToolsWidget } from "./orrery-tools-widget";

const state = (overrides: Partial<OrreryToolsState> = {}): OrreryToolsState => ({
  servers: [],
  tools: [],
  activity: [],
  ...overrides,
});

function widgetWith(service: Partial<OrreryToolsService>): { widget: OrreryToolsWidget; read: () => OrreryToolsState } {
  class TestWidget extends OrreryToolsWidget {
    protected override update(): void {}
    snapshot(): OrreryToolsState { return this.state; }
  }
  const widget = new TestWidget();
  Object.defineProperty(widget, "service", {
    value: {
      load: vi.fn(async () => state()),
      register: vi.fn(async () => state()),
      remove: vi.fn(async () => state()),
      decide: vi.fn(async () => state()),
      invoke: vi.fn(async () => state()),
      ...service,
    },
  });
  return { widget, read: () => widget.snapshot() };
}

describe("OrreryToolsWidget", () => {
  it("identifies itself and loads the catalog on initialization", async () => {
    const load = vi.fn(async () => state({ servers: [{ serverId: "s1", label: "Files", transport: "stdio", origin: "server.exe", enabled: true, toolCount: 0, registeredAt: "now" }] }));
    const { widget, read } = widgetWith({ load });
    (widget as unknown as { initialize(): void }).initialize();
    await vi.waitFor(() => expect(read().loading).toBe(false));
    expect(widget.id).toBe(ORRERY_TOOLS_WIDGET_ID);
    expect(widget.title.label).toBe("Orrery Tools");
    expect(load).toHaveBeenCalledWith();
    expect(read().servers).toHaveLength(1);
  });

  it("passes a registration through and clears the pending flag", async () => {
    const register = vi.fn(async () => state());
    const { widget, read } = widgetWith({ register });
    const added = await widget.register({ serverId: "s1", label: "Files", transport: "stdio", command: "C:\\tools\\server.exe", args: [] });
    expect(register).toHaveBeenCalledWith({ serverId: "s1", label: "Files", transport: "stdio", command: "C:\\tools\\server.exe", args: [] });
    expect(added).toBe(true);
    expect(read().pending).toBe(false);
    expect(read().error).toBeUndefined();
    expect(read().notice).toBe("Added Files.");
  });

  it("does not report success when the registration fails", async () => {
    const { widget, read } = widgetWith({ register: vi.fn(async () => { throw new Error("You declined."); }) });
    expect(await widget.register({ serverId: "s1", label: "Files", transport: "stdio" })).toBe(false);
    expect(read().notice).toBeUndefined();
    expect(read().error).toBe("You declined.");
  });

  it("warns that a completed action left the catalog stale instead of claiming success", async () => {
    const { widget, read } = widgetWith({ remove: vi.fn(async () => ({ ...state(), stale: true })) });
    await widget.remove("s1");
    expect(read().error).toBeUndefined();
    expect(read().notice).toMatch(/could not be refreshed/);
  });

  it("keeps the last result visible across a later unrelated operation", async () => {
    const lastResult = { serverId: "s1", name: "read_file", risk: "read" as const, content: "body", isError: false, truncated: false, invokedAt: "now", sequence: 1 };
    const { widget, read } = widgetWith({ invoke: vi.fn(async () => ({ ...state(), lastResult })), load: vi.fn(async () => state()) });
    await widget.invoke("s1", "read_file", {});
    expect(read().lastResult?.content).toBe("body");
    await widget.refresh();
    expect(read().lastResult?.content).toBe("body");
  });

  it("reports a declined confirmation without clearing the catalog", async () => {
    const { widget, read } = widgetWith({
      load: vi.fn(async () => state({ tools: [{ serverId: "s1", name: "read_file", title: "Read", description: "", risk: "read", decision: "ask", alwaysAsk: false }] })),
      invoke: vi.fn(async () => { throw new Error("The tool run was not approved."); }),
    });
    await widget.refresh();
    await widget.invoke("s1", "read_file", {});
    expect(read().error).toBe("The tool run was not approved.");
    expect(read().tools).toHaveLength(1);
    expect(read().pending).toBe(false);
  });

  it("reports a fallback message for non-Error failures", async () => {
    const { widget, read } = widgetWith({ load: vi.fn(async () => { throw "boom"; }) });
    await widget.refresh();
    expect(read().error).toBe("Unable to load the tool catalog.");
  });

  it("removes a server and changes a permission", async () => {
    const remove = vi.fn(async () => state());
    const decide = vi.fn(async () => state());
    const { widget } = widgetWith({ remove, decide });
    await widget.remove("s1");
    expect(remove).toHaveBeenCalledWith("s1");
    await widget.decide("s1", "read_file", "allow");
    expect(decide).toHaveBeenCalledWith("s1", "read_file", "allow");
  });

  it("does not run overlapping requests, and says so rather than dropping silently", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const invoke = vi.fn(async () => { await gate; return state(); });
    const { widget, read } = widgetWith({ invoke });
    const first = widget.invoke("s1", "read_file", {});
    await widget.invoke("s1", "read_file", {});
    expect(read().notice).toMatch(/already in flight/);
    release();
    await first;
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps a dropped refresh from erasing state while an operation is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const load = vi.fn(async () => state());
    const { widget, read } = widgetWith({ invoke: vi.fn(async () => { await gate; return state(); }), load });
    const pendingInvoke = widget.invoke("s1", "read_file", {});
    // refresh() must not mutate state before the concurrency guard rejects it.
    await widget.refresh();
    expect(load).not.toHaveBeenCalled();
    expect(read().notice).toMatch(/already in flight/);
    release();
    await pendingInvoke;
  });
});
