import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import {
  AllowlistedCommandRunner,
  AppendOnlyEvidenceStore,
  FilePromotionRetryRepository,
  GitWorkspaceService,
  MissionRunner,
  PromotionService,
  type VerificationCommand,
  type EvidenceRecord,
  type MissionRepository,
} from "../packages/mission-kernel/src/index";
import {
  FileMissionEventStore,
  FileMissionStore,
  FileRepositoryRegistry,
  MissionAuthority,
  MissionRegistry,
  TrustedApprovalService,
  PinnedApprovalVerifier,
  missionStoreRepository,
  type ApprovedRepository,
  type MissionEventRecord,
  type RepositoryApprovalInput,
  type RepositoryRegistryPersistence,
  type PromotionApprovalIssuer,
  type TrustedApprovalContext,
  type VerificationCommandContext,
} from "../packages/mission-control-daemon/src/index";
import { transitionMission } from "../packages/mission-control-domain/src/index";
import type { GitInspector } from "../packages/mission-control-daemon/src/authority-ports";
import { atomicWriteJson, initialize, pathsFor } from "../packages/mission-control-daemon/src/durable-store-files";
import { hardenPrivatePath } from "../packages/mission-control-daemon/src/auth";

const execFileAsync = promisify(execFile);

export interface DaemonAuthorityBootstrap {
  readonly authority: MissionAuthority;
  readonly registry: MissionRegistry;
  readonly eventSource: FileMissionEventStore;
  readonly recoverActiveMissions: () => Promise<void>;
  readonly promotionApprovalIssuer?: PromotionApprovalIssuer;
  readonly promotionApprovalEnabled: boolean;
}

export interface DaemonAuthorityOptions {
  readonly verificationCommandResolver?: (repository: ApprovedRepository, context: VerificationCommandContext) => Promise<VerificationCommand | undefined> | VerificationCommand | undefined;
  readonly trustedVerificationCommands?: readonly VerificationCommand[];
  readonly gitInspector?: GitInspector;
  readonly trustedApprovalContext?: TrustedApprovalContext;
  readonly trustedApprovalPublicKey?: string;
}

