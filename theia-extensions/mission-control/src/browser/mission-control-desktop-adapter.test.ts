import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mission } from "../common/mission-control-contracts";
import { MissionControlDesktopAdapter } from "./mission-control-desktop-adapter";

const mission = (): Mission => ({
  id: "mission-1", title: "Workbench tracer", goal: "Render daemon state", mode: "build", status: "ready_for_review",
  createdAt: "2026-08-29T10:00:00.000Z", updatedAt: "2026-08-29T11:00:00.000Z", targetBranch: "main",
  plan: { id: "plan-1", revision: 1, approved: true, createdAt: "2026-08-29T10:00:00.000Z", scope: "Tracer", actions: ["Render"], acceptanceCriteria: ["Accessible"] },
  events: [], changes: [{ path: "src/tracer.ts", additions: 4, deletions: 1, diff: "+tracer" }],
  evidence: [{ id: "evidence-1", kind: "test", status: "passed", summary: "Tests passed", planRevisionId: "plan-1", timestamp: "2026-08-29T11:00:00.000Z" }],
  completionSummary: "Ready for review",
});

describe("MissionControlDesktopAdapter", () => {
  afterEach(() => { delete (window as { orreryMissionControl?: unknown }).orreryMissionControl; });

  it("loads list items and the selected public mission through the desktop mission API", async () => {
    const api = { list: vi.fn(async () => [{ id: "mission-1", title: "Workbench tracer", status: "ready_for_review" as const, updatedAt: "2026-08-29T11:00:00.000Z" }]), getSnapshot: vi.fn(async () => mission()) };
    window.orreryMissionControl = api as never;
    const adapter = new MissionControlDesktopAdapter();
    await expect(adapter.load()).resolves.toMatchObject({ selectedId: "mission-1", selected: { id: "mission-1" } });
    expect(api.getSnapshot).toHaveBeenCalledWith({ missionId: "mission-1" });
  });

  it("returns an empty state when the desktop bridge is unavailable", async () => {
    await expect(new MissionControlDesktopAdapter().load()).resolves.toEqual({ missions: [], selectedId: undefined, selected: undefined });
  });

  it("sends review intent through reviewAndPromote and reloads the selected mission", async () => {
    const snapshot = mission();
    const api = { list: vi.fn(async () => []), getSnapshot: vi.fn(async () => snapshot), reviewAndPromote: vi.fn(async () => ({ mission: { ...snapshot, status: "accepted" } })) };
    window.orreryMissionControl = api as never;
    const adapter = new MissionControlDesktopAdapter();
    await expect(adapter.review(snapshot, "accepted")).resolves.toMatchObject({ status: "accepted" });
    expect(api.reviewAndPromote).toHaveBeenCalledWith(expect.objectContaining({ missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" }));
  });
});
