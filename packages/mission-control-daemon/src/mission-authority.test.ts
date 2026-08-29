import type { Mission } from "@orrery/mission-control-domain";
import type {
  ChangeSnapshot,
  MissionRepository,
  MissionWorkspace,
  RunMissionInput,
  RunMissionResult,
  WorkspaceService,
} from "../../mission-kernel/src";
import { MissionRunner, PromotionService } from "../../mission-kernel/src";
import { describe, expect, it, vi } from "vitest";
import type { MissionEventStore, MissionStore, RepositoryRegistry } from "./authority-ports";
import type { ApprovedRepository, MissionEventRecord, MissionOperation, MissionSnapshot } from "./authority-types";
import { MissionAuthority, type MissionAuthorityOptions, type VerificationCommandContext } from "./mission-authority";
import { TrustedApprovalService } from "./promotion-approval";

const repository: ApprovedRepository = {
  repositoryId: "repository-1",
  canonicalRoot: "C:/approved/repository",
  fingerprint: "sha256:approved",
  gitIdentity: "git-identity",
  approvedAt: "2026-08-28T10:00:00.000Z",
  lastVerifiedAt: "2026-08-28T10:00:00.000Z",
  payloadVersion: 1,
};

const workspace: MissionWorkspace = {
  id: "workspace-1",
  missionId: "mission-1",
  repositoryRoot: repository.canonicalRoot,
  worktreePath: "C:/daemon/worktrees/mission-1",
  targetBranch: "main",
  missionBranch: "orrery/mission-1",
  initialRevision: "target-1",
};

const changes: ChangeSnapshot = {
  revision: "change-1",
  files: [{ path: "change.txt", additions: 1, deletions: 0, binary: false, diff: "+change" }],
  unifiedDiff: "+change",
};

function setup() {
  const snapshots = new Map<string, MissionSnapshot>();
  const records = new Map<string, MissionEventRecord[]>();
  const listeners = new Map<string, Set<(event: MissionEventRecord) => void>>();
  const order: string[] = [];
  const missionStore: MissionStore = {
    create: async (snapshot) => {
      if (snapshots.has(snapshot.id)) throw new Error("exists");
      snapshots.set(snapshot.id, structuredClone(snapshot));
      order.push("persist:create");
    },
    load: async (id) => structuredClone(snapshots.get(id) ?? null),
    list: async () => structuredClone([...snapshots.values()]),
    save: async (snapshot, events) => {
      snapshots.set(snapshot.id, structuredClone(snapshot));
      const history = records.get(snapshot.id) ?? [];
      history.push(...structuredClone(events));
      records.set(snapshot.id, history);
      order.push(`persist:${snapshot.status}`);
      for (const event of events) {
        order.push(`publish:${event.kind}`);
        for (const listener of listeners.get(snapshot.id) ?? []) listener(structuredClone(event));
      }
    },
  };
  const eventStore: MissionEventStore = {
    append: async () => { throw new Error("authority must commit events through MissionStore.save"); },
    readAfter: async (missionId, sequence) => structuredClone((records.get(missionId) ?? []).filter((event) => event.sequence > sequence)),
    subscribe: (missionId, listener) => {
      const group = listeners.get(missionId) ?? new Set();
      group.add(listener);
      listeners.set(missionId, group);
      return { unsubscribe: () => group.delete(listener) };
    },
  };
  const registry: RepositoryRegistry = {
    propose: async () => { throw new Error("not used"); },
    approve: async () => { throw new Error("not used"); },
    resolve: vi.fn(async (repositoryId) => {
      if (repositoryId !== repository.repositoryId) throw new Error("not approved");
      return repository;
    }),
  };
  const workspaceService: WorkspaceService = {
    createMissionWorkspace: async () => workspace,
    removeMissionWorkspace: async () => undefined,
    inspectChanges: vi.fn(async () => changes),
    preparePromotion: async () => { throw new Error("not used"); },
    promote: async () => ({ status: "promoted", revision: "target-2" }),
    promoteRetry: async () => { throw new Error("not used"); },
  };
  const run = vi.fn<(input: RunMissionInput) => Promise<RunMissionResult>>();
  const missionRunner = { run } as unknown as MissionRunner;
  const preparePromotion = vi.fn(async () => ({ status: "prepared" as const, token: {
    missionRevision: "mission-revision",
    expectedTargetRevision: workspace.initialRevision,
    targetBranch: workspace.targetBranch,
    workspace,
    missionParent: workspace.initialRevision,
    missionTree: "mission-tree",
  } }));
  const commitPromotion = vi.fn(async () => ({ status: "promoted" as const, revision: "target-2" }));
  const reconcilePromotion = vi.fn(async () => ({ status: "pending" as const }));
  const promote = vi.fn(async () => ({ status: "promoted" as const, revision: "target-2" }));
  const promotionService = { promote, preparePromotion, commitPromotion, reconcilePromotion } as unknown as PromotionService;
  let nextId = 0;
  const approvals = new TrustedApprovalService({
    reviewerId: () => "trusted-local-reviewer",
    now: () => "2026-08-28T11:00:00.000Z",
    id: () => `approval-${++nextId}`,
  });
  const authority = new MissionAuthority({
    missionStore,
    eventStore,
    repositoryRegistry: registry,
    missionRunner,
    promotionService,
    workspaceService,
    verificationCommandResolver: async () => ({ executable: "npm", args: ["test"] }),
    promotionApprovalVerifier: approvals,
    now: () => "2026-08-28T11:00:00.000Z",
    id: () => `generated-${++nextId}`,
  });
  const createInput = {
    intentId: "intent-create",
    repositoryId: repository.repositoryId,
    title: "Authoritative mission",
    goal: "Run only through the daemon",
    mode: "build" as const,
    plan: { scope: "authority", actions: ["run"], acceptanceCriteria: ["persisted"] },
  };
  return { approvals, authority, commitPromotion, createInput, eventStore, missionStore, order, preparePromotion, promote, reconcilePromotion, registry, run, snapshots, workspaceService };
}

