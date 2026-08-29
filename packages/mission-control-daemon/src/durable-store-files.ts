import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { MissionEventSubscriber } from "./authority-ports";
import type { MissionEventRecord, MissionSnapshot } from "./authority-types";
import { hardenPrivatePath } from "./auth";

export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_EVENT_BYTES = 1024 * 1024;
export const MAX_EVENT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const MISSION_MODES = new Set(["explore", "plan", "build", "delegate"]);
const MISSION_STATUSES = new Set(["draft", "planning", "awaiting_approval", "queued", "running", "paused", "blocked", "ready_for_review", "revision_requested", "accepted", "rejected", "failed", "cancelled"]);
const EVENT_KINDS = new Set(["workspace", "context", "execution", "capability_request", "capability_resolution", "change", "verification", "completion", "cancellation", "interruption", "fallback", "error"]);
const HEX_REVISION = /^[0-9a-f]{40,64}$/;

export interface TransactionJournal {
  payloadVersion: 1;
  missionId: string;
  snapshot: MissionSnapshot;
  events: readonly MissionEventRecord[];
  retainedEvents?: readonly MissionEventRecord[];
}

interface StoreContext {
  tail: Promise<void>;
  subscribers: Map<string, Set<MissionEventSubscriber>>;
}

const contexts = new Map<string, StoreContext>();

export function pathsFor(stateDirectory: string) {
  const root = resolve(stateDirectory);
  return { root, missions: join(root, "missions"), events: join(root, "events"), transactions: join(root, "transactions") };
}

function contextFor(stateDirectory: string) {
  const key = resolve(stateDirectory);
  let context = contexts.get(key);
  if (!context) {
    context = { tail: Promise.resolve(), subscribers: new Map() };
    contexts.set(key, context);
  }
  return context;
}

export function enqueue<T>(stateDirectory: string, operation: () => Promise<T>): Promise<T> {
  const context = contextFor(stateDirectory);
  const result = context.tail.then(operation, operation);
  context.tail = result.then(() => undefined, () => undefined);
  return result;
}

export function subscribeToEvents(stateDirectory: string, missionId: string, subscriber: MissionEventSubscriber) {
  assertIdentifier(missionId, "mission id");
  const context = contextFor(stateDirectory);
  let subscribers = context.subscribers.get(missionId);
  if (!subscribers) {
    subscribers = new Set();
    context.subscribers.set(missionId, subscribers);
  }
  subscribers.add(subscriber);
  return { unsubscribe: () => {
    subscribers!.delete(subscriber);
    if (subscribers!.size === 0) context.subscribers.delete(missionId);
  } };
}

export function publishEvents(stateDirectory: string, events: readonly MissionEventRecord[]) {
  const subscribers = contextFor(stateDirectory).subscribers;
  for (const event of events) {
    for (const subscriber of subscribers.get(event.missionId) ?? []) {
      try { subscriber(clone(event)); } catch { /* A durable commit cannot be rolled back by an observer. */ }
    }
  }
}

export async function initialize(stateDirectory: string) {
  const paths = pathsFor(stateDirectory);
  await privateDirectory(paths.root);
  await Promise.all([privateDirectory(paths.missions), privateDirectory(paths.events), privateDirectory(paths.transactions)]);
  await recoverJournals(stateDirectory);
}

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
  else await hardenPrivatePath(path, "win32");
}

export function assertIdentifier(value: string, label: string) {
  if (!IDENTIFIER.test(value)) throw new Error(`Invalid ${label}.`);
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Corrupt ${label}: expected an object.`);
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Corrupt ${label}: unknown field ${unknown}.`);
}

const MISSION_FIELDS = ["id", "title", "goal", "mode", "status", "createdAt", "updatedAt", "targetBranch", "missionBranch", "workspaceId", "plan", "events", "changes", "evidence", "completionSummary", "reviewDecision", "activeRunId", "repositoryId", "fingerprint", "firstEventSequence", "lastEventSequence", "payloadVersion", "currentChangeSnapshot", "currentWorkspace", "intentOutcomes", "operations"];
const EVENT_FIELDS = ["id", "missionId", "runId", "sequence", "timestamp", "kind", "title", "detail", "capability", "payloadVersion", "recordedAt"];

