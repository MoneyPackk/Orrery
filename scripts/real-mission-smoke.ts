import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AllowlistedCommandRunner,
  AppendOnlyEvidenceStore,
  GitWorkspaceService,
  FilePromotionRetryRepository,
  MissionRunner,
  PromotionService,
  type MissionRepository,
  type MissionSnapshot,
} from "../packages/mission-kernel/src/index.ts";
import { createMission, type Mission } from "../packages/mission-control-domain/src/index.ts";

const execFileAsync = promisify(execFile);
const smokeRoot = join(process.cwd(), ".tmp", "real-mission-smoke");
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });
const root = await mkdtemp(join(smokeRoot, "repository-"));
const runtimeParent = await mkdtemp(join(tmpdir(), "orrery-smoke-runtime-"));
const workspaceRoot = join(runtimeParent, "runtime");
const missionId = crypto.randomUUID();
const reviewerId = "task-8-smoke@example.test";
const timestamp = "2026-08-28T08:00:00.000Z";
const git = async (args: string[], cwd: string, options?: { env?: NodeJS.ProcessEnv }) => {
  const result = await execFileAsync("git", args, { cwd, env: options?.env });
  return { stdout: result.stdout, stderr: result.stderr };
};

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message);
};

const gitRevision = async (ref: string, cwd: string) => (await git(["rev-parse", ref], cwd)).stdout.trim();
const targetStatus = async (cwd: string) => (await git(["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":!.orrery/"], cwd)).stdout;
const normalizedText = async (path: string) => (await readFile(path, "utf8")).replaceAll("\r\n", "\n");

const stateDirectory = join(root, ".orrery", "smoke-state");
const statePath = join(stateDirectory, "mission.json");
const evidencePath = join(stateDirectory, "evidence.jsonl");
const repository: MissionRepository = {
  save: async (snapshot) => {
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(statePath, JSON.stringify(snapshot));
  },
  load: async () => {
    try {
      return JSON.parse(await readFile(statePath, "utf8")) as MissionSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
};

function buildMission(): Mission {
  const mission = createMission({
    title: "Prove real mission isolation",
    goal: "Update the disposable repository only through the reviewed mission path.",
    mode: "build",
    plan: {
      scope: "orrery-mission.txt",
      actions: ["Write the mission file in the isolated worktree."],
      acceptanceCriteria: ["Verification command passes and promotion is explicit."],
    },
  });
  return {
    ...mission,
    id: missionId,
    targetBranch: "main",
    plan: { ...mission.plan, id: "plan-task-8", approved: true },
    status: "queued",
  };
}

try {
  await git(["init", "--initial-branch", "main"], root);
  await git(["config", "user.email", "smoke@orrery.local"], root);
  await git(["config", "user.name", "Orrery Task 8 Smoke"], root);
  await writeFile(join(root, "fixture.txt"), "initial\n");
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "scripts", "desktop-smoke.mjs"), "export {};\n");
  await git(["add", "fixture.txt", "scripts/desktop-smoke.mjs"], root);
  await git(["commit", "-m", "fixture"], root);

  const initialRevision = await gitRevision("main", root);
  const mission = buildMission();
   const workspaceService = new GitWorkspaceService({ git, retryRepository: new FilePromotionRetryRepository(root), workspaceRoot });
   const expectedWorktreePath = join(workspaceRoot, "worktrees", createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex"), `mission-${missionId}`);
  const commandRunner = new AllowlistedCommandRunner({
    worktreePath: expectedWorktreePath,
    allowlist: [{ executable: process.execPath, args: ["--check", "scripts/desktop-smoke.mjs"] }],
    now: () => timestamp,
  });
  const evidenceStore = new AppendOnlyEvidenceStore({
    persistence: (() => {
      let pending = Promise.resolve();
      return {
        reserveAndAppend: (createRecord) => {
          const operation = pending.then(async () => {
            let sequence = 1;
            try {
              const contents = await readFile(evidencePath, "utf8");
              sequence = contents.split("\n").filter(Boolean).length + 1;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            const record = createRecord(sequence);
            await mkdir(stateDirectory, { recursive: true });
            await appendFile(evidencePath, `${JSON.stringify(record)}\n`);
            return record;
          });
          pending = operation.then(() => undefined, () => undefined);
          return operation;
        },
      };
    })(),
    now: () => timestamp,
  });
  const runner = new MissionRunner({
    workspaceService,
    commandRunner,
    evidenceStore,
    repository,
    workspaceRoot,
  });
  const result = await runner.run({
    mission,
    repositoryRoot: root,
    targetBranch: "main",
    runId: "run-task-8",
    verificationCommand: { executable: process.execPath, args: ["--check", "scripts/desktop-smoke.mjs"] },
    now: () => timestamp,
  });

  assert(result.status === "ready_for_review", `Expected ready_for_review, got ${result.status}`);
  assert(result.changeSnapshot.files.length === 1, "Expected exactly one changed file");
  assert(result.changeSnapshot.files[0]?.path === "orrery-mission.txt", "Unexpected changed path");
  assert(result.commandResult?.exitCode === 0, "Verification command did not pass");
  assert(result.mission.evidence.some((item) => item.kind === "diagnostic"), "Missing diff evidence");
  assert(result.mission.evidence.some((item) => item.kind === "command" && item.status === "passed"), "Missing passed command evidence");
  const persistedMission = await repository.load(missionId);
  const persistedEvidence = (await readFile(evidencePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as unknown);
  assert(persistedMission?.status === "ready_for_review", "Mission repository did not persist review-ready state");
  assert(persistedEvidence.length === 2, "Expected diff and command evidence persistence");
  assert(result.workspace.worktreePath === expectedWorktreePath, "Mission used an unexpected worktree");
  assert(await normalizedText(join(result.workspace.worktreePath, "orrery-mission.txt")) === `Prove real mission isolation\n${timestamp}\n`, "Mission file content was not isolated");
  assert(await targetStatus(root) === "", "Target repository content changed before promotion");
  assert(await gitRevision("main", root) === initialRevision, "Target branch advanced before promotion");

  const promotion = await new PromotionService({ workspaceService }).promote({
    mission: result.mission,
    workspace: result.workspace,
    planRevisionId: result.planRevisionId,
    changeSnapshot: result.changeSnapshot,
    reviewerId,
    approvalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    decision: "accepted",
  });
  assert(promotion.status === "promoted", `Promotion failed: ${promotion.status}`);
  const promotedRevision = await gitRevision("main", root);
  assert(promotedRevision === promotion.revision, "Promotion revision does not match target HEAD");
  assert(promotedRevision !== initialRevision, "Promotion did not advance target branch");
  assert((await git(["diff", `${initialRevision}..${promotedRevision}`, "--name-only"], root)).stdout.trim() === "orrery-mission.txt", "Promotion included an unreviewed path");
  assert(await normalizedText(join(root, "orrery-mission.txt")) === `Prove real mission isolation\n${timestamp}\n`, "Promoted content is incorrect");

  console.log("Real mission smoke passed.");
  console.log(JSON.stringify({ initialRevision, promotedRevision, changedFiles: result.changeSnapshot.files.map((file) => file.path), evidence: persistedEvidence.length, reviewerId }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(runtimeParent, { recursive: true, force: true });
  await rm(smokeRoot, { recursive: true, force: true });
}
