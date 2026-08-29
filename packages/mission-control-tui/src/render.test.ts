import { describe, expect, test, vi } from "vitest";
import type { Mission } from "@orrery/mission-control-domain";
import type { MissionListItem } from "@orrery/mission-control-protocol";
import type { SubscriptionState } from "@orrery/mission-control-client";
import { runTui, type OpenTuiRuntime, type RendererLike } from "./render";

function client(overrides: Record<string, unknown> = {}) {
  return {
    listMissions: vi.fn(async (): Promise<ReadonlyArray<MissionListItem>> => []),
    getMission: vi.fn(async (): Promise<Mission> => { throw new Error("not used"); }),
    subscribe: vi.fn(async () => async () => undefined),
    ...overrides,
  };
}

function harness() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const root = { add: vi.fn() };
  let destroyed = false;
  let touchesAfterDestroy = 0;
  const texts: FakeText[] = [];
  const renderer: RendererLike = {
    width: 80,
    height: 24,
    root,
    on(event, listener) {
      const group = listeners.get(event) ?? new Set();
      group.add(listener);
      listeners.set(event, group);
      return this;
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    destroy: vi.fn(() => { destroyed = true; renderer.isDestroyed = true; }),
  };
  class FakeBox {
    add = vi.fn();
    constructor(_renderer: RendererLike, readonly options: Record<string, unknown>) {}
  }
  class FakeText {
    private value: string;
    constructor(_renderer: RendererLike, options: { content?: string }) {
      this.value = options.content ?? "";
      texts.push(this);
    }
    get content() { return this.value; }
    set content(value: string) { if (destroyed) touchesAfterDestroy += 1; this.value = value; }
  }
  let keyHandler: ((event: { name: string; ctrl?: boolean }) => boolean) | undefined;
  const runtime: OpenTuiRuntime = {
    createCliRenderer: vi.fn(async () => renderer),
    BoxRenderable: FakeBox,
    TextRenderable: FakeText,
    installKeymap: vi.fn(async (_renderer, handler) => {
      keyHandler = handler;
      return () => undefined;
    }),
  };
  return {
    renderer,
    runtime,
    root,
    texts,
    get touchesAfterDestroy() { return touchesAfterDestroy; },
    press(name: string, ctrl = false) { keyHandler?.({ name, ctrl }); },
    emit(event: string, ...args: unknown[]) { for (const listener of listeners.get(event) ?? []) listener(...args); },
  };
}

