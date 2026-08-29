import { describe, expect, it } from "vitest";
import type { Mission } from "@orrery/mission-control-domain";
import {
  MAX_LINE_BYTES,
  decodeMessage,
  encodeMessage,
  type ProtocolMessage,
} from "./index";

const request = {
  type: "list_missions",
  version: "mission-control.v1",
  requestId: "request-1",
} as const;

const mission: Mission = {
  id: "mission-1",
  title: "Protocol hardening",
  goal: "Validate every nested DTO field",
  mode: "build",
  status: "running",
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T01:00:00.000Z",
  targetBranch: "main",
  missionBranch: "orrery/protocol-hardening",
  workspaceId: "workspace-1",
  activeRunId: "run-1",
  plan: {
    id: "plan-1",
    revision: 2,
    approved: true,
    createdAt: "2026-08-28T00:00:00.000Z",
    scope: "Protocol DTOs",
    actions: ["Validate nested values"],
    acceptanceCriteria: ["Malformed values are rejected"],
  },
  events: [{
    id: "event-1",
    missionId: "mission-1",
    runId: "run-1",
    sequence: 1,
    timestamp: "2026-08-28T00:30:00.000Z",
    kind: "capability_request",
    title: "Dependency access",
    detail: "Approval required",
    capability: {
      requestId: "capability-1",
      runId: "run-1",
      capability: "dependency",
      scope: "npm registry",
      reason: "Install a package",
      resolved: "allowed",
    },
  }],
  changes: [{ path: "src/index.ts", additions: 4, deletions: 1, diff: "@@ change" }],
  evidence: [{
    id: "evidence-1",
    kind: "test",
    status: "passed",
    summary: "Protocol tests passed",
    criterion: "Malformed values are rejected",
    planRevisionId: "plan-1",
    timestamp: "2026-08-28T01:00:00.000Z",
  }],
  completionSummary: "Validated",
  reviewDecision: "accepted",
};

