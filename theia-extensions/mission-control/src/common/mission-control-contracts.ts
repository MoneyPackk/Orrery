export type MissionMode = "explore" | "plan" | "build" | "delegate";
export type MissionStatus = "draft" | "planning" | "awaiting_approval" | "queued" | "running" | "paused" | "blocked" | "ready_for_review" | "revision_requested" | "accepted" | "rejected" | "failed" | "cancelled";
export type ReviewDecision = "accepted" | "rejected" | "revision_requested";

export const MISSION_LIST_CHANNEL = "mission:v1:list";
export const MISSION_GET_SNAPSHOT_CHANNEL = "mission:v1:get-snapshot";
export const MISSION_REVIEW_CHANNEL = "mission:v1:promote";
export const MISSION_INTAKE_REPOSITORY_CHANNEL = "mission:v1:intake-repository";
export const MISSION_CREATE_CHANNEL = "mission:v1:create";
export const MISSION_RUN_CHANNEL = "mission:v1:run";
export const MISSION_CANCEL_CHANNEL = "mission:v1:cancel";
export const MISSION_INSPECT_CHANNEL = "mission:v1:inspect";

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
export interface RepositoryIntakeInput { readonly intentId: string; readonly localPath: string }
export interface RepositoryIntakeResult { readonly repositoryId: string; readonly canonicalRoot: string; readonly fingerprint: string }
export interface MissionPlanInput { readonly scope: string; readonly actions: ReadonlyArray<string>; readonly acceptanceCriteria: ReadonlyArray<string> }
export interface MissionCreateInput { readonly intentId: string; readonly repositoryId: string; readonly title: string; readonly goal: string; readonly mode: MissionMode; readonly plan: MissionPlanInput }
export interface MissionRunInput { readonly intentId: string; readonly missionId: string; readonly planRevisionId: string }
export interface MissionRunResult { readonly mission: Mission; readonly runId: string }
export interface MissionCancelInput { readonly intentId: string; readonly missionId: string; readonly runId: string }
export interface MissionCancelResult { readonly mission: Mission; readonly runId: string }
export interface MissionInspectInput { readonly missionId: string; readonly planRevisionId: string }
export interface MissionInspectionResult { readonly mission: Mission; readonly planRevisionId: string; readonly changeRevision: string; readonly contentDigest: string; readonly review: MissionReviewContent }
export interface MissionReviewContent { readonly changes: ReadonlyArray<{ readonly path: string; readonly additions: number; readonly deletions: number; readonly binary: boolean; readonly diff: string }>; readonly evidence: ReadonlyArray<Evidence> }
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
  intakeRepository(input: RepositoryIntakeInput): Promise<RepositoryIntakeResult>;
  create(input: MissionCreateInput): Promise<Mission>;
  run(input: MissionRunInput): Promise<MissionRunResult>;
  cancel(input: MissionCancelInput): Promise<MissionCancelResult>;
  list(): Promise<ReadonlyArray<MissionListItem>>;
  getSnapshot(input: MissionSnapshotInput): Promise<Mission>;
  inspect(input: MissionInspectInput): Promise<MissionInspectionResult>;
  reviewAndPromote(input: MissionReviewInput): Promise<MissionPromotionResult>;
}

export const MissionControlHostService = Symbol("MissionControlHostService");
export interface MissionControlHostService extends MissionControlPublicApi {}
