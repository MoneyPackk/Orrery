import { describe, expect, it, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Mission } from "@orrery/mission-control-domain";
import type { EvidenceStore, MissionRepository, WorkspaceService, CommandRunner } from "./ports";
import type { MissionWorkspace, ChangeSnapshot, CommandResult } from "./types";
import { MissionRunner, type MissionRunnerEvent, type RunMissionInput } from "./mission-runner";
import { GitWorkspaceService, type GitCommand } from "./git-workspace-service";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const mission = (overrides: Partial<Mission> = {}): Mission => ({
  id: "mission-1",
  title: "Ship the change",
  goal: "Make the deterministic change",
  mode: "build",
  status: "queued",
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
  targetBranch: "main",
  plan: {
    id: "plan-1",
    revision: 1,
    approved: true,
    createdAt: "2026-08-28T00:00:00.000Z",
    scope: "file",
    actions: ["write the file"],
    acceptanceCriteria: ["verification passes"],
  },
  events: [],
  changes: [],
  evidence: [],
  ...overrides,
});

function ports() {
  const saves: Mission[] = [];
  const events: MissionRunnerEvent[] = [];
  const workspace: MissionWorkspace = {
    id: "workspace-1", missionId: "mission-1", repositoryRoot: "C:/repo", worktreePath: "C:/repo/.orrery/worktrees/workspace-1",
    targetBranch: "main", missionBranch: "orrery/mission-1", initialRevision: "abc",
  };
  const snapshot: ChangeSnapshot = { revision: "change-1", files: [{ path: "orrery-mission.txt", additions: 1, deletions: 0, binary: false, diff: "+change" }], unifiedDiff: "+change" };
  const command: CommandResult = { executable: "node", args: ["--check", "scripts/desktop-smoke.mjs"], cwd: workspace.worktreePath, startedAt: "a", completedAt: "b", exitCode: 0, signal: null, stdout: "ok", stderr: "", truncated: false };
  const repository: MissionRepository = { save: async (value) => { saves.push(structuredClone(value)); }, load: async () => saves.at(-1) ?? null };
  const workspaceService: WorkspaceService = { createMissionWorkspace: async () => workspace, removeMissionWorkspace: async () => undefined, inspectChanges: async () => snapshot, preparePromotion: async () => { throw new Error("not used"); }, promote: async () => { throw new Error("not used"); }, promoteRetry: async () => { throw new Error("not used"); } };
  const commandRunner: CommandRunner = { run: async () => command };
  const evidenceStore: EvidenceStore = { append: async (value) => ({ ...value, id: `evidence-${saves.length}`, timestamp: "c" }) };
  const fileSystem = { writeFile: async () => undefined };
  return { saves, events, workspace, snapshot, command, repository, workspaceService, commandRunner, evidenceStore, fileSystem };
}

const input = (p: ReturnType<typeof ports>, overrides: Partial<RunMissionInput> = {}): RunMissionInput => ({
  mission: mission(), repositoryRoot: "C:/repo", targetBranch: "main", runId: "run-1", now: () => "2026-08-28T01:00:00.000Z",
  verificationCommand: { executable: "node", args: ["--check", "scripts/desktop-smoke.mjs"] },
  ...p, ...overrides,
});

