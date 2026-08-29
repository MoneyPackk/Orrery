import { createHash } from "node:crypto";
import { createMission, transitionMission, type Mission, type MissionEvent } from "@orrery/mission-control-domain";
import type {
  MissionRepository,
  MissionRunner,
  PromotionService,
  RunMissionResult,
  VerificationCommand,
  WorkspaceService,
} from "../../mission-kernel/src";
import type { MissionEventStore, MissionStore, RepositoryRegistry } from "./authority-ports";
import type {
  CancelMissionAuthorityInput,
  CreateMissionAuthorityInput,
  InspectMissionAuthorityInput,
  MissionEventRecord,
  MissionInspectionResult,
  MissionIntentOutcome,
  MissionOperation,
  MissionPromotionResult,
  MissionSnapshot,
  PublicRunMissionResult,
  PromoteMissionAuthorityInput,
  RunMissionAuthorityInput,
} from "./authority-types";
import type { PromotionApprovalVerifier } from "./promotion-approval";
import { publicMission } from "./public-mission";

export interface MissionAuthorityOptions {
  missionStore: MissionStore;
  eventStore: MissionEventStore;
  repositoryRegistry: RepositoryRegistry;
  missionRunner: MissionRunner;
  promotionService: PromotionService;
  workspaceService: WorkspaceService;
  verificationCommandResolver: (context: VerificationCommandContext) => Promise<VerificationCommand | undefined> | VerificationCommand | undefined;
  promotionApprovalVerifier: PromotionApprovalVerifier;
  now?: () => string;
  id?: () => string;
}

export interface VerificationCommandContext {
  readonly repositoryId: string;
  readonly missionId: string;
  readonly title: string;
  readonly intentId: string;
}

interface ActiveRun {
  runId: string;
  intentId: string;
  controller: AbortController;
  promise: Promise<PublicRunMissionResult>;
}

export class MissionAuthority {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly mutationTails = new Map<string, Promise<void>>();
  private createTail: Promise<void> = Promise.resolve();
  private readonly now: () => string;
  private readonly id: () => string;
  private shuttingDown = false;

  constructor(private readonly options: MissionAuthorityOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? (() => crypto.randomUUID());
  }

  async create(input: CreateMissionAuthorityInput): Promise<MissionSnapshot> {
    this.assertMutable();
    return this.serializeCreate(async () => {
      const digest = requestDigest(input);
      const replay = await this.findCreateOutcome(input.intentId, digest);
      if (replay) return replay;
      const approved = await this.options.repositoryRegistry.resolve(input.repositoryId);
      let mission = createMission({ title: input.title, goal: input.goal, mode: input.mode, plan: input.plan });
      mission = transitionMission(mission, { type: "submit_plan" });
      const snapshot: MissionSnapshot = {
        ...mission,
        repositoryId: approved.repositoryId,
        fingerprint: approved.fingerprint,
        lastEventSequence: 0,
        payloadVersion: 1,
      };
      const persisted = this.withOutcome(snapshot, input.intentId, { operation: "create", requestDigest: digest, result: snapshot });
      await this.options.missionStore.create(persisted);
      return structuredClone(snapshot);
    });
  }

