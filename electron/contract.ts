import type { Mission } from "@orrery/mission-control-domain";
import type { ClientRequest, ServerMutationResponse } from "@orrery/mission-control-protocol";

export interface DesktopRuntime {
  platform: NodeJS.Platform;
  versions: { chrome: string; electron: string };
}
export interface SmokeReadiness { desktopRuntimeExists: boolean; processType: string; requireType: string }
export interface SmokeResult { passed: boolean; checks: { desktopRuntimeExists: boolean; rendererProcessUndefined: boolean; rendererRequireUndefined: boolean } }
type MutationResult<T extends ServerMutationResponse["type"]> = Omit<Extract<ServerMutationResponse, { type: T }>, "type" | "version" | "requestId">;
type RequestInput<T extends ClientRequest["type"]> = Omit<Extract<ClientRequest, { type: T }>, "type" | "version" | "requestId">;
export type ProposeRepositoryInput = RequestInput<"propose_repository">;
export type ApproveRepositoryInput = RequestInput<"approve_repository">;
export type CreateMissionInput = RequestInput<"create_mission">;
export type RunMissionInput = RequestInput<"run_mission">;
export type CancelMissionInput = RequestInput<"cancel_mission">;
export type InspectMissionInput = RequestInput<"inspect_mission">;
export type PromoteMissionInput = RequestInput<"promote_mission">;
export interface ReviewPromotionInput { intentId: string; missionId: string; planRevisionId: string; decision: "accepted" | "rejected" }
export interface MissionSnapshotIntent { missionId: string }
export interface MissionApi {
  proposeRepository(input: ProposeRepositoryInput): Promise<MutationResult<"repository_proposal">>;
  create(input: CreateMissionInput): Promise<Mission>;
  run(input: RunMissionInput): Promise<MutationResult<"mission_run_accepted">>;
  cancel(input: CancelMissionInput): Promise<MutationResult<"mission_cancelled">>;
  getSnapshot(input: MissionSnapshotIntent): Promise<Mission>;
  inspect(input: InspectMissionInput): Promise<MutationResult<"mission_inspection">>;
  reviewAndPromote(input: ReviewPromotionInput): Promise<MutationResult<"mission_promotion">>;
}
export interface DesktopApi {
  getRuntime(): Promise<DesktopRuntime>;
  reportSmokeReadiness?(readiness: SmokeReadiness): Promise<void>;
  missions: MissionApi;
}