export function assertSnapshot(value: unknown): asserts value is MissionSnapshot {
  assertObject(value, "mission snapshot");
  exact(value, MISSION_FIELDS, "mission snapshot");
  const plan = value.plan;
  if (typeof value.id !== "string" || typeof value.repositoryId !== "string" || typeof value.fingerprint !== "string" || value.payloadVersion !== 1 || !Number.isSafeInteger(value.lastEventSequence) || (value.lastEventSequence as number) < 0 || (value.firstEventSequence !== undefined && (!Number.isSafeInteger(value.firstEventSequence) || (value.firstEventSequence as number) < 1 || (value.firstEventSequence as number) > (value.lastEventSequence as number) + 1)) || typeof value.title !== "string" || typeof value.goal !== "string" || typeof value.mode !== "string" || !MISSION_MODES.has(value.mode) || typeof value.status !== "string" || !MISSION_STATUSES.has(value.status) || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" || typeof value.targetBranch !== "string" || !Array.isArray(value.events) || !Array.isArray(value.changes) || !Array.isArray(value.evidence) || plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("Corrupt mission snapshot record.");
  }
  const planRecord = plan as Record<string, unknown>;
  exact(planRecord, ["id", "revision", "approved", "createdAt", "scope", "actions", "acceptanceCriteria"], "mission plan");
  if (typeof planRecord.id !== "string" || !Number.isSafeInteger(planRecord.revision) || typeof planRecord.approved !== "boolean" || typeof planRecord.createdAt !== "string" || typeof planRecord.scope !== "string" || !Array.isArray(planRecord.actions) || !planRecord.actions.every((item) => typeof item === "string") || !Array.isArray(planRecord.acceptanceCriteria) || !planRecord.acceptanceCriteria.every((item) => typeof item === "string")) throw new Error("Corrupt mission snapshot record.");
  assertIdentifier(value.id, "mission id");
  assertIdentifier(value.repositoryId, "repository id");
  for (const event of value.events) assertDomainEvent(event);
  for (const change of value.changes) assertChange(change, false);
  for (const evidence of value.evidence) assertEvidence(evidence);
  if (value.currentWorkspace !== undefined) assertWorkspace(value.currentWorkspace);
  if (value.currentChangeSnapshot !== undefined) assertChangeSnapshot(value.currentChangeSnapshot);
  if (value.intentOutcomes !== undefined) assertOutcomes(value.intentOutcomes);
  if (value.operations !== undefined) assertOperations(value.operations);
}

export function assertEvent(value: unknown): asserts value is MissionEventRecord {
  assertObject(value, "mission event");
  exact(value, EVENT_FIELDS, "mission event");
  if (value.payloadVersion !== 1 || typeof value.id !== "string" || typeof value.missionId !== "string" || typeof value.runId !== "string" || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 || typeof value.timestamp !== "string" || typeof value.recordedAt !== "string" || typeof value.kind !== "string" || !EVENT_KINDS.has(value.kind) || typeof value.title !== "string" || typeof value.detail !== "string") {
    throw new Error("Corrupt mission event record.");
  }
  assertIdentifier(value.id, "event id");
  assertIdentifier(value.missionId, "mission id");
  assertIdentifier(value.runId, "run id");
  if (value.capability !== undefined) assertCapability(value.capability);
}

function assertDomainEvent(value: unknown) {
  assertObject(value, "mission event");
  exact(value, EVENT_FIELDS, "mission event");
  if (value.payloadVersion !== undefined || value.recordedAt !== undefined) {
    assertEvent(value);
    return;
  }
  const record = { ...value, payloadVersion: 1, recordedAt: value.timestamp };
  assertEvent(record);
}

function assertCapability(value: unknown) {
  assertObject(value, "capability");
  exact(value, ["requestId", "runId", "capability", "scope", "reason", "resolved"], "capability");
  if (typeof value.requestId !== "string" || typeof value.runId !== "string" || typeof value.capability !== "string" || typeof value.scope !== "string" || typeof value.reason !== "string") throw new Error("Corrupt capability record.");
}

function assertChange(value: unknown, binary: boolean) {
  assertObject(value, "change");
  exact(value, binary ? ["path", "additions", "deletions", "binary", "diff"] : ["path", "additions", "deletions", "diff"], "change");
  if (typeof value.path !== "string" || !Number.isSafeInteger(value.additions) || !Number.isSafeInteger(value.deletions) || typeof value.diff !== "string" || (binary && typeof value.binary !== "boolean")) throw new Error("Corrupt change record.");
}

