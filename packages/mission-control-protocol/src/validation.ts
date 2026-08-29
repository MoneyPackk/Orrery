import type { ProtocolMessage } from "./types";
import { PROTOCOL_VERSION } from "./types";

export const MAX_LINE_BYTES = 256 * 1024;
const MAX_STRING_LENGTH = 64 * 1024;
const MAX_REQUEST_ID_LENGTH = 1024;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MISSION_MODES = ["explore", "plan", "build", "delegate"] as const;
const MISSION_STATUSES = ["draft", "planning", "awaiting_approval", "queued", "running", "paused", "blocked", "ready_for_review", "revision_requested", "accepted", "rejected", "failed", "cancelled"] as const;
const EVENT_KINDS = ["workspace", "context", "execution", "capability_request", "capability_resolution", "change", "verification", "completion", "cancellation", "interruption", "fallback", "error"] as const;
const CAPABILITIES = ["network", "dependency", "secret", "destructive", "deployment"] as const;
const CAPABILITY_RESOLUTIONS = ["allowed", "denied", "interrupted"] as const;
const EVIDENCE_KINDS = ["command", "test", "diagnostic", "screenshot", "log", "manual"] as const;
const EVIDENCE_STATUSES = ["passed", "failed", "warning", "informational"] as const;
const REVIEW_DECISIONS = ["accepted", "rejected", "revision_requested"] as const;
const PROMOTION_DECISIONS = ["accepted", "rejected"] as const;
const PROMOTION_RESULTS = ["promoted", "rejected", "conflict"] as const;
const FINGERPRINT_LENGTH = 64;
const APPROVAL_NONCE_LENGTH = 64;
const SHA256_LENGTH = 64;

function fail(message: string): never {
  throw new Error(`Invalid protocol message: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inspectKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(inspectKeys);
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) fail(`forbidden key ${key}`);
      inspectKeys(child);
    }
  }
}

function exact(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`unknown field ${key}`);
  }
}

function string(value: unknown, name: string, max = MAX_STRING_LENGTH): asserts value is string {
  if (typeof value !== "string" || value.length > max) fail(`${name} must be a bounded string`);
}

function nonemptyString(value: unknown, name: string): asserts value is string {
  string(value, name);
  if (!value) fail(`${name} must not be empty`);
}

function fingerprint(value: unknown): asserts value is string {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${FINGERPRINT_LENGTH}}$`).test(value)) fail("fingerprint is invalid");
}

function approvalNonce(value: unknown): asserts value is string {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${APPROVAL_NONCE_LENGTH}}$`).test(value)) fail("approvalNonce is invalid");
}
function digest(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${SHA256_LENGTH}}$`).test(value)) fail(`${name} is invalid`); }

function member(value: unknown, name: string, allowed: readonly string[]): asserts value is string {
  string(value, name);
  if (!allowed.includes(value)) fail(`${name} is invalid`);
}

function timestamp(value: unknown, name: string): asserts value is string {
  string(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${name} must be an ISO timestamp`);
  }
}

function integer(value: unknown, name: string, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(`${name} must be an integer >= ${minimum}`);
}

function stringArray(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  value.forEach((item) => string(item, `${name} item`));
}

function nonemptyStringArray(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${name} must be a non-empty array`);
  value.forEach((item) => {
    nonemptyString(item, `${name} item`);
    if (!item.trim()) fail(`${name} item must not be blank`);
  });
}

function requestBase(value: Record<string, unknown>, allowed: readonly string[]): void {
  exact(value, allowed);
  if (value.version !== PROTOCOL_VERSION) fail("unsupported version");
  string(value.requestId, "requestId", MAX_REQUEST_ID_LENGTH);
  if (!value.requestId) fail("requestId must not be empty");
}

function mutationBase(value: Record<string, unknown>, allowed: readonly string[]): void {
  requestBase(value, allowed);
  nonemptyString(value.intentId, "intentId");
}

export function encodeMessage(message: ProtocolMessage): string {
  validateMessage(message);
  const line = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) fail("line is too large");
  return line;
}

