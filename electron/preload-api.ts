import {
  DESKTOP_GET_RUNTIME_CHANNEL, DESKTOP_SMOKE_READY_CHANNEL, MISSION_APPROVE_REPOSITORY_CHANNEL,
  MISSION_CANCEL_CHANNEL, MISSION_CREATE_CHANNEL, MISSION_GET_SNAPSHOT_CHANNEL, MISSION_INSPECT_CHANNEL,
  MISSION_PROMOTE_CHANNEL, MISSION_PROPOSE_REPOSITORY_CHANNEL, MISSION_RUN_CHANNEL,
} from "./channels";
import type { DesktopApi, SmokeReadiness } from "./contract";

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;
export function createDesktopApi(invoke: Invoke, smokeMode = false): DesktopApi {
  const api: DesktopApi = {
    getRuntime: () => invoke(DESKTOP_GET_RUNTIME_CHANNEL) as ReturnType<DesktopApi["getRuntime"]>,
    missions: {
      proposeRepository: (input) => invoke(MISSION_PROPOSE_REPOSITORY_CHANNEL, input) as ReturnType<DesktopApi["missions"]["proposeRepository"]>,
      create: (input) => invoke(MISSION_CREATE_CHANNEL, input) as ReturnType<DesktopApi["missions"]["create"]>,
      run: (input) => invoke(MISSION_RUN_CHANNEL, input) as ReturnType<DesktopApi["missions"]["run"]>,
      cancel: (input) => invoke(MISSION_CANCEL_CHANNEL, input) as ReturnType<DesktopApi["missions"]["cancel"]>,
      getSnapshot: (input) => invoke(MISSION_GET_SNAPSHOT_CHANNEL, input) as ReturnType<DesktopApi["missions"]["getSnapshot"]>,
      inspect: (input) => invoke(MISSION_INSPECT_CHANNEL, input) as ReturnType<DesktopApi["missions"]["inspect"]>,
    },
  };
  if (smokeMode) api.reportSmokeReadiness = (readiness: SmokeReadiness) => invoke(DESKTOP_SMOKE_READY_CHANNEL, readiness).then(() => undefined);
  return api;
}