describe("runTui", () => {
  test("renders a compact gapless terminal layout and refreshes on resize", async () => {
    const ui = harness();
    const api = client();
    const running = runTui(api, { runtime: ui.runtime });
    await vi.waitFor(() => expect(api.listMissions).toHaveBeenCalledTimes(1));

    expect(ui.root.add).toHaveBeenCalledTimes(1);
    const layout = ui.root.add.mock.calls[0][0] as { options: Record<string, unknown> };
    expect(layout.options).toMatchObject({ flexDirection: "column", gap: 0, rowGap: 0 });

    ui.renderer.width = 100;
    ui.emit("resize", 100, 30);
    ui.press("q");
    await running;
    expect(ui.renderer.destroy).toHaveBeenCalledTimes(1);
  });

  test("supports only selection, refresh, inspect, subscribe, and quit actions", async () => {
    const ui = harness();
    const missions: MissionListItem[] = [
      { id: "m-1", title: "One", status: "running", updatedAt: "2026-08-28T10:00:00.000Z" },
      { id: "m-2", title: "Two", status: "queued", updatedAt: "2026-08-28T10:01:00.000Z" },
    ];
    const snapshot: Mission = {
      id: "m-2",
      title: "Two",
      goal: "Observe the daemon",
      mode: "build",
      status: "queued",
      createdAt: "2026-08-28T09:00:00.000Z",
      updatedAt: "2026-08-28T10:01:00.000Z",
      targetBranch: "main",
      plan: {
        id: "plan-2",
        revision: 1,
        approved: true,
        createdAt: "2026-08-28T09:00:00.000Z",
        scope: "Terminal observation",
        actions: ["Inspect"],
        acceptanceCriteria: ["Visible state"],
      },
      events: [],
      changes: [],
      evidence: [],
    };
    const unsubscribe = vi.fn(async () => undefined);
    const api = client({
      listMissions: vi.fn(async () => missions),
      getMission: vi.fn(async () => snapshot),
      subscribe: vi.fn(async () => unsubscribe),
    });
    const running = runTui(api, { runtime: ui.runtime });
    await vi.waitFor(() => expect(api.listMissions).toHaveBeenCalledTimes(1));

    ui.press("down");
    ui.press("i");
    await vi.waitFor(() => expect(api.getMission).toHaveBeenCalledWith("m-2"));
    ui.press("s");
    await vi.waitFor(() => expect(api.subscribe).toHaveBeenCalledWith("m-2", expect.any(Function), expect.any(Function), 0));
    await vi.waitFor(() => expect(ui.texts.some((text) => text.content.includes("[DURABLE]"))).toBe(true));
    ui.press("s");
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    ui.press("r");
    await vi.waitFor(() => expect(api.listMissions).toHaveBeenCalledTimes(2));
    ui.press("q");

    await running;
    expect(ui.renderer.destroy).toHaveBeenCalledTimes(1);
  });

  test("always destroys the renderer when setup fails", async () => {
    const ui = harness();
    ui.runtime.installKeymap = vi.fn(async () => { throw new Error("keymap setup failed"); });

    await expect(runTui(client(), { runtime: ui.runtime })).rejects.toThrow("keymap setup failed");
    expect(ui.renderer.destroy).toHaveBeenCalledTimes(1);
  });

  test("aborts and destroys the renderer exactly once", async () => {
    const ui = harness();
    const controller = new AbortController();
    const running = runTui(client(), { runtime: ui.runtime, signal: controller.signal });
    await vi.waitFor(() => expect(ui.runtime.installKeymap).toHaveBeenCalledTimes(1));

    controller.abort();
    controller.abort();
    await running;

    expect(ui.renderer.destroy).toHaveBeenCalledTimes(1);
  });

  test("refreshes and restores an invalid subscription from the snapshot final sequence", async () => {
    const ui = harness();
    const mission = snapshot("m-1");
    mission.events = [missionEvent(1)];
    const replacementSnapshot = snapshot("m-1");
    replacementSnapshot.events = [missionEvent(1), missionEvent(2), missionEvent(3)];
    const refreshed = deferred<Mission>();
    let reportState: ((state: SubscriptionState) => void) | undefined;
    let replacementListener: ((event: ReturnType<typeof missionEvent>) => void) | undefined;
    const firstUnsubscribe = vi.fn(async () => undefined);
    const secondUnsubscribe = vi.fn(async () => undefined);
    const api = client({
      listMissions: vi.fn(async () => [{ id: "m-1", title: "One", status: "running", updatedAt: mission.updatedAt }]),
      getMission: vi.fn()
        .mockResolvedValueOnce(mission)
        .mockImplementationOnce(() => refreshed.promise),
      subscribe: vi.fn(async (_id: string, listener: (event: ReturnType<typeof missionEvent>) => void, onStateChange: (state: SubscriptionState) => void, afterSequence?: number) => {
        if (reportState) {
          replacementListener = listener;
          expect(afterSequence).toBe(3);
          return secondUnsubscribe;
        }
        reportState = onStateChange;
        return firstUnsubscribe;
      }),
    });
    const running = runTui(api, { runtime: ui.runtime });
    await vi.waitFor(() => expect(api.listMissions).toHaveBeenCalledTimes(1));
    ui.press("i");
    await vi.waitFor(() => expect(api.getMission).toHaveBeenCalledTimes(1));
    ui.press("s");
    await vi.waitFor(() => expect(reportState).toBeDefined());
    await vi.waitFor(() => expect(ui.texts.some((text) => text.content.includes("[DURABLE]"))).toBe(true));

    reportState?.({ status: "invalid", expectedSequence: 2, receivedSequence: 3, reason: "timeout" });
    await vi.waitFor(() => expect(api.getMission).toHaveBeenCalledTimes(2));
    expect(ui.texts.some((text) => text.content.includes("UNKNOWN HISTORY"))).toBe(true);
    refreshed.resolve(replacementSnapshot);
    await vi.waitFor(() => expect(api.subscribe).toHaveBeenCalledTimes(2));
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(ui.texts.every((text) => !text.content.includes("UNKNOWN HISTORY"))).toBe(true));

    replacementListener?.(missionEvent(4));
    await vi.waitFor(() => expect(ui.texts.some((text) => text.content.includes("#4 execution Event 4"))).toBe(true));

    ui.press("q");
    await running;
    expect(secondUnsubscribe).toHaveBeenCalledTimes(1);
  });

  test("does not redraw or touch renderables when an async key operation settles after destroy", async () => {
    const ui = harness();
    const pending = deferred<Mission>();
    const api = client({
      listMissions: vi.fn(async () => [{ id: "m-1", title: "One", status: "running", updatedAt: "2026-08-28T10:00:00.000Z" }]),
      getMission: vi.fn(() => pending.promise),
    });
    const running = runTui(api, { runtime: ui.runtime });
    await vi.waitFor(() => expect(api.listMissions).toHaveBeenCalledTimes(1));

    ui.press("i");
    await vi.waitFor(() => expect(api.getMission).toHaveBeenCalledTimes(1));
    ui.press("q");
    await running;
    pending.resolve(snapshot("m-1"));
    await Promise.resolve();

    expect(ui.touchesAfterDestroy).toBe(0);
    expect(ui.renderer.destroy).toHaveBeenCalledTimes(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function snapshot(id: string): Mission {
  return {
    id, title: "One", goal: "Observe", mode: "build", status: "running",
    createdAt: "2026-08-28T09:00:00.000Z", updatedAt: "2026-08-28T10:00:00.000Z", targetBranch: "main",
    plan: { id: "plan-1", revision: 1, approved: true, createdAt: "2026-08-28T09:00:00.000Z", scope: "Observe", actions: [], acceptanceCriteria: [] },
    events: [], changes: [], evidence: [],
  };
}

function missionEvent(sequence: number) {
  return {
    id: `event-${sequence}`, missionId: "m-1", runId: "run-1", sequence,
    timestamp: `2026-08-28T10:00:0${sequence}.000Z`, kind: "execution" as const,
    title: `Event ${sequence}`, detail: `Sequence ${sequence}`,
  };
}