  async run(input: RunMissionAuthorityInput): Promise<PublicRunMissionResult> {
    this.assertMutable();
    const claimed = await this.serialize(input.missionId, async () => {
      const mission = await this.load(input.missionId);
      const digest = requestDigest(input);
      const replay = this.outcome(mission, input.intentId, "run", digest);
      if (replay) return { promise: Promise.resolve(this.publicRunResult(replay.result)) };
      const active = this.activeRuns.get(input.missionId);
      if (active?.intentId === input.intentId) return { promise: active.promise };
      const pending = this.operation(mission, input.intentId, "run", digest);
      if (pending) {
        if (!mission.activeRunId && mission.currentWorkspace && mission.currentChangeSnapshot) {
          const result: PublicRunMissionResult = { missionId: mission.id, runId: pending.runId, planRevisionId: input.planRevisionId, status: mission.status, mission: this.publicMission(mission), workspace: this.publicWorkspace(mission.currentWorkspace), changeSnapshot: mission.currentChangeSnapshot };
          return { promise: this.commitRun(mission, input.intentId, digest, result) };
        }
        throw new Error("Mission run was interrupted before a terminal result was durable.");
      }
      if (mission.plan.id !== input.planRevisionId) throw new Error("Mission plan revision does not match the current plan.");
      if (active) throw new Error("Mission already has an active run.");
      const approved = await this.options.repositoryRegistry.resolve(mission.repositoryId);
      if (approved.fingerprint !== mission.fingerprint) throw new Error("Approved repository fingerprint does not match the mission.");
      const queued = transitionMission(mission, { type: "approve_plan" });
      const runId = this.id();
      const prepared = this.withOperation(queued as MissionSnapshot, input.intentId, { operation: "run", requestDigest: digest, state: "prepared", runId });
      await this.options.missionStore.save(prepared, []);
      await this.options.missionStore.save(this.withOperation(prepared, input.intentId, { operation: "run", requestDigest: digest, state: "in_progress", runId }), []);
      const controller = new AbortController();
      const repository = this.runnerRepository();
      const verificationCommand = await this.options.verificationCommandResolver({
        repositoryId: approved.repositoryId,
        missionId: mission.id,
        title: mission.title,
        intentId: input.intentId,
      });
      let resolveRun!: (result: PublicRunMissionResult) => void;
      let rejectRun!: (error: unknown) => void;
      const runPromise = new Promise<PublicRunMissionResult>((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
      this.activeRuns.set(input.missionId, { runId, intentId: input.intentId, controller, promise: runPromise });
      void this.options.missionRunner.run({
        mission: queued,
        repositoryRoot: approved.canonicalRoot,
        targetBranch: queued.targetBranch,
        runId,
        planRevisionId: input.planRevisionId,
        verificationCommand,
        signal: controller.signal,
        repository,
        onEvent: async () => undefined,
      }).then(async (result) => {
        const current = await this.load(input.missionId);
        const enriched: MissionSnapshot = {
          ...current,
          ...result.mission,
          changes: result.mission.changes.map(({ path, additions, deletions, diff }) => ({ path, additions, deletions, diff })),
          evidence: result.mission.evidence.map(({ id, kind, status, summary, criterion, planRevisionId, timestamp }) => ({
            id, kind, status, summary, ...(criterion === undefined ? {} : { criterion }), planRevisionId, timestamp,
          })),
          repositoryId: current.repositoryId,
          fingerprint: current.fingerprint,
          payloadVersion: 1,
          lastEventSequence: result.mission.events.length,
          intentOutcomes: current.intentOutcomes,
          operations: current.operations,
          currentWorkspace: structuredClone(result.workspace),
          currentChangeSnapshot: structuredClone(result.changeSnapshot),
        };
        enriched.events = enriched.events.map((event) => this.publicEvent(event));
        const storedResult: PublicRunMissionResult = {
          missionId: result.missionId,
          runId: result.runId,
          planRevisionId: result.planRevisionId,
          status: result.status,
          mission: this.publicMission(enriched),
          workspace: this.publicWorkspace(result.workspace),
          changeSnapshot: result.changeSnapshot,
        };
        const durableResult = { ...storedResult, mission: enriched };
        await this.options.missionStore.save(this.withOutcome(this.withOperation(enriched, input.intentId, { operation: "run", requestDigest: digest, state: "committed", runId, result: durableResult }), input.intentId, { operation: "run", requestDigest: digest, result: durableResult }), []);
        return structuredClone(storedResult);
      }).finally(() => {
        if (this.activeRuns.get(input.missionId)?.runId === runId) this.activeRuns.delete(input.missionId);
      }).then(resolveRun, rejectRun);
      return { promise: runPromise };
    });
    return claimed.promise;
  }

  async cancel(input: CancelMissionAuthorityInput): Promise<MissionSnapshot> {
    this.assertMutable();
    const runPromise = await this.serialize(input.missionId, async () => {
      const mission = await this.load(input.missionId);
      const digest = requestDigest(input);
      const replay = this.outcome(mission, input.intentId, "cancel", digest);
      if (replay) return { promise: Promise.resolve(), replay: replay.result };
      const active = this.activeRuns.get(input.missionId);
      if (!active || active.runId !== input.runId) throw new Error("Cancellation does not match the active run.");
      active.controller.abort();
      return { promise: active.promise.then(() => undefined, () => undefined) };
    });
    if (runPromise.replay) return structuredClone(runPromise.replay);
    await runPromise.promise;
    return this.serialize(input.missionId, async () => {
      const current = await this.load(input.missionId);
      if (current.status !== "cancelled") throw new Error("Mission runner completed without durable cancellation state.");
      const operations = { ...current.operations };
      const runOperation = Object.entries(operations).find(([, operation]) => operation.operation === "run" && operation.runId === input.runId);
      if (runOperation) delete operations[runOperation[0]];
      const cancelled = { ...current, operations };
      const persisted = this.withOutcome(cancelled, input.intentId, { operation: "cancel", requestDigest: requestDigest(input), result: cancelled });
      await this.options.missionStore.save(persisted, []);
      return structuredClone(cancelled);
    });
  }

  async inspect(input: InspectMissionAuthorityInput): Promise<MissionInspectionResult> {
    return this.serialize(input.missionId, async () => {
      const mission = await this.load(input.missionId);
      this.assertPlan(mission, input.planRevisionId);
      if (!mission.currentWorkspace) throw new Error("Mission has no durable workspace to inspect.");
      const changeSnapshot = await this.options.workspaceService.inspectChanges(mission.currentWorkspace);
      return { mission: this.publicMission(mission), workspace: this.publicWorkspace(mission.currentWorkspace), changeSnapshot, planRevisionId: input.planRevisionId };
    });
  }

  async promote(input: PromoteMissionAuthorityInput): Promise<MissionPromotionResult> {
    this.assertMutable();
    return this.serialize(input.missionId, async () => {
      const mission = await this.load(input.missionId);
      const digest = requestDigest(input);
      const replay = this.outcome(mission, input.intentId, "promote", digest);
      if (replay) return this.publicPromotionResult(replay.result);
      const pending = this.operation(mission, input.intentId, "promote", digest);
      if (pending?.state === "in_progress") {
        const reconciled = await this.options.promotionService.reconcilePromotion(pending.token);
        const result = reconciled.status === "pending" ? await this.options.promotionService.commitPromotion(pending.token, pending.reviewerId) : reconciled;
        return this.commitPromotion(mission, input.intentId, digest, pending.reviewerId, result);
      }
      if (input.decision !== "accepted" && input.decision !== "rejected") throw new Error("Promotion decision must be accepted or rejected.");
      const approval = this.options.promotionApprovalVerifier.consume({ capability: input.approvalCapability, missionId: input.missionId, planRevisionId: input.planRevisionId, changeRevision: input.changeRevision, decision: input.decision });
      this.assertPlan(mission, input.planRevisionId);
      if (!mission.currentWorkspace || !mission.currentChangeSnapshot) throw new Error("Mission has no durable reviewed workspace.");
      if (mission.currentChangeSnapshot.revision !== input.changeRevision) throw new Error("Mission change revision does not match the reviewed snapshot.");
      await this.options.missionStore.save(this.withOperation(mission, input.intentId, { operation: "promote", requestDigest: digest, state: "prepared", reviewerId: approval.reviewerId }), []);
      const prepared = await this.options.promotionService.preparePromotion({
        mission,
        workspace: mission.currentWorkspace,
        planRevisionId: input.planRevisionId,
        changeSnapshot: mission.currentChangeSnapshot,
        reviewerId: approval.reviewerId,
        decision: input.decision,
      });
      if (prepared.status !== "prepared") return this.commitPromotion(mission, input.intentId, digest, approval.reviewerId, prepared);
      const inProgress = this.withOperation(mission, input.intentId, { operation: "promote", requestDigest: digest, state: "in_progress", reviewerId: approval.reviewerId, token: prepared.token });
      await this.options.missionStore.save(inProgress, []);
      const result = await this.options.promotionService.commitPromotion(prepared.token, approval.reviewerId);
      return this.commitPromotion(inProgress, input.intentId, digest, approval.reviewerId, result);
    });
  }

  private async commitPromotion(mission: MissionSnapshot, intentId: string, digest: string, reviewerId: string, result: Awaited<ReturnType<PromotionService["commitPromotion"]>>): Promise<MissionPromotionResult> {
      const decision = result.status === "rejected" ? "rejected" : "accepted";
      const reviewed = decision === "rejected"
        ? transitionMission(mission, { type: "reject" })
        : result.status === "promoted"
          ? transitionMission(mission, { type: "accept" })
          : mission;
      const reviewedSnapshot: MissionSnapshot = { ...mission, ...reviewed };
      const outcome: MissionPromotionResult = { mission: this.publicMission(reviewedSnapshot), result, reviewerId };
      const existing = mission.operations?.[intentId];
      const durableOutcome = { ...outcome, mission: reviewedSnapshot };
      const committed = this.withOperation(reviewedSnapshot, intentId, { operation: "promote", requestDigest: digest, state: "committed", reviewerId, result: durableOutcome });
      await this.options.missionStore.save(this.withOutcome(committed, intentId, { operation: "promote", requestDigest: digest, result: durableOutcome }), []);
      return structuredClone(outcome);
  }

  async shutdown(timeoutMs = 5_000): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const runs = [...this.activeRuns.values()];
    runs.forEach((run) => run.controller.abort());
    if (runs.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(runs.map((run) => run.promise)),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private assertMutable(): void {
    if (this.shuttingDown) throw new Error("Mission authority is shutting down and cannot accept new mutations.");
  }

  private runnerRepository(): MissionRepository {
    return {
      load: async (missionId) => this.options.missionStore.load(missionId),
      save: async (mission) => {
        const current = await this.load(mission.id);
        const additions = mission.events.slice(current.events.length);
        const publicEvents = additions.map((event) => this.publicEvent(event));
        const records = publicEvents.map((event) => this.record(event));
        const snapshot: MissionSnapshot = {
          ...current,
          ...mission,
          changes: mission.changes.map(({ path, additions, deletions, diff }) => ({ path, additions, deletions, diff })),
          evidence: mission.evidence.map(({ id, kind, status, summary, criterion, planRevisionId, timestamp }) => ({
            id, kind, status, summary, ...(criterion === undefined ? {} : { criterion }), planRevisionId, timestamp,
          })),
          events: [...current.events, ...publicEvents],
          repositoryId: current.repositoryId,
          fingerprint: current.fingerprint,
          payloadVersion: 1,
          lastEventSequence: current.lastEventSequence + records.length,
          intentOutcomes: current.intentOutcomes,
          operations: current.operations,
        };
        await this.options.missionStore.save(snapshot, records);
      },
    };
  }

  private record(event: MissionEvent): MissionEventRecord {
    return { ...event, payloadVersion: 1, recordedAt: this.now() };
  }

  private publicEvent(event: MissionEvent): MissionEvent {
    const { payloadVersion: _payloadVersion, recordedAt: _recordedAt, ...publicEvent } = event as MissionEvent & { payloadVersion?: number; recordedAt?: string };
    if (publicEvent.kind !== "workspace") return structuredClone(publicEvent);
    return { ...publicEvent, detail: `workspace-${publicEvent.missionId}` };
  }

  private publicWorkspace(workspace: { id: string }) {
    return { handle: workspace.id };
  }

  private publicRunResult(result: PublicRunMissionResult): PublicRunMissionResult {
    return structuredClone({ ...result, mission: this.publicMission(result.mission) });
  }

  private publicPromotionResult(result: MissionPromotionResult): MissionPromotionResult {
    return structuredClone({ ...result, mission: this.publicMission(result.mission) });
  }

  private async load(missionId: string): Promise<MissionSnapshot> {
    const mission = await this.options.missionStore.load(missionId);
    if (!mission) throw new Error("Mission was not found.");
    return mission;
  }

  private assertPlan(mission: MissionSnapshot, planRevisionId: string) {
    if (mission.plan.id !== planRevisionId) throw new Error("Mission plan revision does not match the current plan.");
  }

  private withOutcome(snapshot: MissionSnapshot, intentId: string, outcome: MissionIntentOutcome): MissionSnapshot {
    return { ...snapshot, intentOutcomes: { ...snapshot.intentOutcomes, [intentId]: structuredClone(outcome) } };
  }

  private outcome<T extends MissionIntentOutcome["operation"]>(mission: MissionSnapshot, intentId: string, operation: T, digest?: string): Extract<MissionIntentOutcome, { operation: T }> | undefined {
    const outcome = mission.intentOutcomes?.[intentId];
    if (!outcome) return undefined;
    if (outcome.operation !== operation) throw new Error("Intent ID was already used for another operation.");
    if (digest && outcome.requestDigest !== digest) throw new Error("Intent ID was already used with a different request payload.");
    return outcome as Extract<MissionIntentOutcome, { operation: T }>;
  }

  private async findCreateOutcome(intentId: string, digest: string): Promise<MissionSnapshot | undefined> {
    for (const mission of await this.options.missionStore.list()) {
      const outcome = this.outcome(mission, intentId, "create", digest);
      if (outcome) return structuredClone(outcome.result);
    }
    return undefined;
  }

  private operation<T extends MissionOperation["operation"]>(mission: MissionSnapshot, intentId: string, operation: T, digest: string): Extract<MissionOperation, { operation: T }> | undefined {
    const record = mission.operations?.[intentId];
    if (!record) return undefined;
    if (record.operation !== operation) throw new Error("Intent ID was already used for another operation.");
    if (record.requestDigest !== digest) throw new Error("Intent ID was already used with a different request payload.");
    return record as Extract<MissionOperation, { operation: T }>;
  }

  private withOperation(snapshot: MissionSnapshot, intentId: string, operation: MissionOperation): MissionSnapshot {
    return { ...snapshot, operations: { ...snapshot.operations, [intentId]: structuredClone(operation) } };
  }

  private async commitRun(mission: MissionSnapshot, intentId: string, digest: string, result: PublicRunMissionResult): Promise<PublicRunMissionResult> {
    const operation = this.operation(mission, intentId, "run", digest)!;
    const committed = this.withOperation(mission, intentId, { ...operation, state: "committed", result });
    await this.options.missionStore.save(this.withOutcome(committed, intentId, { operation: "run", requestDigest: digest, result }), []);
    return structuredClone(result);
  }

  private publicMission(snapshot: MissionSnapshot): MissionSnapshot {
    return publicMission({ ...snapshot, events: snapshot.events.map((event) => this.publicEvent(event)) }) as MissionSnapshot;
  }

  private serialize<T>(missionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(missionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.mutationTails.set(missionId, tail);
    void tail.finally(() => { if (this.mutationTails.get(missionId) === tail) this.mutationTails.delete(missionId); });
    return result;
  }

  private serializeCreate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.createTail.then(operation, operation);
    this.createTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function requestDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