function assertEvidence(value: unknown) {
  assertObject(value, "evidence");
  exact(value, ["id", "kind", "status", "summary", "criterion", "planRevisionId", "timestamp"], "evidence");
  if (typeof value.id !== "string" || typeof value.kind !== "string" || typeof value.status !== "string" || typeof value.summary !== "string" || typeof value.planRevisionId !== "string" || typeof value.timestamp !== "string") throw new Error("Corrupt evidence record.");
}

function assertWorkspace(value: unknown) {
  assertObject(value, "workspace");
  exact(value, ["id", "missionId", "repositoryRoot", "worktreePath", "targetBranch", "missionBranch", "initialRevision"], "workspace");
  if (["id", "missionId", "repositoryRoot", "worktreePath", "targetBranch", "missionBranch", "initialRevision"].some((key) => typeof value[key] !== "string")) throw new Error("Corrupt workspace record.");
  assertIdentifier(value.id as string, "workspace id");
  assertIdentifier(value.missionId as string, "mission id");
  if (!HEX_REVISION.test(value.initialRevision as string)) throw new Error("Corrupt workspace record.");
}

function assertChangeSnapshot(value: unknown) {
  assertObject(value, "change snapshot");
  exact(value, ["revision", "files", "unifiedDiff"], "change snapshot");
  if (typeof value.revision !== "string" || typeof value.unifiedDiff !== "string" || !Array.isArray(value.files)) throw new Error("Corrupt change snapshot record.");
  for (const file of value.files) assertChange(file, true);
}

function assertOutcomes(value: unknown) {
  assertObject(value, "intent outcomes");
  for (const [intentId, outcome] of Object.entries(value)) {
    assertIdentifier(intentId, "intent id");
    assertObject(outcome, "intent outcome");
    exact(outcome, ["operation", "requestDigest", "result"], "intent outcome");
    if (typeof outcome.operation !== "string" || typeof outcome.requestDigest !== "string" || !/^[0-9a-f]{64}$/.test(outcome.requestDigest)) throw new Error("Corrupt intent outcome record.");
    if (outcome.operation === "create" || outcome.operation === "cancel") assertSnapshot(outcome.result);
    else if (outcome.operation === "run") assertRunResult(outcome.result);
    else if (outcome.operation === "promote") assertMissionPromotionResult(outcome.result);
    else throw new Error("Corrupt intent outcome record.");
  }
}

function assertOperations(value: unknown) {
  assertObject(value, "mission operations");
  for (const [intentId, operation] of Object.entries(value)) {
    assertIdentifier(intentId, "operation id");
    assertObject(operation, "mission operation");
    if (!new Set(["run", "promote"]).has(String(operation.operation)) || !new Set(["prepared", "in_progress", "committed"]).has(String(operation.state)) || typeof operation.requestDigest !== "string" || !/^[0-9a-f]{64}$/.test(operation.requestDigest)) throw new Error("Corrupt mission operation record.");
    if (operation.operation === "run") {
      exact(operation, operation.state === "committed" ? ["operation", "requestDigest", "state", "runId", "result"] : ["operation", "requestDigest", "state", "runId"], "mission operation");
      if (typeof operation.runId !== "string") throw new Error("Corrupt mission operation record.");
      assertIdentifier(operation.runId, "run id");
      if (operation.state === "committed") assertRunResult(operation.result);
    } else {
      const fields = operation.state === "committed" ? ["operation", "requestDigest", "state", "reviewerId", "result"] : operation.state === "in_progress" ? ["operation", "requestDigest", "state", "reviewerId", "token"] : ["operation", "requestDigest", "state", "reviewerId"];
      exact(operation, fields, "mission operation");
      if (typeof operation.reviewerId !== "string") throw new Error("Corrupt mission operation record.");
      assertIdentifier(operation.reviewerId, "reviewer id");
      if (operation.state === "committed") assertMissionPromotionResult(operation.result);
      else if (operation.state === "in_progress") assertPromotionRetryToken(operation.token);
    }
  }
}

function assertRunResult(value: unknown) {
  assertObject(value, "run result");
  exact(value, ["missionId", "runId", "planRevisionId", "status", "mission", "workspace", "changeSnapshot"], "run result");
  if (typeof value.missionId !== "string" || typeof value.runId !== "string" || typeof value.planRevisionId !== "string" || typeof value.status !== "string" || !MISSION_STATUSES.has(value.status)) throw new Error("Corrupt run result.");
  assertIdentifier(value.missionId, "mission id");
  assertIdentifier(value.runId, "run id");
  assertIdentifier(value.planRevisionId.replace(":", "-"), "plan revision id");
  assertSnapshot(value.mission);
  assertObject(value.workspace, "public workspace");
  exact(value.workspace, ["handle"], "public workspace");
  if (typeof value.workspace.handle !== "string") throw new Error("Corrupt public workspace.");
  assertIdentifier(value.workspace.handle, "workspace handle");
  assertChangeSnapshot(value.changeSnapshot);
}