export function decodeMessage(line: string): ProtocolMessage {
  if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) fail("line is too large");
  const trimmed = line.endsWith("\n") ? line.slice(0, -1).replace(/\r$/, "") : line;
  if (!trimmed) fail("empty line");
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    fail("malformed JSON");
  }
  inspectKeys(value);
  if (!isRecord(value)) fail("message must be an object");
  validateMessage(value);
  return value as ProtocolMessage;
}

function validateMessage(value: unknown): void {
  if (!isRecord(value)) fail("message must be an object");
  const type = value.type;
  if (typeof type !== "string") fail("type is required");
  switch (type) {
    case "hello":
      requestBase(value, ["type", "version", "requestId", "token"]); string(value.token, "token"); return;
    case "list_missions": case "ping":
      requestBase(value, ["type", "version", "requestId"]); return;
    case "get_mission": case "unsubscribe_mission_events":
      if (type === "get_mission") {
        requestBase(value, ["type", "version", "requestId", "missionId"]); nonemptyString(value.missionId, "missionId");
      } else {
        requestBase(value, ["type", "version", "requestId", "subscriptionId"]); nonemptyString(value.subscriptionId, "subscriptionId");
      }
      return;
    case "subscribe_mission_events":
      requestBase(value, ["type", "version", "requestId", "subscriptionId", "missionId", "afterSequence"]); nonemptyString(value.subscriptionId, "subscriptionId"); nonemptyString(value.missionId, "missionId"); if (value.afterSequence !== undefined) integer(value.afterSequence, "afterSequence"); return;
    case "propose_repository":
      mutationBase(value, ["type", "version", "requestId", "intentId", "localPath"]); nonemptyString(value.localPath, "localPath"); return;
    case "approve_repository":
      mutationBase(value, ["type", "version", "requestId", "intentId", "proposalId", "fingerprint", "approvalNonce"]); nonemptyString(value.proposalId, "proposalId"); fingerprint(value.fingerprint); approvalNonce(value.approvalNonce); return;
    case "create_mission":
      mutationBase(value, ["type", "version", "requestId", "intentId", "repositoryId", "title", "goal", "mode", "plan"]); nonemptyString(value.repositoryId, "repositoryId"); nonemptyString(value.title, "title"); nonemptyString(value.goal, "goal"); member(value.mode, "mission mode", MISSION_MODES); validatePlanInput(value.plan); return;
    case "run_mission":
      mutationBase(value, ["type", "version", "requestId", "intentId", "missionId", "planRevisionId"]); nonemptyString(value.missionId, "missionId"); nonemptyString(value.planRevisionId, "planRevisionId"); return;
    case "cancel_mission":
      mutationBase(value, ["type", "version", "requestId", "intentId", "missionId", "runId"]); nonemptyString(value.missionId, "missionId"); nonemptyString(value.runId, "runId"); return;
    case "inspect_mission":
      requestBase(value, ["type", "version", "requestId", "missionId", "planRevisionId"]); nonemptyString(value.missionId, "missionId"); nonemptyString(value.planRevisionId, "planRevisionId"); return;
    case "promote_mission":
      mutationBase(value, ["type", "version", "requestId", "intentId", "missionId", "planRevisionId", "changeRevision", "contentDigest", "decision", "approvalCapability"]); nonemptyString(value.missionId, "missionId"); nonemptyString(value.planRevisionId, "planRevisionId"); nonemptyString(value.changeRevision, "changeRevision"); digest(value.contentDigest, "contentDigest"); member(value.decision, "decision", PROMOTION_DECISIONS); nonemptyString(value.approvalCapability, "approvalCapability"); return;
    case "hello_ack": case "pong":
      requestBase(value, ["type", "version", "requestId"]); return;
    case "mission_list":
      requestBase(value, ["type", "version", "requestId", "missions"]); if (!Array.isArray(value.missions)) fail("missions must be an array"); value.missions.forEach(validateListItem); return;
    case "mission_snapshot":
      requestBase(value, ["type", "version", "requestId", "mission"]); validateMission(value.mission); return;
    case "repository_proposal":
      requestBase(value, ["type", "version", "requestId", "proposalId", "canonicalRoot", "fingerprint", "approvalNonce", "expiresAt"]); nonemptyString(value.proposalId, "proposalId"); nonemptyString(value.canonicalRoot, "canonicalRoot"); fingerprint(value.fingerprint); approvalNonce(value.approvalNonce); timestamp(value.expiresAt, "expiresAt"); return;
    case "repository_approved":
      requestBase(value, ["type", "version", "requestId", "repositoryId", "fingerprint"]); nonemptyString(value.repositoryId, "repositoryId"); fingerprint(value.fingerprint); return;
    case "mission_created":
      requestBase(value, ["type", "version", "requestId", "mission"]); validateMission(value.mission); return;
    case "mission_run_accepted": case "mission_cancelled":
      requestBase(value, ["type", "version", "requestId", "mission", "runId"]); validateMission(value.mission); nonemptyString(value.runId, "runId"); return;
    case "mission_inspection":
      requestBase(value, ["type", "version", "requestId", "mission", "planRevisionId", "changeRevision", "contentDigest", "review"]); validateMission(value.mission); nonemptyString(value.planRevisionId, "planRevisionId"); nonemptyString(value.changeRevision, "changeRevision"); digest(value.contentDigest, "contentDigest"); validateReview(value.review); return;
    case "mission_promotion":
      requestBase(value, ["type", "version", "requestId", "mission", "planRevisionId", "changeRevision", "decision", "reviewerId", "result"]); validateMission(value.mission); nonemptyString(value.planRevisionId, "planRevisionId"); nonemptyString(value.changeRevision, "changeRevision"); member(value.decision, "decision", PROMOTION_DECISIONS); nonemptyString(value.reviewerId, "reviewerId"); member(value.result, "result", PROMOTION_RESULTS); return;
    case "mission_event":
      requestBase(value, ["type", "version", "requestId", "subscriptionId", "event"]); nonemptyString(value.subscriptionId, "subscriptionId"); validateEvent(value.event); return;
    case "subscribed":
      requestBase(value, ["type", "version", "requestId", "subscriptionId", "missionId", "afterSequence", "replay", "cursor", "highWaterMark", "overflow"]); nonemptyString(value.subscriptionId, "subscriptionId"); nonemptyString(value.missionId, "missionId"); integer(value.afterSequence, "afterSequence"); member(value.replay, "replay", ["live_only", "durable"]); if (value.cursor !== undefined) integer(value.cursor, "cursor"); if (value.highWaterMark !== undefined) integer(value.highWaterMark, "highWaterMark"); if (value.overflow !== undefined) { if (!isRecord(value.overflow)) fail("overflow must be an object"); exact(value.overflow, ["firstAvailableSequence"]); integer(value.overflow.firstAvailableSequence, "firstAvailableSequence", 1); } return;
    case "unsubscribed":
      requestBase(value, ["type", "version", "requestId", "subscriptionId"]); nonemptyString(value.subscriptionId, "subscriptionId"); return;
    case "error":
      requestBase(value, ["type", "version", "requestId", "code", "message"]); string(value.code, "code"); string(value.message, "message"); return;
    default: fail(`unknown message type ${type}`);
  }
}

