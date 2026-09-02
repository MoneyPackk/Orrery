import { describe, expect, it, vi } from "vitest";
import {
  createMissionControlPreloadApi,
  MISSION_GET_SNAPSHOT_CHANNEL,
  MISSION_LIST_CHANNEL,
  MISSION_REVIEW_CHANNEL,
  MISSION_INTAKE_REPOSITORY_CHANNEL, MISSION_CREATE_CHANNEL, MISSION_RUN_CHANNEL, MISSION_CANCEL_CHANNEL, MISSION_INSPECT_CHANNEL,
} from "./mission-control-preload-api";

describe("Theia Mission Control preload API", () => {
  it("exposes only bounded mission operations over fixed channels", async () => {
    const call = vi.fn().mockResolvedValue({});
    const api = createMissionControlPreloadApi(call);
    expect(Object.keys(api)).toEqual(["intakeRepository", "create", "run", "cancel", "list", "getSnapshot", "inspect", "reviewAndPromote"]);
    expect(api).not.toHaveProperty("invoke");
    expect(api).not.toHaveProperty("approveRepository");

    await api.intakeRepository({ intentId: "repo-1", localPath: "C:/repo" });
    await api.create({ intentId: "create-1", repositoryId: "repository-1", title: "Title", goal: "Goal", mode: "build", plan: { scope: "Scope", actions: ["Act"], acceptanceCriteria: ["Pass"] } });
    await api.run({ intentId: "run-1", missionId: "mission-1", planRevisionId: "plan-1" });
    await api.cancel({ intentId: "cancel-1", missionId: "mission-1", runId: "run-1" });
    await api.list();
    await api.getSnapshot({ missionId: "mission-1" });
    await api.inspect({ missionId: "mission-1", planRevisionId: "plan-1" });
    await api.reviewAndPromote({ intentId: "review-1", missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" });
    expect(call.mock.calls).toEqual([
      [MISSION_INTAKE_REPOSITORY_CHANNEL, { intentId: "repo-1", localPath: "C:/repo" }],
      [MISSION_CREATE_CHANNEL, { intentId: "create-1", repositoryId: "repository-1", title: "Title", goal: "Goal", mode: "build", plan: { scope: "Scope", actions: ["Act"], acceptanceCriteria: ["Pass"] } }],
      [MISSION_RUN_CHANNEL, { intentId: "run-1", missionId: "mission-1", planRevisionId: "plan-1" }],
      [MISSION_CANCEL_CHANNEL, { intentId: "cancel-1", missionId: "mission-1", runId: "run-1" }],
      [MISSION_LIST_CHANNEL],
      [MISSION_GET_SNAPSHOT_CHANNEL, { missionId: "mission-1" }],
      [MISSION_INSPECT_CHANNEL, { missionId: "mission-1", planRevisionId: "plan-1" }],
      [MISSION_REVIEW_CHANNEL, { intentId: "review-1", missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" }],
    ]);
  });
});
