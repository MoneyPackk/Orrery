import type { Mission, MissionEvent } from "@orrery/mission-control-domain";
import type { ChangeSnapshot, MissionWorkspace, PromotionResult, PromotionRetryToken, RunMissionResult } from "../../mission-kernel/src";

export interface PublicWorkspace { readonly handle: string }
export type PublicRunMissionResult = Omit<RunMissionResult, "mission" | "workspace"> & { readonly mission: MissionSnapshot; readonly workspace: PublicWorkspace };

export interface ApprovedRepository {
  readonly repositoryId: string;
  readonly canonicalRoot: string;
  readonly fingerprint: string;
  readonly gitIdentity: string;
  readonly approvedAt: string;
  readonly lastVerifiedAt: string;
  readonly payloadVersion: 1;
}

export interface RepositoryProposal {
  readonly proposalId: string;
  readonly canonicalRoot: string;
  readonly fingerprint: string;
  readonly gitIdentity: string;
  readonly approvalNonceHash: string;
  readonly expiresAt: string;
  readonly payloadVersion: 1;
}

export interface RepositoryProposalResult {
  readonly proposalId: string;
  readonly canonicalRoot: string;
  readonly fingerprint: string;
  readonly gitIdentity: string;
  readonly approvalNonce: string;
  readonly expiresAt: string;
  readonly payloadVersion: 1;
}

export interface RepositoryApprovalInput {
  readonly proposalId: string;
  readonly fingerprint: string;
  readonly approvalNonce: string;
}

export interface CreateMissionAuthorityInput {
  readonly intentId: string;
  readonly repositoryId: string;
  readonly title: string;
  readonly goal: string;
  readonly mode: Mission["mode"];
  readonly plan: Mission["plan"] extends infer Plan ? Omit<Plan, "id" | "revision" | "approved" | "createdAt"> : never;
}

export interface RunMissionAuthorityInput { readonly intentId: string; readonly missionId: string; readonly planRevisionId: string }
export interface CancelMissionAuthorityInput { readonly intentId: string; readonly missionId: string; readonly runId: string }
export interface InspectMissionAuthorityInput { readonly missionId: string; readonly planRevisionId: string }
export interface PromoteMissionAuthorityInput {
  readonly intentId: string;
  readonly missionId: string;
  readonly planRevisionId: string;
  readonly changeRevision: string;
  readonly approvalCapability: string;
  readonly decision: Mission["reviewDecision"];
}
export interface MissionSnapshot extends Mission {
  readonly repositoryId: string;
  readonly fingerprint: string;
  readonly lastEventSequence: number;
  readonly firstEventSequence?: number;
  readonly payloadVersion: 1;
  readonly currentChangeSnapshot?: ChangeSnapshot;
  readonly currentWorkspace?: MissionWorkspace;
  readonly intentOutcomes?: Readonly<Record<string, MissionIntentOutcome>>;
  readonly operations?: Readonly<Record<string, MissionOperation>>;
}

export type MissionIntentOutcome =
  | { readonly operation: "create"; readonly requestDigest: string; readonly result: MissionSnapshot }
  | { readonly operation: "run"; readonly requestDigest: string; readonly result: PublicRunMissionResult }
  | { readonly operation: "cancel"; readonly requestDigest: string; readonly result: MissionSnapshot }
  | { readonly operation: "promote"; readonly requestDigest: string; readonly result: MissionPromotionResult };

export type MissionOperation =
  | { readonly operation: "run"; readonly requestDigest: string; readonly state: "prepared" | "in_progress"; readonly runId: string }
  | { readonly operation: "run"; readonly requestDigest: string; readonly state: "committed"; readonly runId: string; readonly result: PublicRunMissionResult }
  | { readonly operation: "promote"; readonly requestDigest: string; readonly state: "prepared"; readonly reviewerId: string }
  | { readonly operation: "promote"; readonly requestDigest: string; readonly state: "in_progress"; readonly reviewerId: string; readonly token: PromotionRetryToken }
  | { readonly operation: "promote"; readonly requestDigest: string; readonly state: "committed"; readonly reviewerId: string; readonly result: MissionPromotionResult };

export interface MissionInspectionResult {
  readonly mission: MissionSnapshot;
  readonly workspace: PublicWorkspace;
  readonly changeSnapshot: ChangeSnapshot;
  readonly planRevisionId: string;
}

export interface MissionPromotionResult {
  readonly mission: MissionSnapshot;
  readonly result: PromotionResult;
  readonly reviewerId: string;
}

export interface MissionEventRecord extends MissionEvent {
  readonly payloadVersion: 1;
  readonly recordedAt: string;
}