describe("MissionRunner", () => {
  afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

  it("persists each transition before emitting it and binds the result to mission, run, and plan revision", async () => {
    const p = ports();
    const runner = new MissionRunner({ ...p, onEvent: async (event) => { p.events.push(event); } });
    const result = await runner.run(input(p));

    expect(result).toMatchObject({ missionId: "mission-1", runId: "run-1", planRevisionId: "plan-1", status: "ready_for_review" });
    expect(result.changeSnapshot).toBe(p.snapshot);
    expect(p.events).toHaveLength(6);
    expect(p.saves).toHaveLength(6);
    expect(p.saves.map((save) => save.status)).toEqual(["running", "running", "running", "running", "running", "ready_for_review"]);
    expect(p.saves.map((save) => save.events.length)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("uses per-run persistence and event adapters when the daemon supplies them", async () => {
    const p = ports();
    const runSaves: Mission[] = [];
    const runEvents: MissionRunnerEvent[] = [];
    const runner = new MissionRunner({ ...p, repository: { save: async () => { throw new Error("constructor repository used"); }, load: p.repository.load } });

    await runner.run(input(p, {
      repository: { save: async (value) => { runSaves.push(structuredClone(value)); }, load: async () => runSaves.at(-1) ?? null },
      onEvent: async (event) => { runEvents.push(event); },
    }));

    expect(runSaves).toHaveLength(6);
    expect(runEvents).toHaveLength(6);
  });

  it("records failed verification and still completes with a failed result", async () => {
    const p = ports();
    p.commandRunner.run = async () => ({ ...p.command, exitCode: 2, stderr: "bad" });
    const result = await new MissionRunner(p).run(input(p));
    expect(result.status).toBe("failed");
    expect(result.mission.evidence.find((evidence) => evidence.kind === "command")).toMatchObject({ status: "failed", planRevisionId: "plan-1" });
  });

  it("does not run a verification command when it is omitted", async () => {
    const p = ports();
    let calls = 0;
    p.commandRunner.run = async () => { calls++; return p.command; };
    const result = await new MissionRunner(p).run(input(p, { verificationCommand: undefined }));
    expect(calls).toBe(0);
    expect(result.status).toBe("ready_for_review");
    expect(result.mission.evidence.find((evidence) => evidence.kind === "manual")).toMatchObject({
      status: "warning",
      summary: expect.stringMatching(/verification.*not run/i),
    });
    expect(result.mission.completionSummary).not.toMatch(/verification passed/i);
  });

  it("cancels live verification with the run signal without recording command evidence or completion", async () => {
    const p = ports();
    const controller = new AbortController();
    p.commandRunner.run = async (command) => {
      expect(command.signal).toBe(controller.signal);
      controller.abort();
      return p.command;
    };

    await expect(new MissionRunner(p).run(input(p, { signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });

    expect(p.saves.at(-1)?.status).toBe("cancelled");
    expect(p.saves.at(-1)?.evidence.some((evidence) => evidence.kind === "command")).toBe(false);
    expect(p.saves.at(-1)?.events.some((event) => event.kind === "completion")).toBe(false);
  });

  it("does not claim the mission file was updated when the change snapshot is empty", async () => {
    const p = ports();
    p.workspaceService.inspectChanges = async () => ({ revision: "unchanged", files: [], unifiedDiff: "" });

    const result = await new MissionRunner(p).run(input(p));

    expect(result.mission.completionSummary).not.toMatch(/file updated/i);
    expect(result.mission.completionSummary).toMatch(/no file changes/i);
    expect(result.status).not.toBe("ready_for_review");
    expect(result.mission.evidence.some((evidence) => evidence.kind === "diagnostic")).toBe(false);
  });

  it("leaves a recoverable workspace when evidence persistence fails after workspace creation", async () => {
    const p = ports();
    let workspaceExists = false;
    let cleanupCalls = 0;
    p.workspaceService.createMissionWorkspace = async () => {
      if (workspaceExists) throw new Error("workspace already exists");
      workspaceExists = true;
      return p.workspace;
    };
    p.workspaceService.removeMissionWorkspace = async () => { cleanupCalls++; workspaceExists = false; };
    let saves = 0;
    p.evidenceStore.append = async (value) => {
      if (++saves === 1) throw new Error("evidence disk full");
      return { ...value, id: `evidence-${saves}`, timestamp: "c" };
    };

    const runner = new MissionRunner(p);
    await expect(runner.run(input(p))).rejects.toThrow("evidence disk full");
    expect(cleanupCalls).toBe(1);
    expect(p.saves.at(-1)?.status).toBe("failed");
    const freshLoaded = await p.repository.load("mission-1");
    expect(freshLoaded?.status).toBe("failed");
    expect(freshLoaded?.activeRunId).toBeUndefined();
  });

  it("persists a terminal failure before cleaning a workspace after a durable transition", async () => {
    const p = ports();
    p.repository.save = async (value) => { p.saves.push(structuredClone(value)); };
    p.evidenceStore.append = async () => { throw new Error("evidence disk full"); };
    let workspaceRemoved = false;
    p.workspaceService.removeMissionWorkspace = async () => { workspaceRemoved = true; };

    await expect(new MissionRunner(p).run(input(p))).rejects.toThrow("evidence disk full");

    expect(p.saves.at(-1)?.status).toBe("failed");
    expect(workspaceRemoved).toBe(true);
    const freshRepository: MissionRepository = { save: async () => undefined, load: async () => p.saves.at(-1) ?? null };
    expect((await freshRepository.load("mission-1"))?.status).toBe("failed");
  });

  it("persists cancellation before emitting the cancellation event", async () => {
    const p = ports();
    const controller = new AbortController();
    const runner = new MissionRunner({ ...p, onEvent: async (event) => { p.events.push(event); if (event.kind === "workspace") controller.abort(); } });
    await expect(runner.run(input(p, { signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
    expect(p.saves.at(-1)?.status).toBe("cancelled");
    expect(p.events.at(-1)?.kind).toBe("cancellation");
  });

  it("does not emit when persisting the preceding transition fails", async () => {
    const p = ports();
    let saves = 0;
    p.repository.save = async () => { saves++; if (saves === 1) throw new Error("disk full"); };
    const events: MissionRunnerEvent[] = [];
    await expect(new MissionRunner({ ...p, onEvent: async (event) => { events.push(event); } }).run(input(p))).rejects.toThrow("disk full");
    expect(events).toEqual([]);
  });

  it("cleans up a newly-created workspace when its first repository save fails so a retry can recreate it", async () => {
    const p = ports();
    let workspaceExists = false;
    let cleanupCalls = 0;
    p.workspaceService.createMissionWorkspace = async () => {
      if (workspaceExists) throw new Error("workspace already exists");
      workspaceExists = true;
      return p.workspace;
    };
    p.workspaceService.removeMissionWorkspace = async () => {
      cleanupCalls++;
      workspaceExists = false;
    };
    let fail = true;
    p.repository.save = async (value) => {
      if (fail) {
        fail = false;
        throw new Error("disk full");
      }
      p.saves.push(structuredClone(value));
    };
    const runner = new MissionRunner(p);

    await expect(runner.run(input(p))).rejects.toThrow("disk full");
    expect(cleanupCalls).toBe(1);
    await expect(runner.run(input(p, { runId: "run-2" }))).resolves.toMatchObject({ status: "ready_for_review" });
  });

  it("writes only inside a real isolated Git worktree and runs the exact command there", async () => {
    const root = await mkdtemp(join(tmpdir(), "orrery-runner-"));
    temporaryDirectories.push(root);
    await execFileAsync("git", ["init", "--initial-branch", "main"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@orrery.local"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Orrery Test"], { cwd: root });
    await writeFile(join(root, "fixture.txt"), "initial\n");
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
    const git: GitCommand = async (args, cwd) => {
      const result = await execFileAsync("git", args, { cwd });
      return { stdout: result.stdout, stderr: result.stderr };
    };
    const workspaceService = new GitWorkspaceService({ git });
    let commandCwd = "";
    const p = ports();
    const result = await new MissionRunner({
      workspaceService,
      commandRunner: { run: async (command) => { commandCwd = command.cwd; return p.command; } },
      evidenceStore: p.evidenceStore,
      repository: p.repository,
      fileSystem: { writeFile: async (path, content) => writeFile(path, content) },
    }).run(input(p, { repositoryRoot: root, mission: mission({ id: "550e8400-e29b-41d4-a716-446655440000" }) }));
    expect(commandCwd).toBe(result.workspace.worktreePath);
    expect(await readFile(join(result.workspace.worktreePath, "orrery-mission.txt"), "utf8")).toContain("Ship the change");
    await expect(readFile(join(root, "orrery-mission.txt"), "utf8")).rejects.toThrow();
    expect(result.changeSnapshot.files[0].path).toBe("orrery-mission.txt");
  });

  it.runIf(process.platform !== "win32")("refuses a committed mission-file symlink without writing outside the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "orrery-runner-link-"));
    temporaryDirectories.push(root);
    const worktree = join(root, "worktree");
    const outside = join(root, "outside.txt");
    await mkdir(worktree);
    await writeFile(outside, "outside remains unchanged\n");
    await symlink(outside, join(worktree, "orrery-mission.txt"), "file");
    await execFileAsync("git", ["init", "--initial-branch", "main"], { cwd: worktree });
    await execFileAsync("git", ["config", "user.email", "test@orrery.local"], { cwd: worktree });
    await execFileAsync("git", ["config", "user.name", "Orrery Test"], { cwd: worktree });
    await execFileAsync("git", ["add", "orrery-mission.txt"], { cwd: worktree });
    await execFileAsync("git", ["commit", "-m", "malicious link"], { cwd: worktree });
    const p = ports();
    p.workspaceService.createMissionWorkspace = async () => ({ ...p.workspace, worktreePath: worktree });

    await expect(new MissionRunner({ ...p, fileSystem: undefined }).run(input(p))).rejects.toThrow(/mission file|symbolic link|safe/i);
    expect(await readFile(outside, "utf8")).toBe("outside remains unchanged\n");
  });

  it.runIf(process.platform === "win32")("refuses an untracked mission-file junction without writing outside the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "orrery-runner-junction-"));
    temporaryDirectories.push(root);
    const worktree = join(root, "worktree");
    const outside = join(root, "outside");
    await mkdir(worktree);
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), "outside remains unchanged\n");
    await symlink(outside, join(worktree, "orrery-mission.txt"), "junction");
    const p = ports();
    p.workspaceService.createMissionWorkspace = async () => ({ ...p.workspace, worktreePath: worktree });

    await expect(new MissionRunner({ ...p, fileSystem: undefined }).run(input(p))).rejects.toThrow(/mission file|symbolic link|safe/i);
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("outside remains unchanged\n");
  });

  it("refuses a replaced mission worktree parent without writing to the redirect target", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "orrery-runner-parent-swap-repo-"));
    const runtimeParent = await mkdtemp(join(tmpdir(), "orrery-runner-parent-swap-runtime-"));
    const outside = await mkdtemp(join(tmpdir(), "orrery-runner-parent-swap-outside-"));
    temporaryDirectories.push(repositoryRoot, runtimeParent, outside);
    await execFileAsync("git", ["init", "--initial-branch", "main"], { cwd: repositoryRoot });
    await execFileAsync("git", ["config", "user.email", "test@orrery.local"], { cwd: repositoryRoot });
    await execFileAsync("git", ["config", "user.name", "Orrery Test"], { cwd: repositoryRoot });
    await writeFile(join(repositoryRoot, "fixture.txt"), "initial\n");
    await execFileAsync("git", ["add", "."], { cwd: repositoryRoot });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repositoryRoot });
    const workspaceRoot = join(runtimeParent, "runtime");
    const workspaceService = new GitWorkspaceService({ git: async (args, cwd) => {
      const result = await execFileAsync("git", args, { cwd });
      return { stdout: result.stdout, stderr: result.stderr };
    }, workspaceRoot });
    const p = ports();

    await expect(new MissionRunner({
      workspaceService,
      commandRunner: p.commandRunner,
      evidenceStore: p.evidenceStore,
      repository: p.repository,
      onEvent: async (event) => {
        if (event.kind !== "workspace") return;
        const workspacePath = event.detail;
        await rm(workspacePath, { recursive: true, force: true });
        await symlink(outside, workspacePath, process.platform === "win32" ? "junction" : "dir");
      },
    }).run(input(p, {
      repositoryRoot,
      mission: mission({ id: "550e8400-e29b-41d4-a716-446655440009" }),
    }))).rejects.toThrow(/workspace|mission file|safe/i);

    await expect(readFile(join(outside, "orrery-mission.txt"), "utf8")).rejects.toThrow();
  });

  it("reruns the same plan revision with a new run binding", async () => {
    const p = ports();
    const runner = new MissionRunner(p);
    const first = await runner.run(input(p, { runId: "run-1" }));
    const second = await runner.run(input(p, { runId: "run-2" }));
    expect(first.planRevisionId).toBe(second.planRevisionId);
    expect(second.runId).toBe("run-2");
    expect(second.mission.activeRunId).toBeUndefined();
  });
});