function assertMissionPromotionResult(value: unknown) {
  assertObject(value, "mission promotion result");
  exact(value, ["mission", "result", "reviewerId"], "mission promotion result");
  if (typeof value.reviewerId !== "string") throw new Error("Corrupt mission promotion result.");
  assertIdentifier(value.reviewerId, "reviewer id");
  assertSnapshot(value.mission);
  assertPromotionResult(value.result);
}

function assertPromotionResult(value: unknown) {
  assertObject(value, "promotion result");
  if (value.status === "promoted") {
    exact(value, ["status", "revision"], "promotion result");
    if (typeof value.revision !== "string" || !HEX_REVISION.test(value.revision)) throw new Error("Corrupt promotion result.");
  } else if (value.status === "rejected") {
    exact(value, ["status"], "promotion result");
  } else if (value.status === "conflict") {
    exact(value, value.retry === undefined ? ["status", "reason"] : ["status", "reason", "retry"], "promotion result");
    if (typeof value.reason !== "string") throw new Error("Corrupt promotion result.");
    if (value.retry !== undefined) assertPromotionRetryToken(value.retry);
  } else throw new Error("Corrupt promotion result.");
}

function assertPromotionRetryToken(value: unknown) {
  assertObject(value, "promotion retry token");
  exact(value, ["missionRevision", "expectedTargetRevision", "targetBranch", "workspace", "missionParent", "missionTree"], "promotion retry token");
  if (["missionRevision", "expectedTargetRevision", "targetBranch", "missionParent", "missionTree"].some((key) => typeof value[key] !== "string")) throw new Error("Corrupt promotion retry token.");
  if (![value.missionRevision, value.expectedTargetRevision, value.missionParent, value.missionTree].every((revision) => HEX_REVISION.test(revision as string))) throw new Error("Corrupt promotion retry token.");
  assertWorkspace(value.workspace);
}

async function boundedRead(path: string, maximumBytes: number, label: string) {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`Corrupt ${label}: expected a regular file.`);
  if (details.size > maximumBytes) throw new Error(`${label} is too large.`);
  return readFile(path, "utf8");
}

function parseJson(text: string, label: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { throw new Error(`Corrupt ${label}: invalid JSON.`); }
}

export async function readSnapshotFile(path: string): Promise<MissionSnapshot> {
  const value = parseJson(await boundedRead(path, MAX_SNAPSHOT_BYTES, "mission snapshot"), "mission snapshot");
  assertSnapshot(value);
  return value;
}

export async function atomicWriteJson(path: string, value: unknown, maximumBytes: number) {
  const data = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(data) > maximumBytes) throw new Error("Persistent record is too large.");
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try { await handle.writeFile(data, "utf8"); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporaryPath, path); await syncParent(path); } catch (error) { await rm(temporaryPath, { force: true }); throw error; }
}

async function syncParent(path: string) {
  if (process.platform === "win32") return;
  const handle = await open(dirname(path), "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function serializeEvent(event: MissionEventRecord) {
  const line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new Error("Mission event is too large.");
  return line;
}

export async function appendAndFlush(path: string, events: readonly MissionEventRecord[]) {
  if (events.length === 0) return;
  const handle = await open(path, "a", 0o600);
  try { await handle.writeFile(events.map(serializeEvent).join(""), "utf8"); await handle.sync(); } finally { await handle.close(); }
}

interface EventFile { records: MissionEventRecord[]; completeBytes: number; remainder: string }

async function readEventFile(path: string, allowIncompleteTail = false): Promise<EventFile> {
  let text: string;
  try { text = await boundedRead(path, MAX_EVENT_FILE_BYTES, "mission event log"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], completeBytes: 0, remainder: "" }; throw error; }
  const lastNewline = text.lastIndexOf("\n");
  const complete = lastNewline < 0 ? "" : text.slice(0, lastNewline + 1);
  const remainder = lastNewline < 0 ? text : text.slice(lastNewline + 1);
  if (remainder && !allowIncompleteTail) throw new Error("Corrupt mission event log: incomplete JSONL record.");
  const records = complete.split("\n").filter(Boolean).map((line) => {
    if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new Error("Mission event is too large.");
    const value = parseJson(line, "mission event log");
    assertEvent(value);
    return value;
  });
  return { records, completeBytes: Buffer.byteLength(complete), remainder };
}

