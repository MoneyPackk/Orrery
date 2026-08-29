import { describe, expect, it } from "vitest";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovedRepository, RepositoryProposal } from "./authority-types";
import type { GitInspector, RepositoryRegistryPersistence } from "./authority-ports";
import { FileRepositoryRegistry } from "./repository-registry";

function setup(initial: readonly ApprovedRepository[] = [], initialNow = 1_000) {
  let now = initialNow;
  const savedProposals: RepositoryProposal[] = [];
  let entries = [...initial];
  const persistence: RepositoryRegistryPersistence = {
    load: async () => entries,
    loadProposals: async () => savedProposals,
    save: async (next) => { entries = [...next]; },
    saveProposal: async (proposal) => { savedProposals.push(proposal); },
    approveProposal: async (proposalId, next) => {
      entries = [...next];
      const index = savedProposals.findIndex((proposal) => proposal.proposalId === proposalId);
      if (index >= 0) savedProposals.splice(index, 1);
    },
  };
  const identities = new Map<string, { canonicalRoot: string; gitIdentity: string }>();
  const gitInspector: GitInspector = { inspect: async (path) => {
    const identity = identities.get(path);
    if (!identity) throw new Error("Not a Git repository.");
    return identity;
  } };
  return { persistence, gitInspector, savedProposals, entries: () => entries, setNow: (value: number) => { now = value; }, now: () => now, identities };
}

