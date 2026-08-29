import type { Mission } from "@orrery/mission-control-domain";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceService } from "./ports";
import { PromotionService } from "./promotion-service";
import type { ChangeSnapshot, MissionWorkspace, PromotionInput } from "./types";

const workspace: MissionWorkspace = {
  id: "workspace-1",
  missionId: "mission-1",
  repositoryRoot: "C:/repo",
  worktreePath: "C:/repo/.orrery/worktrees/mission-1",
  targetBranch: "main",
  missionBranch: "orrery/mission-1",
  initialRevision: "target-head-1",
};

const snapshot: ChangeSnapshot = {
  revision: "change-1",
  files: [{ path: "fixture.txt", additions: 1, deletions: 1, binary: false, diff: "-old\n+new\n" }],
  unifiedDiff: "-old\n+new\n",
};

const mission: Mission = {
  id: "mission-1",
  title: "Mission",
  goal: "Goal",
  mode: "build",
  status: "ready_for_review",
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
  targetBranch: "main",
  workspaceId: workspace.id,
  missionBranch: workspace.missionBranch,
  plan: { id: "plan-1", revision: 2, approved: true, createdAt: "2026-08-28T00:00:00.000Z", scope: "scope", actions: ["action"], acceptanceCriteria: ["criterion"] },
  events: [],
  changes: [{ path: "fixture.txt", additions: 1, deletions: 1, diff: "-old\n+new\n" }],
  evidence: [],
  completionSummary: "complete",
};

function input(overrides: Partial<PromotionInput> = {}): PromotionInput {
  return { mission, workspace, planRevisionId: "plan-1", changeSnapshot: snapshot, reviewerId: "reviewer@example.test", decision: "accepted", ...overrides };
}

function createPromotionService() {
  const promote = vi.fn(async () => ({ status: "promoted" as const, revision: "target-head-2" }));
  const preparePromotion = vi.fn(async () => ({ status: "prepared" as const, token: {
    missionRevision: "mission-commit-1", expectedTargetRevision: workspace.initialRevision,
    targetBranch: workspace.targetBranch, workspace, missionParent: workspace.initialRevision, missionTree: "tree-1",
  } }));
  const inspectChanges = vi.fn(async () => snapshot);
  const promoteRetry = vi.fn(async () => ({ status: "promoted" as const, revision: "target-head-3" }));
  const workspaceService = { promote, preparePromotion, promoteRetry, inspectChanges } as unknown as WorkspaceService;
  return { service: new PromotionService({ workspaceService }), promote, preparePromotion, promoteRetry, inspectChanges };
}

describe("PromotionService", () => {
  it("rejects without mutating the target", async () => {
    const { service, promote, inspectChanges } = createPromotionService();

    const result = await service.promote(input({ decision: "rejected" }));

    expect(result).toEqual({ status: "rejected" });
    expect(promote).not.toHaveBeenCalled();
    expect(inspectChanges).not.toHaveBeenCalled();
  });

  it("requires a ready mission, matching plan revision, exact snapshot, and reviewer", async () => {
    const cases: Array<[string, Partial<PromotionInput>, string]> = [
      ["ready mission", { mission: { ...mission, status: "running" } }, "ready_for_review"],
      ["plan revision", { planRevisionId: "plan-old" }, "plan revision"],
      ["change snapshot", { changeSnapshot: { ...snapshot, revision: "other" } }, "change snapshot"],
      ["reviewer", { reviewerId: " " }, "Reviewer identity"],
      ["workspace mission", { workspace: { ...workspace, missionId: "other" } }, "workspace does not belong"],
    ];

    for (const [, overrides, message] of cases) {
      const { service, promote, inspectChanges } = createPromotionService();
      await expect(service.promote(input(overrides))).rejects.toThrow(message);
      expect(promote).not.toHaveBeenCalled();
      if (message === "ready_for_review" || message === "Reviewer identity") {
        expect(inspectChanges).not.toHaveBeenCalled();
      }
    }
  });

  it("requires rejected decisions to come from an identified review of a ready mission", async () => {
    const notReady = createPromotionService();
    await expect(notReady.service.promote(input({ decision: "rejected", mission: { ...mission, status: "running" } }))).rejects.toThrow("ready_for_review");
    expect(notReady.inspectChanges).not.toHaveBeenCalled();

    const anonymous = createPromotionService();
    await expect(anonymous.service.promote(input({ decision: "rejected", reviewerId: " " }))).rejects.toThrow("Reviewer identity");
    expect(anonymous.inspectChanges).not.toHaveBeenCalled();
  });

  it("delegates an accepted matching promotion", async () => {
    const { service, promote } = createPromotionService();

    await expect(service.promote(input())).resolves.toEqual({ status: "promoted", revision: "target-head-2" });
  expect(promote).toHaveBeenCalledWith(workspace, "main", "reviewer@example.test", snapshot);
  });

  it("prepares an accepted promotion without invoking the target-mutating promotion operation", async () => {
    const { service, preparePromotion, promote } = createPromotionService();

    await expect(service.preparePromotion(input())).resolves.toMatchObject({ status: "prepared" });
    expect(preparePromotion).toHaveBeenCalledWith(workspace, "main", "reviewer@example.test", snapshot);
    expect(promote).not.toHaveBeenCalled();
  });

  it("executes a retry token with its immutable mission commit and expected target", async () => {
    const { service, promote, promoteRetry } = createPromotionService();

    await expect(service.promoteRetry({
      missionRevision: "mission-commit-1",
       expectedTargetRevision: workspace.initialRevision,
       targetBranch: workspace.targetBranch,
       missionParent: workspace.initialRevision,
       missionTree: "tree-1",
       workspace,
    }, "reviewer@example.test")).resolves.toEqual({ status: "promoted", revision: "target-head-3" });
    expect(promote).not.toHaveBeenCalled();
    expect(promoteRetry).toHaveBeenCalledWith({
      missionRevision: "mission-commit-1",
       expectedTargetRevision: workspace.initialRevision,
       targetBranch: workspace.targetBranch,
       missionParent: workspace.initialRevision,
       missionTree: "tree-1",
       workspace,
    }, "reviewer@example.test");
  });
});
