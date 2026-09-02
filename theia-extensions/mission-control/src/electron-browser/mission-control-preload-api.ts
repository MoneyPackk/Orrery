import {
  MISSION_GET_SNAPSHOT_CHANNEL,
  MISSION_LIST_CHANNEL,
  MISSION_REVIEW_CHANNEL,
  MISSION_INTAKE_REPOSITORY_CHANNEL, MISSION_CREATE_CHANNEL, MISSION_RUN_CHANNEL, MISSION_CANCEL_CHANNEL, MISSION_INSPECT_CHANNEL,
  type MissionControlPublicApi,
} from "../common/mission-control-contracts";

export { MISSION_GET_SNAPSHOT_CHANNEL, MISSION_LIST_CHANNEL, MISSION_REVIEW_CHANNEL, MISSION_INTAKE_REPOSITORY_CHANNEL, MISSION_CREATE_CHANNEL, MISSION_RUN_CHANNEL, MISSION_CANCEL_CHANNEL, MISSION_INSPECT_CHANNEL };

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export type MissionControlPreloadApi = MissionControlPublicApi;

export function createMissionControlPreloadApi(call: Invoke): MissionControlPreloadApi {
  return {
    intakeRepository: (input) => call(MISSION_INTAKE_REPOSITORY_CHANNEL, input) as ReturnType<MissionControlPreloadApi["intakeRepository"]>,
    create: (input) => call(MISSION_CREATE_CHANNEL, input) as ReturnType<MissionControlPreloadApi["create"]>,
    run: (input) => call(MISSION_RUN_CHANNEL, input) as ReturnType<MissionControlPreloadApi["run"]>,
    cancel: (input) => call(MISSION_CANCEL_CHANNEL, input) as ReturnType<MissionControlPreloadApi["cancel"]>,
    list: () => call(MISSION_LIST_CHANNEL) as ReturnType<MissionControlPreloadApi["list"]>,
    getSnapshot: (input) => call(MISSION_GET_SNAPSHOT_CHANNEL, input) as ReturnType<MissionControlPreloadApi["getSnapshot"]>,
    inspect: (input) => call(MISSION_INSPECT_CHANNEL, input) as ReturnType<MissionControlPreloadApi["inspect"]>,
    reviewAndPromote: (input) => call(MISSION_REVIEW_CHANNEL, input) as ReturnType<MissionControlPreloadApi["reviewAndPromote"]>,
  };
}
