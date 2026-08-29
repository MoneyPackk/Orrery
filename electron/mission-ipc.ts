import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { Mission } from "@orrery/mission-control-domain";
import type { ServerMutationResponse } from "@orrery/mission-control-protocol";
import type {
  CancelMissionInput, CreateMissionInput, InspectMissionInput,
  PromoteMissionInput, ProposeRepositoryInput, RunMissionInput,
  ReviewPromotionInput,
} from "./contract";
import { isTrustedIpcSender } from "./policy";
import {
  MISSION_APPROVE_REPOSITORY_CHANNEL, MISSION_CANCEL_CHANNEL, MISSION_CREATE_CHANNEL,
  MISSION_GET_SNAPSHOT_CHANNEL, MISSION_INSPECT_CHANNEL, MISSION_PROMOTE_CHANNEL,
  MISSION_PROPOSE_REPOSITORY_CHANNEL, MISSION_RUN_CHANNEL,
} from "./channels";

export * from "./channels";

type MutationResult<T extends ServerMutationResponse["type"]> = Omit<Extract<ServerMutationResponse, { type: T }>, "type" | "version" | "requestId">;
export interface MissionIpcService {
  proposeRepository(input: ProposeRepositoryInput): Promise<MutationResult<"repository_proposal">>;
  create(input: CreateMissionInput): Promise<Mission>;
  run(input: RunMissionInput): Promise<MutationResult<"mission_run_accepted">>;
  cancel(input: CancelMissionInput): Promise<MutationResult<"mission_cancelled">>;
  getSnapshot(input: MissionSnapshotIntent): Promise<Mission>;
  inspect(input: InspectMissionInput): Promise<MutationResult<"mission_inspection">>;
  reviewAndPromote(input: ReviewPromotionInput): Promise<MutationResult<"mission_promotion">>;
}
export interface MissionSnapshotIntent { missionId: string }

const modes = ["explore", "plan", "build", "delegate"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 200;
const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 8_192;
const exact = (value: Record<string, unknown>, required: readonly string[]): boolean => Object.keys(value).length === required.length && required.every((key) => key in value);
const isHex64 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function invalid(): never { throw new Error("Invalid mission IPC payload"); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || !exact(value, keys)) return invalid();
  return value;
}
function parseProposal(value: unknown): ProposeRepositoryInput {
  const input = record(value, ["intentId", "localPath"]);
  if (!isId(input.intentId) || !isText(input.localPath)) return invalid();
  return input as unknown as ProposeRepositoryInput;
}
function parseCreate(value: unknown): CreateMissionInput {
  const input = record(value, ["intentId", "repositoryId", "title", "goal", "mode", "plan"]);
  if (!isId(input.intentId) || !isId(input.repositoryId) || !isText(input.title) || !isText(input.goal) || typeof input.mode !== "string" || !modes.includes(input.mode as typeof modes[number])) return invalid();
  const plan = record(input.plan, ["scope", "actions", "acceptanceCriteria"]);
  if (!isText(plan.scope) || !isStringArray(plan.actions) || !isStringArray(plan.acceptanceCriteria)) return invalid();
  return input as unknown as CreateMissionInput;
}
function parseRun(value: unknown): RunMissionInput {
  const input = record(value, ["intentId", "missionId", "planRevisionId"]);
  if (!isId(input.intentId) || !isId(input.missionId) || !isId(input.planRevisionId)) return invalid();
  return input as unknown as RunMissionInput;
}
function parseCancel(value: unknown): CancelMissionInput {
  const input = record(value, ["intentId", "missionId", "runId"]);
  if (!isId(input.intentId) || !isId(input.missionId) || !isId(input.runId)) return invalid();
  return input as unknown as CancelMissionInput;
}
function parseSnapshot(value: unknown): MissionSnapshotIntent {
  const input = record(value, ["missionId"]);
  if (!isId(input.missionId)) return invalid();
  return input as unknown as MissionSnapshotIntent;
}
function parseInspect(value: unknown): InspectMissionInput {
  const input = record(value, ["missionId", "planRevisionId"]);
  if (!isId(input.missionId) || !isId(input.planRevisionId)) return invalid();
  return input as unknown as InspectMissionInput;
}
function parsePromotion(value: unknown): PromoteMissionInput {
  const input = record(value, ["intentId", "missionId", "planRevisionId", "changeRevision", "decision", "approvalCapability"]);
  if (!isId(input.intentId) || !isId(input.missionId) || !isId(input.planRevisionId) || !isId(input.changeRevision) || (input.decision !== "accepted" && input.decision !== "rejected") || !isText(input.approvalCapability)) return invalid();
  return input as unknown as PromoteMissionInput;
}
function parseReview(value: unknown): ReviewPromotionInput {
  const input = record(value, ["intentId", "missionId", "planRevisionId", "decision"]);
  if (!isId(input.intentId) || !isId(input.missionId) || !isId(input.planRevisionId) || (input.decision !== "accepted" && input.decision !== "rejected")) return invalid();
  return input as unknown as ReviewPromotionInput;
}
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(isText); }
function assertTrusted(event: IpcMainInvokeEvent, rendererUrl: string): void {
  if (!isTrustedIpcSender(event.senderFrame, event.sender.mainFrame, rendererUrl)) throw new Error("Rejected untrusted mission IPC request");
}

export function registerMissionIpc(ipcMain: IpcMain, getRendererUrl: () => string, service: MissionIpcService): void {
  const guarded = <T>(parse: (value: unknown) => T, invoke: (input: T) => unknown) => async (event: IpcMainInvokeEvent, value: unknown) => {
    assertTrusted(event, getRendererUrl());
    return await invoke(parse(value));
  };
  const handlers: Array<[string, (event: IpcMainInvokeEvent, value: unknown) => unknown]> = [
    [MISSION_PROPOSE_REPOSITORY_CHANNEL, guarded(parseProposal, (input) => service.proposeRepository(input))],
    [MISSION_CREATE_CHANNEL, guarded(parseCreate, (input) => service.create(input))],
    [MISSION_RUN_CHANNEL, guarded(parseRun, (input) => service.run(input))],
    [MISSION_CANCEL_CHANNEL, guarded(parseCancel, (input) => service.cancel(input))],
    [MISSION_GET_SNAPSHOT_CHANNEL, guarded(parseSnapshot, (input) => service.getSnapshot(input))],
    [MISSION_INSPECT_CHANNEL, guarded(parseInspect, (input) => service.inspect(input))],
    [MISSION_PROMOTE_CHANNEL, guarded(parseReview, (input) => service.reviewAndPromote(input))],
  ];
  for (const [channel, handler] of handlers) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); }
}
