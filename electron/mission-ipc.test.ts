import { describe, expect, it, vi } from "vitest";
import type { Mission } from "@orrery/mission-control-domain";
import {
  MISSION_APPROVE_REPOSITORY_CHANNEL,
  MISSION_CANCEL_CHANNEL,
  MISSION_CREATE_CHANNEL,
  MISSION_GET_SNAPSHOT_CHANNEL,
  MISSION_LIST_CHANNEL,
  MISSION_INSPECT_CHANNEL,
  MISSION_PROPOSE_REPOSITORY_CHANNEL,
  MISSION_PROMOTE_CHANNEL,
  MISSION_RUN_CHANNEL,
  registerMissionIpc,
  type MissionIpcService,
} from "./mission-ipc";

const rendererUrl = "file:///C:/Orrery/dist/index.html";

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "9d02ebf8-89f1-4a74-9a11-469973af4748",
    title: "Secure desktop bridge",
    goal: "Expose mission intents only",
    mode: "build",
    status: "queued",
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
    targetBranch: "main",
    plan: {
      id: "plan-revision-1",
      revision: 1,
      approved: true,
      createdAt: "2026-08-28T10:00:00.000Z",
      scope: "Bridge mission intents",
      actions: ["Register handlers"],
      acceptanceCriteria: ["No raw primitives are exposed"],
    },
    events: [],
    changes: [],
    evidence: [],
    ...overrides,
  };
}

function setup(snapshot = mission()) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcMain = {
    removeHandler: vi.fn(),
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  };
  const service: MissionIpcService = {
    proposeRepository: vi.fn().mockResolvedValue({ proposalId: "proposal-1" }),
    create: vi.fn().mockResolvedValue(snapshot),
    run: vi.fn().mockResolvedValue({ mission: snapshot, runId: "run-1" }),
    cancel: vi.fn().mockResolvedValue({ mission: snapshot, runId: "run-1" }),
    list: vi.fn().mockResolvedValue([{ id: snapshot.id, title: snapshot.title, status: snapshot.status, updatedAt: snapshot.updatedAt }]),
    getSnapshot: vi.fn().mockResolvedValue(snapshot),
    inspect: vi.fn().mockResolvedValue({ mission: snapshot, planRevisionId: "plan-revision-1" }),
    reviewAndPromote: vi.fn().mockResolvedValue({ mission: snapshot, planRevisionId: "plan-revision-1", changeRevision: "change-1", decision: "accepted", reviewerId: "native", result: "promoted" }),
  };
  registerMissionIpc(ipcMain as never, () => rendererUrl, service);
  const mainFrame = { url: rendererUrl };
  const event = { senderFrame: mainFrame, sender: { mainFrame } };
  return { handlers, service, event, mainFrame };
}

