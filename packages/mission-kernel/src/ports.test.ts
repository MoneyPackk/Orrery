import { describe, expect, it } from "vitest";
import type { Evidence } from "@orrery/mission-control-domain";
import {
  assertCommandArgs,
  assertNonEmptyId,
  assertWorktreeContainedCwd,
  type CommandRunner,
  type EvidenceStore,
  type MissionRepository,
  type WorkspaceService,
} from "./ports";
import type {
  ChangeSnapshot,
  CommandInput,
  CommandResult,
  CreateWorkspaceInput,
  EvidenceInput,
  MissionSnapshot,
  MissionWorkspace,
  PromotionResult,
} from "./types";

describe("mission kernel ports", () => {
  it("describes the workspace, command, evidence, and repository boundaries", async () => {
    const workspace: MissionWorkspace = {
      id: "workspace-1",
      missionId: "mission-1",
      repositoryRoot: "C:/repos/example",
      worktreePath: "C:/repos/example/.orrery/worktrees/mission-1",
      targetBranch: "main",
      missionBranch: "orrery/mission-1",
      initialRevision: "abc123",
    };
    const createInput: CreateWorkspaceInput = {
      missionId: "mission-1",
      repositoryRoot: workspace.repositoryRoot,
      targetBranch: workspace.targetBranch,
    };
    const commandInput: CommandInput = {
      executable: "node",
      args: ["--version"],
      cwd: workspace.worktreePath,
    };
    const commandResult: CommandResult = {
      ...commandInput,
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: "2026-08-28T00:00:01.000Z",
      exitCode: 0,
      signal: null,
      stdout: "v24",
      stderr: "",
      truncated: false,
    };
    const changeSnapshot: ChangeSnapshot = {
      revision: "abc123",
      files: [],
      unifiedDiff: "",
    };
    const evidenceInput: EvidenceInput = {
      kind: "command",
      status: "passed",
      summary: "node --version passed",
      planRevisionId: "plan-1",
    };
    const evidence: Evidence = {
      ...evidenceInput,
      id: "evidence-1",
      timestamp: "2026-08-28T00:00:01.000Z",
    };
    const snapshot = {} as MissionSnapshot;
    const promotion: PromotionResult = { status: "promoted", revision: "def456" };

    const workspaceService: WorkspaceService = {
      createMissionWorkspace: async (_input: CreateWorkspaceInput) => workspace,
      removeMissionWorkspace: async (_workspace: MissionWorkspace) => undefined,
      inspectChanges: async (_workspace: MissionWorkspace) => changeSnapshot,
      preparePromotion: async () => ({ status: "conflict", reason: "not prepared" }),
      promote: async (
        _workspace: MissionWorkspace,
        _targetBranch: string,
        _reviewerId: string,
        _reviewedSnapshot: ChangeSnapshot,
      ) => promotion,
      promoteRetry: async () => promotion,
    };
    const commandRunner: CommandRunner = {
      run: async (_input: CommandInput) => commandResult,
    };
    const evidenceStore: EvidenceStore = {
      append: async (_input: EvidenceInput) => evidence,
    };
    const repository: MissionRepository = {
      save: async (_snapshot: MissionSnapshot) => undefined,
      load: async (_missionId: string) => snapshot,
    };

    expect(await workspaceService.createMissionWorkspace(createInput)).toBe(workspace);
    expect(await workspaceService.inspectChanges(workspace)).toBe(changeSnapshot);
    expect(await workspaceService.promote(workspace, "main", "reviewer@example.test", changeSnapshot, "2099-01-01T00:00:00.000Z")).toBe(promotion);
    expect(await commandRunner.run(commandInput)).toBe(commandResult);
    expect(await evidenceStore.append(evidenceInput)).toBe(evidence);
    expect(await repository.load("mission-1")).toBe(snapshot);
  });

  it("rejects empty identifiers", () => {
    expect(() => assertNonEmptyId(" ", "missionId")).toThrow("missionId must be a nonempty ID");
    expect(() => assertNonEmptyId("\t", "workspaceId")).toThrow("workspaceId must be a nonempty ID");
  });

  it("accepts a cwd inside the worktree and rejects an absolute cwd outside it", () => {
    expect(() => assertWorktreeContainedCwd("C:/repos/example/worktree/src", "C:/repos/example/worktree")).not.toThrow();
    expect(() => assertWorktreeContainedCwd("C:/repos/example/other", "C:/repos/example/worktree")).toThrow(
      "cwd must be contained by the mission worktree",
    );
  });

  it("rejects traversal and non-array command arguments", () => {
    expect(() => assertWorktreeContainedCwd("C:/repos/example/worktree/../other", "C:/repos/example/worktree")).toThrow();
    expect(() => assertCommandArgs("--version" as unknown as string[])).toThrow(
      "Command args must be an array",
    );
    expect(() => assertCommandArgs(["ok", 1] as unknown as string[])).toThrow(
      "Command args must contain only strings",
    );
  });
});