describe("FileRepositoryRegistry", () => {
  it("canonicalizes equivalent paths and produces a stable identity fingerprint", async () => {
    const state = setup();
    const root = await realpath(process.cwd());
    state.identities.set(root, { canonicalRoot: root, gitIdentity: "git-123" });
    const registry = new FileRepositoryRegistry({ ...state, now: state.now, proposalTtlMs: 10_000 });

    const first = await registry.propose(join(root, "."));
    const second = await registry.propose(root);

    expect(first.fingerprint).toHaveLength(64);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("rejects a path that is not a Git root", async () => {
    const state = setup();
    const registry = new FileRepositoryRegistry({ ...state, now: state.now, proposalTtlMs: 10_000 });
    await expect(registry.propose(process.cwd())).rejects.toThrow("Not a Git repository");
  });

  it("expires proposals and consumes an approval nonce exactly once", async () => {
    const state = setup();
    const root = await realpath(process.cwd());
    state.identities.set(root, { canonicalRoot: root, gitIdentity: "git-123" });
    const registry = new FileRepositoryRegistry({ ...state, now: state.now, proposalTtlMs: 100 });
    const proposal = await registry.propose(root);

    state.setNow(1_099);
    const approved = await registry.approve({ proposalId: proposal.proposalId, fingerprint: proposal.fingerprint, approvalNonce: proposal.approvalNonce });
    expect(approved.repositoryId).not.toContain("C:/repo");
    await expect(registry.approve({ proposalId: proposal.proposalId, fingerprint: proposal.fingerprint, approvalNonce: proposal.approvalNonce })).rejects.toThrow("already used");

    const expired = await registry.propose(root);
    state.setNow(1_200);
    await expect(registry.approve({ proposalId: expired.proposalId, fingerprint: expired.fingerprint, approvalNonce: expired.approvalNonce })).rejects.toThrow("expired");
  });

  it("rejects a changed identity during approval and resolution", async () => {
    const state = setup();
    const root = await realpath(process.cwd());
    state.identities.set(root, { canonicalRoot: root, gitIdentity: "git-123" });
    const registry = new FileRepositoryRegistry({ ...state, now: state.now, proposalTtlMs: 10_000 });
    const proposal = await registry.propose(root);
    state.identities.set(root, { canonicalRoot: root, gitIdentity: "git-changed" });
    await expect(registry.approve({ proposalId: proposal.proposalId, fingerprint: proposal.fingerprint, approvalNonce: proposal.approvalNonce })).rejects.toThrow("identity");

    state.identities.set(root, { canonicalRoot: root, gitIdentity: "git-123" });
    const approved = await registry.approve({ proposalId: proposal.proposalId, fingerprint: proposal.fingerprint, approvalNonce: proposal.approvalNonce });
    state.identities.set(root, { canonicalRoot: root, gitIdentity: "git-changed" });
    await expect(registry.resolve(approved.repositoryId)).rejects.toThrow("identity");
  });

  it("loads durable allowlist entries on restart", async () => {
    const state = setup();
    const sourceState = setup();
    const root = await realpath(process.cwd());
    sourceState.identities.set(root, { canonicalRoot: root, gitIdentity: "git-123" });
    const sourceRegistry = new FileRepositoryRegistry({ ...sourceState, now: sourceState.now, proposalTtlMs: 10_000 });
    const proposed = await sourceRegistry.propose(root);
    const entry: ApprovedRepository = { repositoryId: "repo-id", canonicalRoot: root, fingerprint: proposed.fingerprint, gitIdentity: "git-123", approvedAt: "1970-01-01T00:00:01.000Z", lastVerifiedAt: "1970-01-01T00:00:01.000Z", payloadVersion: 1 };
    state.identities.set(root, { canonicalRoot: root, gitIdentity: "git-123" });
    const registry = new FileRepositoryRegistry({ ...state, persistence: setup([entry]).persistence, now: state.now, proposalTtlMs: 10_000 });
    expect((await registry.resolve("repo-id")).repositoryId).toBe("repo-id");
  });

  it("reloads an unexpired proposal after restart and consumes it durably", async () => {
    const state = setup();
    const root = await realpath(process.cwd());
    state.identities.set(root, { canonicalRoot: root, gitIdentity: "git-123" });
    const first = new FileRepositoryRegistry({ ...state, now: state.now, proposalTtlMs: 10_000 });
    const proposal = await first.propose(root);

    const restarted = new FileRepositoryRegistry({ ...state, now: state.now, proposalTtlMs: 10_000 });
    const approved = await restarted.approve({ proposalId: proposal.proposalId, fingerprint: proposal.fingerprint, approvalNonce: proposal.approvalNonce });
    const afterApproval = new FileRepositoryRegistry({ ...state, now: state.now, proposalTtlMs: 10_000 });

    expect((await afterApproval.resolve(approved.repositoryId)).repositoryId).toBe(approved.repositoryId);
    await expect(afterApproval.approve({ proposalId: proposal.proposalId, fingerprint: proposal.fingerprint, approvalNonce: proposal.approvalNonce })).rejects.toThrow(/already used|not found/i);
  });

  it("does not acknowledge approval unless allowlist persistence and proposal consumption commit together", async () => {
    const state = setup();
    const root = await realpath(process.cwd());
    state.identities.set(root, { canonicalRoot: root, gitIdentity: "git-123" });
    const proposal = await new FileRepositoryRegistry({ ...state, now: state.now, proposalTtlMs: 10_000 }).propose(root);
    state.persistence.approveProposal = async () => { throw new Error("atomic commit failed"); };
    const restarted = new FileRepositoryRegistry({ ...state, now: state.now, proposalTtlMs: 10_000 });

    await expect(restarted.approve({ proposalId: proposal.proposalId, fingerprint: proposal.fingerprint, approvalNonce: proposal.approvalNonce })).rejects.toThrow("atomic commit failed");
    expect(state.entries()).toEqual([]);
    expect(state.savedProposals).toHaveLength(1);
  });

  it("does not reload expired proposals", async () => {
    const state = setup();
    const root = await realpath(process.cwd());
    state.identities.set(root, { canonicalRoot: root, gitIdentity: "git-123" });
    const proposal = await new FileRepositoryRegistry({ ...state, now: state.now, proposalTtlMs: 100 }).propose(root);
    state.setNow(1_100);

    const restarted = new FileRepositoryRegistry({ ...state, now: state.now, proposalTtlMs: 100 });
    await expect(restarted.approve({ proposalId: proposal.proposalId, fingerprint: proposal.fingerprint, approvalNonce: proposal.approvalNonce })).rejects.toThrow(/already used|not found/i);
  });
});