export async function createDaemonAuthority(runtimeDirectory: string, options: DaemonAuthorityOptions = {}): Promise<DaemonAuthorityBootstrap> {
  await initialize(runtimeDirectory);
  const paths = pathsFor(runtimeDirectory);
  const repositoriesDirectory = join(paths.root, "repositories");
  const evidenceDirectory = join(paths.root, "evidence");
  const workspaceRoot = join(paths.root, "workspaces");
  await privateDirectory(repositoriesDirectory);
  await privateDirectory(evidenceDirectory);
  await privateDirectory(workspaceRoot);
  await privateDirectory(join(workspaceRoot, ".orrery"));
  const repositoriesPath = join(repositoriesDirectory, "approved.json");
  const repositoryPersistence = jsonRepositoryPersistence(repositoriesPath);
  const gitInspector = options.gitInspector ?? realGitInspector;
  const repositoryRegistry = new FileRepositoryRegistry({ persistence: repositoryPersistence, gitInspector, now: Date.now, proposalTtlMs: 15 * 60 * 1000 });
  await repositoryRegistry.ready();
  const missionStore = new FileMissionStore(runtimeDirectory);
  const eventStore = new FileMissionEventStore(runtimeDirectory);
  await missionStore.list();
  const workspaceService = new GitWorkspaceService({ workspaceRoot, retryRepository: new FilePromotionRetryRepository(workspaceRoot) });
  const evidenceStore = new AppendOnlyEvidenceStore({ persistence: fileEvidencePersistence(join(evidenceDirectory, "records.jsonl")) });
  const trustedVerificationCommand: VerificationCommand = { executable: process.execPath, args: ["--check", "scripts/desktop-smoke.mjs"] };
  const trustedVerificationCommands = options.trustedVerificationCommands ?? [trustedVerificationCommand];
  if (trustedVerificationCommands.length === 0) throw new Error("At least one trusted verification command is required.");
  const commandRunner = new AllowlistedCommandRunner({ worktreePath: workspaceRoot, allowlist: [...trustedVerificationCommands] });
  const unusedRunnerRepository: MissionRepository = {
    load: (missionId) => missionStore.load(missionId),
    save: async () => { throw new Error("Daemon mission runs require the authority-owned durable repository adapter."); },
  };
  const runner = new MissionRunner({ workspaceService, commandRunner, evidenceStore, repository: unusedRunnerRepository, workspaceRoot });
  const approvals = options.trustedApprovalContext ? new TrustedApprovalService(options.trustedApprovalContext) : undefined;
  const pinnedPublicKey = options.trustedApprovalPublicKey ?? approvals?.publicKey;
  const approvalVerifier = pinnedPublicKey ? new PinnedApprovalVerifier(pinnedPublicKey) : { verify: () => { throw new Error("Promotion is unavailable without an Electron-owned daemon."); } };
  const authority = new MissionAuthority({
    missionStore,
    eventStore,
    repositoryRegistry,
    missionRunner: runner,
    promotionService: new PromotionService({ workspaceService }),
    workspaceService,
    verificationCommandResolver: async (context) => {
      const repository = await repositoryRegistry.resolve(context.repositoryId);
      return options.verificationCommandResolver
        ? options.verificationCommandResolver(repository, context)
        : resolveDefaultVerificationCommand(repository, trustedVerificationCommands[0]);
    },
    promotionApprovalVerifier: approvalVerifier,
  });
  const recoverActiveMissions = async () => {
    for (const mission of await missionStore.list()) {
      const strandedOperation = Object.entries(mission.operations ?? {}).find(([, operation]) =>
        operation.operation === "run" && operation.state !== "committed" && !mission.activeRunId && !mission.currentWorkspace && !mission.currentChangeSnapshot,
      );
      const runId = mission.activeRunId ?? (strandedOperation?.[1].operation === "run" ? strandedOperation[1].runId : undefined);
      if (!runId || (!strandedOperation && !["running", "paused", "blocked"].includes(mission.status))) continue;
      const event: MissionEventRecord = {
        id: `recovery-${crypto.randomUUID()}`,
        missionId: mission.id,
        runId,
        sequence: mission.lastEventSequence + 1,
        timestamp: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        kind: "interruption",
        title: "Mission interrupted during daemon restart",
        detail: "The previous daemon did not retain executable run state; the mission was safely failed.",
        payloadVersion: 1,
      };
      const interrupted = { ...mission, events: [...mission.events, event] };
      const failed = strandedOperation
        ? { ...interrupted, status: "failed" as const, completionSummary: "Mission interrupted by daemon restart.", activeRunId: undefined }
        : transitionMission(interrupted, { type: "fail", runId, reason: "Mission interrupted by daemon restart." });
      const operations = { ...mission.operations };
      if (strandedOperation) delete operations[strandedOperation[0]];
      await missionStore.save({ ...mission, ...failed, operations, lastEventSequence: event.sequence, payloadVersion: 1 }, [event]);
    }
  };
  const snapshots = missionStoreRepository(missionStore);
  const registryRepository = Object.assign(snapshots, {
    propose: (localPath: string) => repositoryRegistry.propose(localPath),
    approve: (input: RepositoryApprovalInput) => repositoryRegistry.approve(input),
  });
  const registry = new MissionRegistry(registryRepository);
  return { authority, registry, eventSource: eventStore, recoverActiveMissions, promotionApprovalEnabled: Boolean(pinnedPublicKey), ...(options.trustedApprovalContext && approvals ? { promotionApprovalIssuer: approvals } : {}) };
}

