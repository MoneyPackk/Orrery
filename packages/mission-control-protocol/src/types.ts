import type { Mission, MissionEvent, MissionMode, MissionStatus, ReviewDecision } from "@orrery/mission-control-domain";

export const PROTOCOL_VERSION = "mission-control.v1" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export interface MissionListItem {
  id: string;
  title: string;
  status: MissionStatus;
  updatedAt: string;
}

export interface MissionPlanInput {
  scope: string;
  actions: ReadonlyArray<string>;
  acceptanceCriteria: ReadonlyArray<string>;
}

export type ClientMutationRequest =
  | { type: "propose_repository"; version: ProtocolVersion; requestId: string; intentId: string; localPath: string }
  | { type: "approve_repository"; version: ProtocolVersion; requestId: string; intentId: string; proposalId: string; fingerprint: string; approvalNonce: string }
  | { type: "create_mission"; version: ProtocolVersion; requestId: string; intentId: string; repositoryId: string; title: string; goal: string; mode: MissionMode; plan: MissionPlanInput }
  | { type: "run_mission"; version: ProtocolVersion; requestId: string; intentId: string; missionId: string; planRevisionId: string }
  | { type: "cancel_mission"; version: ProtocolVersion; requestId: string; intentId: string; missionId: string; runId: string }
  | { type: "inspect_mission"; version: ProtocolVersion; requestId: string; missionId: string; planRevisionId: string }
  | { type: "promote_mission"; version: ProtocolVersion; requestId: string; intentId: string; missionId: string; planRevisionId: string; changeRevision: string; decision: Exclude<ReviewDecision, "revision_requested">; approvalCapability: string };

type ReadOnlyClientRequest =
  | { type: "hello"; version: ProtocolVersion; requestId: string; token: string }
  | { type: "list_missions"; version: ProtocolVersion; requestId: string }
  | { type: "get_mission"; version: ProtocolVersion; requestId: string; missionId: string }
  | { type: "subscribe_mission_events"; version: ProtocolVersion; requestId: string; subscriptionId: string; missionId: string; afterSequence?: number }
  | { type: "unsubscribe_mission_events"; version: ProtocolVersion; requestId: string; subscriptionId: string }
  | { type: "ping"; version: ProtocolVersion; requestId: string };

export type ClientRequest = ReadOnlyClientRequest | ClientMutationRequest;

export type ServerMutationResponse =
  | { type: "repository_proposal"; version: ProtocolVersion; requestId: string; proposalId: string; canonicalRoot: string; fingerprint: string; approvalNonce: string; expiresAt: string }
  | { type: "repository_approved"; version: ProtocolVersion; requestId: string; repositoryId: string; fingerprint: string }
  | { type: "mission_created"; version: ProtocolVersion; requestId: string; mission: Mission }
  | { type: "mission_run_accepted"; version: ProtocolVersion; requestId: string; mission: Mission; runId: string }
  | { type: "mission_cancelled"; version: ProtocolVersion; requestId: string; mission: Mission; runId: string }
  | { type: "mission_inspection"; version: ProtocolVersion; requestId: string; mission: Mission; planRevisionId: string }
  | { type: "mission_promotion"; version: ProtocolVersion; requestId: string; mission: Mission; planRevisionId: string; changeRevision: string; decision: Exclude<ReviewDecision, "revision_requested">; reviewerId: string; result: "promoted" | "rejected" | "conflict" };

type ReadOnlyServerResponse =
  | { type: "hello_ack"; version: ProtocolVersion; requestId: string }
  | { type: "mission_list"; version: ProtocolVersion; requestId: string; missions: ReadonlyArray<MissionListItem> }
  | { type: "mission_snapshot"; version: ProtocolVersion; requestId: string; mission: Mission }
  | { type: "mission_event"; version: ProtocolVersion; requestId: string; subscriptionId: string; event: MissionEvent }
  | { type: "subscribed"; version: ProtocolVersion; requestId: string; subscriptionId: string; missionId: string; afterSequence: number; replay: "live_only" | "durable"; cursor?: number; highWaterMark?: number; overflow?: { firstAvailableSequence: number } }
  | { type: "unsubscribed"; version: ProtocolVersion; requestId: string; subscriptionId: string }
  | { type: "pong"; version: ProtocolVersion; requestId: string }
  | { type: "error"; version: ProtocolVersion; requestId: string; code: string; message: string };

export type ServerResponse = ReadOnlyServerResponse | ServerMutationResponse;

export type ProtocolMessage = ClientRequest | ServerResponse;
