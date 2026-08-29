import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FilePromotionRetryRepository, GitWorkspaceService, type GitCommand } from "./git-workspace-service";
import type { PromotionRetryRepository } from "./ports";
import type { MissionWorkspace, PromotionRetryToken } from "./types";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const ACTIVE_APPROVAL_EXPIRY = "2099-01-01T00:00:00.000Z";

function retryToken(missionRevision: string): PromotionRetryToken {
  return {
    missionRevision,
    expectedTargetRevision: "target-revision",
    targetBranch: "main",
    workspace: {
      id: "workspace-id",
      missionId: "550e8400-e29b-41d4-a716-446655440000",
      repositoryRoot: "repository-root",
      worktreePath: "worktree-path",
      missionBranch: "orrery/mission-550e8400-e29b-41d4-a716-446655440000",
      targetBranch: "main",
      initialRevision: "target-revision",
    },
    missionParent: "target-revision",
    missionTree: "mission-tree",
  };
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orrery-mission-"));
  temporaryDirectories.push(root);
  await execFileAsync("git", ["init", "--initial-branch", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@orrery.local"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Orrery Test"], { cwd: root });
  await writeFile(join(root, "fixture.txt"), "initial\n");
  await execFileAsync("git", ["add", "fixture.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

async function createWorkspace() {
  const repositoryRoot = await createRepository();
  const service = new GitWorkspaceService({ git: realGit });
  const workspace = await service.createMissionWorkspace({
    missionId: crypto.randomUUID(),
    repositoryRoot,
    targetBranch: "main",
  });
  return { repositoryRoot, service, workspace };
}

const realGit: GitCommand = async (args, cwd, options) => {
  const result = await execFileAsync("git", args, { cwd, env: options?.env });
  return { stdout: result.stdout, stderr: result.stderr };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FilePromotionRetryRepository locking", () => {
  it("recovers a stale abandoned lock whose owner process is dead", async () => {
    const repositoryRoot = await createRepository();
    const lockPath = join(repositoryRoot, ".orrery", "promotion-retries.json.lock");
    await mkdir(join(repositoryRoot, ".orrery"));
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      ownerId: "abandoned-owner",
      pid: 424242,
      hostname: "test-host",
      acquiredAt: "2026-08-28T09:00:00.000Z",
    }));
    const repository = new FilePromotionRetryRepository(repositoryRoot, {
      acquisitionTimeoutMs: 100,
      staleAfterMs: 1_000,
      retryDelayMs: 1,
      now: () => new Date("2026-08-28T10:00:00.000Z"),
      hostname: "test-host",
      isProcessAlive: () => false,
    });
    const token = retryToken("stale-recovery");

    await repository.save(token);

    await expect(repository.claim(token)).resolves.toEqual(token);
  });

  it("times out without deleting an active lock owned by another process", async () => {
    const repositoryRoot = await createRepository();
    const lockPath = join(repositoryRoot, ".orrery", "promotion-retries.json.lock");
    const metadata = {
      ownerId: "active-owner",
      pid: 515151,
      hostname: "test-host",
      acquiredAt: "2026-08-28T09:00:00.000Z",
    };
    await mkdir(join(repositoryRoot, ".orrery"));
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify(metadata));
    const repository = new FilePromotionRetryRepository(repositoryRoot, {
      acquisitionTimeoutMs: 20,
      staleAfterMs: 1,
      retryDelayMs: 1,
      now: () => new Date("2026-08-28T10:00:00.000Z"),
      hostname: "test-host",
      isProcessAlive: () => true,
    });

    await expect(repository.save(retryToken("active-timeout"))).rejects.toThrow("Timed out acquiring promotion retry lock");
    expect(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"))).toEqual(metadata);
  });

  it("times out conservatively when lock owner metadata is malformed", async () => {
    const repositoryRoot = await createRepository();
    const lockPath = join(repositoryRoot, ".orrery", "promotion-retries.json.lock");
    await mkdir(join(repositoryRoot, ".orrery"));
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), "not-json");
    const repository = new FilePromotionRetryRepository(repositoryRoot, {
      acquisitionTimeoutMs: 20,
      staleAfterMs: 1,
      retryDelayMs: 1,
    });

    await expect(repository.save(retryToken("malformed-timeout"))).rejects.toThrow("Timed out acquiring promotion retry lock");
    await expect(readFile(join(lockPath, "owner.json"), "utf8")).resolves.toBe("not-json");
  });

  it("serializes concurrent claims and preserves atomic consume", async () => {
    const repositoryRoot = await createRepository();
    await mkdir(join(repositoryRoot, ".orrery"));
    const token = retryToken("concurrent-claim");
    const first = new FilePromotionRetryRepository(repositoryRoot, { retryDelayMs: 1 });
    const second = new FilePromotionRetryRepository(repositoryRoot, { retryDelayMs: 1 });
    await first.save(token);

    const claims = await Promise.all([first.claim(token), second.claim(token)]);

    expect(claims.filter((claim) => claim !== null)).toEqual([token]);
    const winner = claims[0] ? first : second;
    expect(await winner.consume(token)).toBe(true);
    expect(await first.claim(token)).toBeNull();
  });
});