function validateReview(value: unknown): void {
  if (!isRecord(value)) fail("review must be an object");
  exact(value, ["changes", "evidence"]);
  if (!Array.isArray(value.changes) || !Array.isArray(value.evidence)) fail("review content must use arrays");
  value.changes.forEach((change) => { if (!isRecord(change)) fail("review change must be an object"); exact(change, ["path", "additions", "deletions", "binary", "diff"]); nonemptyString(change.path, "change path"); integer(change.additions, "change additions"); integer(change.deletions, "change deletions"); if (typeof change.binary !== "boolean") fail("change binary must be boolean"); string(change.diff, "change diff"); });
  value.evidence.forEach(validateEvidence);
}

function validateListItem(value: unknown): void {
  if (!isRecord(value)) fail("mission list item must be an object");
  exact(value, ["id", "title", "status", "updatedAt"]);
  nonemptyString(value.id, "mission id"); string(value.title, "mission title"); member(value.status, "mission status", MISSION_STATUSES); timestamp(value.updatedAt, "updatedAt");
}

function validateMission(value: unknown): void {
  if (!isRecord(value)) fail("mission must be an object");
  exact(value, ["id", "title", "goal", "mode", "status", "createdAt", "updatedAt", "targetBranch", "missionBranch", "workspaceId", "plan", "events", "changes", "evidence", "completionSummary", "reviewDecision", "activeRunId"]);
  nonemptyString(value.id, "mission id"); string(value.title, "mission title"); string(value.goal, "mission goal");
  member(value.mode, "mission mode", MISSION_MODES); member(value.status, "mission status", MISSION_STATUSES);
  timestamp(value.createdAt, "mission createdAt"); timestamp(value.updatedAt, "mission updatedAt"); nonemptyString(value.targetBranch, "targetBranch");
  for (const key of ["missionBranch", "workspaceId", "completionSummary", "activeRunId"] as const) if (value[key] !== undefined) string(value[key], key);
  if (value.reviewDecision !== undefined) member(value.reviewDecision, "reviewDecision", REVIEW_DECISIONS);
  validatePlan(value.plan);
  if (!Array.isArray(value.events)) fail("events must be an array"); value.events.forEach(validateEvent);
  if (!Array.isArray(value.changes)) fail("changes must be an array"); value.changes.forEach(validateChange);
  if (!Array.isArray(value.evidence)) fail("evidence must be an array"); value.evidence.forEach(validateEvidence);
}

