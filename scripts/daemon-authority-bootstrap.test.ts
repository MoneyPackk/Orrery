import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createMission, transitionMission } from "../packages/mission-control-domain/src/index";
import { FileMissionStore, type GitInspector, type MissionSnapshot } from "../packages/mission-control-daemon/src/index";
import { createDaemonAuthority } from "./daemon-authority-bootstrap";

describe("daemon authority bootstrap", () => {
  it("starts a cancellable run through the real authority bootstrap", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-authority-run-cancel-"));
    const repositoryRoot = join(parent, "repository");
    const runtime = join(parent, "runtime");
    const command = { executable: process.execPath, args: ["-e", "setTimeout(() => {}, 30_000)"] };
    try {
      await mkdir(repositoryRoot);
      await git(["init", "--initial-branch", "main"], repositoryRoot);
      await git(["config", "user.email", "bootstrap-test@orrery.local"], repositoryRoot);
      await git(["config", "user.name", "Orrery Bootstrap Test"], repositoryRoot);
      await writeFile(join(repositoryRoot, "fixture.txt"), "initial\n", "utf8");
      await git(["add", "fixture.txt"], repositoryRoot);
      await git(["commit", "-m", "fixture"], repositoryRoot);
      const bootstrap = await createDaemonAuthority(runtime, {
        trustedVerificationCommands: [command],
        verificationCommandResolver: () => command,
      });
      const proposal = await bootstrap.registry.propose(repositoryRoot);
      const approved = await bootstrap.registry.approve({ proposalId: proposal.proposalId, fingerprint: proposal.fingerprint, approvalNonce: proposal.approvalNonce });
      const mission = await bootstrap.authority.create({
        intentId: "create-run-cancel",
        repositoryId: approved.repositoryId,
        title: "Cancel active verification",
        goal: "Expose the active run before cancellation.",
        mode: "build",
        plan: { scope: "fixture", actions: ["run verification"], acceptanceCriteria: ["verification starts"] },
      });

      const run = bootstrap.authority.run({ intentId: "run-cancel", missionId: mission.id, planRevisionId: mission.plan.id });
      const active = await waitForActiveRun(new FileMissionStore(runtime), mission.id, run);
      await expect(bootstrap.authority.cancel({ intentId: "cancel-run", missionId: mission.id, runId: active })).resolves.toMatchObject({ status: "cancelled" });
      await expect(run).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 15_000);

  it("creates private durable state and an empty authority", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-authority-bootstrap-"));
    try {
      const runtime = join(parent, "runtime");
      const result = await createDaemonAuthority(runtime);

      expect(await readdir(runtime)).toEqual(expect.arrayContaining(["repositories", "missions", "events", "evidence", "workspaces", "transactions"]));
      expect((await stat(join(runtime, "repositories"))).isDirectory()).toBe(true);
      if (process.platform !== "win32") expect((await stat(join(runtime, "repositories"))).mode & 0o777).toBe(0o700);
      await expect(result.registry.list()).resolves.toEqual([]);
      await expect(result.authority).toBeDefined();
      expect(result).not.toHaveProperty("promotionApprovalIssuer");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("keeps promotion unavailable for a standalone or TUI-owned daemon without a pinned key", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-authority-no-key-"));
    try {
      const result = await createDaemonAuthority(join(parent, "runtime"));
      expect(result).not.toHaveProperty("promotionApprovalIssuer");
      expect(result.promotionApprovalEnabled).toBe(false);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("exposes an issuer only for an explicitly injected trusted approval context", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-authority-approval-"));
    try {
      const result = await createDaemonAuthority(join(parent, "runtime"), { trustedApprovalContext: { reviewerId: () => "headless-smoke" } });
      expect(result.promotionApprovalIssuer).toBeDefined();
      expect(result.authority).not.toHaveProperty("issuePromotionApproval");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("loads approved repositories and missions after restart", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-authority-restart-"));
    try {
      const runtime = join(parent, "runtime");
      const repositoryRoot = join(parent, "repository");
      await mkdir(repositoryRoot);
      const gitInspector: GitInspector = { inspect: async () => ({ canonicalRoot: repositoryRoot, gitIdentity: "fixture-git" }) };
      const first = await createDaemonAuthority(runtime, { gitInspector });
      const proposal = await first.registry.propose(repositoryRoot);
      const approved = await first.registry.approve({ proposalId: proposal.proposalId, fingerprint: proposal.fingerprint, approvalNonce: proposal.approvalNonce });
      const mission = await first.authority.create({
        intentId: "create-restart",
        repositoryId: approved.repositoryId,
        title: "Persist me",
        goal: "Remain visible after restart",
        mode: "build",
        plan: { scope: "fixture", actions: ["change fixture"], acceptanceCriteria: ["fixture changed"] },
      });

      const restarted = await createDaemonAuthority(runtime, { gitInspector });

      const reloaded = await restarted.registry.get(mission.id);
      expect(reloaded).toMatchObject({ id: mission.id });
      expect(reloaded).not.toHaveProperty("repositoryId");
      await expect(new FileMissionStore(runtime).load(mission.id)).resolves.toMatchObject({ id: mission.id, repositoryId: approved.repositoryId });
      await expect(restarted.registry.propose(repositoryRoot)).resolves.toMatchObject({ canonicalRoot: repositoryRoot });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("loads an unexpired proposal after restart and removes its durable record on approval", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-authority-proposal-restart-"));
    try {
      const runtime = join(parent, "runtime");
      const repositoryRoot = join(parent, "repository");
      await mkdir(repositoryRoot);
      const gitInspector: GitInspector = { inspect: async () => ({ canonicalRoot: repositoryRoot, gitIdentity: "fixture-git" }) };
      const first = await createDaemonAuthority(runtime, { gitInspector });
      const proposal = await first.registry.propose(repositoryRoot);

      const restarted = await createDaemonAuthority(runtime, { gitInspector });
      await expect(restarted.registry.approve({ proposalId: proposal.proposalId, fingerprint: proposal.fingerprint, approvalNonce: proposal.approvalNonce })).resolves.toHaveProperty("repositoryId");
      await expect(readFile(join(runtime, "repositories", `proposal-${proposal.proposalId}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("bounds approved registry and evidence reads", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-authority-bounds-"));
    try {
      const runtime = join(parent, "runtime");
      await createDaemonAuthority(runtime);
      await writeFile(join(runtime, "repositories", "approved.json"), " ".repeat(4 * 1024 * 1024 + 1), "utf8");
      await expect(createDaemonAuthority(runtime)).rejects.toThrow(/too large/i);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("refuses corrupt persisted snapshots during bootstrap", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-authority-corrupt-"));
    try {
      const runtime = join(parent, "runtime");
      await createDaemonAuthority(runtime);
      await writeFile(join(runtime, "missions", "broken.json"), "not-json\n", "utf8");

      await expect(createDaemonAuthority(runtime)).rejects.toThrow(/corrupt|json/i);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects adversarial approved repository persistence", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-authority-repository-corrupt-"));
    try {
      const valid = {
        repositoryId: "a".repeat(32), canonicalRoot: resolve(parent), fingerprint: "b".repeat(64), gitIdentity: "c".repeat(64),
        approvedAt: "2026-08-28T10:00:00.000Z", lastVerifiedAt: "2026-08-28T10:00:00.000Z", payloadVersion: 1,
      };
      const cases = [
        [{ ...valid, unexpected: true }],
        [{ ...valid, repositoryId: "bad id" }],
        [{ ...valid, fingerprint: "short" }],
        [{ ...valid, gitIdentity: "" }],
        [{ ...valid, approvedAt: "yesterday" }],
        [{ ...valid, canonicalRoot: "relative/repository" }],
        [valid, { ...valid }],
      ];
      for (const [index, records] of cases.entries()) {
        const runtime = join(parent, `runtime-${index}`);
        await createDaemonAuthority(runtime);
        await writeFile(join(runtime, "repositories", "approved.json"), `${JSON.stringify(records)}\n`, "utf8");
        await expect(createDaemonAuthority(runtime)).rejects.toThrow(/corrupt|invalid|duplicate/i);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects adversarial repository proposal persistence", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-authority-proposal-corrupt-"));
    try {
      const valid = {
        proposalId: "a".repeat(32), canonicalRoot: resolve(parent), fingerprint: "b".repeat(64), gitIdentity: "c".repeat(64),
        approvalNonceHash: "d".repeat(64), expiresAt: "2099-08-28T10:00:00.000Z", payloadVersion: 1,
      };
      const cases = [
        { ...valid, proposalId: "bad id" },
        { ...valid, canonicalRoot: "relative/repository" },
        { ...valid, approvalNonceHash: "short" },
        { ...valid, expiresAt: "never" },
        { ...valid, unexpected: true },
      ];
      for (const [index, proposal] of cases.entries()) {
        const runtime = join(parent, `runtime-${index}`);
        await createDaemonAuthority(runtime);
        await writeFile(join(runtime, "repositories", `proposal-${proposal.proposalId}.json`), `${JSON.stringify(proposal)}\n`, "utf8");
        await expect(createDaemonAuthority(runtime)).rejects.toThrow(/corrupt|invalid/i);
      }
      const duplicateRuntime = join(parent, "runtime-duplicate");
      await createDaemonAuthority(duplicateRuntime);
      await writeFile(join(duplicateRuntime, "repositories", `proposal-${valid.proposalId}.json`), `${JSON.stringify(valid)}\n`, "utf8");
      await writeFile(join(duplicateRuntime, "repositories", `proposal-${valid.proposalId}.json.copy.json`), `${JSON.stringify(valid)}\n`, "utf8");
      await expect(createDaemonAuthority(duplicateRuntime)).rejects.toThrow(/corrupt|duplicate/i);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 20_000);

  it("durably fails a persisted active mission with an interruption event", async () => {
    const parent = await mkdtemp(join(tmpdir(), "orrery-authority-recovery-"));
    try {
      const runtime = join(parent, "runtime");
      const initial = await createDaemonAuthority(runtime);
      const store = new FileMissionStore(runtime);
      const active = activeMission();
      await store.create(active);

      await initial.recoverActiveMissions();

      const recovered = await store.load(active.id);
      expect(recovered).toMatchObject({ status: "failed", lastEventSequence: 1 });
      expect(recovered?.activeRunId).toBeUndefined();
      expect(recovered?.events).toEqual([expect.objectContaining({ kind: "interruption", runId: "run-before-restart", sequence: 1 })]);
      await expect(initial.eventSource.readAfter(active.id, 0)).resolves.toEqual([expect.objectContaining({ kind: "interruption", sequence: 1 })]);
      await initial.recoverActiveMissions();
      await expect(initial.eventSource.readAfter(active.id, 0)).resolves.toHaveLength(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it.each(["prepared", "in_progress"] as const)("durably resets a %s run operation stranded before active run persistence", async (state) => {
    const parent = await mkdtemp(join(tmpdir(), `orrery-authority-${state}-recovery-`));
    try {
      const runtime = join(parent, "runtime");
      const bootstrap = await createDaemonAuthority(runtime);
      const store = new FileMissionStore(runtime);
      const stranded = queuedMission(state);
      await store.create(stranded);

      await bootstrap.recoverActiveMissions();

      const recovered = await store.load(stranded.id);
      expect(recovered).toMatchObject({ status: "failed", lastEventSequence: 1 });
      expect(recovered?.activeRunId).toBeUndefined();
      expect(recovered?.operations?.["run-before-restart"]).toBeUndefined();
      expect(recovered?.events).toEqual([expect.objectContaining({ kind: "interruption", runId: "operation-run-id", sequence: 1 })]);
      await bootstrap.recoverActiveMissions();
      await expect(bootstrap.eventSource.readAfter(stranded.id, 0)).resolves.toHaveLength(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string) {
  return execFileAsync("git", args, { cwd });
}

async function waitForActiveRun(store: FileMissionStore, missionId: string, run: Promise<unknown>): Promise<string> {
  const timeout = Date.now() + 10_000;
  while (Date.now() < timeout) {
    const mission = await store.load(missionId);
    if (mission?.activeRunId) return mission.activeRunId;
    const outcome = await Promise.race([run.then(() => "resolved", () => "rejected"), new Promise<"pending">((resolvePending) => setTimeout(() => resolvePending("pending"), 25))]);
    if (outcome !== "pending") await run;
  }
  throw new Error("Run did not expose a durable activeRunId.");
}

function activeMission(): MissionSnapshot {
  let mission = createMission({
    title: "Interrupted mission",
    goal: "Recover safely",
    mode: "build",
    plan: { scope: "fixture", actions: ["change fixture"], acceptanceCriteria: ["fixture changed"] },
  });
  mission = transitionMission(mission, { type: "submit_plan" });
  mission = transitionMission(mission, { type: "approve_plan" });
  mission = transitionMission(mission, { type: "start", workspaceId: `mission-${mission.id}`, runId: "run-before-restart" });
  return { ...mission, repositoryId: "repository-1", fingerprint: "fingerprint-1", lastEventSequence: 0, payloadVersion: 1 };
}

function queuedMission(state: "prepared" | "in_progress"): MissionSnapshot {
  let mission = createMission({
    title: "Stranded operation",
    goal: "Recover the durable claim",
    mode: "build",
    plan: { scope: "fixture", actions: ["change fixture"], acceptanceCriteria: ["fixture changed"] },
  });
  mission = transitionMission(mission, { type: "submit_plan" });
  mission = transitionMission(mission, { type: "approve_plan" });
  return {
    ...mission,
    repositoryId: "repository-1",
    fingerprint: "fingerprint-1",
    lastEventSequence: 0,
    payloadVersion: 1,
    operations: {
      "run-before-restart": {
        operation: "run",
        requestDigest: "a".repeat(64),
        state,
        runId: "operation-run-id",
      },
    },
  };
}