describe("mission control protocol validation", () => {
  it("round trips valid requests and responses as one NDJSON line", () => {
    const messages: ProtocolMessage[] = [
      { type: "hello", version: "mission-control.v1", requestId: "h", token: "token" },
      request,
      { type: "hello_ack", version: "mission-control.v1", requestId: "h" },
      { type: "pong", version: "mission-control.v1", requestId: "p" },
      { type: "error", version: "mission-control.v1", requestId: "e", code: "not_found", message: "Missing" },
    ];

    for (const message of messages) {
      expect(decodeMessage(encodeMessage(message))).toEqual(message);
      expect(encodeMessage(message).endsWith("\n")).toBe(true);
    }
  });

  it("rejects unknown fields", () => {
    expect(() => decodeMessage(JSON.stringify({ ...request, extra: true }))).toThrow(/unknown field/i);
  });

  it("rejects wrong versions and invalid request ids", () => {
    expect(() => decodeMessage(JSON.stringify({ ...request, version: "mission-control.v2" }))).toThrow(/version/i);
    expect(() => decodeMessage(JSON.stringify({ ...request, requestId: "" }))).toThrow(/requestId/i);
  });

  it("rejects malformed JSON and oversized lines", () => {
    expect(() => decodeMessage("{" )).toThrow(/json/i);
    expect(() => decodeMessage("x".repeat(MAX_LINE_BYTES + 1))).toThrow(/size|large|limit/i);
    expect(() => encodeMessage({ ...request, requestId: "x".repeat(1025) })).toThrow(/requestId/i);
  });

  it("rejects prototype-pollution-shaped keys", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(() => decodeMessage(`{"type":"list_missions","version":"mission-control.v1","requestId":"x","${key}":{}}`)).toThrow(/forbidden|prototype/i);
    }
  });

  it("deeply validates complete mission snapshots and events", () => {
    expect(decodeMessage(JSON.stringify({
      type: "mission_snapshot",
      version: "mission-control.v1",
      requestId: "snapshot-1",
      mission,
    }))).toMatchObject({ type: "mission_snapshot", mission: { id: "mission-1" } });

    const withUnknownPlanField = structuredClone(mission) as Record<string, any>;
    withUnknownPlanField.plan.extra = true;
    expect(() => decodeMessage(JSON.stringify({
      type: "mission_snapshot",
      version: "mission-control.v1",
      requestId: "snapshot-2",
      mission: withUnknownPlanField,
    }))).toThrow(/unknown field/i);

    const withInvalidStatus = { ...mission, status: "launching" };
    expect(() => decodeMessage(JSON.stringify({
      type: "mission_snapshot",
      version: "mission-control.v1",
      requestId: "snapshot-3",
      mission: withInvalidStatus,
    }))).toThrow(/status/i);

    const malformedEvent = { ...mission.events[0], sequence: 1.5 };
    expect(() => decodeMessage(JSON.stringify({
      type: "mission_event",
      version: "mission-control.v1",
      requestId: "event-message-1",
      subscriptionId: "subscription-1",
      event: malformedEvent,
    }))).toThrow(/sequence/i);
  });

  it("validates mission list enums and timestamps", () => {
    expect(() => decodeMessage(JSON.stringify({
      type: "mission_list",
      version: "mission-control.v1",
      requestId: "list-1",
      missions: [{ id: "mission-1", title: "Mission", status: "unknown", updatedAt: "not-a-date" }],
    }))).toThrow(/status/i);

    expect(() => decodeMessage(JSON.stringify({
      type: "mission_list",
      version: "mission-control.v1",
      requestId: "list-2",
      missions: [{ id: "mission-1", title: "Mission", status: "running", updatedAt: "not-a-date" }],
    }))).toThrow(/updatedAt/i);
  });

  it("requires explicit subscription identity and a supported replay acknowledgement", () => {
    const subscribe = {
      type: "subscribe_mission_events",
      version: "mission-control.v1",
      requestId: "subscribe-1",
      missionId: "mission-1",
      afterSequence: 4,
    };
    expect(() => decodeMessage(JSON.stringify(subscribe))).toThrow(/subscriptionId/i);
    expect(decodeMessage(JSON.stringify({ ...subscribe, subscriptionId: "subscription-1" }))).toEqual({
      ...subscribe,
      subscriptionId: "subscription-1",
    });

    expect(() => decodeMessage(JSON.stringify({
      type: "subscribed",
      version: "mission-control.v1",
      requestId: "subscribe-1",
      subscriptionId: "subscription-1",
      missionId: "mission-1",
      afterSequence: 4,
    }))).toThrow(/replay/i);

    expect(decodeMessage(JSON.stringify({
      type: "subscribed",
      version: "mission-control.v1",
      requestId: "subscribe-1",
      subscriptionId: "subscription-1",
      missionId: "mission-1",
      afterSequence: 4,
      replay: "live_only",
    }))).toMatchObject({ subscriptionId: "subscription-1", afterSequence: 4, replay: "live_only" });

    expect(decodeMessage(JSON.stringify({
      type: "subscribed",
      version: "mission-control.v1",
      requestId: "subscribe-1",
      subscriptionId: "subscription-1",
      missionId: "mission-1",
      afterSequence: 4,
      replay: "durable",
    }))).toMatchObject({ replay: "durable" });
  });

  it("round trips every guarded request and response shape", () => {
    const messages: ProtocolMessage[] = [
      { type: "propose_repository", version: "mission-control.v1", requestId: "p", intentId: "i", localPath: "C:/repo" },
      { type: "approve_repository", version: "mission-control.v1", requestId: "a", intentId: "i", proposalId: "proposal-1", fingerprint: "a".repeat(64), approvalNonce: "b".repeat(64) },
      { type: "create_mission", version: "mission-control.v1", requestId: "c", intentId: "i", repositoryId: "repo-1", title: "Title", goal: "Goal", mode: "build", plan: { scope: "scope", actions: ["action"], acceptanceCriteria: ["criterion"] } },
      { type: "run_mission", version: "mission-control.v1", requestId: "r", intentId: "i", missionId: "mission-1", planRevisionId: "plan-1" },
      { type: "cancel_mission", version: "mission-control.v1", requestId: "x", intentId: "i", missionId: "mission-1", runId: "run-1" },
      { type: "inspect_mission", version: "mission-control.v1", requestId: "n", missionId: "mission-1", planRevisionId: "plan-1" },
      { type: "promote_mission", version: "mission-control.v1", requestId: "m", intentId: "i", missionId: "mission-1", planRevisionId: "plan-1", changeRevision: "change-1", contentDigest: "a".repeat(64), decision: "accepted", approvalCapability: "capability-1" },
      { type: "repository_proposal", version: "mission-control.v1", requestId: "p", proposalId: "proposal-1", canonicalRoot: "C:/repo", fingerprint: "a".repeat(64), approvalNonce: "b".repeat(64), expiresAt: "2026-08-28T01:00:00.000Z" },
      { type: "repository_approved", version: "mission-control.v1", requestId: "a", repositoryId: "repo-1", fingerprint: "a".repeat(64) },
      { type: "mission_created", version: "mission-control.v1", requestId: "c", mission },
      { type: "mission_run_accepted", version: "mission-control.v1", requestId: "r", mission, runId: "run-1" },
      { type: "mission_cancelled", version: "mission-control.v1", requestId: "x", mission, runId: "run-1" },
      { type: "mission_inspection", version: "mission-control.v1", requestId: "n", mission, planRevisionId: "plan-1", changeRevision: "change-1", contentDigest: "a".repeat(64), review: { changes: [], evidence: [] } },
      { type: "mission_promotion", version: "mission-control.v1", requestId: "m", mission, planRevisionId: "plan-1", changeRevision: "change-1", decision: "accepted", reviewerId: "reviewer-1", result: "promoted" },
    ];

    for (const message of messages) {
      expect(decodeMessage(encodeMessage(message))).toEqual(message);
    }
  });

  it("rejects malformed guarded revisions, bounded trust values, extra fields, and raw paths", () => {
    const valid = { type: "run_mission", version: "mission-control.v1", requestId: "r", intentId: "i", missionId: "mission-1", planRevisionId: "plan-1" };
    expect(() => decodeMessage(JSON.stringify({ ...valid, planRevisionId: "" }))).toThrow(/planRevisionId/i);
    expect(() => decodeMessage(JSON.stringify({ ...valid, intentId: "" }))).toThrow(/intentId/i);
    expect(() => decodeMessage(JSON.stringify({ ...valid, planRevisionId: "x".repeat(65537) }))).toThrow(/bounded|string|large/i);
    const promotion = { type: "promote_mission", version: "mission-control.v1", requestId: "m", intentId: "i", missionId: "m", planRevisionId: "p", changeRevision: "c", contentDigest: "a".repeat(64), decision: "accepted", approvalCapability: "capability" };
    expect(() => decodeMessage(JSON.stringify({ ...promotion, reviewerId: "caller" }))).toThrow(/unknown field/i);
    expect(() => decodeMessage(JSON.stringify({ ...promotion, expiresAt: "2099-01-01T00:00:00.000Z" }))).toThrow(/unknown field/i);
    expect(() => decodeMessage(JSON.stringify({ type: "approve_repository", version: "mission-control.v1", requestId: "a", intentId: "i", proposalId: "p", fingerprint: "", approvalNonce: "n" }))).toThrow(/fingerprint/i);
    expect(() => decodeMessage(JSON.stringify({ type: "approve_repository", version: "mission-control.v1", requestId: "a", intentId: "i", proposalId: "p", fingerprint: "a".repeat(63), approvalNonce: "n" }))).toThrow(/fingerprint/i);
    expect(() => decodeMessage(JSON.stringify({ type: "approve_repository", version: "mission-control.v1", requestId: "a", intentId: "i", proposalId: "p", fingerprint: "g".repeat(64), approvalNonce: "n" }))).toThrow(/fingerprint/i);
    expect(() => decodeMessage(JSON.stringify({ type: "approve_repository", version: "mission-control.v1", requestId: "a", intentId: "i", proposalId: "p", fingerprint: "a".repeat(64), approvalNonce: "" }))).toThrow(/approvalNonce/i);
    expect(() => decodeMessage(JSON.stringify({ type: "approve_repository", version: "mission-control.v1", requestId: "a", intentId: "i", proposalId: "p", fingerprint: "a".repeat(64), approvalNonce: "a".repeat(63) }))).toThrow(/approvalNonce/i);
    expect(() => decodeMessage(JSON.stringify({ type: "approve_repository", version: "mission-control.v1", requestId: "a", intentId: "i", proposalId: "p", fingerprint: "a".repeat(64), approvalNonce: "z".repeat(64) }))).toThrow(/approvalNonce/i);
    expect(() => decodeMessage(JSON.stringify({ type: "approve_repository", version: "mission-control.v1", requestId: "a", intentId: "i", proposalId: "p", fingerprint: "a".repeat(64), approvalNonce: "x".repeat(65537) }))).toThrow(/approvalNonce/i);
    expect(() => decodeMessage(JSON.stringify({ type: "subscribe_mission_events", version: "mission-control.v1", requestId: "s", subscriptionId: "s", missionId: "m", afterSequence: -1 }))).toThrow(/afterSequence/i);
    expect(() => decodeMessage(JSON.stringify({ type: "create_mission", version: "mission-control.v1", requestId: "c", intentId: "i", repositoryId: "r", title: "t", goal: "g", mode: "build", plan: { scope: "s", actions: [], acceptanceCriteria: [], extra: true } }))).toThrow(/unknown field/i);
    expect(() => decodeMessage(JSON.stringify({ type: "create_mission", version: "mission-control.v1", requestId: "c", intentId: "i", repositoryId: "r", title: "t", goal: "g", mode: "build", plan: { scope: " ", actions: ["action"], acceptanceCriteria: ["criterion"] } }))).toThrow(/scope/i);
    expect(() => decodeMessage(JSON.stringify({ type: "create_mission", version: "mission-control.v1", requestId: "c", intentId: "i", repositoryId: "r", title: "t", goal: "g", mode: "build", plan: { scope: "scope", actions: [], acceptanceCriteria: ["criterion"] } }))).toThrow(/actions/i);
    expect(() => decodeMessage(JSON.stringify({ type: "create_mission", version: "mission-control.v1", requestId: "c", intentId: "i", repositoryId: "r", title: "t", goal: "g", mode: "build", plan: { scope: "scope", actions: ["action"], acceptanceCriteria: [""] } }))).toThrow(/acceptanceCriteria/i);
  });

  it("rejects every raw path field from every non-proposal mutation intent", () => {
    const mutations = [
      { type: "approve_repository", version: "mission-control.v1", requestId: "a", intentId: "i", proposalId: "p", fingerprint: "a".repeat(64), approvalNonce: "b".repeat(64) },
      { type: "create_mission", version: "mission-control.v1", requestId: "c", intentId: "i", repositoryId: "r", title: "t", goal: "g", mode: "build", plan: { scope: "s", actions: [], acceptanceCriteria: [] } },
      { type: "run_mission", version: "mission-control.v1", requestId: "r", intentId: "i", missionId: "m", planRevisionId: "p" },
      { type: "cancel_mission", version: "mission-control.v1", requestId: "x", intentId: "i", missionId: "m", runId: "r" },
      { type: "inspect_mission", version: "mission-control.v1", requestId: "n", missionId: "m", planRevisionId: "p" },
      { type: "promote_mission", version: "mission-control.v1", requestId: "m", intentId: "i", missionId: "m", planRevisionId: "p", changeRevision: "c", decision: "accepted", reviewerId: "r" },
    ];

    for (const mutation of mutations) {
      for (const pathField of ["repositoryRoot", "cwd", "worktreePath", "localPath"]) {
        expect(() => decodeMessage(JSON.stringify({ ...mutation, [pathField]: "C:/raw" }))).toThrow(/unknown field/i);
      }
    }
  });
});