async function createReady(setupResult: ReturnType<typeof setup>) {
  const created = await setupResult.authority.create(setupResult.createInput);
  const ready: MissionSnapshot = {
    ...created,
    status: "ready_for_review",
    workspaceId: workspace.id,
    missionBranch: workspace.missionBranch,
    plan: { ...created.plan, approved: true },
    evidence: [{ id: "evidence-1", kind: "diagnostic", status: "passed", summary: "verified", planRevisionId: created.plan.id, timestamp: created.updatedAt }],
    completionSummary: "ready",
    currentWorkspace: { ...workspace, missionId: created.id },
    currentChangeSnapshot: changes,
  };
  setupResult.snapshots.set(created.id, ready);
  return ready;
}

describe("MissionAuthority", () => {
  it("requires a bound, unexpired, single-use approval capability and derives reviewer identity from its issuer", async () => {
    const context = setup();
    const ready = await createReady(context);
    expect(context.authority).not.toHaveProperty("issuePromotionApproval");
    const approval = context.approvals.issue({
      missionId: ready.id,
      planRevisionId: ready.plan.id,
      changeRevision: changes.revision,
      decision: "accepted",
    });

    await context.authority.promote({
      intentId: "promote-capability",
      missionId: ready.id,
      planRevisionId: ready.plan.id,
      changeRevision: changes.revision,
      decision: "accepted",
      approvalCapability: approval,
    });

    expect(context.preparePromotion).toHaveBeenCalledWith(expect.objectContaining({ reviewerId: "trusted-local-reviewer" }));
    await expect(context.authority.promote({
      intentId: "replay-capability",
      missionId: ready.id,
      planRevisionId: ready.plan.id,
      changeRevision: changes.revision,
      decision: "accepted",
      approvalCapability: approval,
    })).rejects.toThrow(/capability.*used/i);
  });
  it("creates and submits a complete plan against a daemon-resolved approved repository", async () => {
    const context = setup();
    const mission = await context.authority.create(context.createInput);

    expect(mission).toMatchObject({
      repositoryId: repository.repositoryId,
      fingerprint: repository.fingerprint,
      status: "awaiting_approval",
      payloadVersion: 1,
      lastEventSequence: 0,
      plan: { approved: false, revision: 1, scope: "authority" },
    });
    expect(context.registry.resolve).toHaveBeenCalledWith(repository.repositoryId);
    expect(JSON.stringify(mission)).not.toContain(repository.canonicalRoot);
  });

  it("replays a duplicate create intent without creating another mission", async () => {
    const context = setup();
    const first = await context.authority.create(context.createInput);
    const second = await context.authority.create(context.createInput);

    expect(second).toEqual(first);
    expect(await context.missionStore.list()).toHaveLength(1);
  });

  it("rejects reuse of an intent ID when the canonical request payload differs", async () => {
    const context = setup();
    await context.authority.create(context.createInput);

    await expect(context.authority.create({ ...context.createInput, goal: "A different goal" }))
      .rejects.toThrow(/intent.*payload/i);
  });

  it("serializes simultaneous retries of the same create intent", async () => {
    const context = setup();

    const [first, second] = await Promise.all([
      context.authority.create(context.createInput),
      context.authority.create(context.createInput),
    ]);

    expect(second).toEqual(first);
    expect(await context.missionStore.list()).toHaveLength(1);
  });

  it("approves only the exact current plan and claims one active run per mission", async () => {
    const context = setup();
    const created = await context.authority.create(context.createInput);
    let finish!: (result: RunMissionResult) => void;
    context.run.mockImplementation(async (input) => new Promise((resolve) => {
      finish = resolve;
      expect(input.mission.status).toBe("queued");
      expect(input.mission.plan.approved).toBe(true);
      expect(input.repositoryRoot).toBe(repository.canonicalRoot);
      expect(input.verificationCommand).toEqual({ executable: "npm", args: ["test"] });
      expect(input.repository).toBeDefined();
    }));

    await expect(context.authority.run({ intentId: "stale", missionId: created.id, planRevisionId: "old-plan" }))
      .rejects.toThrow(/plan revision/i);
    const first = context.authority.run({ intentId: "run-1", missionId: created.id, planRevisionId: created.plan.id });
    await vi.waitFor(() => expect(context.run).toHaveBeenCalledTimes(1));
    await expect(context.authority.run({ intentId: "run-2", missionId: created.id, planRevisionId: created.plan.id }))
      .rejects.toThrow(/active run/i);

    const input = context.run.mock.calls[0][0];
    const completed = { ...input.mission, status: "ready_for_review" as const, activeRunId: undefined };
    finish({ missionId: created.id, runId: input.runId, planRevisionId: created.plan.id, status: "ready_for_review", mission: completed, workspace: { ...workspace, missionId: created.id }, changeSnapshot: changes });
    await expect(first).resolves.toMatchObject({ status: "ready_for_review" });
  });

  it("resolves verification commands from the current mission independent of earlier calls", async () => {
    const context = setup();
    const resolver = vi.fn(async ({ missionId, title, intentId }: VerificationCommandContext) => ({
      executable: "npm",
      args: [title === "Cancel verification" ? "long" : "quick", missionId, intentId],
    }));
    (context.authority as unknown as { options: MissionAuthorityOptions }).options.verificationCommandResolver = resolver;
    context.run.mockImplementation(async (input) => ({
      missionId: input.mission.id,
      runId: input.runId,
      planRevisionId: input.mission.plan.id,
      status: "ready_for_review",
      mission: { ...input.mission, status: "ready_for_review", activeRunId: undefined } as Mission,
      workspace: { ...workspace, missionId: input.mission.id },
      changeSnapshot: changes,
    }));
    const earlier = await context.authority.create({ ...context.createInput, intentId: "create-earlier", title: "Earlier verification" });
    await context.authority.run({ intentId: "run-earlier", missionId: earlier.id, planRevisionId: earlier.plan.id });
    const cancellation = await context.authority.create({ ...context.createInput, intentId: "create-cancel", title: "Cancel verification" });

    await context.authority.run({ intentId: "run-cancel", missionId: cancellation.id, planRevisionId: cancellation.plan.id });

    expect(context.run.mock.calls[1][0].verificationCommand).toEqual({ executable: "npm", args: ["long", cancellation.id, "run-cancel"] });
  });

  it("replays a completed run intent without invoking the runner twice", async () => {
    const context = setup();
    const created = await context.authority.create(context.createInput);
    context.run.mockImplementation(async (input) => ({
      missionId: created.id,
      runId: input.runId,
      planRevisionId: created.plan.id,
      status: "ready_for_review",
      mission: { ...input.mission, status: "ready_for_review", activeRunId: undefined } as Mission,
      workspace: { ...workspace, missionId: created.id },
      changeSnapshot: changes,
    }));
    const intent = { intentId: "run-once", missionId: created.id, planRevisionId: created.plan.id };

    const first = await context.authority.run(intent);
    const second = await context.authority.run(intent);

    expect(second).toEqual(first);
    expect(context.run).toHaveBeenCalledTimes(1);
  });

  it("finalizes a run after restart when the runner completed before the outcome commit", async () => {
    const context = setup();
    const created = await context.authority.create(context.createInput);
    context.run.mockImplementation(async (input) => {
      const completed = { ...input.mission, status: "ready_for_review" as const, activeRunId: undefined };
      const result = { missionId: created.id, runId: input.runId, planRevisionId: created.plan.id, status: "ready_for_review" as const, mission: completed, workspace: { ...workspace, missionId: created.id }, changeSnapshot: changes };
      const durable = context.snapshots.get(created.id)!;
      context.snapshots.set(created.id, { ...durable, ...completed, currentWorkspace: result.workspace, currentChangeSnapshot: changes });
      context.missionStore.save = vi.fn(async () => { throw new Error("simulated crash"); });
      return result;
    });
    const intent = { intentId: "run-crash", missionId: created.id, planRevisionId: created.plan.id };

    await expect(context.authority.run(intent)).rejects.toThrow("simulated crash");
    const operation = context.snapshots.get(created.id)!.operations![intent.intentId];
    expect(operation.state).toBe("in_progress");
    const restarted = setup();
    restarted.snapshots.set(created.id, structuredClone(context.snapshots.get(created.id)!));
    const result = await restarted.authority.run(intent);

    expect(result.status).toBe("ready_for_review");
    expect(restarted.run).not.toHaveBeenCalled();
    expect(restarted.snapshots.get(created.id)!.operations![intent.intentId].state).toBe("committed");
  });

  it("shares the active promise for simultaneous retries of the same run intent", async () => {
    const context = setup();
    const created = await context.authority.create(context.createInput);
    let finish!: (result: RunMissionResult) => void;
    context.run.mockImplementation(async (input) => new Promise((resolve) => { finish = resolve; }));
    const intent = { intentId: "run-same", missionId: created.id, planRevisionId: created.plan.id };

    const first = context.authority.run(intent);
    await vi.waitFor(() => expect(context.run).toHaveBeenCalledTimes(1));
    const second = context.authority.run(intent);
    const input = context.run.mock.calls[0][0];
    finish({ missionId: created.id, runId: input.runId, planRevisionId: created.plan.id, status: "ready_for_review", mission: { ...input.mission, status: "ready_for_review" }, workspace: { ...workspace, missionId: created.id }, changeSnapshot: changes });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(context.run).toHaveBeenCalledTimes(1);
  });

  it("publishes runner events only after the matching snapshot is durable", async () => {
    const context = setup();
    const created = await context.authority.create(context.createInput);
    context.eventStore.subscribe(created.id, () => undefined);
    context.run.mockImplementation(async (input) => {
      const running: Mission = { ...input.mission, status: "running", activeRunId: input.runId };
      const event = { id: "event-1", missionId: created.id, runId: input.runId, sequence: 1, timestamp: created.updatedAt, kind: "workspace" as const, title: "Workspace", detail: "isolated" };
      const persisted = { ...running, events: [event] };
      await input.repository!.save(persisted);
      await input.onEvent?.(event);
      return { missionId: created.id, runId: input.runId, planRevisionId: created.plan.id, status: "running", mission: persisted, workspace: { ...workspace, missionId: created.id }, changeSnapshot: changes };
    });

    await context.authority.run({ intentId: "run-events", missionId: created.id, planRevisionId: created.plan.id });

    expect(context.order.indexOf("persist:running")).toBeLessThan(context.order.indexOf("publish:workspace"));
  });

  it("redacts absolute workspace paths from durable and public events and outcomes", async () => {
    const context = setup();
    const created = await context.authority.create(context.createInput);
    context.run.mockImplementation(async (input) => {
      const rawWorkspace = { ...workspace, missionId: created.id };
      const rawEvent = { id: "event-path", missionId: created.id, runId: input.runId, sequence: 1, timestamp: created.updatedAt, kind: "workspace" as const, title: "Workspace", detail: rawWorkspace.worktreePath };
      const persisted = { ...input.mission, status: "ready_for_review" as const, activeRunId: undefined, events: [rawEvent] };
      await input.repository!.save(persisted);
      return { missionId: created.id, runId: input.runId, planRevisionId: created.plan.id, status: "ready_for_review", mission: persisted, workspace: rawWorkspace, changeSnapshot: changes };
    });

    const result = await context.authority.run({ intentId: "run-private-path", missionId: created.id, planRevisionId: created.plan.id });
    const publicPayload = JSON.stringify(result);

    expect(publicPayload).not.toContain(repository.canonicalRoot);
    expect(publicPayload).not.toContain(workspace.worktreePath);
    expect(result.workspace).toEqual({ handle: workspace.id });
    expect(result.mission.events[0].detail).not.toMatch(/^[A-Za-z]:[\\/]|^\//);
  });

  it("aborts the active controller, awaits the runner, and returns durable cancellation", async () => {
    const context = setup();
    const created = await context.authority.create(context.createInput);
    context.run.mockImplementation(async (input) => new Promise((_, reject) => {
      input.signal!.addEventListener("abort", async () => {
        const event = { id: "cancel-event", missionId: created.id, runId: input.runId, sequence: 1, timestamp: created.updatedAt, kind: "cancellation" as const, title: "Cancelled", detail: "cancelled" };
        await input.repository!.save({ ...input.mission, status: "cancelled", events: [event] });
        reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
      }, { once: true });
    }));
    const running = context.authority.run({ intentId: "run-cancel", missionId: created.id, planRevisionId: created.plan.id });
    await vi.waitFor(() => expect(context.run).toHaveBeenCalledTimes(1));
    const runId = context.run.mock.calls[0][0].runId;

    const cancelled = await context.authority.cancel({ intentId: "cancel-once", missionId: created.id, runId });

    expect(context.run.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(cancelled.status).toBe("cancelled");
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects a replayed cancellation intent when the run ID differs", async () => {
    const context = setup();
    const created = await context.authority.create(context.createInput);
    context.run.mockImplementation(async (input) => new Promise((_, reject) => {
      input.signal!.addEventListener("abort", async () => {
        const event = { id: "cancel-event", missionId: created.id, runId: input.runId, sequence: 1, timestamp: created.updatedAt, kind: "cancellation" as const, title: "Cancelled", detail: "cancelled" };
        await input.repository!.save({ ...input.mission, status: "cancelled", events: [event] });
        reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
      }, { once: true });
    }));
    const running = context.authority.run({ intentId: "run-cancel-digest", missionId: created.id, planRevisionId: created.plan.id });
    await vi.waitFor(() => expect(context.run).toHaveBeenCalledTimes(1));
    const runId = context.run.mock.calls[0][0].runId;
    await context.authority.cancel({ intentId: "cancel-digest", missionId: created.id, runId });
    await expect(running).rejects.toMatchObject({ name: "AbortError" });

    await expect(context.authority.cancel({ intentId: "cancel-digest", missionId: created.id, runId: "different-run" }))
      .rejects.toThrow(/different request payload/i);
  });

  it("persists public mission DTOs without kernel change and evidence metadata", async () => {
    const context = setup();
    const created = await context.authority.create(context.createInput);
    context.run.mockImplementation(async (input) => {
      const kernelChange = { ...changes.files[0], binary: false };
      const kernelEvidence = { id: "evidence-1", sequence: 1, kind: "diagnostic" as const, status: "passed" as const, summary: "captured", planRevisionId: created.plan.id, timestamp: created.updatedAt };
      const running = { ...input.mission, status: "running" as const, activeRunId: input.runId, changes: [kernelChange], evidence: [kernelEvidence] };
      await input.repository!.save(running);
      const completed = { ...running, status: "ready_for_review" as const, activeRunId: undefined, completionSummary: "complete" };
      return { missionId: created.id, runId: input.runId, planRevisionId: created.plan.id, status: "ready_for_review", mission: completed, workspace: { ...workspace, missionId: created.id }, changeSnapshot: { ...changes, files: [kernelChange] } };
    });

    await context.authority.run({ intentId: "run-public-dto", missionId: created.id, planRevisionId: created.plan.id });
    const durable = context.snapshots.get(created.id)!;

    expect(durable.changes[0]).not.toHaveProperty("binary");
    expect(durable.evidence[0]).not.toHaveProperty("sequence");
    expect(durable.currentChangeSnapshot?.files[0]).toHaveProperty("binary", false);
  });

  it("rejects new mutations and aborts and awaits active runs during shutdown", async () => {
    const context = setup();
    const created = await context.authority.create(context.createInput);
    let finish!: () => void;
    context.run.mockImplementation(async (input) => new Promise((resolve) => {
      finish = () => resolve({ missionId: created.id, runId: input.runId, planRevisionId: created.plan.id, status: "cancelled", mission: { ...input.mission, status: "cancelled" }, workspace: { ...workspace, missionId: created.id }, changeSnapshot: changes });
    }));
    const running = context.authority.run({ intentId: "run-shutdown", missionId: created.id, planRevisionId: created.plan.id });
    await vi.waitFor(() => expect(context.run).toHaveBeenCalledOnce());

    const shutdown = context.authority.shutdown(100);

    expect(context.run.mock.calls[0][0].signal?.aborted).toBe(true);
    await expect(context.authority.create({ ...context.createInput, intentId: "after-shutdown" })).rejects.toThrow(/shutting down/i);
    let settled = false;
    void shutdown.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await shutdown;
    await running;
  });

  it("bounds shutdown while still preventing later mutations", async () => {
    vi.useFakeTimers();
    const context = setup();
    const created = await context.authority.create(context.createInput);
    context.run.mockImplementation(async () => new Promise(() => undefined));
    void context.authority.run({ intentId: "run-stuck", missionId: created.id, planRevisionId: created.plan.id });
    await vi.waitFor(() => expect(context.run).toHaveBeenCalledOnce());

    const shutdown = context.authority.shutdown(25);
    await vi.advanceTimersByTimeAsync(25);

    await expect(shutdown).resolves.toBeUndefined();
    await expect(context.authority.run({ intentId: "after-timeout", missionId: created.id, planRevisionId: created.plan.id })).rejects.toThrow(/shutting down/i);
    vi.useRealTimers();
  });

  it("inspects and promotes only the stored workspace and exact reviewed snapshot", async () => {
    const context = setup();
    const ready = await createReady(context);

    const inspection = await context.authority.inspect({ missionId: ready.id, planRevisionId: ready.plan.id });
    expect(inspection.changeSnapshot).toEqual(changes);
    expect(context.workspaceService.inspectChanges).toHaveBeenCalledWith(ready.currentWorkspace);
    const staleApproval = context.approvals.issue({ missionId: ready.id, planRevisionId: ready.plan.id, changeRevision: "other", decision: "accepted" });
    await expect(context.authority.promote({ intentId: "stale-change", missionId: ready.id, planRevisionId: ready.plan.id, changeRevision: "other", approvalCapability: staleApproval, decision: "accepted" }))
      .rejects.toThrow(/change revision/i);

    const approval = context.approvals.issue({ missionId: ready.id, planRevisionId: ready.plan.id, changeRevision: changes.revision, decision: "accepted" });
    const promoted = await context.authority.promote({ intentId: "promote-once", missionId: ready.id, planRevisionId: ready.plan.id, changeRevision: changes.revision, approvalCapability: approval, decision: "accepted" });
    const replayed = await context.authority.promote({ intentId: "promote-once", missionId: ready.id, planRevisionId: ready.plan.id, changeRevision: changes.revision, approvalCapability: approval, decision: "accepted" });

    expect(promoted.mission.status).toBe("accepted");
    expect(replayed).toEqual(promoted);
    expect(context.preparePromotion).toHaveBeenCalledTimes(1);
    expect(context.preparePromotion).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: ready.id }),
      workspace: ready.currentWorkspace,
      planRevisionId: ready.plan.id,
      changeSnapshot: changes,
      reviewerId: "trusted-local-reviewer",
      decision: "accepted",
    }));
  });

  it("replays a prepared promotion after restart without preparing it twice", async () => {
    const context = setup();
    const ready = await createReady(context);
    const approval = context.approvals.issue({ missionId: ready.id, planRevisionId: ready.plan.id, changeRevision: changes.revision, decision: "accepted" });
    const intent = { intentId: "promote-crash-prepared", missionId: ready.id, planRevisionId: ready.plan.id, changeRevision: changes.revision, approvalCapability: approval, decision: "accepted" as const };
    context.commitPromotion.mockRejectedValueOnce(new Error("simulated crash"));

    await expect(context.authority.promote(intent)).rejects.toThrow("simulated crash");
    expect(context.snapshots.get(ready.id)!.operations![intent.intentId].state).toBe("in_progress");
    const restarted = setup();
    restarted.snapshots.set(ready.id, structuredClone(context.snapshots.get(ready.id)!));
    restarted.reconcilePromotion.mockResolvedValueOnce({ status: "pending" });
    const result = await restarted.authority.promote(intent);

    expect(result.result.status).toBe("promoted");
    expect(restarted.preparePromotion).not.toHaveBeenCalled();
    expect(restarted.commitPromotion).toHaveBeenCalledTimes(1);
  });

  it("finalizes promotion after restart when the target ref was updated before outcome commit", async () => {
    const context = setup();
    const ready = await createReady(context);
    const approval = context.approvals.issue({ missionId: ready.id, planRevisionId: ready.plan.id, changeRevision: changes.revision, decision: "accepted" });
    const intent = { intentId: "promote-crash-ref", missionId: ready.id, planRevisionId: ready.plan.id, changeRevision: changes.revision, approvalCapability: approval, decision: "accepted" as const };
    context.commitPromotion.mockImplementationOnce(async () => {
      context.missionStore.save = vi.fn(async () => { throw new Error("simulated crash"); });
      return { status: "promoted", revision: "target-2" };
    });

    await expect(context.authority.promote(intent)).rejects.toThrow("simulated crash");
    const restarted = setup();
    restarted.snapshots.set(ready.id, structuredClone(context.snapshots.get(ready.id)!));
    restarted.reconcilePromotion.mockResolvedValueOnce({ status: "promoted", revision: "target-2" } as never);
    const result = await restarted.authority.promote(intent);

    expect(result.result).toEqual({ status: "promoted", revision: "target-2" });
    expect(restarted.commitPromotion).not.toHaveBeenCalled();
    expect(restarted.snapshots.get(ready.id)!.operations![intent.intentId].state).toBe("committed");
  });
});
