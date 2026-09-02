import type { Mission, MissionControlPublicApi, MissionListItem, ReviewDecision, RepositoryIntakeInput, MissionCreateInput, MissionRunInput, MissionCancelInput, IntelligenceMessage, IntelligenceSettingsInput, IntelligenceSettingsStatus } from "./mission-control-contracts";

export const MissionControlService = Symbol("MissionControlService");
export const OrreryIntelligenceService = Symbol("OrreryIntelligenceService");

export interface OrreryIntelligenceState {
  readonly threadId: string;
  readonly messages: ReadonlyArray<IntelligenceMessage>;
  readonly settings: IntelligenceSettingsStatus;
  readonly loading?: boolean;
  readonly sending?: boolean;
  readonly error?: string;
}

export interface OrreryIntelligenceService {
  load(threadId: string): Promise<OrreryIntelligenceState>;
  send(threadId: string, text: string, missionId?: string): Promise<OrreryIntelligenceState>;
  clear(threadId: string): Promise<OrreryIntelligenceState>;
  configure(input: Omit<IntelligenceSettingsInput, "intentId">): Promise<OrreryIntelligenceState>;
}

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
