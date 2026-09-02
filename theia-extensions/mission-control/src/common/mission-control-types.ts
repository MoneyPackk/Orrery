import type { Mission, MissionControlPublicApi, MissionListItem, ReviewDecision, RepositoryIntakeInput, MissionCreateInput, MissionRunInput, MissionCancelInput } from "./mission-control-contracts";

export const MissionControlService = Symbol("MissionControlService");

export interface MissionControlState {
  readonly missions: ReadonlyArray<MissionListItem>;
  readonly selectedId?: string;
  readonly selected?: Mission;
  readonly loading?: boolean;
  readonly pendingReview?: boolean;
  readonly pendingAction?: string;
  readonly repository?: { readonly repositoryId: string; readonly canonicalRoot: string; readonly fingerprint: string };
  readonly error?: string;
}

export type DesktopMissionApi = MissionControlPublicApi;

export interface MissionControlService {
  load(selectedId?: string): Promise<MissionControlState>;
  getMission(missionId: string): Promise<Mission>;
  intakeRepository(input: RepositoryIntakeInput): Promise<MissionControlState>;
  create(input: MissionCreateInput): Promise<MissionControlState>;
  run(input: MissionRunInput): Promise<MissionControlState>;
  cancel(input: MissionCancelInput): Promise<MissionControlState>;
  review(mission: Mission, decision: Exclude<ReviewDecision, "revision_requested">): Promise<Mission>;
}

declare global {
  interface Window {
    readonly orreryMissionControl?: DesktopMissionApi;
  }
}
