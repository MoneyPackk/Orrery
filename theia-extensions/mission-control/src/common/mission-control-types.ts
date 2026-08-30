import type { Mission, MissionControlPublicApi, MissionListItem, ReviewDecision } from "./mission-control-contracts";

export const MissionControlService = Symbol("MissionControlService");

export interface MissionControlState {
  readonly missions: ReadonlyArray<MissionListItem>;
  readonly selectedId?: string;
  readonly selected?: Mission;
  readonly loading?: boolean;
  readonly pendingReview?: boolean;
  readonly error?: string;
}

export type DesktopMissionApi = MissionControlPublicApi;

export interface MissionControlService {
  load(selectedId?: string): Promise<MissionControlState>;
  getMission(missionId: string): Promise<Mission>;
  review(mission: Mission, decision: Exclude<ReviewDecision, "revision_requested">): Promise<Mission>;
}

declare global {
  interface Window {
    readonly orreryMissionControl?: DesktopMissionApi;
  }
}