export async function readEvents(stateDirectory: string, missionId: string) {
  assertIdentifier(missionId, "mission id");
  const file = await readEventFile(join(pathsFor(stateDirectory).events, `${missionId}.jsonl`));
  validateEventHistory(file.records, missionId);
  return file.records;
}

export function validateEventHistory(events: readonly MissionEventRecord[], missionId: string) {
  const firstSequence = events[0]?.sequence ?? 1;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].missionId !== missionId || events[index].sequence !== firstSequence + index) throw new Error(`Corrupt mission event log for ${missionId}: sequence is not contiguous.`);
  }
}

export function clone<T>(value: T): T { return structuredClone(value); }

export async function assertSnapshotConsistent(stateDirectory: string, snapshot: MissionSnapshot) {
  const events = await readEvents(stateDirectory, snapshot.id);
  const firstEventSequence = snapshot.firstEventSequence ?? 1;
  if ((events[0]?.sequence ?? snapshot.lastEventSequence + 1) !== firstEventSequence || events.length !== Math.max(0, snapshot.lastEventSequence - firstEventSequence + 1)) throw new Error(`Inconsistent mission persistence for ${snapshot.id}: snapshot/event sequence mismatch.`);
  const domainEvent = ({ payloadVersion: _payloadVersion, recordedAt: _recordedAt, ...event }: MissionEventRecord) => event;
  if (!isDeepStrictEqual(snapshot.events.map((event) => domainEvent(event as MissionEventRecord)), events.map(domainEvent))) throw new Error(`Inconsistent mission persistence for ${snapshot.id}: snapshot event differs from event log.`);
}

export async function writeJournal(stateDirectory: string, journal: TransactionJournal) {
  assertJournal(journal);
  await atomicWriteJson(join(pathsFor(stateDirectory).transactions, `${journal.missionId}.json`), journal, MAX_JOURNAL_BYTES);
}

export async function removeJournal(stateDirectory: string, missionId: string) {
  const path = join(pathsFor(stateDirectory).transactions, `${missionId}.json`);
  await rm(path);
  await syncParent(path);
}

function assertJournal(value: unknown): asserts value is TransactionJournal {
  assertObject(value, "transaction journal");
  exact(value, ["payloadVersion", "missionId", "snapshot", "events", "retainedEvents"], "transaction journal");
  if (value.payloadVersion !== 1 || typeof value.missionId !== "string" || !Array.isArray(value.events)) throw new Error("Corrupt transaction journal record.");
  assertIdentifier(value.missionId, "mission id");
  assertSnapshot(value.snapshot);
  for (const event of value.events) assertEvent(event);
  if (value.retainedEvents !== undefined) {
    if (!Array.isArray(value.retainedEvents)) throw new Error("Corrupt transaction journal record.");
    for (const event of value.retainedEvents) assertEvent(event);
  }
  if (value.snapshot.id !== value.missionId) throw new Error("Corrupt transaction journal: mission mismatch.");
}

async function recoverJournals(stateDirectory: string) {
  const paths = pathsFor(stateDirectory);
  const entries = await readdir(paths.transactions, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) throw new Error("Corrupt transaction journal directory.");
    const value = parseJson(await boundedRead(join(paths.transactions, entry.name), MAX_JOURNAL_BYTES, "transaction journal"), "transaction journal");
    assertJournal(value);
    if (entry.name !== `${value.missionId}.json`) throw new Error("Corrupt transaction journal filename.");
    await completeJournal(stateDirectory, value);
  }
}

