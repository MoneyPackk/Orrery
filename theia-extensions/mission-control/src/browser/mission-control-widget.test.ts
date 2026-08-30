import { describe, expect, it, vi } from "vitest";
import type { Mission } from "../common/mission-control-contracts";
import type { MissionControlService, MissionControlState } from "../common/mission-control-types";
import { MissionControlWidget } from "./mission-control-widget";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const mission = (id: string, status: Mission["status"] = "ready_for_review"): Mission => ({
  id, title: id, goal: "Goal", mode: "build", status, createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", targetBranch: "main",
  plan: { id: `plan-${id}`, revision: 1, approved: true, createdAt: "2026-08-29T00:00:00.000Z", scope: "Scope", actions: ["Act"], acceptanceCriteria: ["Pass"] }, events: [], changes: [], evidence: [],
});

class TestWidget extends MissionControlWidget {
  constructor(service: MissionControlService, state: MissionControlState) { super(); Object.defineProperty(this, "service", { value: service }); this.state = state; }
  snapshot(): MissionControlState { return this.state; }
  protected override update(): void {}
}

describe("MissionControlWidget request ordering", () => {
  it("ignores a stale selection that completes after a newer selection", async () => {
    const first = deferred<Mission>(); const second = deferred<Mission>();
    const service = { getMission: vi.fn((id: string) => id === "first" ? first.promise : second.promise) } as unknown as MissionControlService;
    const widget = new TestWidget(service, { missions: [] });
    const oldRequest = widget.selectMission("first"); const newRequest = widget.selectMission("second");
    second.resolve(mission("second")); await newRequest; first.resolve(mission("first")); await oldRequest;
    expect(widget.snapshot().selected?.id).toBe("second");
  });

  it("allows only one review while pending and refreshes list state after completion", async () => {
    const review = deferred<Mission>(); const reviewed = mission("one", "accepted");
    const service = { review: vi.fn(() => review.promise), load: vi.fn(async () => ({ missions: [{ id: "one", title: "one", status: "accepted", updatedAt: reviewed.updatedAt }], selectedId: "one", selected: reviewed })) } as unknown as MissionControlService;
    const widget = new TestWidget(service, { missions: [{ id: "one", title: "one", status: "ready_for_review", updatedAt: reviewed.updatedAt }], selectedId: "one", selected: mission("one") });
    const first = widget.review("accepted"); const duplicate = widget.review("accepted");
    expect(widget.snapshot().pendingReview).toBe(true); expect(service.review).toHaveBeenCalledOnce();
    review.resolve(reviewed); await Promise.all([first, duplicate]);
    expect(service.load).toHaveBeenCalledWith("one"); expect(widget.snapshot().selected?.status).toBe("accepted"); expect(widget.snapshot().pendingReview).toBe(false);
  });

  it("ignores a refresh completion superseded by a selection", async () => {
    const refresh = deferred<MissionControlState>(); const selection = deferred<Mission>();
    const service = { load: vi.fn(() => refresh.promise), getMission: vi.fn(() => selection.promise) } as unknown as MissionControlService;
    const widget = new TestWidget(service, { missions: [{ id: "old", title: "old", status: "running", updatedAt: "now" }], selectedId: "old", selected: mission("old", "running") });
    const oldRequest = widget.refresh(); const newRequest = widget.selectMission("new");
    selection.resolve(mission("new")); await newRequest; refresh.resolve({ missions: [], selectedId: undefined, selected: undefined }); await oldRequest;
    expect(widget.snapshot().selected?.id).toBe("new");
  });

  it("does not reload or apply a stale review superseded by selection", async () => {
    const review = deferred<Mission>(); const selection = deferred<Mission>();
    const service = { review: vi.fn(() => review.promise), load: vi.fn(), getMission: vi.fn(() => selection.promise) } as unknown as MissionControlService;
    const widget = new TestWidget(service, { missions: [], selectedId: "old", selected: mission("old") });
    const oldRequest = widget.review("accepted"); const newRequest = widget.selectMission("new");
    selection.resolve(mission("new")); await newRequest;
    const duplicate = widget.review("accepted");
    expect(service.review).toHaveBeenCalledOnce(); expect(widget.snapshot().selected?.id).toBe("new"); expect(widget.snapshot().pendingReview).toBe(true);
    review.resolve(mission("old", "accepted")); await Promise.all([oldRequest, duplicate]);
    expect(service.load).not.toHaveBeenCalled(); expect(widget.snapshot().selected?.id).toBe("new"); expect(widget.snapshot().pendingReview).toBe(false);
  });

  it("keeps a review pending through refresh and suppresses a duplicate review", async () => {
    const review = deferred<Mission>(); const refresh = deferred<MissionControlState>();
    const service = { review: vi.fn(() => review.promise), load: vi.fn(() => refresh.promise) } as unknown as MissionControlService;
    const widget = new TestWidget(service, { missions: [], selectedId: "one", selected: mission("one") });
    const mutation = widget.review("accepted"); const read = widget.refresh();
    refresh.resolve({ missions: [], selectedId: "one", selected: mission("one") }); await read;
    const duplicate = widget.review("accepted");
    expect(service.review).toHaveBeenCalledOnce(); expect(widget.snapshot().pendingReview).toBe(true);
    review.resolve(mission("one", "accepted")); await Promise.all([mutation, duplicate]);
    expect(widget.snapshot().pendingReview).toBe(false);
  });
});
