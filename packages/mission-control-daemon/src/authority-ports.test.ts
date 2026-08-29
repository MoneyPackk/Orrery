import type { Mission, MissionEvent } from "@orrery/mission-control-domain";
import type { ChangeSnapshot } from "@orrery/mission-kernel";
import { describe, expect, it } from "vitest";
import type {
  ApprovedRepository,
  CancelMissionAuthorityInput,
  CreateMissionAuthorityInput,
  InspectMissionAuthorityInput,
  MissionEventRecord,
  MissionSnapshot,
  PromoteMissionAuthorityInput,
  RepositoryProposalResult,
  RunMissionAuthorityInput,
} from "./authority-types";
import type {
  EventListener,
  EventSubscription,
  MissionEventStore,
  MissionStore,
  RepositoryRegistry,
} from "./authority-ports";

describe("mission authority ports", () => {
  it("models a proposal result and approved repository without exposing ordinary mutation paths", () => {
    const proposal: RepositoryProposalResult = {
      proposalId: "proposal-1",
      canonicalRoot: "C:/repo",
      fingerprint: "sha256:fingerprint",
      gitIdentity: "git@example.com:orrery.git",
      approvalNonce: "nonce-1",
      expiresAt: "2026-08-28T12:00:00.000Z",
      payloadVersion: 1,
    };
    const approved: ApprovedRepository = {
      repositoryId: "repository-1",
      canonicalRoot: proposal.canonicalRoot,
      fingerprint: proposal.fingerprint,
      gitIdentity: proposal.gitIdentity,
      approvedAt: proposal.expiresAt,
      lastVerifiedAt: proposal.expiresAt,
      payloadVersion: 1,
    };

    expect(proposal.payloadVersion).toBe(1);
    expect(approved.repositoryId).not.toBe(proposal.proposalId);

    const mutation: RunMissionAuthorityInput = {
      intentId: "intent-1",
      missionId: "mission-1",
      planRevisionId: "plan-1",
    };
    expect(mutation).not.toHaveProperty("repositoryRoot");
    expect(mutation).not.toHaveProperty("cwd");
    expect(mutation).not.toHaveProperty("worktreePath");

    // @ts-expect-error Raw paths are forbidden on ordinary mutation records.
    const invalidRoot: RunMissionAuthorityInput = { ...mutation, repositoryRoot: "C:/repo" };
    // @ts-expect-error Raw paths are forbidden on ordinary mutation records.
    const invalidCwd: RunMissionAuthorityInput = { ...mutation, cwd: "C:/repo" };
    // @ts-expect-error Raw paths are forbidden on ordinary mutation records.
    const invalidWorktree: RunMissionAuthorityInput = { ...mutation, worktreePath: "C:/repo/.worktree" };
    expect([invalidRoot, invalidCwd, invalidWorktree]).toHaveLength(3);

    const ordinaryMutations: readonly [
      CreateMissionAuthorityInput,
      CancelMissionAuthorityInput,
      InspectMissionAuthorityInput,
      PromoteMissionAuthorityInput,
    ] = [
      {
        intentId: "intent-create",
        repositoryId: approved.repositoryId,
        title: "Mission",
        goal: "Keep mutation inputs pathless",
        mode: "build",
        plan: { scope: "Contracts", actions: ["Define records"], acceptanceCriteria: ["No raw paths"] },
      },
      { intentId: "intent-cancel", missionId: "mission-1", runId: "run-1" },
      { missionId: "mission-1", planRevisionId: "plan-1" },
      {
        intentId: "intent-promote",
        missionId: "mission-1",
        planRevisionId: "plan-1",
        changeRevision: "change-1",
        approvalCapability: "capability-1",
        decision: "accepted",
      },
    ];
    for (const input of ordinaryMutations) {
      expect(input).not.toHaveProperty("localPath");
      expect(input).not.toHaveProperty("repositoryRoot");
      expect(input).not.toHaveProperty("cwd");
      expect(input).not.toHaveProperty("worktreePath");
    }
  });

  it("binds durable snapshots to opaque repositories and reuses kernel change snapshots", () => {
    const mission = {} as Mission;
    const changeSnapshot = {} as ChangeSnapshot;
    const snapshot: MissionSnapshot = {
      ...mission,
      repositoryId: "repository-1",
      fingerprint: "sha256:fingerprint",
      lastEventSequence: 0,
      payloadVersion: 1,
      currentChangeSnapshot: changeSnapshot,
    };

    expect(snapshot.repositoryId).toBe("repository-1");
    expect(snapshot.currentChangeSnapshot).toBe(changeSnapshot);
  });

  it("adds durable metadata without changing the domain event payload", () => {
    const event = {} as MissionEvent;
    const record: MissionEventRecord = {
      ...event,
      payloadVersion: 1,
      recordedAt: "2026-08-28T12:00:00.000Z",
    };

    expect(record.sequence).toBe(event.sequence);
    expect(record.payloadVersion).toBe(1);
  });

  it("describes repository, snapshot, and replay ports", async () => {
    const listener: EventListener = () => undefined;
    const subscription: EventSubscription = { unsubscribe: () => undefined };
    const registry: RepositoryRegistry = {
      propose: async () => proposal(),
      approve: async () => approvedRepository(),
      resolve: async () => approvedRepository(),
    };
    const store: MissionStore = {
      create: async () => undefined,
      load: async () => snapshot(),
      list: async () => [],
      save: async () => undefined,
    };
    const events: MissionEventStore = {
      append: async () => undefined,
      readAfter: async () => [],
      subscribe: () => subscription,
    };

    expect(await registry.resolve("repository-1")).toHaveProperty("payloadVersion", 1);
    expect(await store.load("mission-1")).toHaveProperty("payloadVersion", 1);
    expect(await events.readAfter("mission-1", 0)).toEqual([]);
    expect(events.subscribe("mission-1", listener)).toBe(subscription);
  });
});

function snapshot(): MissionSnapshot {
  return {
    ...({} as Mission),
    repositoryId: "repository-1",
    fingerprint: "sha256:fingerprint",
    lastEventSequence: 0,
    payloadVersion: 1,
  };
}

function proposal(): RepositoryProposalResult {
  return {
    proposalId: "proposal-1",
    canonicalRoot: "C:/repo",
    fingerprint: "sha256:fingerprint",
    gitIdentity: "git@example.com:orrery.git",
    approvalNonce: "nonce-1",
    expiresAt: "2026-08-28T12:00:00.000Z",
    payloadVersion: 1,
  };
}

function approvedRepository(): ApprovedRepository {
  return {
    repositoryId: "repository-1",
    canonicalRoot: "C:/repo",
    fingerprint: "sha256:fingerprint",
    gitIdentity: "git@example.com:orrery.git",
    approvedAt: "2026-08-28T12:00:00.000Z",
    lastVerifiedAt: "2026-08-28T12:00:00.000Z",
    payloadVersion: 1,
  };
}
