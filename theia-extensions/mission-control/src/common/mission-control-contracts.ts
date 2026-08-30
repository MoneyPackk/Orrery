export type MissionMode = "explore" | "plan" | "build" | "delegate";
export type MissionStatus = "draft" | "planning" | "awaiting_approval" | "queued" | "running" | "paused" | "blocked" | "ready_for_review" | "revision_requested" | "accepted" | "rejected" | "failed" | "cancelled";
export type ReviewDecision = "accepted" | "rejected" | "revision_requested";

export const MISSION_LIST_CHANNEL = "mission:v1:list";
export const MISSION_GET_SNAPSHOT_CHANNEL = "mission:v1:get-snapshot";
export const MISSION_REVIEW_CHANNEL = "mission:v1:promote";

export interface PlanRevision {
  readonly id: string;
  readonly revision: number;
  readonly approved: boolean;
  readonly createdAt: string;
  readonly scope: string;
  readonly actions: ReadonlyArray<string>;
  readonly acceptanceCriteria: ReadonlyArray<string>;
}

export interface MissionEvent {
  readonly id: string;
  readonly missionId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly kind: string;
  readonly title: string;
  readonly detail: string;
}

export interface FileChange {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly diff: string;
}

export interface Evidence {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly summary: string;
  readonly criterion?: string;
  readonly planRevisionId: string;
  readonly timestamp: string;
}

export interface Mission {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly mode: MissionMode;
  readonly status: MissionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly targetBranch: string;
  readonly missionBranch?: string;
  readonly workspaceId?: string;
  readonly plan: PlanRevision;
  readonly events: ReadonlyArray<MissionEvent>;
  readonly changes: ReadonlyArray<FileChange>;
  readonly evidence: ReadonlyArray<Evidence>;
  readonly completionSummary?: string;
  readonly reviewDecision?: ReviewDecision;
  readonly activeRunId?: string;
}

export interface MissionListItem {
  readonly id: string;
  readonly title: string;
  readonly status: MissionStatus;
  readonly updatedAt: string;
}

export interface MissionSnapshotInput { readonly missionId: string }
export interface MissionReviewInput {
  readonly intentId: string;
  readonly missionId: string;
  readonly planRevisionId: string;
  readonly decision: Exclude<ReviewDecision, "revision_requested">;
}
export interface MissionPromotionResult {
  readonly mission: Mission;
  readonly planRevisionId: string;
  readonly changeRevision: string;
  readonly decision: Exclude<ReviewDecision, "revision_requested">;
  readonly reviewerId: string;
  readonly result: "promoted" | "rejected" | "conflict";
}

export interface MissionControlPublicApi {
  list(): Promise<ReadonlyArray<MissionListItem>>;
  getSnapshot(input: MissionSnapshotInput): Promise<Mission>;
  reviewAndPromote(input: MissionReviewInput): Promise<MissionPromotionResult>;
}

export const MissionControlHostService = Symbol("MissionControlHostService");
export interface MissionControlHostService extends MissionControlPublicApi {}
