import { describe, expect, it, vi } from "vitest";
import {
  createMissionControlPreloadApi,
  MISSION_GET_SNAPSHOT_CHANNEL,
  MISSION_LIST_CHANNEL,
  MISSION_REVIEW_CHANNEL,
} from "./mission-control-preload-api";

describe("Theia Mission Control preload API", () => {
  it("exposes only list, snapshot, and trusted review over fixed channels", async () => {
    const call = vi.fn().mockResolvedValue({});
    const api = createMissionControlPreloadApi(call);
    expect(Object.keys(api)).toEqual(["list", "getSnapshot", "reviewAndPromote"]);
    expect(api).not.toHaveProperty("invoke");
    expect(api).not.toHaveProperty("create");
    expect(api).not.toHaveProperty("run");
    expect(api).not.toHaveProperty("cancel");
    expect(api).not.toHaveProperty("inspect");

    await api.list();
    await api.getSnapshot({ missionId: "mission-1" });
    await api.reviewAndPromote({ intentId: "review-1", missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" });
    expect(call.mock.calls).toEqual([
      [MISSION_LIST_CHANNEL],
      [MISSION_GET_SNAPSHOT_CHANNEL, { missionId: "mission-1" }],
      [MISSION_REVIEW_CHANNEL, { intentId: "review-1", missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" }],
    ]);
  });
});
