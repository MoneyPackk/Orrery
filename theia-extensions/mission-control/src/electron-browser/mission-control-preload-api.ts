import {
  MISSION_GET_SNAPSHOT_CHANNEL,
  MISSION_LIST_CHANNEL,
  MISSION_REVIEW_CHANNEL,
  type MissionControlPublicApi,
} from "../common/mission-control-contracts";

export { MISSION_GET_SNAPSHOT_CHANNEL, MISSION_LIST_CHANNEL, MISSION_REVIEW_CHANNEL };

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export type MissionControlPreloadApi = MissionControlPublicApi;

export function createMissionControlPreloadApi(call: Invoke): MissionControlPreloadApi {
  return {
    list: () => call(MISSION_LIST_CHANNEL) as ReturnType<MissionControlPreloadApi["list"]>,
    getSnapshot: (input) => call(MISSION_GET_SNAPSHOT_CHANNEL, input) as ReturnType<MissionControlPreloadApi["getSnapshot"]>,
    reviewAndPromote: (input) => call(MISSION_REVIEW_CHANNEL, input) as ReturnType<MissionControlPreloadApi["reviewAndPromote"]>,
  };
}