describe("GitWorkspaceService", () => {
  it("creates a separate mission worktree at the target HEAD", async () => {
    const repositoryRoot = await createRepository();
    const runtimeParent = await mkdtemp(join(tmpdir(), "orrery-private-runtime-parent-"));
    temporaryDirectories.push(runtimeParent);
    const workspaceRoot = join(runtimeParent, "runtime");
    const service = new GitWorkspaceService({ git: realGit, workspaceRoot });

    const workspace = await service.createMissionWorkspace({
      missionId: "550e8400-e29b-41d4-a716-446655440000",
      repositoryRoot,
      targetBranch: "main",
    });

    expect(workspace.repositoryRoot).toBe(resolve(repositoryRoot));
    expect(workspace.worktreePath).toMatch(new RegExp(`${escapeRegex(join(workspaceRoot, "worktrees"))}.+${escapeRegex(workspace.id)}$`));
    expect(workspace.missionBranch).toBe("orrery/mission-550e8400-e29b-41d4-a716-446655440000");
    expect((await readFile(join(workspace.worktreePath, "fixture.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe(
      "initial\n",
    );
    expect((await realGit(["rev-parse", "--abbrev-ref", "HEAD"], workspace.worktreePath)).stdout.trim()).toBe(
      workspace.missionBranch,
    );
    expect((await realGit(["rev-parse", "main"], repositoryRoot)).stdout.trim()).toBe(workspace.initialRevision);
  });

  it("does not execute a configured post-checkout hook while creating the initial mission worktree", async () => {
    const repositoryRoot = await createRepository();
    const hooksPath = await mkdtemp(join(tmpdir(), "orrery-malicious-hooks-"));
    temporaryDirectories.push(hooksPath);
    const markerPath = join(repositoryRoot, "initial-hook-executed.txt");
    const hook = join(hooksPath, "post-checkout");
    await writeFile(hook, `#!/bin/sh\nprintf executed > "${markerPath.replaceAll("\\", "/")}"\n`);
    await chmod(hook, 0o755);
    await realGit(["config", "--local", "core.hooksPath", hooksPath], repositoryRoot);

    await new GitWorkspaceService({ git: realGit }).createMissionWorkspace({
      missionId: "550e8400-e29b-41d4-a716-446655440006",
      repositoryRoot,
      targetBranch: "main",
    });

    await expect(access(markerPath)).rejects.toThrow();
  });

  it("rejects mission IDs that could escape the branch and worktree namespaces", async () => {
    const repositoryRoot = await createRepository();
    const service = new GitWorkspaceService({ git: realGit });

    await expect(
      service.createMissionWorkspace({ missionId: "../../escape", repositoryRoot, targetBranch: "main" }),
    ).rejects.toThrow("missionId must be a UUID");
  });

  it("rejects a non-Git repository before creating workspace directories", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "orrery-not-git-"));
    temporaryDirectories.push(repositoryRoot);
    const service = new GitWorkspaceService({ git: realGit });

    await expect(
      service.createMissionWorkspace({
        missionId: "550e8400-e29b-41d4-a716-446655440001",
        repositoryRoot,
        targetBranch: "main",
      }),
    ).rejects.toThrow("repositoryRoot must be a Git repository");
    expect(await mkdir(join(repositoryRoot, ".orrery"), { recursive: true })).toBeDefined();
  });

  it("does not let a repository .orrery junction redirect workspace creation", async () => {
    const repositoryRoot = await createRepository();
    const outside = await mkdtemp(join(tmpdir(), "orrery-worktree-escape-"));
    temporaryDirectories.push(outside);
    await symlink(outside, join(repositoryRoot, ".orrery"), "junction");
    const runtimeParent = await mkdtemp(join(tmpdir(), "orrery-private-runtime-parent-"));
    temporaryDirectories.push(runtimeParent);
    const workspaceRoot = join(runtimeParent, "runtime");

    const workspace = await new GitWorkspaceService({ git: realGit, workspaceRoot }).createMissionWorkspace({
        missionId: "550e8400-e29b-41d4-a716-446655440007",
        repositoryRoot,
        targetBranch: "main",
      });

    expect(workspace.worktreePath).toMatch(new RegExp(`${escapeRegex(join(workspaceRoot, "worktrees"))}.+${escapeRegex(workspace.id)}$`));
    await expect(access(join(outside, "worktrees"))).rejects.toThrow();
  });

  it("rejects a mission branch collision without replacing the existing worktree", async () => {
    const repositoryRoot = await createRepository();
    await execFileAsync("git", ["branch", "orrery/mission-550e8400-e29b-41d4-a716-446655440003"], {
      cwd: repositoryRoot,
    });
    const service = new GitWorkspaceService({ git: realGit });

    await expect(
      service.createMissionWorkspace({
        missionId: "550e8400-e29b-41d4-a716-446655440003",
        repositoryRoot,
        targetBranch: "main",
      }),
    ).rejects.toThrow("Mission branch already exists");
    expect((await readFile(join(repositoryRoot, "fixture.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe(
      "initial\n",
    );
  });

  it("reports a missing Git executable clearly", async () => {
    const repositoryRoot = await createRepository();
    const unavailableGit: GitCommand = async () => {
      throw new Error("spawn git ENOENT");
    };
    const service = new GitWorkspaceService({ git: unavailableGit });

    await expect(
      service.createMissionWorkspace({
        missionId: "550e8400-e29b-41d4-a716-446655440004",
        repositoryRoot,
        targetBranch: "main",
      }),
    ).rejects.toThrow("repositoryRoot must be a Git repository");
  });

  it("cleans up a partially-created worktree when Git fails", async () => {
    const repositoryRoot = await createRepository();
    const calls: string[][] = [];
    const failingGit: GitCommand = async (args, cwd, options) => {
      calls.push(args);
      const worktreeIndex = args.indexOf("worktree");
      if (worktreeIndex >= 0 && args[worktreeIndex + 1] === "add") {
        await realGit(args, cwd, options);
        throw new Error("worktree failed");
      }
      return realGit(args, cwd, options);
    };
    const service = new GitWorkspaceService({ git: failingGit });

    await expect(
      service.createMissionWorkspace({
        missionId: "550e8400-e29b-41d4-a716-446655440002",
        repositoryRoot,
        targetBranch: "main",
      }),
    ).rejects.toThrow("worktree failed");
    expect(calls.some((args) => args.includes("worktree"))).toBe(true);
    await expect(access(join(repositoryRoot, ".orrery", "worktrees", "mission-550e8400-e29b-41d4-a716-446655440002"))).rejects.toThrow();
    await expect(
      realGit(["show-ref", "--verify", "refs/heads/orrery/mission-550e8400-e29b-41d4-a716-446655440002"], repositoryRoot),
    ).rejects.toThrow();
  });

  it("removes a created workspace and branch so the same mission can retry", async () => {
    const repositoryRoot = await createRepository();
    const service = new GitWorkspaceService({ git: realGit });
    const input = {
      missionId: "550e8400-e29b-41d4-a716-446655440005",
      repositoryRoot,
      targetBranch: "main",
    };
    const workspace = await service.createMissionWorkspace(input);

    await service.removeMissionWorkspace(workspace);

    await expect(access(workspace.worktreePath)).rejects.toThrow();
    await expect(realGit(["show-ref", "--verify", `refs/heads/${workspace.missionBranch}`], repositoryRoot)).rejects.toThrow();
    await expect(service.createMissionWorkspace(input)).resolves.toMatchObject({ missionId: input.missionId });
  });

  it("sanitizes every delegated Git process across create, inspect, promotion, and cleanup", async () => {
    const repositoryRoot = await createRepository();
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const recordingGit: GitCommand = async (args, cwd, options) => {
      calls.push({ args, env: options?.env });
      return realGit(args, cwd, options);
    };
    const service = new GitWorkspaceService({ git: recordingGit });
    const workspace = await service.createMissionWorkspace({
      missionId: crypto.randomUUID(),
      repositoryRoot,
      targetBranch: "main",
    });
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");
    const reviewedSnapshot = await service.inspectChanges(workspace);
    await expect(service.promote(workspace, "main", "reviewer@example.test", reviewedSnapshot, ACTIVE_APPROVAL_EXPIRY)).resolves.toMatchObject({
      status: "promoted",
    });
    await service.removeMissionWorkspace(workspace);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.args).toEqual(expect.arrayContaining(["core.fsmonitor=false", "diff.external="]));
      expect(call.args.some((arg) => arg.startsWith("core.hooksPath="))).toBe(true);
      expect(call.args.some((arg) => arg.startsWith("core.attributesFile="))).toBe(true);
      expect(call.env).toMatchObject({
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_EXTERNAL_DIFF: "",
        GIT_TERMINAL_PROMPT: "0",
      });
      expect(call.env?.GIT_CONFIG_GLOBAL).toContain("orrery-git-config-");
      expect(call.env?.HOME).toContain("orrery-git-config-");
    }
    const targetUpdate = calls.find(({ args }) => args[args.indexOf("update-ref") + 1] === "refs/heads/main");
    expect(targetUpdate?.args.slice(targetUpdate.args.indexOf("update-ref"), targetUpdate.args.indexOf("update-ref") + 4)).toEqual([
      "update-ref",
      "refs/heads/main",
      expect.stringMatching(/^[0-9a-f]{40}$/),
      workspace.initialRevision,
    ]);
    expect(calls.some(({ args }) => args.includes("merge"))).toBe(false);
  });

  it("cleans the derived workspace when a persisted worktree path is tampered", async () => {
    const { repositoryRoot, service, workspace } = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "orrery-remove-target-"));
    temporaryDirectories.push(outside);
    const sentinel = join(outside, "keep.txt");
    await writeFile(sentinel, "keep\n");

    await expect(service.removeMissionWorkspace({ ...workspace, worktreePath: outside })).resolves.toBeUndefined();
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
    await expect(access(workspace.worktreePath)).rejects.toThrow();
    await expect(realGit(["show-ref", "--verify", `refs/heads/${workspace.missionBranch}`], repositoryRoot)).rejects.toThrow();
  });

  it("rejects a tampered repository identity before invoking Git or rm", async () => {
    const { service, workspace } = await createWorkspace();
    const otherRepository = await createRepository();
    const sentinel = join(workspace.worktreePath, "keep.txt");
    await writeFile(sentinel, "keep\n");

    await expect(
      service.removeMissionWorkspace({ ...workspace, repositoryRoot: otherRepository }),
    ).rejects.toThrow("workspace identity");
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
  });

  it("returns an empty stable snapshot for a clean worktree", async () => {
    const { service, workspace } = await createWorkspace();

    const first = await service.inspectChanges(workspace);
    const second = await service.inspectChanges(workspace);

    expect(first).toEqual({ revision: first.revision, files: [], unifiedDiff: "" });
    expect(first.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(second.revision).toBe(first.revision);
  });

  it("reports a modified text file with additions, deletions, and its unified diff", async () => {
    const { service, workspace } = await createWorkspace();
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "changed\nsecond\n");

    const snapshot = await service.inspectChanges(workspace);

    expect(snapshot.files).toEqual([
      { path: "fixture.txt", additions: 2, deletions: 1, binary: false, diff: expect.stringContaining("+second") },
    ]);
    expect(snapshot.unifiedDiff).toContain("diff --git a/fixture.txt b/fixture.txt");
    expect(snapshot.unifiedDiff).toContain("-initial");
    expect(snapshot.unifiedDiff).toContain("+changed");
  });

  it("reports an added file before it is staged", async () => {
    const { service, workspace } = await createWorkspace();
    await writeFile(join(workspace.worktreePath, "added.txt"), "one\ntwo\n");

    const snapshot = await service.inspectChanges(workspace);

    expect(snapshot.files).toEqual([
      { path: "added.txt", additions: 2, deletions: 0, binary: false, diff: expect.stringContaining("+++ b/added.txt") },
    ]);
    expect(snapshot.unifiedDiff).toContain("new file mode 100644");
    expect(snapshot.unifiedDiff).toContain("+one");
  });

  it("reports a deleted file", async () => {
    const { service, workspace } = await createWorkspace();
    await unlink(join(workspace.worktreePath, "fixture.txt"));

    const snapshot = await service.inspectChanges(workspace);

    expect(snapshot.files).toEqual([
      { path: "fixture.txt", additions: 0, deletions: 1, binary: false, diff: expect.stringContaining("deleted file mode") },
    ]);
    expect(snapshot.unifiedDiff).toContain("--- a/fixture.txt");
    expect(snapshot.unifiedDiff).toContain("+++ /dev/null");
  });

  it("reports binary changes without pretending they have line counts", async () => {
    const { service, workspace } = await createWorkspace();
    await writeFile(join(workspace.worktreePath, "image.bin"), Buffer.from([0, 1, 2, 3, 255]));

    const snapshot = await service.inspectChanges(workspace);

    expect(snapshot.files).toEqual([
      { path: "image.bin", additions: 0, deletions: 0, binary: true, diff: expect.stringContaining("GIT binary patch") },
    ]);
    expect(snapshot.unifiedDiff).toContain("GIT binary patch");
  });

  it("treats option-like and spaced paths as data and changes identity with content", async () => {
    const { service, workspace } = await createWorkspace();
    const unsafeLookingPath = "--output unsafe name.txt";
    await writeFile(join(workspace.worktreePath, unsafeLookingPath), "first\n");

    const first = await service.inspectChanges(workspace);
    await writeFile(join(workspace.worktreePath, unsafeLookingPath), "second\n");
    const second = await service.inspectChanges(workspace);

    expect(first.files.map((file) => file.path)).toEqual([unsafeLookingPath]);
    expect(first.unifiedDiff).toContain("first");
    expect(second.unifiedDiff).toContain("second");
    expect(second.revision).not.toBe(first.revision);
  });

  it("does not execute configured textconv programs while inspecting changes", async () => {
    const { repositoryRoot, service, workspace } = await createWorkspace();
    const markerPath = join(repositoryRoot, "textconv-executed.txt");
    const scriptPath = join(repositoryRoot, "malicious-textconv.cjs");
    await writeFile(scriptPath, `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed");\n`);
    await realGit(["config", "--local", "diff.malicious.textconv", quotedCommand(scriptPath)], repositoryRoot);
    await writeFile(join(workspace.worktreePath, ".gitattributes"), "fixture.txt diff=malicious\n");
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "changed\n");

    const snapshot = await service.inspectChanges(workspace);

    expect(snapshot.files.map((file) => file.path)).toEqual([".gitattributes", "fixture.txt"]);
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("does not execute configured clean filters while inspecting or staging promotion", async () => {
    const { repositoryRoot, service, workspace } = await createWorkspace();
    const markerPath = join(repositoryRoot, "filter-executed.txt");
    const scriptsPath = await mkdtemp(join(tmpdir(), "orrery-malicious-filter-"));
    temporaryDirectories.push(scriptsPath);
    const scriptPath = join(scriptsPath, "malicious-filter.cjs");
    await writeFile(
      scriptPath,
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed");process.stdin.pipe(process.stdout);\n`,
    );
    await realGit(["config", "--local", "filter.malicious.clean", quotedCommand(scriptPath)], repositoryRoot);
    await writeFile(join(workspace.worktreePath, ".gitattributes"), "fixture.txt filter=malicious\n");
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");

    const reviewedSnapshot = await service.inspectChanges(workspace);
    await expect(access(markerPath)).rejects.toThrow();
    await expect(service.promote(workspace, "main", "reviewer@example.test", reviewedSnapshot, ACTIVE_APPROVAL_EXPIRY)).resolves.toMatchObject({
      status: "promoted",
    });
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("does not execute a clean filter declared by nested attributes", async () => {
    const { repositoryRoot, service, workspace } = await createWorkspace();
    const markerPath = join(repositoryRoot, "nested-filter-executed.txt");
    const scriptsPath = await mkdtemp(join(tmpdir(), "orrery-nested-filter-"));
    temporaryDirectories.push(scriptsPath);
    const scriptPath = join(scriptsPath, "malicious-filter.cjs");
    await writeFile(
      scriptPath,
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed");process.stdin.pipe(process.stdout);\n`,
    );
    await realGit(["config", "--local", "filter.nested.clean", quotedCommand(scriptPath)], repositoryRoot);
    await mkdir(join(workspace.worktreePath, "nested"));
    await writeFile(join(workspace.worktreePath, "nested", ".gitattributes"), "*.txt filter=nested\n");
    await writeFile(join(workspace.worktreePath, "nested", "reviewed.txt"), "reviewed\n");

    const reviewedSnapshot = await service.inspectChanges(workspace);
    await expect(service.promote(workspace, "main", "reviewer@example.test", reviewedSnapshot, ACTIVE_APPROVAL_EXPIRY)).resolves.toMatchObject({
      status: "promoted",
    });
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("does not execute a repository-configured fsmonitor command during the workspace lifecycle", async () => {
    const { repositoryRoot, service, workspace } = await createWorkspace();
    const markerPath = join(repositoryRoot, "fsmonitor-executed.txt");
    const scriptPath = await createMarkerScript(markerPath, "process.stdout.write('token\\n');");
    await realGit(["config", "--local", "core.fsmonitor", quotedCommand(scriptPath)], repositoryRoot);
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");

    const reviewedSnapshot = await service.inspectChanges(workspace);
    await expect(service.promote(workspace, "main", "reviewer@example.test", reviewedSnapshot, ACTIVE_APPROVAL_EXPIRY)).resolves.toMatchObject({
      status: "promoted",
    });
    await service.removeMissionWorkspace(workspace);

    await expect(access(markerPath)).rejects.toThrow();
  });

  it("does not execute filters selected by .git/info/attributes", async () => {
    const { repositoryRoot, service, workspace } = await createWorkspace();
    const markerPath = join(repositoryRoot, "info-attributes-filter-executed.txt");
    const scriptPath = await createPassthroughMarkerScript(markerPath);
    const commonGitDirectory = (await realGit(["rev-parse", "--git-common-dir"], repositoryRoot)).stdout.trim();
    await writeFile(join(resolve(repositoryRoot, commonGitDirectory), "info", "attributes"), "fixture.txt filter=infoattack\n");
    await realGit(["config", "--local", "filter.infoattack.clean", quotedCommand(scriptPath)], repositoryRoot);
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");

    const reviewedSnapshot = await service.inspectChanges(workspace);
    await expect(service.promote(workspace, "main", "reviewer@example.test", reviewedSnapshot, ACTIVE_APPROVAL_EXPIRY)).resolves.toMatchObject({
      status: "promoted",
    });

    await expect(access(markerPath)).rejects.toThrow();
  });

  it("does not execute filters selected by core.attributesFile", async () => {
    const { repositoryRoot, service, workspace } = await createWorkspace();
    const markerPath = join(repositoryRoot, "external-attributes-filter-executed.txt");
    const scriptPath = await createPassthroughMarkerScript(markerPath);
    const attributesDirectory = await mkdtemp(join(tmpdir(), "orrery-external-attributes-"));
    temporaryDirectories.push(attributesDirectory);
    const attributesPath = join(attributesDirectory, "external.attributes");
    await writeFile(attributesPath, "fixture.txt filter=externalattack\n");
    await realGit(["config", "--local", "core.attributesFile", attributesPath], repositoryRoot);
    await realGit(["config", "--local", "filter.externalattack.clean", quotedCommand(scriptPath)], repositoryRoot);
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");

    const reviewedSnapshot = await service.inspectChanges(workspace);
    await expect(service.promote(workspace, "main", "reviewer@example.test", reviewedSnapshot, ACTIVE_APPROVAL_EXPIRY)).resolves.toMatchObject({
      status: "promoted",
    });

    await expect(access(markerPath)).rejects.toThrow();
  });

  it("does not execute commands supplied by included or worktree configuration", async () => {
    const { repositoryRoot, service, workspace } = await createWorkspace();
    const includeMarkerPath = join(repositoryRoot, "included-filter-executed.txt");
    const worktreeMarkerPath = join(repositoryRoot, "worktree-filter-executed.txt");
    const includeScriptPath = await createPassthroughMarkerScript(includeMarkerPath);
    const worktreeScriptPath = await createPassthroughMarkerScript(worktreeMarkerPath);
    const includedConfigDirectory = await mkdtemp(join(tmpdir(), "orrery-included-config-"));
    temporaryDirectories.push(includedConfigDirectory);
    const includedConfigPath = join(includedConfigDirectory, "included.config");
    await writeFile(includedConfigPath, `[filter "includedattack"]\n\tclean = ${quotedCommand(includeScriptPath)}\n`);
    await realGit(["config", "--local", "include.path", includedConfigPath], repositoryRoot);
    await realGit(["config", "--local", "extensions.worktreeConfig", "true"], repositoryRoot);
    await realGit(["config", "--worktree", "filter.worktreeattack.clean", quotedCommand(worktreeScriptPath)], workspace.worktreePath);
    await writeFile(
      join(workspace.worktreePath, ".gitattributes"),
      "fixture.txt filter=includedattack\nworktree.txt filter=worktreeattack\n",
    );
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");
    await writeFile(join(workspace.worktreePath, "worktree.txt"), "reviewed\n");

    const reviewedSnapshot = await service.inspectChanges(workspace);
    await expect(service.promote(workspace, "main", "reviewer@example.test", reviewedSnapshot, ACTIVE_APPROVAL_EXPIRY)).resolves.toMatchObject({
      status: "promoted",
    });

    await expect(access(includeMarkerPath)).rejects.toThrow();
    await expect(access(worktreeMarkerPath)).rejects.toThrow();
  });

  it("promotes an explicit mission commit while preserving the mission worktree", async () => {
    const { repositoryRoot, service, workspace } = await createWorkspace();
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "promoted\n");
    const reviewedSnapshot = await service.inspectChanges(workspace);

    const result = await service.promote(workspace, "main", "reviewer@example.test", reviewedSnapshot, ACTIVE_APPROVAL_EXPIRY);

    expect(result.status).toBe("promoted");
    expect((await realGit(["log", "-1", "--format=%s"], repositoryRoot)).stdout.trim()).toContain(
      "reviewed by reviewer@example.test",
    );
    expect((await readFile(join(repositoryRoot, "fixture.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe("promoted\n");
    expect((await realGit(["status", "--porcelain=v1", "--", ".", ":!.orrery/"], repositoryRoot)).stdout).toBe("");
    expect((await realGit(["rev-parse", "--abbrev-ref", "HEAD"], workspace.worktreePath)).stdout.trim()).toBe(
      workspace.missionBranch,
    );
    expect((await service.inspectChanges(workspace)).files).toEqual([]);
  });

  it("does not execute repository-configured hooks while creating or applying the reviewed commit", async () => {
    const { repositoryRoot, service, workspace } = await createWorkspace();
    const hooksPath = await mkdtemp(join(tmpdir(), "orrery-malicious-hooks-"));
    temporaryDirectories.push(hooksPath);
    const markerPath = join(repositoryRoot, "hook-executed.txt");
    for (const hookName of ["pre-commit", "post-checkout"]) {
      const hook = join(hooksPath, hookName);
      await writeFile(hook, `#!/bin/sh\nprintf executed > "${markerPath.replaceAll("\\", "/")}"\n`);
      await chmod(hook, 0o755);
    }
    await realGit(["config", "--local", "core.hooksPath", hooksPath], repositoryRoot);
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");
    const reviewedSnapshot = await service.inspectChanges(workspace);

    await expect(service.promote(workspace, "main", "reviewer@example.test", reviewedSnapshot, ACTIVE_APPROVAL_EXPIRY)).resolves.toMatchObject({
      status: "promoted",
    });
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("prepares an immutable promotion capability without updating the target", async () => {
    const { repositoryRoot, service, workspace } = await createWorkspace();
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");
    const reviewedSnapshot = await service.inspectChanges(workspace);

    const preparation = await service.preparePromotion(workspace, "main", "reviewer@example.test", reviewedSnapshot);

    expect(preparation).toMatchObject({ status: "prepared", token: { expectedTargetRevision: workspace.initialRevision } });
    expect(await serviceRevision(repositoryRoot, "main")).toBe(workspace.initialRevision);
    if (preparation.status !== "prepared") throw new Error("Expected prepared promotion");
    await expect(service.promoteRetry(preparation.token, "reviewer@example.test", "2099-01-01T00:00:00.000Z")).resolves.toMatchObject({ status: "promoted" });
    expect((await realGit(["show", "main:fixture.txt"], repositoryRoot)).stdout.replaceAll("\r\n", "\n")).toBe("reviewed\n");
  });

  it("does not mutate the target when approval expires before the promotion CAS", async () => {
    const { repositoryRoot, service, workspace } = await createWorkspace();
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");
    const reviewedSnapshot = await service.inspectChanges(workspace);
    const preparation = await service.preparePromotion(workspace, "main", "reviewer@example.test", reviewedSnapshot);
    if (preparation.status !== "prepared") throw new Error("Expected prepared promotion");

    await expect(service.promoteRetry(preparation.token, "reviewer@example.test", "2000-01-01T00:00:00.000Z"))
      .rejects.toThrow(/approval expired/i);

    expect(await serviceRevision(repositoryRoot, "main")).toBe(workspace.initialRevision);
    expect((await realGit(["show", "main:fixture.txt"], repositoryRoot)).stdout.replaceAll("\r\n", "\n")).toBe("initial\n");
  });

  it("does not mutate the target when approval expires after the earlier check and before the CAS", async () => {
    let now = new Date("2099-01-01T00:00:00.000Z");
    const repositoryRoot = await createRepository();
    await mkdir(join(repositoryRoot, ".orrery"));
    const retryRepository = new FilePromotionRetryRepository(repositoryRoot);
    const baseService = new GitWorkspaceService({ git: realGit, retryRepository });
    const workspace = await baseService.createMissionWorkspace({ missionId: crypto.randomUUID(), repositoryRoot, targetBranch: "main" });
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");
    const reviewedSnapshot = await new GitWorkspaceService({ git: realGit }).inspectChanges(workspace);
    const preparation = await baseService.preparePromotion(workspace, "main", "reviewer@example.test", reviewedSnapshot);
    if (preparation.status !== "prepared") throw new Error("Expected prepared promotion");
    let promotedRevisionRead = false;
    const racingGit: GitCommand = async (args, cwd, options) => {
      const result = await realGit(args, cwd, options);
      if (args.at(-2) === "rev-parse" && args.at(-1) === "HEAD" && cwd.includes("promotion-")) {
        promotedRevisionRead = true;
        now = new Date("2100-01-01T00:00:00.000Z");
      }
      return result;
    };
    const service = new GitWorkspaceService({ git: racingGit, retryRepository, now: () => now });

    await expect(service.promoteRetry(preparation.token, "reviewer@example.test", "2099-01-01T00:01:00.000Z"))
      .rejects.toThrow(/approval expired/i);
    expect(promotedRevisionRead).toBe(true);
    expect(await serviceRevision(repositoryRoot, "main")).toBe(workspace.initialRevision);
  });

  it("does not let a direct kernel caller omit approval TTL before target mutation", async () => {
    const { repositoryRoot, service, workspace } = await createWorkspace();
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");
    const reviewedSnapshot = await service.inspectChanges(workspace);
    const preparation = await service.preparePromotion(workspace, "main", "reviewer@example.test", reviewedSnapshot);
    if (preparation.status !== "prepared") throw new Error("Expected prepared promotion");

    await expect((service.promoteRetry as unknown as (token: PromotionRetryToken, reviewerId: string) => Promise<unknown>)(preparation.token, "reviewer@example.test"))
      .rejects.toThrow(/approval expiry/i);

    expect(await serviceRevision(repositoryRoot, "main")).toBe(workspace.initialRevision);
  });

  it("rejects an expired direct reconciliation instead of accepting the target as promoted", async () => {
    const { service, workspace } = await createWorkspace();
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");
    const reviewedSnapshot = await service.inspectChanges(workspace);
    const preparation = await service.preparePromotion(workspace, "main", "reviewer@example.test", reviewedSnapshot);
    if (preparation.status !== "prepared") throw new Error("Expected prepared promotion");
    await service.promoteRetry(preparation.token, "reviewer@example.test", "2099-01-01T00:00:00.000Z");

    await expect(service.reconcilePromotion(preparation.token, "2000-01-01T00:00:00.000Z")).rejects.toThrow(/approval expired/i);
  });

  it("refuses worktree content changed between review and staging", async () => {
    const { repositoryRoot, workspace } = await createWorkspace();
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");
    const baseline = new GitWorkspaceService({ git: realGit });
    const reviewedSnapshot = await baseline.inspectChanges(workspace);
    const racingGit: GitCommand = async (args, cwd, options) => {
      if (cwd === workspace.worktreePath && args.includes("read-tree")) {
        await writeFile(join(workspace.worktreePath, "fixture.txt"), "unreviewed\n");
      }
      return realGit(args, cwd, options);
    };
    const service = new GitWorkspaceService({ git: racingGit });

    await expect(service.promote(workspace, "main", "reviewer@example.test", reviewedSnapshot, ACTIVE_APPROVAL_EXPIRY)).resolves.toEqual({
      status: "conflict",
      reason: "Mission worktree changed after review",
    });
    expect(await serviceRevision(repositoryRoot, "main")).toBe(workspace.initialRevision);
    expect((await realGit(["log", "-1", "--format=%s"], workspace.worktreePath)).stdout.trim()).toBe("fixture");
  });

  it("does not let shared-index tampering after comparison alter the reviewed commit", async () => {
    const { repositoryRoot, workspace } = await createWorkspace();
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");
    const baseline = new GitWorkspaceService({ git: realGit });
    const reviewedSnapshot = await baseline.inspectChanges(workspace);
    let tampered = false;
    const racingGit: GitCommand = async (args, cwd, options) => {
      const result = await realGit(args, cwd, options);
      if (
        !tampered &&
        cwd === workspace.worktreePath &&
        args[0] === "diff" &&
        args.includes("--cached")
      ) {
        tampered = true;
        await writeFile(join(workspace.worktreePath, "unreviewed.txt"), "injected\n");
        await realGit(["add", "unreviewed.txt"], workspace.worktreePath);
      }
      return result;
    };

    const result = await new GitWorkspaceService({ git: racingGit }).promote(
      workspace,
      "main",
      "reviewer@example.test",
      reviewedSnapshot,
      ACTIVE_APPROVAL_EXPIRY,
    );

    expect(result.status).toBe("promoted");
    expect((await realGit(["show", "--format=", "--name-only", "main"], repositoryRoot)).stdout.trim()).toBe(
      "fixture.txt",
    );
    await expect(realGit(["cat-file", "-e", "main:unreviewed.txt"], repositoryRoot)).rejects.toThrow();
  });

  it("does not promote onto a target that moves immediately before cherry-pick", async () => {
    const { repositoryRoot, workspace } = await createWorkspace();
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");
    const baseline = new GitWorkspaceService({ git: realGit });
    const reviewedSnapshot = await baseline.inspectChanges(workspace);
    let movedRevision = "";
    let moved = false;
    const racingGit: GitCommand = async (args, cwd, options) => {
      if (!moved && args.includes("cherry-pick") && !args.includes("--abort")) {
        moved = true;
        await writeFile(join(repositoryRoot, "target-only.txt"), "moved\n");
        await realGit(["add", "target-only.txt"], repositoryRoot);
        await realGit(["commit", "-m", "concurrent target movement"], repositoryRoot);
        movedRevision = await serviceRevision(repositoryRoot, "main");
      }
      return realGit(args, cwd, options);
    };
    const service = new GitWorkspaceService({ git: racingGit });

    await expect(service.promote(workspace, "main", "reviewer@example.test", reviewedSnapshot, ACTIVE_APPROVAL_EXPIRY)).resolves.toMatchObject({
      status: "conflict",
      reason: "Target branch changed during promotion",
    });
    expect(await serviceRevision(repositoryRoot, "main")).toBe(movedRevision);
    expect((await readFile(join(repositoryRoot, "fixture.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe("initial\n");
  });

  it("does not erase a concurrent user commit at the target application boundary", async () => {
    const { repositoryRoot, workspace } = await createWorkspace();
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");
    const baseline = new GitWorkspaceService({ git: realGit });
    const reviewedSnapshot = await baseline.inspectChanges(workspace);
    let concurrentRevision = "";
    let injected = false;
    const makeConcurrentCommit = async () => {
      await writeFile(join(repositoryRoot, "user-work.txt"), "must survive\n");
      await realGit(["add", "user-work.txt"], repositoryRoot);
      await realGit(["commit", "-m", "concurrent user work"], repositoryRoot);
      concurrentRevision = await serviceRevision(repositoryRoot, "main");
    };
    const racingGit: GitCommand = async (args, cwd, options) => {
      const operationIndex = args.findIndex((arg) => arg === "merge");
      if (!injected && cwd === repositoryRoot && operationIndex >= 0) {
        injected = true;
        await makeConcurrentCommit();
      }
      if (
        !injected &&
        cwd === repositoryRoot &&
        args[args.indexOf("update-ref") + 1] === "refs/heads/main"
      ) {
        injected = true;
        await makeConcurrentCommit();
      }
      return realGit(args, cwd, options);
    };

    await expect(
      new GitWorkspaceService({ git: racingGit }).promote(
        workspace,
        "main",
        "reviewer@example.test",
        reviewedSnapshot,
        ACTIVE_APPROVAL_EXPIRY,
      ),
    ).resolves.toMatchObject({ status: "conflict", reason: "Target branch changed during promotion" });
    expect(await serviceRevision(repositoryRoot, "main")).toBe(concurrentRevision);
    expect(await readFile(join(repositoryRoot, "user-work.txt"), "utf8")).toBe("must survive\n");
  });

  it.each(["backward", "sideways"] as const)(
    "rejects a target moving %s after the initial promotion check with expected-old CAS",
    async (movement) => {
      const { repositoryRoot, workspace } = await createWorkspaceWithHistory();
      await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");
      const baseline = new GitWorkspaceService({ git: realGit });
      const reviewedSnapshot = await baseline.inspectChanges(workspace);
      const movedRevision = await createMovedRevision(repositoryRoot, workspace.initialRevision, movement);
      let injected = false;
      const racingGit: GitCommand = async (args, cwd, options) => {
        const updateRefIndex = args.indexOf("update-ref");
        if (
          !injected &&
          cwd === repositoryRoot &&
          updateRefIndex >= 0 &&
          args[updateRefIndex + 1] === "refs/heads/main"
        ) {
          injected = true;
          await realGit(["update-ref", "refs/heads/main", movedRevision, workspace.initialRevision], repositoryRoot);
        }
        return realGit(args, cwd, options);
      };

      await expect(
        new GitWorkspaceService({ git: racingGit }).promote(
          workspace,
          "main",
          "reviewer@example.test",
          reviewedSnapshot,
          ACTIVE_APPROVAL_EXPIRY,
        ),
      ).resolves.toMatchObject({ status: "conflict", reason: "Target branch changed during promotion" });
      expect(injected).toBe(true);
      expect(await serviceRevision(repositoryRoot, "main")).toBe(movedRevision);
      expect((await readFile(join(repositoryRoot, "fixture.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe("initial\n");
    },
  );

  it("returns the immutable mission commit when cherry-pick fails so it remains retryable", async () => {
    const { repositoryRoot, workspace } = await createWorkspace();
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed\n");
    const baseline = new GitWorkspaceService({ git: realGit });
    const reviewedSnapshot = await baseline.inspectChanges(workspace);
    const failingGit: GitCommand = async (args, cwd, options) => {
      const cherryPickIndex = args.indexOf("cherry-pick");
      if (cherryPickIndex >= 0 && args[cherryPickIndex + 1] !== "--abort") {
        throw new Error("injected cherry-pick failure");
      }
      return realGit(args, cwd, options);
    };
    const service = new GitWorkspaceService({ git: failingGit });

    const result = await service.promote(workspace, "main", "reviewer@example.test", reviewedSnapshot, ACTIVE_APPROVAL_EXPIRY);

    expect(result).toMatchObject({
      status: "conflict",
      reason: "injected cherry-pick failure",
      retry: {
        missionRevision: expect.stringMatching(/^[0-9a-f]{40}$/),
        expectedTargetRevision: workspace.initialRevision,
        targetBranch: "main",
      },
    });
    if (result.status !== "conflict" || !result.retry) throw new Error("Expected retry token");
    const immutableContents = (await realGit(["show", `${result.retry.missionRevision}:fixture.txt`], repositoryRoot)).stdout;
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "later mutation\n");
    expect(immutableContents.replaceAll("\r\n", "\n")).toBe("reviewed\n");
    expect((await realGit(["show", `${result.retry.missionRevision}:fixture.txt`], repositoryRoot)).stdout).toBe(immutableContents);
  });

  it("promotes a previously conflicted immutable mission commit on retry", async () => {
    const { repositoryRoot, workspace } = await createWorkspace();
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "promoted on retry\n");
    const reviewedSnapshot = await new GitWorkspaceService({ git: realGit }).inspectChanges(workspace);
    let failCherryPick = true;
    const service = new GitWorkspaceService({
      git: async (args, cwd, options) => {
        if (failCherryPick && args.includes("cherry-pick") && !args.includes("--abort")) {
          failCherryPick = false;
          throw new Error("synthetic cherry-pick conflict");
        }
        return realGit(args, cwd, options);
      },
    });

    const first = await service.promote(workspace, "main", "reviewer@example.test", reviewedSnapshot, ACTIVE_APPROVAL_EXPIRY);
    expect(first.status).toBe("conflict");
    if (first.status !== "conflict" || !first.retry) throw new Error("Expected retry token");
    await expect(service.promoteRetry(first.retry, "reviewer@example.test", ACTIVE_APPROVAL_EXPIRY)).resolves.toMatchObject({ status: "promoted" });
    expect((await realGit(["show", "main:fixture.txt"], repositoryRoot)).stdout.replaceAll("\r\n", "\n")).toBe("promoted on retry\n");
  });

  it.each(["backward", "sideways"] as const)(
    "rejects a target moving %s at the retry application boundary with expected-old CAS",
    async (movement) => {
      const { repositoryRoot, workspace } = await createWorkspaceWithHistory();
      await writeFile(join(workspace.worktreePath, "fixture.txt"), "reviewed on retry\n");
      const reviewedSnapshot = await new GitWorkspaceService({ git: realGit }).inspectChanges(workspace);
      let failCherryPick = true;
      const records = new Map<string, PromotionRetryToken>();
      const claimed = new Set<string>();
      const retryRepository: PromotionRetryRepository = {
        save: async (token) => { records.set(token.missionRevision, token); },
        claim: async (token) => {
          const stored = records.get(token.missionRevision);
          if (!stored || claimed.has(token.missionRevision)) return null;
          claimed.add(token.missionRevision);
          return stored;
        },
        release: async (token) => { claimed.delete(token.missionRevision); },
        consume: async (token) => claimed.delete(token.missionRevision) && records.delete(token.missionRevision),
      };
      const service = new GitWorkspaceService({
        git: async (args, cwd, options) => {
          if (failCherryPick && args.includes("cherry-pick") && !args.includes("--abort")) {
            failCherryPick = false;
            throw new Error("synthetic cherry-pick conflict");
          }
          return realGit(args, cwd, options);
        },
        retryRepository,
      });
      const first = await service.promote(workspace, "main", "reviewer@example.test", reviewedSnapshot, ACTIVE_APPROVAL_EXPIRY);
      if (first.status !== "conflict" || !first.retry) throw new Error("Expected retry token");
      const movedRevision = await createMovedRevision(repositoryRoot, workspace.initialRevision, movement);
      let injected = false;
      const racingService = new GitWorkspaceService({
        git: async (args, cwd, options) => {
          const updateRefIndex = args.indexOf("update-ref");
          if (
            !injected &&
            cwd === repositoryRoot &&
            updateRefIndex >= 0 &&
            args[updateRefIndex + 1] === "refs/heads/main"
          ) {
            injected = true;
            await realGit(["update-ref", "refs/heads/main", movedRevision, workspace.initialRevision], repositoryRoot);
          }
          return realGit(args, cwd, options);
        },
        retryRepository,
      });

      await expect(racingService.promoteRetry(first.retry, "reviewer@example.test", ACTIVE_APPROVAL_EXPIRY)).resolves.toMatchObject({
        status: "conflict",
        reason: "Target branch changed during promotion",
      });
      expect(injected).toBe(true);
      expect(await serviceRevision(repositoryRoot, "main")).toBe(movedRevision);
      expect((await readFile(join(repositoryRoot, "fixture.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe("initial\n");
    },
  );

  it("loads a retry token in a fresh service and consumes it only after promotion succeeds", async () => {
    const { repositoryRoot, workspace } = await createWorkspace();
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "fresh service retry\n");
    const reviewedSnapshot = await new GitWorkspaceService({ git: realGit }).inspectChanges(workspace);
    let failCherryPick = true;
    const records = new Map<string, PromotionRetryToken>();
    const retryRepository: PromotionRetryRepository = {
      save: async (token) => { records.set(token.missionRevision, token); },
      claim: async (token) => records.get(token.missionRevision) ?? null,
      release: async () => undefined,
      consume: async (token) => records.delete(token.missionRevision),
    };
    const firstService = new GitWorkspaceService({
      git: async (args, cwd, options) => {
        if (failCherryPick && args.includes("cherry-pick") && !args.includes("--abort")) {
          failCherryPick = false;
          throw new Error("synthetic cherry-pick conflict");
        }
        return realGit(args, cwd, options);
      },
      retryRepository,
    });

    const first = await firstService.promote(workspace, "main", "reviewer@example.test", reviewedSnapshot, ACTIVE_APPROVAL_EXPIRY);
    expect(first.status).toBe("conflict");
    if (first.status !== "conflict" || !first.retry) throw new Error("Expected retry token");

    const freshService = new GitWorkspaceService({ git: realGit, retryRepository });
    await expect(freshService.promoteRetry(first.retry, "reviewer@example.test", ACTIVE_APPROVAL_EXPIRY)).resolves.toMatchObject({ status: "promoted" });
    expect(records.size).toBe(0);
    await expect(freshService.promoteRetry(first.retry, "reviewer@example.test", ACTIVE_APPROVAL_EXPIRY)).rejects.toThrow("unknown or expired");
  });

  it("rejects an oversized promotion retry registry before parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "orrery-retry-bound-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".orrery"));
    await writeFile(join(root, ".orrery", "promotion-retries.json"), " ".repeat(4 * 1024 * 1024 + 1));
    const repository = new FilePromotionRetryRepository(root);
    const token = { missionRevision: "a".repeat(40), expectedTargetRevision: "b".repeat(40), targetBranch: "main", workspace: { id: "workspace", missionId: crypto.randomUUID(), repositoryRoot: root, worktreePath: root, targetBranch: "main", missionBranch: "orrery/mission", initialRevision: "b".repeat(40) }, missionParent: "b".repeat(40), missionTree: "c".repeat(40) };

    await expect(repository.claim(token)).rejects.toThrow(/too large/i);
  });

  it("returns a conflict without committing when the target is dirty or moved", async () => {
    const first = await createWorkspace();
    await writeFile(join(first.workspace.worktreePath, "fixture.txt"), "change\n");
    await writeFile(join(first.repositoryRoot, "uncommitted.txt"), "dirty\n");
    const firstSnapshot = await first.service.inspectChanges(first.workspace);
    await expect(first.service.promote(first.workspace, "main", "reviewer@example.test", firstSnapshot, ACTIVE_APPROVAL_EXPIRY)).resolves.toEqual({
      status: "conflict",
      reason: "Target branch has uncommitted changes",
    });

    const second = await createWorkspace();
    await writeFile(join(second.workspace.worktreePath, "fixture.txt"), "change\n");
    await writeFile(join(second.repositoryRoot, "other.txt"), "other\n");
    await realGit(["add", "other.txt"], second.repositoryRoot);
    await realGit(["commit", "-m", "move target"], second.repositoryRoot);
    const secondSnapshot = await second.service.inspectChanges(second.workspace);
    await expect(second.service.promote(second.workspace, "main", "reviewer@example.test", secondSnapshot, ACTIVE_APPROVAL_EXPIRY)).resolves.toEqual({
      status: "conflict",
      reason: "Target branch changed since workspace creation",
    });
    expect((await serviceRevision(second.repositoryRoot, "main"))).not.toBe(second.workspace.initialRevision);
  });

  it("validates the promotion branch and reviewer arguments", async () => {
    const { service, workspace } = await createWorkspace();

    const snapshot = await service.inspectChanges(workspace);
    await expect(service.promote(workspace, "../main", "reviewer@example.test", snapshot, ACTIVE_APPROVAL_EXPIRY)).rejects.toThrow(
      "targetBranch must be a valid Git branch name",
    );
    await expect(service.promote(workspace, "main", " ", snapshot, ACTIVE_APPROVAL_EXPIRY)).rejects.toThrow("reviewerId must be a nonempty ID");
  });

  it("does not cherry-pick onto a different checked-out branch", async () => {
    const { repositoryRoot, service, workspace } = await createWorkspace();
    await writeFile(join(workspace.worktreePath, "fixture.txt"), "change\n");
    await realGit(["switch", "-c", "other"], repositoryRoot);

    const snapshot = await service.inspectChanges(workspace);
    await expect(service.promote(workspace, "main", "reviewer@example.test", snapshot, ACTIVE_APPROVAL_EXPIRY)).resolves.toEqual({
      status: "conflict",
      reason: "Target branch is not checked out at the repository root",
    });
    expect(await serviceRevision(repositoryRoot, "main")).toBe(workspace.initialRevision);
  });
});

async function serviceRevision(repositoryRoot: string, ref: string): Promise<string> {
  return (await realGit(["rev-parse", ref], repositoryRoot)).stdout.trim();
}

async function createWorkspaceWithHistory() {
  const repositoryRoot = await createRepository();
  await writeFile(join(repositoryRoot, "history.txt"), "second\n");
  await realGit(["add", "history.txt"], repositoryRoot);
  await realGit(["commit", "-m", "second fixture"], repositoryRoot);
  const service = new GitWorkspaceService({ git: realGit });
  const workspace = await service.createMissionWorkspace({
    missionId: crypto.randomUUID(),
    repositoryRoot,
    targetBranch: "main",
  });
  return { repositoryRoot, service, workspace };
}

async function createMovedRevision(
  repositoryRoot: string,
  initialRevision: string,
  movement: "backward" | "sideways",
): Promise<string> {
  const parent = (await realGit(["rev-parse", `${initialRevision}^`], repositoryRoot)).stdout.trim();
  if (movement === "backward") return parent;
  const tree = (await realGit(["rev-parse", `${initialRevision}^{tree}`], repositoryRoot)).stdout.trim();
  return (
    await realGit(
      ["commit-tree", tree, "-p", parent, "-m", "sideways target movement"],
      repositoryRoot,
    )
  ).stdout.trim();
}

function quotedCommand(scriptPath: string): string {
  return `"${process.execPath.replaceAll("\\", "/")}" "${scriptPath.replaceAll("\\", "/")}"`;
}

async function createMarkerScript(markerPath: string, suffix = ""): Promise<string> {
  const scriptsPath = await mkdtemp(join(tmpdir(), "orrery-malicious-git-command-"));
  temporaryDirectories.push(scriptsPath);
  const scriptPath = join(scriptsPath, "command.cjs");
  await writeFile(
    scriptPath,
    `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed");${suffix}\n`,
  );
  return scriptPath;
}

async function createPassthroughMarkerScript(markerPath: string): Promise<string> {
  return createMarkerScript(markerPath, "process.stdin.pipe(process.stdout);");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
