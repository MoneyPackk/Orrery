import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname as getHostname, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { PromotionRetryRepository, WorkspaceService } from "./ports";
import { assertNonEmptyId } from "./ports";
import type {
  ChangeSnapshot,
  CreateWorkspaceInput,
  MissionWorkspace,
  PromotionPreparation,
  PromotionResult,
  PromotionRetryToken,
} from "./types";

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitCommandOptions {
  env?: NodeJS.ProcessEnv;
}

export type GitCommand = (args: string[], cwd: string, options?: GitCommandOptions) => Promise<GitCommandResult>;

export interface GitWorkspaceServiceOptions {
  git?: GitCommand;
  retryRepository?: PromotionRetryRepository;
  workspaceRoot?: string;
}

interface PromotionRetryLockMetadata {
  ownerId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export interface FilePromotionRetryRepositoryOptions {
  acquisitionTimeoutMs?: number;
  staleAfterMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
  hostname?: string;
  isProcessAlive?: (pid: number) => boolean | undefined;
}

const DEFAULT_LOCK_ACQUISITION_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_AFTER_MS = 30_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const MAX_RETRY_REGISTRY_BYTES = 4 * 1024 * 1024;

const execFileAsync = promisify(execFile);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BRANCH_PATTERN = /^(?!\.)(?!.*\.\.)(?!.*(?:^|\/)\.($|\/))(?!.*[~^:?*\\\[\s])[^/]+(?:\/[^/]+)*$/;

const defaultGit: GitCommand = async (args, cwd, options) => {
  const result = await execFileAsync("git", args, { cwd, env: options?.env });
  return { stdout: result.stdout, stderr: result.stderr };
};

function parseStatus(stdout: string): string[] {
  return stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3));
}

function lineCounts(diff: string): { additions: number; deletions: number; binary: boolean } {
  if (diff.includes("Binary files ") || diff.includes("GIT binary patch")) {
    return { additions: 0, deletions: 0, binary: true };
  }
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions, binary: false };
}

function validateBranch(branch: string): void {
  assertNonEmptyId(branch, "targetBranch");
  if (!BRANCH_PATTERN.test(branch) || branch.endsWith(".") || branch.endsWith("/")) {
    throw new Error("targetBranch must be a valid Git branch name");
  }
}

function validateMissionId(missionId: string): void {
  assertNonEmptyId(missionId, "missionId");
  if (!UUID_PATTERN.test(missionId)) throw new Error("missionId must be a UUID");
}

function commandError(error: unknown, fallback: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message || fallback, { cause: error });
}

function snapshotsMatch(reviewed: ChangeSnapshot, current: ChangeSnapshot): boolean {
  return JSON.stringify(reviewed) === JSON.stringify(current);
}

async function validateDirectory(path: string, expectedCanonicalPath: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(path)) !== expectedCanonicalPath) {
    throw new Error("workspace path must be a real directory beneath the private runtime root");
  }
}

export function defaultWorkspaceRoot(): string {
  return join(tmpdir(), "orrery-runtime");
}

async function preparePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await validateDirectory(path, resolve(path));
  await chmodPrivate(path);
}

async function chmodPrivate(path: string): Promise<void> {
  await chmod(path, 0o700);
}

function repositoryRuntimeKey(repositoryRoot: string): string {
  const identity = process.platform === "win32" ? repositoryRoot.toLowerCase() : repositoryRoot;
  return createHash("sha256").update(identity).digest("hex");
}

async function prepareWorktreesRoot(workspaceRoot: string, repositoryRoot: string): Promise<string> {
  await preparePrivateDirectory(workspaceRoot);
  const worktreesRoot = join(workspaceRoot, "worktrees", repositoryRuntimeKey(repositoryRoot));
  await preparePrivateDirectory(join(workspaceRoot, "worktrees"));
  await preparePrivateDirectory(worktreesRoot);
  return worktreesRoot;
}