function validatePlan(value: unknown): void {
  if (!isRecord(value)) fail("plan must be an object");
  exact(value, ["id", "revision", "approved", "createdAt", "scope", "actions", "acceptanceCriteria"]);
  nonemptyString(value.id, "plan id"); integer(value.revision, "plan revision", 1);
  if (typeof value.approved !== "boolean") fail("plan approved must be a boolean");
  timestamp(value.createdAt, "plan createdAt"); string(value.scope, "plan scope"); stringArray(value.actions, "plan actions"); stringArray(value.acceptanceCriteria, "plan acceptanceCriteria");
}

function validatePlanInput(value: unknown): void {
  if (!isRecord(value)) fail("plan must be an object");
  exact(value, ["scope", "actions", "acceptanceCriteria"]);
  nonemptyString(value.scope, "plan scope"); if (!value.scope.trim()) fail("plan scope must not be blank"); nonemptyStringArray(value.actions, "plan actions"); nonemptyStringArray(value.acceptanceCriteria, "plan acceptanceCriteria");
}

function validateEvent(value: unknown): void {
  if (!isRecord(value)) fail("event must be an object");
  exact(value, ["id", "missionId", "runId", "sequence", "timestamp", "kind", "title", "detail", "capability"]);
  nonemptyString(value.id, "event id"); nonemptyString(value.missionId, "event missionId"); nonemptyString(value.runId, "event runId"); integer(value.sequence, "event sequence", 1);
  timestamp(value.timestamp, "event timestamp"); member(value.kind, "event kind", EVENT_KINDS); string(value.title, "event title"); string(value.detail, "event detail");
  if (value.capability !== undefined) validateCapability(value.capability);
}

function validateCapability(value: unknown): void {
  if (!isRecord(value)) fail("capability must be an object");
  exact(value, ["requestId", "runId", "capability", "scope", "reason", "resolved"]);
  nonemptyString(value.requestId, "capability requestId"); nonemptyString(value.runId, "capability runId"); member(value.capability, "capability", CAPABILITIES); string(value.scope, "capability scope"); string(value.reason, "capability reason");
  if (value.resolved !== undefined) member(value.resolved, "capability resolution", CAPABILITY_RESOLUTIONS);
}

function validateChange(value: unknown): void {
  if (!isRecord(value)) fail("change must be an object");
  exact(value, ["path", "additions", "deletions", "diff"]); nonemptyString(value.path, "change path"); integer(value.additions, "change additions"); integer(value.deletions, "change deletions"); string(value.diff, "change diff");
}

function validateEvidence(value: unknown): void {
  if (!isRecord(value)) fail("evidence must be an object");
  exact(value, ["id", "kind", "status", "summary", "criterion", "planRevisionId", "timestamp"]);
  nonemptyString(value.id, "evidence id"); member(value.kind, "evidence kind", EVIDENCE_KINDS); member(value.status, "evidence status", EVIDENCE_STATUSES); string(value.summary, "evidence summary");
  if (value.criterion !== undefined) string(value.criterion, "evidence criterion");
  nonemptyString(value.planRevisionId, "evidence planRevisionId"); timestamp(value.timestamp, "evidence timestamp");
}
