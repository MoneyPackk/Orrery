import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MissionProvider,
  STORAGE_KEY,
  useMissions,
} from "./mission-context";
import { createMission } from "../domain/mission";

const wrapper = ({ children }: { children: ReactNode }) => (
  <MissionProvider runtimeDelay={0}>{children}</MissionProvider>
);

const createInput = {
  title: "Refine source control",
  goal: "Make changed files easier to inspect",
  mode: "build" as const,
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("MissionProvider", () => {
  it("rejects duplicate mission IDs and invalid enum values", () => {
    const mission = createMission({ ...createInput, plan: { scope: "Scope", actions: ["Act"], acceptanceCriteria: ["Prove"] } });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, missions: [mission, mission] }));
    const duplicate = renderHook(() => useMissions(), { wrapper });
    expect(duplicate.result.current.storageError).toMatch(/invalid|duplicate/i);
    duplicate.unmount();

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, missions: [{ ...mission, status: "invented" }] }));
    const invalidEnum = renderHook(() => useMissions(), { wrapper });
    expect(invalidEnum.result.current.storageError).toMatch(/invalid/i);
  });

  it("rejects oversized persistence before parsing", () => {
    window.localStorage.setItem(STORAGE_KEY, " ".repeat(1_000_001));
    const parse = vi.spyOn(JSON, "parse");
    const { result } = renderHook(() => useMissions(), { wrapper });
    expect(result.current.storageError).toMatch(/large|size/i);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it.each(["running", "paused", "blocked"] as const)("normalizes reloaded %s work to recoverable blocked state", (status) => {
    const mission = createMission({ ...createInput, plan: { scope: "Scope", actions: ["Act"], acceptanceCriteria: ["Prove"] } });
    const active = {
      ...mission,
      status,
      plan: { ...mission.plan, approved: true },
      activeRunId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, missions: [active] }));
    const { result } = renderHook(() => useMissions(), { wrapper });
    expect(result.current.missions[0].status).toBe("blocked");
    expect(result.current.missions[0].activeRunId).toBeUndefined();
    expect(result.current.missions[0].events.at(-1)?.kind).toBe("interruption");
  });

  it("keeps interrupted recovery idempotent across repeated reloads", () => {
    const mission = createMission({ ...createInput, plan: { scope: "Scope", actions: ["Act"], acceptanceCriteria: ["Prove"] } });
    const active = {
      ...mission,
      status: "blocked" as const,
      plan: { ...mission.plan, approved: true },
      activeRunId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, missions: [active] }));
    const first = renderHook(() => useMissions(), { wrapper });
    const firstEvents = first.result.current.missions[0].events;
    first.unmount();

    const second = renderHook(() => useMissions(), { wrapper });

    expect(second.result.current.storageError).toBeUndefined();
    expect(second.result.current.missions[0].status).toBe("blocked");
    expect(second.result.current.missions[0].activeRunId).toBeUndefined();
    expect(second.result.current.missions[0].events).toEqual(firstEvents);
  });

  it.each(["queued", "running", "paused", "blocked"] as const)("rejects persisted %s work without an approved plan", (status) => {
    const mission = createMission({ ...createInput, plan: { scope: "Scope", actions: ["Act"], acceptanceCriteria: ["Prove"] } });
    const invalid = {
      ...mission,
      status,
      activeRunId: ["running", "paused", "blocked"].includes(status) ? crypto.randomUUID() : undefined,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, missions: [invalid] }));

    const { result } = renderHook(() => useMissions(), { wrapper });

    expect(result.current.missions).toEqual([]);
    expect(result.current.storageError).toMatch(/invalid|approved/i);
  });

  it("creates, edits, approves, and persists a mission", async () => {
    const { result } = renderHook(() => useMissions(), { wrapper });

    act(() => result.current.create(createInput));
    const missionId = result.current.missions[0].id;
    act(() =>
      result.current.updatePlan(missionId, {
        scope: "Implement a compact changed-file index.",
        actions: ["Add file navigator", "Connect selection"],
        acceptanceCriteria: ["Changed files are keyboard accessible"],
      }),
    );
    act(() => result.current.approvePlan(missionId));

    expect(result.current.missions[0].status).toBe("queued");
    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(persisted.version).toBe(1);
    expect(persisted.missions[0].title).toBe("Refine source control");
  });

  it("restores versioned mission state after remount", () => {
    const first = renderHook(() => useMissions(), { wrapper });
    act(() => first.result.current.create(createInput));
    first.unmount();

    const second = renderHook(() => useMissions(), { wrapper });

    expect(second.result.current.missions).toHaveLength(1);
    expect(second.result.current.missions[0].goal).toBe(
      "Make changed files easier to inspect",
    );
  });

  it("translates the fixture run into events, changes, evidence, and review readiness", async () => {
    const { result } = renderHook(() => useMissions(), { wrapper });
    act(() => result.current.create(createInput));
    const missionId = result.current.missions[0].id;
    act(() =>
      result.current.updatePlan(missionId, {
        scope: "Implement fixture behavior.",
        actions: ["Run deterministic fixture"],
        acceptanceCriteria: ["The delegated change is covered by passing tests"],
      }),
    );
    act(() => result.current.approvePlan(missionId));
    act(() => {
      void result.current.start(missionId);
    });

    await waitFor(() => {
      expect(
        result.current.missions[0].events.some(
          (event) => event.kind === "capability_request",
        ),
      ).toBe(true);
    });
    const request = result.current.missions[0].events.find((event) => event.capability)?.capability!;
    act(() => result.current.resolveCapability(missionId, request.runId, request.requestId, "denied"));

    await waitFor(() => expect(result.current.missions[0].status).toBe("ready_for_review"));
    expect(result.current.missions[0].changes).toHaveLength(1);
    expect(result.current.missions[0].evidence[0].status).toBe("passed");
    expect(result.current.missions[0].events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(result.current.missions[0].events.map((event) => event.kind)).toEqual([
      "workspace",
      "context",
      "execution",
      "capability_request",
      "fallback",
      "change",
      "verification",
      "verification",
      "completion",
    ]);
  });

  it("registers runs atomically and makes duplicate starts a safe no-op", async () => {
    const { result } = renderHook(() => useMissions(), { wrapper });
    act(() => result.current.create(createInput));
    const missionId = result.current.missions[0].id;
    act(() =>
      result.current.updatePlan(missionId, {
        scope: "Implement fixture behavior.",
        actions: ["Run deterministic fixture"],
        acceptanceCriteria: ["The delegated change is covered by passing tests"],
      }),
    );
    act(() => result.current.approvePlan(missionId));

    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      first = result.current.start(missionId);
      duplicate = result.current.start(missionId);
    });
    await expect(duplicate).resolves.toBeUndefined();
    await waitFor(() =>
      expect(result.current.missions[0].events.some((event) => event.kind === "capability_request")).toBe(true),
    );
    expect(new Set(result.current.missions[0].events.map((event) => event.runId))).toHaveLength(1);
    act(() => result.current.cancel(missionId));
    await expect(first).resolves.toBeUndefined();
  });

  it("cancels an active run without failure and discards late signals", async () => {
    const { result } = renderHook(() => useMissions(), { wrapper });
    act(() => result.current.create(createInput));
    const missionId = result.current.missions[0].id;
    act(() =>
      result.current.updatePlan(missionId, {
        scope: "Implement fixture behavior.",
        actions: ["Run deterministic fixture"],
        acceptanceCriteria: ["The delegated change is covered by passing tests"],
      }),
    );
    act(() => result.current.approvePlan(missionId));
    let running!: Promise<void>;
    act(() => { running = result.current.start(missionId); });
    await waitFor(() => expect(result.current.missions[0].status).toBe("running"));
    act(() => result.current.cancel(missionId));
    await expect(running).resolves.toBeUndefined();

    expect(result.current.missions[0].status).toBe("cancelled");
    expect(result.current.runtimeError).toBeUndefined();
    const eventCount = result.current.missions[0].events.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.missions[0].events).toHaveLength(eventCount);
  });

  it("handles start and cancel in the same act without stranding running state", async () => {
    const { result } = renderHook(() => useMissions(), { wrapper });
    act(() => result.current.create({ ...createInput, plan: { scope: "Scope", actions: ["Act"], acceptanceCriteria: ["Prove"] } }));
    const missionId = result.current.missions[0].id;
    act(() => result.current.approvePlan(missionId));
    let running!: Promise<void>;
    act(() => {
      running = result.current.start(missionId);
      result.current.cancel(missionId);
    });
    await running;
    await waitFor(() => expect(result.current.missions[0].status).toBe("cancelled"));
    expect(result.current.missions[0].activeRunId).toBeUndefined();
    expect(result.current.missions[0].events.at(-1)?.kind).toBe("cancellation");
  });

  it("uses an opaque workspace handle unrelated to persisted mission text", async () => {
    const { result } = renderHook(() => useMissions(), { wrapper });
    act(() => result.current.create({ ...createInput, plan: { scope: "Scope", actions: ["Act"], acceptanceCriteria: ["Prove"] } }));
    const missionId = result.current.missions[0].id;
    act(() => result.current.approvePlan(missionId));
    act(() => { void result.current.start(missionId); });
    await waitFor(() => expect(result.current.missions[0].workspaceId).toBeDefined());
    expect(result.current.missions[0].workspaceId).toMatch(/^fixture-workspace-[0-9a-f-]{36}$/i);
    expect(result.current.missions[0].workspaceId).not.toContain(missionId);
    act(() => result.current.cancel(missionId));
  });

  it("cancels immediately after start before React rerenders", async () => {
    const { result } = renderHook(() => useMissions(), { wrapper });
    act(() => result.current.create(createInput));
    const missionId = result.current.missions[0].id;
    act(() => result.current.updatePlan(missionId, {
      scope: "Exercise cancellation.", actions: ["Start"], acceptanceCriteria: ["Stops safely"],
    }));
    act(() => result.current.approvePlan(missionId));

    let running!: Promise<void>;
    act(() => {
      running = result.current.start(missionId);
      result.current.cancel(missionId);
    });
    await running;

    await waitFor(() => expect(result.current.missions[0].status).toBe("cancelled"));
    expect(result.current.missions[0].events.at(-1)?.kind).toBe("cancellation");
    expect(result.current.runtimeError).toBeUndefined();
  });

  it("keeps the durable event sequence contiguous across revision runs", async () => {
    const { result } = renderHook(() => useMissions(), { wrapper });
    act(() => result.current.create(createInput));
    const missionId = result.current.missions[0].id;
    act(() => result.current.updatePlan(missionId, {
      scope: "Implement fixture behavior.",
      actions: ["Run deterministic fixture"],
      acceptanceCriteria: ["The delegated change is covered by passing tests"],
    }));
    act(() => result.current.approvePlan(missionId));

    act(() => { void result.current.start(missionId); });
    await waitFor(() => expect(result.current.missions[0].events.some((event) => event.capability)).toBe(true));
    let request = result.current.missions[0].events.find((event) => event.capability)?.capability!;
    act(() => result.current.resolveCapability(missionId, request.runId, request.requestId, "denied"));
    await waitFor(() => expect(result.current.missions[0].status).toBe("ready_for_review"));

    act(() => result.current.review(missionId, "request_revision"));
    act(() => result.current.updatePlan(missionId, {
      scope: "Implement the revised fixture behavior.",
      actions: ["Run deterministic fixture again"],
      acceptanceCriteria: ["The delegated change is covered by passing tests"],
    }));
    act(() => result.current.approvePlan(missionId));
    act(() => { void result.current.start(missionId); });
    await waitFor(() => expect(result.current.missions[0].events.filter((event) => event.capability).length).toBe(2));
    request = result.current.missions[0].events.filter((event) => event.capability).at(-1)!.capability!;
    act(() => result.current.resolveCapability(missionId, request.runId, request.requestId, "denied"));
    await waitFor(() => expect(result.current.missions[0].status).toBe("ready_for_review"));

    expect(result.current.missions[0].events).toHaveLength(18);
    expect(result.current.missions[0].events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 18 }, (_, index) => index + 1),
    );
    expect(new Set(result.current.missions[0].events.map((event) => event.runId)).size).toBe(2);
  });

  it("exposes corrupt persisted state without overwriting it and can recover", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, missions: [{ id: "broken" }] }));
    const original = window.localStorage.getItem(STORAGE_KEY);
    const { result } = renderHook(() => useMissions(), { wrapper });

    expect(result.current.storageError).toMatch(/corrupt|invalid/i);
    expect(result.current.missions).toEqual([]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(original);
    act(() => result.current.resetDemo());
    expect(result.current.storageError).toBeUndefined();
  });

  it("normalizes a reload during a permission request to a recoverable interruption", async () => {
    const first = renderHook(() => useMissions(), { wrapper });
    act(() => first.result.current.create(createInput));
    const missionId = first.result.current.missions[0].id;
    act(() => first.result.current.updatePlan(missionId, {
      scope: "Request permission.", actions: ["Run"], acceptanceCriteria: ["Can recover"],
    }));
    act(() => first.result.current.approvePlan(missionId));
    act(() => { void first.result.current.start(missionId); });
    await waitFor(() => expect(first.result.current.missions[0].status).toBe("blocked"));
    first.unmount();

    const second = renderHook(() => useMissions(), { wrapper });
    const restored = second.result.current.missions[0];
    expect(restored.status).toBe("blocked");
    expect(restored.activeRunId).toBeUndefined();
    expect(restored.completionSummary).toMatch(/interrupted|reload/i);
    expect(restored.events.find((event) => event.kind === "capability_request")?.capability?.resolved).toBe("interrupted");

    act(() => second.result.current.cancel(missionId));
    expect(second.result.current.missions[0].status).toBe("cancelled");
    expect(second.result.current.missions[0].events.map((event) => event.sequence)).toEqual(
      Array.from({ length: second.result.current.missions[0].events.length }, (_, index) => index + 1),
    );
    expect(second.result.current.missions[0].events.at(-1)).toMatchObject({
      kind: "cancellation",
      runId: restored.events.at(-1)?.runId,
    });
    expect(second.result.current.missions[0].events.slice(0, -1)).toEqual(restored.events);
  });

  it.each([
    ["unknown status", (mission: Record<string, unknown>) => { mission.status = "mystery"; }],
    ["duplicate mission id", (_mission: Record<string, unknown>, payload: { missions: unknown[] }) => { payload.missions.push(structuredClone(payload.missions[0])); }],
    ["invalid evidence enum", (mission: Record<string, unknown>) => { (mission.evidence as Array<Record<string, unknown>>).push({ id: "e", kind: "test", status: "maybe", summary: "x", planRevisionId: (mission.plan as Record<string, unknown>).id, timestamp: "2026-08-27T10:00:00.000Z" }); }],
    ["inconsistent terminal run", (mission: Record<string, unknown>) => { mission.status = "accepted"; mission.activeRunId = "run"; mission.reviewDecision = "accepted"; mission.completionSummary = "done"; }],
  ])("rejects persisted state with %s", (_name, mutate) => {
    const seed = renderHook(() => useMissions(), { wrapper });
    act(() => seed.result.current.create(createInput));
    seed.unmount();
    const payload = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    mutate(payload.missions[0], payload);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));

    const restored = renderHook(() => useMissions(), { wrapper });
    expect(restored.result.current.storageError).toMatch(/corrupt|invalid/i);
    expect(restored.result.current.missions).toEqual([]);
  });

  it("does not expose a mission transition when its durable write fails", async () => {
    const storage: Storage = {
      length: 0,
      clear: vi.fn(),
      getItem: vi.fn(() => null),
      key: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }),
    };
    const failingWrapper = ({ children }: { children: ReactNode }) => (
      <MissionProvider runtimeDelay={0} storage={storage}>{children}</MissionProvider>
    );
    const { result } = renderHook(() => useMissions(), { wrapper: failingWrapper });
    act(() => result.current.create(createInput));

    await waitFor(() => expect(result.current.storageError).toMatch(/save|storage/i));
    expect(result.current.missions).toEqual([]);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("persists each transition once before exposing it", () => {
    const writes: string[] = [];
    const storage: Storage = {
      length: 0,
      clear: vi.fn(),
      getItem: vi.fn(() => null),
      key: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn((_key, value) => writes.push(value)),
    };
    const durableWrapper = ({ children }: { children: ReactNode }) => (
      <MissionProvider runtimeDelay={0} storage={storage}>{children}</MissionProvider>
    );
    const { result } = renderHook(() => useMissions(), { wrapper: durableWrapper });

    act(() => result.current.create(createInput));

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writes[0]).missions[0].id).toBe(result.current.missions[0].id);
  });

  it("does not start runtime work when persisting the running state fails", async () => {
    const mission = createMission({ ...createInput, plan: { scope: "Scope", actions: ["Act"], acceptanceCriteria: ["Prove"] } });
    const queued = { ...mission, status: "queued" as const, plan: { ...mission.plan, approved: true } };
    const storage: Storage = {
      length: 1,
      clear: vi.fn(),
      getItem: vi.fn(() => JSON.stringify({ version: 1, missions: [queued] })),
      key: vi.fn(() => STORAGE_KEY),
      removeItem: vi.fn(),
      setItem: vi.fn(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); }),
    };
    const failingWrapper = ({ children }: { children: ReactNode }) => (
      <MissionProvider runtimeDelay={0} storage={storage}>{children}</MissionProvider>
    );
    const { result } = renderHook(() => useMissions(), { wrapper: failingWrapper });

    await act(async () => { await result.current.start(mission.id); });

    expect(result.current.missions[0].status).toBe("queued");
    expect(result.current.storageError).toMatch(/save|storage/i);
    act(() => result.current.cancel(mission.id));
    expect(result.current.runtimeError).toMatch(/no active run/i);
  });
});
