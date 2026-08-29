import type {
  ChangeSnapshot,
  CommandInput,
  CommandResult,
  CreateWorkspaceInput,
  EvidenceInput,
  MissionSnapshot,
  MissionWorkspace,
  PromotionPreparation,
  PromotionResult,
  PromotionReconciliation,
  PromotionRetryToken,
} from "./types";
import type { Evidence } from "@orrery/mission-control-domain";

export interface WorkspaceService {
  createMissionWorkspace(input: CreateWorkspaceInput): Promise<MissionWorkspace>;
  removeMissionWorkspace(workspace: MissionWorkspace): Promise<void>;
  inspectChanges(workspace: MissionWorkspace): Promise<ChangeSnapshot>;
  preparePromotion(
    workspace: MissionWorkspace,
    targetBranch: string,
    reviewerId: string,
    reviewedSnapshot: ChangeSnapshot,
  ): Promise<PromotionPreparation>;
  promote(
    workspace: MissionWorkspace,
    targetBranch: string,
    reviewerId: string,
    reviewedSnapshot: ChangeSnapshot,
    approvalExpiresAt: string,
  ): Promise<PromotionResult>;
  promoteRetry(token: PromotionRetryToken, reviewerId: string, approvalExpiresAt: string): Promise<PromotionResult>;
  reconcilePromotion?(token: PromotionRetryToken, approvalExpiresAt: string): Promise<PromotionReconciliation>;
}

export interface CommandRunner {
  run(input: CommandInput): Promise<CommandResult>;
}

export interface EvidenceStore {
  append(evidence: EvidenceInput): Promise<Evidence>;
}

export interface MissionRepository {
  save(snapshot: MissionSnapshot): Promise<void>;
  load(missionId: string): Promise<MissionSnapshot | null>;
}

export interface PromotionRetryRepository {
  save(token: PromotionRetryToken): Promise<void>;
  claim(token: PromotionRetryToken): Promise<PromotionRetryToken | null>;
  release(token: PromotionRetryToken): Promise<void>;
  consume(token: PromotionRetryToken): Promise<boolean>;
}

export function assertNonEmptyId(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a nonempty ID`);
  }
}

export function assertCommandArgs(args: unknown): asserts args is string[] {
  if (!Array.isArray(args)) {
    throw new Error("Command args must be an array");
  }
  if (!args.every((arg) => typeof arg === "string")) {
    throw new Error("Command args must contain only strings");
  }
}

function normalizePath(value: string): string {
  const path = value.replaceAll("\\", "/");
  const prefix = path.match(/^(?:[A-Za-z]:)?\//)?.[0] ?? "";
  const segments = path.slice(prefix.length).split("/");
  const normalized: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      normalized.pop();
    } else {
      normalized.push(segment);
    }
  }

  return `${prefix}${normalized.join("/")}`.replace(/\/$/, "");
}

export function assertWorktreeContainedCwd(cwd: string, worktreePath: string): void {
  if (typeof cwd !== "string" || typeof worktreePath !== "string") {
    throw new Error("cwd and worktreePath must be strings");
  }

  const normalizedCwd = normalizePath(cwd);
  const normalizedWorktree = normalizePath(worktreePath);
  const worktreePrefix = normalizedWorktree.endsWith("/")
    ? normalizedWorktree
    : `${normalizedWorktree}/`;

  if (normalizedCwd !== normalizedWorktree && !normalizedCwd.startsWith(worktreePrefix)) {
    throw new Error("cwd must be contained by the mission worktree");
  }
}
