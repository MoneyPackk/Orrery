import { inject, injectable, optional } from "@theia/core/shared/inversify";
import type { ElectronMainApplication, ElectronMainApplicationContribution } from "@theia/core/lib/electron-main/electron-main-application";
import { app, ipcMain, type IpcMain, type IpcMainInvokeEvent } from "@theia/core/electron-shared/electron";
import {
  MissionControlHostService,
  MISSION_GET_SNAPSHOT_CHANNEL,
  MISSION_LIST_CHANNEL,
  MISSION_REVIEW_CHANNEL,
  type MissionReviewInput,
  type MissionPromotionResult,
  type MissionSnapshotInput,
} from "../common/mission-control-contracts";

export interface MissionControlHostRequestContext {
  reviewAndPromote(input: MissionReviewInput): Promise<MissionPromotionResult>;
}

export interface ElectronMainMissionControlHostService extends MissionControlHostService {
  requestContext(sender: object, senderFrame: object | null): MissionControlHostRequestContext | null;
}
const HOST_READY_CHANNEL = "mission:v1:host-ready";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 200;

function exactRecord(value: unknown, keys: ReadonlyArray<string>): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || !keys.every((key) => key in value)) {
    throw new Error("Invalid mission IPC payload");
  }
  return value;
}

function parseSnapshot(value: unknown): MissionSnapshotInput {
  const input = exactRecord(value, ["missionId"]);
  if (!isId(input.missionId)) throw new Error("Invalid mission IPC payload");
  return { missionId: input.missionId };
}

function parseReview(value: unknown): MissionReviewInput {
  const input = exactRecord(value, ["intentId", "missionId", "planRevisionId", "decision"]);
  if (!isId(input.intentId) || !isId(input.missionId) || !isId(input.planRevisionId) || (input.decision !== "accepted" && input.decision !== "rejected")) {
    throw new Error("Invalid mission IPC payload");
  }
  return { intentId: input.intentId, missionId: input.missionId, planRevisionId: input.planRevisionId, decision: input.decision };
}

function trustedContext(event: IpcMainInvokeEvent, host: ElectronMainMissionControlHostService): MissionControlHostRequestContext {
  const sameFrame = event.senderFrame === event.sender.mainFrame;
  const context = sameFrame ? host.requestContext(event.sender, event.senderFrame) : null;
  if (!context) {
    throw new Error("Rejected untrusted mission IPC request");
  }
  return context;
}

export function registerMissionControlHostIpc(target: Pick<IpcMain, "handle" | "removeHandler">, host: ElectronMainMissionControlHostService): void {
  const trusted = (invoke: () => unknown) => async (event: IpcMainInvokeEvent, ...values: unknown[]) => {
    trustedContext(event, host);
    if (values.length !== 0) throw new Error("Invalid mission IPC payload");
    return invoke();
  };
  const guarded = <T>(parse: (value: unknown) => T, invoke: (input: T) => unknown) => async (event: IpcMainInvokeEvent, ...values: unknown[]) => {
    trustedContext(event, host);
    if (values.length !== 1) throw new Error("Invalid mission IPC payload");
    return invoke(parse(values[0]));
  };
  const handlers = [
    [MISSION_LIST_CHANNEL, trusted(() => host.list())],
    [MISSION_GET_SNAPSHOT_CHANNEL, guarded(parseSnapshot, (input) => host.getSnapshot(input))],
    [MISSION_REVIEW_CHANNEL, async (event: IpcMainInvokeEvent, ...values: unknown[]) => {
      const context = trustedContext(event, host);
      if (values.length !== 1) throw new Error("Invalid mission IPC payload");
      return context.reviewAndPromote(parseReview(values[0]));
    }],
    [HOST_READY_CHANNEL, async (event: IpcMainInvokeEvent, ...values: unknown[]) => {
      const context = trustedContext(event, host);
      if (values.length !== 0) throw new Error("Invalid mission IPC payload");
      await host.list();
      if (process.env.ORRERY_THEIA_SMOKE === "1") {
        console.log("ORRERY_THEIA_READY");
        setTimeout(() => app.quit(), 50);
      }
    }],
  ] as const;
  for (const [channel, handler] of handlers) {
    target.removeHandler(channel);
    target.handle(channel, handler);
  }
}

@injectable()
export class MissionControlElectronMainContribution implements ElectronMainApplicationContribution {
  constructor(@inject(MissionControlHostService) @optional() private readonly host?: ElectronMainMissionControlHostService) {}

  onStart(_application: ElectronMainApplication): void {
    if (!this.host) {
      throw new Error("Mission Control requires the assembled Theia host to bind MissionControlHostService before Electron main startup.");
    }
    registerMissionControlHostIpc(ipcMain, this.host);
  }
}