function jsonRepositoryPersistence(path: string): RepositoryRegistryPersistence {
  const directory = dirname(path);
  return {
    async load() {
      try {
        const value: unknown = JSON.parse(await boundedRead(path, 4 * 1024 * 1024, "approved repository registry"));
        if (!Array.isArray(value) || !value.every(isApprovedRepository)) throw new Error("Corrupt approved repository registry.");
        if (new Set(value.map((entry) => entry.repositoryId)).size !== value.length) throw new Error("Corrupt approved repository registry: duplicate repository id.");
        return value;
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    },
    async loadProposals() {
      const proposals = [];
      const proposalIds = new Set<string>();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.name.startsWith("proposal-") || entry.name.endsWith(".consumed")) continue;
        if (!entry.isFile() || !entry.name.endsWith(".json")) throw new Error("Corrupt repository proposal.");
        const value: unknown = JSON.parse(await boundedRead(join(directory, entry.name), 64 * 1024, "repository proposal"));
        if (!isRepositoryProposal(value) || entry.name !== `proposal-${value.proposalId}.json`) throw new Error("Corrupt repository proposal.");
        if (proposalIds.has(value.proposalId)) throw new Error("Corrupt repository proposal: duplicate proposal id.");
        proposalIds.add(value.proposalId);
        proposals.push(value);
      }
      return proposals;
    },
    async save(entries) { await atomicWriteJson(path, entries, 4 * 1024 * 1024); },
    async saveProposal(proposal) { await atomicWriteJson(join(dirname(path), `proposal-${proposal.proposalId}.json`), proposal, 64 * 1024); },
    async approveProposal(proposalId, entries) {
      const proposalPath = join(directory, `proposal-${proposalId}.json`);
      const tombstone = `${proposalPath}.consumed`;
      await rename(proposalPath, tombstone);
      try { await atomicWriteJson(path, entries, 4 * 1024 * 1024); }
      catch (error) { await rename(tombstone, proposalPath); throw error; }
      await rm(tombstone, { force: true });
    },
  };
}

function fileEvidencePersistence(path: string) {
  let tail = Promise.resolve();
  return {
    reserveAndAppend(createRecord: (sequence: number) => EvidenceRecord) {
      const operation = tail.then(async () => {
        let sequence = 1;
        try { sequence = (await boundedRead(path, 64 * 1024 * 1024, "evidence log")).split("\n").filter(Boolean).length + 1; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const record = createRecord(sequence);
        const handle = await open(path, "a", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return record;
      });
      tail = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}

const realGitInspector: GitInspector = {
  async inspect(localPath) {
    const root = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: localPath })).stdout.trim();
    const canonicalRoot = await realpath(root);
    const commonValue = (await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd: canonicalRoot })).stdout.trim();
    const common = await realpath(isAbsolute(commonValue) ? commonValue : resolve(canonicalRoot, commonValue));
    const remote = await execFileAsync("git", ["config", "--get", "remote.origin.url"], { cwd: canonicalRoot }).then((result) => result.stdout.trim()).catch(() => "");
    return { canonicalRoot, gitIdentity: createHash("sha256").update(JSON.stringify([common, remote]), "utf8").digest("hex") };
  },
};

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
  else await hardenPrivatePath(path, "win32");
}

async function resolveDefaultVerificationCommand(repository: ApprovedRepository, command: VerificationCommand): Promise<VerificationCommand | undefined> {
  try {
    const script = await lstat(join(repository.canonicalRoot, "scripts", "desktop-smoke.mjs"));
    return script.isFile() && !script.isSymbolicLink() ? command : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isApprovedRepository(value: unknown): value is ApprovedRepository {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return exactKeys(entry, ["repositoryId", "canonicalRoot", "fingerprint", "gitIdentity", "approvedAt", "lastVerifiedAt", "payloadVersion"]) &&
    entry.payloadVersion === 1 && isId(entry.repositoryId) && isCanonicalRoot(entry.canonicalRoot) && isHash(entry.fingerprint) && isIdentity(entry.gitIdentity) &&
    isTimestamp(entry.approvedAt) && isTimestamp(entry.lastVerifiedAt);
}

function isRepositoryProposal(value: unknown): value is import("../packages/mission-control-daemon/src/index").RepositoryProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proposal = value as Record<string, unknown>;
  return exactKeys(proposal, ["proposalId", "canonicalRoot", "fingerprint", "gitIdentity", "approvalNonceHash", "expiresAt", "payloadVersion"]) && proposal.payloadVersion === 1 &&
    isId(proposal.proposalId) && isCanonicalRoot(proposal.canonicalRoot) && isHash(proposal.fingerprint) && isIdentity(proposal.gitIdentity) && isHash(proposal.approvalNonceHash) && isTimestamp(proposal.expiresAt);
}

function exactKeys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function isId(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{32}$/.test(value); }
function isHash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function isIdentity(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1024; }
function isTimestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function isCanonicalRoot(value: unknown): value is string { return typeof value === "string" && isAbsolute(value) && normalize(value) === value; }

async function boundedRead(path: string, maximumBytes: number, label: string): Promise<string> {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`Corrupt ${label}: expected a regular file.`);
  if (details.size > maximumBytes) throw new Error(`${label} is too large.`);
  return readFile(path, "utf8");
}