async function completeJournal(stateDirectory: string, journal: TransactionJournal) {
  const paths = pathsFor(stateDirectory);
  const eventPath = join(paths.events, `${journal.missionId}.jsonl`);
  const file = await readEventFile(eventPath, true);
  validateEventHistory(file.records, journal.missionId);
  if (journal.retainedEvents) {
    validateEventHistory(journal.retainedEvents, journal.missionId);
    await replaceEvents(eventPath, journal.retainedEvents);
    await atomicWriteJson(join(paths.missions, `${journal.missionId}.json`), journal.snapshot, MAX_SNAPSHOT_BYTES);
    await removeJournal(stateDirectory, journal.missionId);
    await assertSnapshotConsistent(stateDirectory, journal.snapshot);
    return;
  }
  const firstSequence = journal.events[0]?.sequence ?? journal.snapshot.lastEventSequence + 1;
  const baseSequence = firstSequence - 1;
  const targetSequence = journal.snapshot.lastEventSequence;
  if (journal.events.some((event, index) => event.missionId !== journal.missionId || event.sequence !== firstSequence + index) || baseSequence + journal.events.length !== targetSequence || file.records.length < baseSequence || file.records.length > targetSequence) throw new Error("Corrupt transaction journal sequence.");
  for (let index = baseSequence; index < file.records.length; index += 1) {
    if (JSON.stringify(file.records[index]) !== JSON.stringify(journal.events[index - baseSequence])) throw new Error("Corrupt transaction journal: persisted event differs from journal.");
  }
  const remaining = journal.events.slice(file.records.length - baseSequence);
  const remainingData = remaining.map(serializeEvent).join("");
  if (file.remainder) {
    if (!remainingData.startsWith(file.remainder)) throw new Error("Corrupt transaction journal: incomplete event differs from journal.");
    await truncate(eventPath, file.completeBytes);
  }
  await appendAndFlush(eventPath, remaining);
  const snapshotPath = join(paths.missions, `${journal.missionId}.json`);
  try {
    const current = await readSnapshotFile(snapshotPath);
    if (current.id !== journal.missionId || ![baseSequence, targetSequence].includes(current.lastEventSequence)) throw new Error("Corrupt transaction journal: snapshot sequence cannot be recovered.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (baseSequence !== 0) throw new Error("Corrupt transaction journal: prior snapshot is missing.");
  }
  await atomicWriteJson(snapshotPath, journal.snapshot, MAX_SNAPSHOT_BYTES);
  await removeJournal(stateDirectory, journal.missionId);
  await assertSnapshotConsistent(stateDirectory, journal.snapshot);
}

export async function appendEventsDirect(stateDirectory: string, events: readonly MissionEventRecord[], options: { maxEventFileBytes?: number; retainedEventCount?: number } = {}) {
  const grouped = new Map<string, MissionEventRecord[]>();
  for (const event of events) { assertEvent(event); const group = grouped.get(event.missionId) ?? []; group.push(event); grouped.set(event.missionId, group); }
  for (const [missionId, additions] of grouped) {
    const existing = await readEvents(stateDirectory, missionId);
    const expected = (existing.at(-1)?.sequence ?? 0) + 1;
    if (additions.some((event, index) => event.sequence !== expected + index)) throw new Error(`Mission event sequence must be contiguous; expected ${expected}.`);
    const path = join(pathsFor(stateDirectory).events, `${missionId}.jsonl`);
    const maximumBytes = options.maxEventFileBytes ?? MAX_EVENT_FILE_BYTES;
    const additionData = additions.map(serializeEvent).join("");
    const existingBytes = Buffer.byteLength(existing.map(serializeEvent).join(""));
    if (Buffer.byteLength(additionData) > maximumBytes) throw new Error("Mission event append exceeds the event log quota.");
    if (existingBytes + Buffer.byteLength(additionData) > maximumBytes) {
      await retainEvents(path, existing, options.retainedEventCount ?? 256, maximumBytes - Buffer.byteLength(additionData));
    }
    await appendAndFlush(path, additions);
  }
}

export async function retainedEvents(events: readonly MissionEventRecord[], retainedCount: number, byteBudget: number): Promise<readonly MissionEventRecord[]> {
  const retained: string[] = [];
  let bytes = 0;
  for (const event of events.slice(-Math.max(0, retainedCount)).reverse()) {
    const line = serializeEvent(event);
    const size = Buffer.byteLength(line);
    if (bytes + size > byteBudget) break;
    retained.unshift(line);
    bytes += size;
  }
  return retained.map((line) => JSON.parse(line) as MissionEventRecord);
}

export async function replaceEvents(path: string, events: readonly MissionEventRecord[]) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try { await handle.writeFile(events.map(serializeEvent).join(""), "utf8"); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporaryPath, path); await syncParent(path); } catch (error) { await rm(temporaryPath, { force: true }); throw error; }
}

export async function retainEvents(path: string, events: readonly MissionEventRecord[], retainedCount: number, byteBudget: number): Promise<void> {
  const retained = await retainedEvents(events, retainedCount, byteBudget);
  await replaceEvents(path, retained);
}