describe("mission IPC", () => {
  it("registers all guarded handlers and forwards exact typed payloads", async () => {
    const { handlers, service, event } = setup(mission({ status: "ready_for_review", completionSummary: "Ready", evidence: [{ id: "evidence-1", kind: "diagnostic", status: "passed", summary: "Diff captured", planRevisionId: "plan-revision-1", timestamp: "2026-08-28T10:00:00.000Z" }] }));
    const proposal = { intentId: "intent-propose", localPath: "C:/repo" };
    const approval = { intentId: "intent-approve", proposalId: "proposal-1", fingerprint: "a".repeat(64), approvalNonce: "b".repeat(64) };
    const create = { intentId: "intent-create", repositoryId: "repository-1", title: "Secure desktop bridge", goal: "Expose intents", mode: "build" as const, plan: { scope: "Bridge", actions: ["Connect"], acceptanceCriteria: ["Guarded"] } };
    const revisionIntent = { intentId: "intent-run", missionId: mission().id, planRevisionId: "plan-revision-1" };

    await handlers.get(MISSION_PROPOSE_REPOSITORY_CHANNEL)?.(event, proposal);
    await handlers.get(MISSION_CREATE_CHANNEL)?.(event, create);
    await handlers.get(MISSION_RUN_CHANNEL)?.(event, revisionIntent);
    await handlers.get(MISSION_CANCEL_CHANNEL)?.(event, { intentId: "intent-cancel", missionId: mission().id, runId: "run-1" });
    await handlers.get(MISSION_LIST_CHANNEL)?.(event);
    await handlers.get(MISSION_GET_SNAPSHOT_CHANNEL)?.(event, { missionId: mission().id });
    await handlers.get(MISSION_INSPECT_CHANNEL)?.(event, { missionId: mission().id, planRevisionId: "plan-revision-1" });
    const review = { intentId: "intent-review", missionId: mission().id, planRevisionId: "plan-revision-1", decision: "accepted" as const };
    await handlers.get(MISSION_PROMOTE_CHANNEL)?.(event, review);

    expect(service.proposeRepository).toHaveBeenCalledWith(proposal);
    expect(service.create).toHaveBeenCalledWith(create);
    expect(service.run).toHaveBeenCalledWith(revisionIntent);
    expect(service.cancel).toHaveBeenCalledWith({ intentId: "intent-cancel", missionId: mission().id, runId: "run-1" });
    expect(service.list).toHaveBeenCalledOnce();
    expect(service.getSnapshot).toHaveBeenCalledWith({ missionId: mission().id });
    expect(service.inspect).toHaveBeenCalledWith({ missionId: mission().id, planRevisionId: "plan-revision-1" });
    expect(service.reviewAndPromote).toHaveBeenCalledWith(review);
  });

  it.each([
    [MISSION_PROPOSE_REPOSITORY_CHANNEL, { intentId: "intent-1", localPath: "C:/repo", cwd: "C:/repo" }],
    [MISSION_CREATE_CHANNEL, { intentId: "intent-1", repositoryId: "repository-1", title: "x", goal: "y", mode: "build", plan: { scope: "s", actions: ["a"], acceptanceCriteria: ["c"] }, repositoryRoot: "C:/repo" }],
    [MISSION_RUN_CHANNEL, { missionId: mission().id }],
    [MISSION_CANCEL_CHANNEL, { intentId: "intent-1", missionId: mission().id, runId: "run-1", worktreePath: "C:/repo" }],
    [MISSION_GET_SNAPSHOT_CHANNEL, { missionId: mission().id, extra: true }],
    [MISSION_INSPECT_CHANNEL, { missionId: "", planRevisionId: "plan-revision-1" }],
  ])("rejects malformed exact payloads on %s", async (channel, payload) => {
    const { handlers, service, event } = setup();
    await expect(handlers.get(channel)?.(event, payload)).rejects.toThrow("Invalid mission IPC payload");
    expect(service.create).not.toHaveBeenCalled();
    expect(service.run).not.toHaveBeenCalled();
    expect(service.getSnapshot).not.toHaveBeenCalled();
    expect(service.inspect).not.toHaveBeenCalled();
  });

  it("rejects untrusted and non-main-frame senders", async () => {
    const { handlers, service, mainFrame } = setup();
    const payload = { missionId: mission().id };

    await expect(handlers.get(MISSION_GET_SNAPSHOT_CHANNEL)?.({
      senderFrame: { url: rendererUrl }, sender: { mainFrame },
    }, payload)).rejects.toThrow("Rejected untrusted mission IPC request");
    await expect(handlers.get(MISSION_GET_SNAPSHOT_CHANNEL)?.({
      senderFrame: mainFrame, sender: { mainFrame: { url: "https://attacker.invalid/" } },
    }, payload)).rejects.toThrow("Rejected untrusted mission IPC request");
    expect(service.getSnapshot).not.toHaveBeenCalled();
    await expect(handlers.get(MISSION_PROMOTE_CHANNEL)?.({ senderFrame: { url: rendererUrl }, sender: { mainFrame } }, { intentId: "review", missionId: mission().id, planRevisionId: "plan-revision-1", decision: "accepted" })).rejects.toThrow("Rejected untrusted mission IPC request");
    expect(service.reviewAndPromote).not.toHaveBeenCalled();
  });

  it("delegates revision and state authority to the daemon service", async () => {
    const { handlers, service, event } = setup(mission({ status: "running" }));
    const stale = { intentId: "intent-run", missionId: mission().id, planRevisionId: "plan-revision-0" };
    await expect(handlers.get(MISSION_RUN_CHANNEL)?.(event, stale)).resolves.toBeDefined();
    expect(service.run).toHaveBeenCalledWith(stale);
  });

  it("enforces zero arguments for list and exactly one for get and review", async () => {
    const { handlers, service, event } = setup();
    await expect(handlers.get(MISSION_LIST_CHANNEL)?.(event, {})).rejects.toThrow("Invalid mission IPC payload");
    await expect(handlers.get(MISSION_GET_SNAPSHOT_CHANNEL)?.(event, { missionId: mission().id }, "trailing")).rejects.toThrow("Invalid mission IPC payload");
    await expect(handlers.get(MISSION_PROMOTE_CHANNEL)?.(event, { intentId: "review", missionId: mission().id, planRevisionId: "plan-revision-1", decision: "accepted" }, "trailing")).rejects.toThrow("Invalid mission IPC payload");
    expect(service.list).not.toHaveBeenCalled(); expect(service.getSnapshot).not.toHaveBeenCalled(); expect(service.reviewAndPromote).not.toHaveBeenCalled();
  });
});
