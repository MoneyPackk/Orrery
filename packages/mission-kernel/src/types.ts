import type { Evidence, FileChange, Mission } from "@orrery/mission-control-domain";

export interface CreateWorkspaceInput {
  missionId: string;
  repositoryRoot: string;
  targetBranch: string;
}

export interface MissionWorkspace {
  id: string;
  missionId: string;
  repositoryRoot: string;
  worktreePath: string;
  targetBranch: string;
  missionBranch: string;
  initialRevision: string;
}

export interface ChangeSnapshot {
  revision: string;
  files: ChangeFile[];
  unifiedDiff: string;
}

export interface PromotionInput {
  mission: MissionSnapshot;
  workspace: MissionWorkspace;
  planRevisionId: string;
  changeSnapshot: ChangeSnapshot;
  reviewerId: string;
  decision: "accepted" | "rejected";
}

export interface ChangeFile extends FileChange {
  binary: boolean;
}

export interface CommandInput {
  executable: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
}

export interface CommandResult extends Omit<CommandInput, "signal"> {
  startedAt: string;
  completedAt: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export type EvidenceInput = Omit<Evidence, "id" | "timestamp">;

export interface MissionSnapshot extends Mission {}

export interface PromotionRetryToken {
  missionRevision: string;
  expectedTargetRevision: string;
  targetBranch: string;
  workspace: MissionWorkspace;
  missionParent: string;
  missionTree: string;
}

export type PromotionResult =
  | { status: "promoted"; revision: string }
  | { status: "conflict"; reason: string; retry?: PromotionRetryToken }
  | { status: "rejected" };

export type PromotionPreparation =
  | { status: "rejected" }
  | { status: "conflict"; reason: string; retry?: PromotionRetryToken }
  | { status: "prepared"; token: PromotionRetryToken };

export type PromotionReconciliation =
  | { status: "pending" }
  | { status: "promoted"; revision: string }
  | { status: "conflict"; reason: string; retry?: PromotionRetryToken };