function isContainedPath(path: string, root: string): boolean {
  const child = relative(root, path);
  return child !== "" && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

interface SafeGitContext {
  directory: string;
  env: NodeJS.ProcessEnv;
  hooksPath: string;
  attributesPath: string;
}

async function createIsolatedGitEnvironment(): Promise<SafeGitContext> {
  const directory = await mkdtemp(join(tmpdir(), "orrery-git-config-"));
  const globalConfig = join(directory, "config");
  const attributesPath = join(directory, "attributes");
  const hooksPath = join(directory, "hooks");
  await writeFile(globalConfig, "");
  await writeFile(attributesPath, "");
  await mkdir(hooksPath);
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name === "GIT_CONFIG_PARAMETERS" || /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name)) delete env[name];
  }
  return {
    directory,
    hooksPath,
    attributesPath,
    env: {
      ...env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_EXTERNAL_DIFF: "",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      HOME: directory,
      XDG_CONFIG_HOME: directory,
    },
  };
}

function baseSafeGitArguments(context: SafeGitContext): string[] {
  return [
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${context.hooksPath}`,
    "-c", `core.attributesFile=${context.attributesPath}`,
    "-c", "core.autocrlf=true",
    "-c", "diff.external=",
    "-c", "core.pager=cat",
  ];
}

function executableConfigOverrides(stdout: string): string[] {
  const overrides: string[] = [];
  for (const entry of stdout.split("\0")) {
    const separator = entry.indexOf("\n");
    const key = (separator < 0 ? entry : entry.slice(0, separator)).toLowerCase();
    if (/^filter\..+\.(?:clean|smudge|process)$/.test(key)) {
      overrides.push("-c", `${key}=`);
    } else if (/^diff\..+\.(?:command|external|textconv)$/.test(key) || /^merge\..+\.driver$/.test(key)) {
      overrides.push("-c", `${key}=`);
    }
  }
  return overrides;
}

function createSafeGit(git: GitCommand, context: SafeGitContext): GitCommand {
  const baseArgs = baseSafeGitArguments(context);
  return async (args, cwd, options) => {
    const env = { ...context.env, ...options?.env };
    const config = await git([...baseArgs, "config", "--includes", "--null", "--list"], cwd, { env });
    return git([...baseArgs, ...executableConfigOverrides(config.stdout), ...args], cwd, { env });
  };
}

async function applyTargetRevision(
  safeGit: GitCommand,
  repositoryRoot: string,
  targetBranch: string,
  expectedRevision: string,
  promotedRevision: string,
  options: GitCommandOptions,
): Promise<boolean> {
  const targetRef = `refs/heads/${targetBranch}`;
  try {
    await safeGit(["update-ref", targetRef, promotedRevision, expectedRevision], repositoryRoot, options);
  } catch {
    return false;
  }

  try {
    await safeGit(["read-tree", "-u", "-m", expectedRevision, promotedRevision], repositoryRoot, options);
    return true;
  } catch (error) {
    await safeGit(["update-ref", targetRef, expectedRevision, promotedRevision], repositoryRoot, options).catch(() => undefined);
    throw error;
  }
}

export class GitWorkspaceService implements WorkspaceService {
  private readonly git: GitCommand;
  private readonly retryRepository: PromotionRetryRepository;
  private readonly workspaceRoot: string;

  constructor(options: GitWorkspaceServiceOptions = {}) {
    this.git = options.git ?? defaultGit;
    this.retryRepository = options.retryRepository ?? new InMemoryPromotionRetryRepository();
    this.workspaceRoot = resolve(options.workspaceRoot ?? defaultWorkspaceRoot());
  }

  async createMissionWorkspace(input: CreateWorkspaceInput): Promise<MissionWorkspace> {
    validateMissionId(input.missionId);
    validateBranch(input.targetBranch);
    const isolatedConfig = await createIsolatedGitEnvironment();
    const safeGit = createSafeGit(this.git, isolatedConfig);

    let repositoryRoot: string;
    try {
      repositoryRoot = await realpath(input.repositoryRoot);
      if (isContainedPath(this.workspaceRoot, repositoryRoot) || this.workspaceRoot === repositoryRoot) {
        throw new Error("workspaceRoot must be outside the repository");
      }
      const topLevel = (await safeGit(["rev-parse", "--show-toplevel"], repositoryRoot)).stdout.trim();
      if (!topLevel || (await realpath(topLevel)) !== repositoryRoot) throw new Error("not the repository root");
    } catch (error) {
      await rm(isolatedConfig.directory, { recursive: true, force: true }).catch(() => undefined);
      throw new Error("repositoryRoot must be a Git repository", { cause: error });
    }

    try {
      await safeGit(["rev-parse", "--verify", `refs/heads/${input.targetBranch}`], repositoryRoot);
    } catch (error) {
      await rm(isolatedConfig.directory, { recursive: true, force: true }).catch(() => undefined);
      throw commandError(error, `Target branch does not exist: ${input.targetBranch}`);
    }

    const missionBranch = `orrery/mission-${input.missionId}`;
    const id = `mission-${input.missionId}`;
    const worktreesRoot = await prepareWorktreesRoot(this.workspaceRoot, repositoryRoot);
    const worktreePath = join(worktreesRoot, id);
    try {
      await safeGit(["show-ref", "--verify", "--quiet", `refs/heads/${missionBranch}`], repositoryRoot);
      throw new Error(`Mission branch already exists: ${missionBranch}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Mission branch already exists")) {
        await rm(isolatedConfig.directory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }

    const initialRevision = (await safeGit(["rev-parse", input.targetBranch], repositoryRoot)).stdout.trim();
    try {
      await safeGit(["worktree", "add", "-b", missionBranch, worktreePath, input.targetBranch], repositoryRoot);
    } catch (error) {
      await safeGit(["worktree", "remove", "--force", worktreePath], repositoryRoot).catch(() => undefined);
      await safeGit(["branch", "-D", missionBranch], repositoryRoot).catch(() => undefined);
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
      throw commandError(error, "Unable to create mission worktree");
    } finally {
      await rm(isolatedConfig.directory, { recursive: true, force: true }).catch(() => undefined);
    }

    return {
      id,
      missionId: input.missionId,
      repositoryRoot,
      worktreePath,
      targetBranch: input.targetBranch,
      missionBranch,
      initialRevision,
    };
  }

  async removeMissionWorkspace(workspace: MissionWorkspace): Promise<void> {
    validateMissionId(workspace.missionId);
    validateBranch(workspace.targetBranch);
    const repositoryRoot = await realpath(workspace.repositoryRoot).catch(() => {
      throw new Error("Invalid workspace identity");
    });
    const expectedId = `mission-${workspace.missionId}`;
    const expectedBranch = `orrery/mission-${workspace.missionId}`;
    const expectedWorktreesRoot = join(this.workspaceRoot, "worktrees", repositoryRuntimeKey(repositoryRoot));
    const expectedWorktreePath = join(expectedWorktreesRoot, expectedId);
    if (
      repositoryRoot !== workspace.repositoryRoot ||
      workspace.id !== expectedId ||
      workspace.missionBranch !== expectedBranch ||
      workspace.repositoryRoot !== repositoryRoot
    ) {
      throw new Error("Invalid workspace identity");
    }
    await validateDirectory(this.workspaceRoot, this.workspaceRoot).catch(() => {
      throw new Error("Invalid workspace identity");
    });
    await validateDirectory(expectedWorktreesRoot, expectedWorktreesRoot).catch(() => {
      throw new Error("Invalid workspace identity");
    });
    await validateDirectory(expectedWorktreePath, expectedWorktreePath).catch(() => {
      throw new Error("Invalid workspace identity");
    });

    const isolatedConfig = await createIsolatedGitEnvironment();
    const safeGit = createSafeGit(this.git, isolatedConfig);
    try {
      const repositoryTopLevel = (await safeGit(["rev-parse", "--show-toplevel"], repositoryRoot)).stdout.trim();
      const worktreeTopLevel = (await safeGit(["rev-parse", "--show-toplevel"], expectedWorktreePath)).stdout.trim();
      const worktreeBranch = (await safeGit(["branch", "--show-current"], expectedWorktreePath)).stdout.trim();
      const repositoryGitDirectoryValue = (await safeGit(["rev-parse", "--git-common-dir"], repositoryRoot)).stdout.trim();
      const worktreeGitDirectoryValue = (await safeGit(["rev-parse", "--git-common-dir"], expectedWorktreePath)).stdout.trim();
      const repositoryGitDirectory = await realpath(resolve(repositoryRoot, repositoryGitDirectoryValue));
      const worktreeGitDirectory = await realpath(resolve(expectedWorktreePath, worktreeGitDirectoryValue));
      if (
        (await realpath(repositoryTopLevel)) !== repositoryRoot ||
        (await realpath(worktreeTopLevel)) !== expectedWorktreePath ||
        worktreeBranch !== expectedBranch ||
        repositoryGitDirectory !== worktreeGitDirectory
      ) {
        throw new Error("Invalid workspace identity");
      }

      await safeGit(["worktree", "remove", "--force", expectedWorktreePath], repositoryRoot).catch(() => undefined);
      await safeGit(["branch", "-D", expectedBranch], repositoryRoot).catch(() => undefined);
      await rm(expectedWorktreePath, { recursive: true, force: true });
    } finally {
      await rm(isolatedConfig.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async inspectChanges(workspace: MissionWorkspace): Promise<ChangeSnapshot> {
    const isolatedConfig = await createIsolatedGitEnvironment();
    const safeGit = createSafeGit(this.git, isolatedConfig);
    try {
      const status = await safeGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"], workspace.worktreePath);
      const paths = [...new Set(parseStatus(status.stdout))].sort();
      const files = [];
      const diffs: string[] = [];

      for (const path of paths) {
        const trackedDiff = await safeGit(["diff", "--no-ext-diff", "--no-textconv", "--binary", "--no-color", "HEAD", "--", path], workspace.worktreePath);
        let diff = trackedDiff.stdout;
        if (!diff) {
          try {
            const untrackedDiff = await safeGit(["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--binary", "--no-color", "--", "/dev/null", path], workspace.worktreePath);
            diff = untrackedDiff.stdout;
          } catch (error) {
            const result = error as { stdout?: string };
            diff = result.stdout ?? "";
          }
        }
        const counts = lineCounts(diff);
        files.push({ path, ...counts, diff });
        if (diff) diffs.push(diff);
      }

      const unifiedDiff = diffs.join("");
      const revision = createHash("sha256").update(JSON.stringify({ files, unifiedDiff })).digest("hex");
      return { revision, files, unifiedDiff };
    } finally {
      await rm(isolatedConfig.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async promote(
    workspace: MissionWorkspace,
    targetBranch: string,
    reviewerId: string,
    reviewedSnapshot: ChangeSnapshot,
  ): Promise<PromotionResult> {
    const preparation = await this.preparePromotion(workspace, targetBranch, reviewerId, reviewedSnapshot);
    if (preparation.status !== "prepared") return preparation;
    return this.promoteRetry(preparation.token, reviewerId);
  }

  async preparePromotion(
    workspace: MissionWorkspace,
    targetBranch: string,
    reviewerId: string,
    reviewedSnapshot: ChangeSnapshot,
  ): Promise<PromotionPreparation> {
    validateBranch(targetBranch);
    assertNonEmptyId(reviewerId, "reviewerId");
    if (targetBranch !== workspace.targetBranch) throw new Error("targetBranch does not match workspace");

    const temporaryIndexDirectory = await mkdtemp(join(tmpdir(), "orrery-index-"));
    const temporaryIndexPath = join(temporaryIndexDirectory, "index");
    const isolatedConfig = await createIsolatedGitEnvironment();
    const safeGit = createSafeGit(this.git, isolatedConfig);
    const isolatedIndex = { env: { ...isolatedConfig.env, GIT_INDEX_FILE: temporaryIndexPath } };
    try {
      await safeGit(["rev-parse", "--verify", `refs/heads/${targetBranch}`], workspace.repositoryRoot);
      const checkedOutBranch = (await safeGit(["branch", "--show-current"], workspace.repositoryRoot)).stdout.trim();
      if (checkedOutBranch !== targetBranch) {
        return { status: "conflict", reason: "Target branch is not checked out at the repository root" };
      }
      const status = await safeGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ":!.orrery/"], workspace.repositoryRoot);
      if (status.stdout) return { status: "conflict", reason: "Target branch has uncommitted changes" };
      const targetRevision = (await safeGit(["rev-parse", targetBranch], workspace.repositoryRoot)).stdout.trim();
      if (targetRevision !== workspace.initialRevision) return { status: "conflict", reason: "Target branch changed since workspace creation" };

      const missionStatus = await safeGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"], workspace.worktreePath);
      if (!missionStatus.stdout) return { status: "conflict", reason: "Mission worktree has no changes" };
      const preStageSnapshot = await this.inspectChanges(workspace);
      if (!snapshotsMatch(reviewedSnapshot, preStageSnapshot)) {
        return { status: "conflict", reason: "Mission worktree changed after review" };
      }
      await safeGit(["read-tree", "HEAD"], workspace.worktreePath, isolatedIndex);
      const preApplySnapshot = await this.inspectChanges(workspace);
      if (!snapshotsMatch(reviewedSnapshot, preApplySnapshot)) {
        return { status: "conflict", reason: "Mission worktree changed after review" };
      }
      const reviewedPatchPath = join(temporaryIndexDirectory, "reviewed.patch");
      await writeFile(reviewedPatchPath, reviewedSnapshot.unifiedDiff);
      await safeGit(["apply", "--cached", "--binary", "--whitespace=nowarn", "--", reviewedPatchPath], workspace.worktreePath, isolatedIndex);
      const stagedDiff = await safeGit(
        ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "--no-color", "HEAD", "--"],
        workspace.worktreePath,
        isolatedIndex,
      );
      if (stagedDiff.stdout !== reviewedSnapshot.unifiedDiff) {
        return { status: "conflict", reason: "Mission worktree changed after review" };
      }
      const reviewedTree = (await safeGit(["write-tree"], workspace.worktreePath, isolatedIndex)).stdout.trim();
      const missionRevision = (
        await safeGit(
          [
            "commit-tree",
            reviewedTree,
            "-p",
            workspace.initialRevision,
            "-m",
            `Promote mission ${workspace.missionId} (reviewed by ${reviewerId})`,
          ],
          workspace.repositoryRoot,
          isolatedConfig.env,
        )
      ).stdout.trim();
       const missionTree = reviewedTree;
       const retry = { missionRevision, expectedTargetRevision: targetRevision, targetBranch, workspace, missionParent: workspace.initialRevision, missionTree };
       await this.retryRepository.save(retry);
      try {
        await safeGit(
          ["update-ref", `refs/heads/${workspace.missionBranch}`, missionRevision, workspace.initialRevision],
          workspace.repositoryRoot,
          isolatedConfig.env,
        );
      } catch {
        return { status: "conflict", reason: "Mission branch changed during promotion", retry };
      }
      await safeGit(["reset", "--mixed", missionRevision, "--"], workspace.worktreePath);

      return { status: "prepared", token: retry };
    } catch (error) {
      throw commandError(error, "Unable to promote mission changes");
    } finally {
      await rm(temporaryIndexDirectory, { recursive: true, force: true }).catch(() => undefined);
      await rm(isolatedConfig.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async promoteRetry(token: PromotionRetryToken, reviewerId: string): Promise<PromotionResult> {
    validateBranch(token.targetBranch);
    assertNonEmptyId(reviewerId, "reviewerId");
    if (!/^[0-9a-f]{40,64}$/i.test(token.missionRevision) || !/^[0-9a-f]{40,64}$/i.test(token.expectedTargetRevision)) {
      throw new Error("Invalid promotion retry revisions");
    }
    const stored = await this.retryRepository.claim(token);
    const workspace = stored?.workspace;
    if (!workspace || workspace.targetBranch !== token.targetBranch) throw new Error("Promotion retry token is unknown or expired");
    const repositoryRoot = await realpath(workspace.repositoryRoot).catch(() => { throw new Error("Invalid promotion retry repository"); });
    const isolatedConfig = await createIsolatedGitEnvironment();
    const safeGit = createSafeGit(this.git, isolatedConfig);
    let promotionWorktreePath: string | undefined;
    try {
      validateMissionId(workspace.missionId);
      const expectedId = `mission-${workspace.missionId}`;
      const expectedBranch = `orrery/mission-${workspace.missionId}`;
       const expectedWorktreesRoot = join(this.workspaceRoot, "worktrees", repositoryRuntimeKey(repositoryRoot));
       const expectedWorktreePath = join(expectedWorktreesRoot, expectedId);
      if (workspace.id !== expectedId || workspace.missionBranch !== expectedBranch || workspace.worktreePath !== expectedWorktreePath || workspace.repositoryRoot !== repositoryRoot || workspace.initialRevision !== token.missionParent) {
        throw new Error("Invalid promotion retry workspace");
      }
       await validateDirectory(this.workspaceRoot, this.workspaceRoot);
       await validateDirectory(expectedWorktreesRoot, expectedWorktreesRoot);
      await validateDirectory(workspace.worktreePath, workspace.worktreePath);
      const worktreeTopLevel = (await safeGit(["rev-parse", "--show-toplevel"], workspace.worktreePath)).stdout.trim();
      const worktreeBranch = (await safeGit(["branch", "--show-current"], workspace.worktreePath)).stdout.trim();
      if ((await realpath(worktreeTopLevel)) !== workspace.worktreePath || worktreeBranch !== workspace.missionBranch) throw new Error("Invalid promotion retry workspace");
      const topLevel = (await safeGit(["rev-parse", "--show-toplevel"], repositoryRoot)).stdout.trim();
      if ((await realpath(topLevel)) !== repositoryRoot) throw new Error("Invalid promotion retry repository");
      const checkedOutBranch = (await safeGit(["branch", "--show-current"], repositoryRoot)).stdout.trim();
       if (checkedOutBranch !== token.targetBranch) { await this.retryRepository.release(token); return { status: "conflict", reason: "Target branch is not checked out at the repository root", retry: token }; }
      const status = await safeGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ":!.orrery/"], repositoryRoot);
       if (status.stdout) { await this.retryRepository.release(token); return { status: "conflict", reason: "Target branch has uncommitted changes", retry: token }; }
      const targetRevision = (await safeGit(["rev-parse", token.targetBranch], repositoryRoot)).stdout.trim();
       if (targetRevision !== token.expectedTargetRevision) { await this.retryRepository.release(token); return { status: "conflict", reason: "Target branch changed since promotion attempt", retry: token }; }
      const missionRevision = (await safeGit(["rev-parse", `${token.missionRevision}^{commit}`], repositoryRoot)).stdout.trim();
      if (missionRevision !== token.missionRevision) throw new Error("Invalid promotion retry mission commit");
       const parents = (await safeGit(["show", "-s", "--format=%P", missionRevision], repositoryRoot)).stdout.trim().split(/\s+/);
       if (parents.length !== 1 || parents[0] !== token.missionParent || token.missionParent !== token.expectedTargetRevision) throw new Error("Promotion retry commit has an unexpected parent");
       const tree = (await safeGit(["show", "-s", "--format=%T", missionRevision], repositoryRoot)).stdout.trim();
       if (tree !== token.missionTree) throw new Error("Promotion retry commit has an unexpected tree");

       const promotionWorktreesRoot = await prepareWorktreesRoot(this.workspaceRoot, repositoryRoot);
      promotionWorktreePath = join(promotionWorktreesRoot, `promotion-${randomUUID()}`);
      await safeGit(["worktree", "add", "--detach", promotionWorktreePath, targetRevision], repositoryRoot);
      try {
        await safeGit(["cherry-pick", missionRevision], promotionWorktreePath);
      } catch (error) {
        await safeGit(["cherry-pick", "--abort"], promotionWorktreePath).catch(() => undefined);
         await this.retryRepository.release(token);
         return { status: "conflict", reason: error instanceof Error ? error.message : String(error), retry: token };
      }
      const promotedRevision = (await safeGit(["rev-parse", "HEAD"], promotionWorktreePath)).stdout.trim();
      if (!(await applyTargetRevision(
        safeGit,
        repositoryRoot,
        token.targetBranch,
        targetRevision,
        promotedRevision,
        isolatedConfig.env,
      ))) {
        await this.retryRepository.release(token);
        return { status: "conflict", reason: "Target branch changed during promotion", retry: token };
      }
       if (!(await this.retryRepository.consume(token))) throw new Error("Promotion retry token was consumed concurrently");
       return { status: "promoted", revision: promotedRevision };
     } catch (error) {
       await this.retryRepository.release(token).catch(() => undefined);
       throw error;
    } finally {
      if (promotionWorktreePath) {
        await safeGit(["worktree", "remove", "--force", promotionWorktreePath], repositoryRoot).catch(() => undefined);
        await rm(promotionWorktreePath, { recursive: true, force: true }).catch(() => undefined);
      }
      await rm(isolatedConfig.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async reconcilePromotion(token: PromotionRetryToken) {
    validateBranch(token.targetBranch);
    const isolatedConfig = await createIsolatedGitEnvironment();
    const safeGit = createSafeGit(this.git, isolatedConfig);
    try {
      const targetRevision = (await safeGit(["rev-parse", token.targetBranch], token.workspace.repositoryRoot)).stdout.trim();
      if (targetRevision === token.expectedTargetRevision) return { status: "pending" as const };
      const parents = (await safeGit(["show", "-s", "--format=%P", targetRevision], token.workspace.repositoryRoot)).stdout.trim().split(/\s+/);
      const tree = (await safeGit(["show", "-s", "--format=%T", targetRevision], token.workspace.repositoryRoot)).stdout.trim();
      if (parents.length === 1 && parents[0] === token.expectedTargetRevision && tree === token.missionTree) {
        return { status: "promoted" as const, revision: targetRevision };
      }
      return { status: "conflict" as const, reason: "Target branch changed since promotion attempt", retry: token };
    } finally {
      await rm(isolatedConfig.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

class InMemoryPromotionRetryRepository implements PromotionRetryRepository {
  private readonly records = new Map<string, PromotionRetryToken>();
  private readonly claimed = new Set<string>();
  async save(token: PromotionRetryToken): Promise<void> { this.records.set(token.missionRevision, token); }
  async claim(token: PromotionRetryToken): Promise<PromotionRetryToken | null> {
    const stored = this.records.get(token.missionRevision);
    if (!stored || JSON.stringify(stored) !== JSON.stringify(token) || this.claimed.has(token.missionRevision)) return null;
    this.claimed.add(token.missionRevision);
    return stored;
  }
  async release(token: PromotionRetryToken): Promise<void> { this.claimed.delete(token.missionRevision); }
  async consume(token: PromotionRetryToken): Promise<boolean> { return this.claimed.delete(token.missionRevision) && this.records.delete(token.missionRevision); }
}

export class FilePromotionRetryRepository implements PromotionRetryRepository {
  private readonly repositoryRoot: string;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly lockOptions: Required<Omit<FilePromotionRetryRepositoryOptions, "isProcessAlive">> &
    Pick<FilePromotionRetryRepositoryOptions, "isProcessAlive">;

  constructor(repositoryRoot: string, options: FilePromotionRetryRepositoryOptions = {}) {
    this.repositoryRoot = repositoryRoot;
    this.statePath = join(repositoryRoot, ".orrery", "promotion-retries.json");
    this.lockPath = `${this.statePath}.lock`;
    this.lockOptions = {
      acquisitionTimeoutMs: options.acquisitionTimeoutMs ?? DEFAULT_LOCK_ACQUISITION_TIMEOUT_MS,
      staleAfterMs: options.staleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS,
      retryDelayMs: options.retryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS,
      now: options.now ?? (() => new Date()),
      hostname: options.hostname ?? getHostname(),
      isProcessAlive: options.isProcessAlive,
    };
    if (this.lockOptions.acquisitionTimeoutMs <= 0 || this.lockOptions.staleAfterMs < 0 || this.lockOptions.retryDelayMs <= 0) {
      throw new Error("Invalid promotion retry lock timing");
    }
  }

  async save(token: PromotionRetryToken): Promise<void> {
    await this.withLock(async () => {
      const records = await this.read();
      records[token.missionRevision] = { token, claimed: false };
      await this.write(records);
    });
  }

  async claim(token: PromotionRetryToken): Promise<PromotionRetryToken | null> {
    return this.withLock(async () => {
      const records = await this.read();
      const record = records[token.missionRevision];
      if (!record || record.claimed || JSON.stringify(record.token) !== JSON.stringify(token)) return null;
      records[token.missionRevision] = { ...record, claimed: true };
      await this.write(records);
      return record.token;
    });
  }

  async release(token: PromotionRetryToken): Promise<void> {
    await this.withLock(async () => {
      const records = await this.read();
      const record = records[token.missionRevision];
      if (record) { records[token.missionRevision] = { ...record, claimed: false }; await this.write(records); }
    });
  }

  async consume(token: PromotionRetryToken): Promise<boolean> {
    return this.withLock(async () => {
      const records = await this.read();
      const record = records[token.missionRevision];
      if (!record?.claimed || JSON.stringify(record.token) !== JSON.stringify(token)) return false;
      delete records[token.missionRevision];
      await this.write(records);
      return true;
    });
  }

  private async read(): Promise<Record<string, { token: PromotionRetryToken; claimed: boolean }>> {
    try {
      if ((await stat(this.statePath)).size > MAX_RETRY_REGISTRY_BYTES) throw new Error("Promotion retry registry is too large");
      return JSON.parse(await readFile(this.statePath, "utf8"));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }

  private async write(records: Record<string, unknown>): Promise<void> {
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(records), { mode: 0o600 });
    await rename(temporaryPath, this.statePath);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const root = await realpath(this.repositoryRoot);
    const orrery = join(root, ".orrery");
    await validateDirectory(orrery, orrery);
    const owner: PromotionRetryLockMetadata = {
      ownerId: randomUUID(),
      pid: process.pid,
      hostname: this.lockOptions.hostname,
      acquiredAt: this.lockOptions.now().toISOString(),
    };
    const deadline = Date.now() + this.lockOptions.acquisitionTimeoutMs;
    for (;;) {
      let created = false;
      try {
        await mkdir(this.lockPath);
        created = true;
        await writeFile(join(this.lockPath, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
        break;
      } catch (error) {
        if (created) {
          await rm(this.lockPath, { recursive: true, force: true });
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.recoverStaleLock(owner)) break;
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring promotion retry lock after ${this.lockOptions.acquisitionTimeoutMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, Math.min(this.lockOptions.retryDelayMs, Math.max(1, deadline - Date.now()))));
      }
    }
    try { return await operation(); }
    finally {
      const currentOwner = await this.readLockMetadata(this.lockPath);
      if (currentOwner?.ownerId === owner.ownerId) await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  private async recoverStaleLock(owner: PromotionRetryLockMetadata): Promise<boolean> {
    const observed = await this.readLockMetadata(this.lockPath);
    if (!observed || this.lockOptions.now().getTime() - Date.parse(observed.acquiredAt) < this.lockOptions.staleAfterMs) return false;
    if (observed.hostname !== this.lockOptions.hostname || this.isProcessAlive(observed.pid) !== false) return false;

    const abandonedPath = `${this.lockPath}.abandoned-${randomUUID()}`;
    try {
      await rename(this.lockPath, abandonedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    let reserved = false;
    try {
      await mkdir(this.lockPath);
      reserved = true;
      await writeFile(join(this.lockPath, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
    } catch (error) {
      if (reserved) await rm(this.lockPath, { recursive: true, force: true }).catch(() => undefined);
      if (reserved) await rename(abandonedPath, this.lockPath).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    const quarantined = await this.readLockMetadata(abandonedPath);
    if (quarantined?.ownerId === observed.ownerId) {
      await rm(abandonedPath, { recursive: true, force: true });
      return true;
    }
    const currentOwner = await this.readLockMetadata(this.lockPath);
    if (currentOwner?.ownerId === owner.ownerId) await rm(this.lockPath, { recursive: true, force: true });
    await rename(abandonedPath, this.lockPath).catch(() => undefined);
    return false;
  }

  private async readLockMetadata(path: string): Promise<PromotionRetryLockMetadata | null> {
    try {
      const value: unknown = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
      if (!value || typeof value !== "object") return null;
      const metadata = value as Partial<PromotionRetryLockMetadata>;
      if (
        typeof metadata.ownerId !== "string" || !metadata.ownerId ||
        !Number.isSafeInteger(metadata.pid) || (metadata.pid ?? 0) <= 0 ||
        typeof metadata.hostname !== "string" || !metadata.hostname ||
        typeof metadata.acquiredAt !== "string" || !Number.isFinite(Date.parse(metadata.acquiredAt))
      ) return null;
      return metadata as PromotionRetryLockMetadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private isProcessAlive(pid: number): boolean | undefined {
    if (this.lockOptions.isProcessAlive) return this.lockOptions.isProcessAlive(pid);
    try { process.kill(pid, 0); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      return undefined;
    }
  }
}
