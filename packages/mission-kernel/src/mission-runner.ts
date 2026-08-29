import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Evidence, Mission, MissionEvent } from "@orrery/mission-control-domain";
import { transitionMission } from "@orrery/mission-control-domain";
import type { CommandRunner, EvidenceStore, MissionRepository, WorkspaceService } from "./ports";
import type { CommandResult, MissionWorkspace, ChangeSnapshot } from "./types";

export interface MissionFileSystem {
  writeFile(path: string, content: string, workspaceRoot?: string): Promise<void>;
}

export interface VerificationCommand {
  executable: string;
  args: string[];
}

export interface RunMissionInput {
  mission: Mission;
  repositoryRoot: string;
  targetBranch: string;
  runId: string;
  planRevisionId?: string;
  verificationCommand?: VerificationCommand;
  signal?: AbortSignal;
  now?: () => string;
  id?: () => string;
  repository?: MissionRepository;
  onEvent?: (event: MissionRunnerEvent) => void | Promise<void>;
}

export interface MissionRunnerEvent extends MissionEvent {}

export interface RunMissionResult {
  missionId: string;
  runId: string;
  planRevisionId: string;
  status: Mission["status"];
  mission: Mission;
  workspace: MissionWorkspace;
  changeSnapshot: ChangeSnapshot;
  commandResult?: CommandResult;
}

export interface MissionRunnerOptions {
  workspaceService: WorkspaceService;
  commandRunner: CommandRunner;
  evidenceStore: EvidenceStore;
  repository: MissionRepository;
  fileSystem?: MissionFileSystem;
  workspaceRoot?: string;
  onEvent?: (event: MissionRunnerEvent) => void | Promise<void>;
}

const defaultFileSystem: MissionFileSystem = { writeFile: writeMissionFileSafely };

export class MissionRunner {
  private readonly fileSystem: MissionFileSystem;

  constructor(private readonly options: MissionRunnerOptions) {
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
  }

  async run(input: RunMissionInput): Promise<RunMissionResult> {
    const now = input.now ?? (() => new Date().toISOString());
    const id = input.id ?? (() => crypto.randomUUID());
    const planRevisionId = input.planRevisionId ?? input.mission.plan.id;
    if (planRevisionId !== input.mission.plan.id) throw new Error("Mission plan revision does not match the run");
    if (input.signal?.aborted) throw abortError();

    const workspace = await this.options.workspaceService.createMissionWorkspace({
      missionId: input.mission.id, repositoryRoot: input.repositoryRoot, targetBranch: input.targetBranch,
    });
    let current = transitionMission(input.mission, { type: "start", workspaceId: workspace.id, runId: input.runId });
    try {
       current = await this.commitEvent(input, current, input.runId, "workspace", "Workspace isolated", workspace.worktreePath, now, id);
    } catch (error) {
      await this.options.workspaceService.removeMissionWorkspace(workspace).catch(() => undefined);
      throw error;
    }
    try {
    if (input.signal?.aborted) return this.cancel(input, current, now, id);

    await this.fileSystem.writeFile(join(workspace.worktreePath, "orrery-mission.txt"), `${input.mission.title}\n${now()}\n`, this.options.workspaceRoot);
    const changeSnapshot = await this.options.workspaceService.inspectChanges(workspace);
    if (changeSnapshot.files.length === 0) {
      const failed = transitionMission(current, { type: "fail", runId: input.runId, reason: "No file changes were detected; review requires a concrete change." });
      const event = this.event(input, "completion", "Run failed", failed.completionSummary!, now, id, failed.events.length + 1);
      const persisted = { ...failed, events: [...failed.events, event] };
       await this.repository(input).save(persisted);
       await this.publish(input, event);
      await this.options.workspaceService.removeMissionWorkspace(workspace).catch(() => undefined);
      return { missionId: input.mission.id, runId: input.runId, planRevisionId, status: persisted.status, mission: persisted, workspace, changeSnapshot };
    }
    for (const change of changeSnapshot.files) {
      current = transitionMission(current, { type: "observe_change", runId: input.runId, change });
       current = await this.commitEvent(input, current, input.runId, "change", "Change observed", `${change.path}: +${change.additions} -${change.deletions}`, now, id);
    }
    const diffEvidence = await this.options.evidenceStore.append({
      kind: "diagnostic", status: "passed",
      summary: `Git diff captured: ${changeSnapshot.files.length} file(s), revision ${changeSnapshot.revision}`,
      planRevisionId,
    });
    current = transitionMission(current, { type: "record_evidence", runId: input.runId, evidence: diffEvidence });
     current = await this.commitEvent(input, current, input.runId, "verification", "Diff evidence recorded", diffEvidence.summary, now, id);

    let commandResult: CommandResult | undefined;
    if (input.verificationCommand) {
       current = await this.commitEvent(input, current, input.runId, "execution", "Verification started", `${input.verificationCommand.executable} ${input.verificationCommand.args.join(" ")}`, now, id);
      await this.checkCancelled(input.signal);
      try {
        commandResult = await this.options.commandRunner.run({ ...input.verificationCommand, cwd: workspace.worktreePath, signal: input.signal });
      } catch (error) {
        if (isAbort(error)) return this.cancel(input, current, now, id);
        throw error;
      }
      if (input.signal?.aborted) return this.cancel(input, current, now, id);
      const passed = commandResult.exitCode === 0 && commandResult.signal === null;
      const commandEvidence = await this.options.evidenceStore.append({
        kind: "command", status: passed ? "passed" : "failed",
        summary: `${commandResult.executable} ${commandResult.args.join(" ")} ${passed ? "passed" : "failed"}`,
        planRevisionId,
      });
      current = transitionMission(current, { type: "record_evidence", runId: input.runId, evidence: commandEvidence });
       current = await this.commitEvent(input, current, input.runId, "verification", "Verification completed", commandEvidence.summary, now, id);
      if (!passed) {
        const failed = transitionMission(current, { type: "fail", runId: input.runId, reason: commandEvidence.summary });
        const event = this.event(input, "completion", "Run failed", commandEvidence.summary, now, id, failed.events.length + 1);
        const persisted = { ...failed, events: [...failed.events, event] };
       await this.repository(input).save(persisted);
       await this.publish(input, event);
        return { missionId: input.mission.id, runId: input.runId, planRevisionId, status: persisted.status, mission: persisted, workspace, changeSnapshot, commandResult };
      }
    } else {
      const manualEvidence = await this.options.evidenceStore.append({
        kind: "manual", status: "warning",
        summary: "Automated verification was not run; manual verification is required.",
        planRevisionId,
      });
      current = transitionMission(current, { type: "record_evidence", runId: input.runId, evidence: manualEvidence });
       current = await this.commitEvent(input, current, input.runId, "verification", "Verification not run", manualEvidence.summary, now, id);
    }

    const changeSummary = changeSnapshot.files.length === 0
      ? "No file changes were detected."
      : `${changeSnapshot.files.length} file change(s) captured.`;
    const verificationSummary = input.verificationCommand
      ? "Automated verification passed."
      : "Manual verification is required.";
    const completed = transitionMission(current, { type: "complete", runId: input.runId, summary: `${changeSummary} ${verificationSummary}` });
    const completion = this.event(input, "completion", "Run complete", completed.completionSummary!, now, id, completed.events.length + 1);
    const persisted = { ...completed, events: [...completed.events, completion] };
     await this.repository(input).save(persisted);
     await this.publish(input, completion);
    return { missionId: input.mission.id, runId: input.runId, planRevisionId, status: persisted.status, mission: persisted, workspace, changeSnapshot, commandResult };
    } catch (error) {
      if (input.signal?.aborted) return this.cancel(input, current, now, id);
      if (isAbort(error)) throw error;
      if (current.status === "running") {
        try {
          const failed = transitionMission(current, { type: "fail", runId: input.runId, reason: error instanceof Error ? error.message : String(error) });
          const event = this.event(input, "completion", "Run failed", failed.completionSummary!, now, id, failed.events.length + 1);
           await this.repository(input).save({ ...failed, events: [...failed.events, event] });
        } catch { /* Preserve the operational error when recovery persistence itself fails. */ }
      }
      await this.options.workspaceService.removeMissionWorkspace(workspace).catch(() => undefined);
      throw error;
    }
  }

  private async commitEvent(input: RunMissionInput, mission: Mission, runId: string, kind: MissionEvent["kind"], title: string, detail: string, now: () => string, id: () => string) {
    const next = transitionMission(mission, { type: "append_event", runId, event: this.event({ mission, runId }, kind, title, detail, now, id, mission.events.length + 1) });
     await this.repository(input).save(next);
     await this.publish(input, next.events.at(-1)!);
    return next;
  }

  private event(input: Pick<RunMissionInput, "mission" | "runId">, kind: MissionEvent["kind"], title: string, detail: string, now: () => string, id: () => string, sequence: number): MissionEvent {
    return { id: id(), missionId: input.mission.id, runId: input.runId, sequence, timestamp: now(), kind, title, detail };
  }

  private async cancel(input: RunMissionInput, mission: Mission, now: () => string, id: () => string): Promise<never> {
    const event = this.event(input, "cancellation", "Run cancelled", "Mission run was cancelled.", now, id, mission.events.length + 1);
    const cancelled = transitionMission(mission, { type: "cancel", runId: input.runId, event });
     await this.repository(input).save(cancelled);
     await this.publish(input, event);
    throw abortError();
  }

  private async checkCancelled(signal?: AbortSignal): Promise<void> { if (signal?.aborted) throw abortError(); }

  private repository(input: RunMissionInput): MissionRepository { return input.repository ?? this.options.repository; }

  private publish(input: RunMissionInput, event: MissionRunnerEvent): void | Promise<void> {
    return (input.onEvent ?? this.options.onEvent)?.(event);
  }
}

function abortError() { return Object.assign(new Error("Mission run was cancelled"), { name: "AbortError" }); }
function isAbort(error: unknown) { return error instanceof Error && (error.name === "AbortError" || error.message.includes("cancelled")); }

async function writeMissionFileSafely(path: string, content: string, configuredWorkspaceRoot?: string): Promise<void> {
  const parent = dirname(path);
  const workspaceRoot = resolve(configuredWorkspaceRoot ?? dirname(dirname(parent)));
  const canonicalRoot = await realpath(workspaceRoot);
  if (canonicalRoot !== workspaceRoot) throw new Error("Mission workspace root is not safe");
  const rootMetadata = await lstat(workspaceRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("Mission workspace root is not safe");
  const canonicalParent = await realpath(parent);
  const relativeParent = relative(workspaceRoot, canonicalParent);
  if (canonicalParent !== resolve(parent) || relativeParent === "" || relativeParent === ".." || relativeParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativeParent)) {
    throw new Error("Mission file parent is not safe");
  }

  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let file;
  try {
    file = await open(path, flags, 0o600);
  } catch (error) {
    if (isNodeError(error) && (error.code === "EEXIST" || error.code === "EISDIR")) {
      throw new Error("Mission file path already exists and is not safe to replace", { cause: error });
    }
    throw error;
  }
  try {
    const opened = await file.stat();
    if (!opened.isFile()) throw new Error("Mission file must be a regular file");
    const [revalidatedRoot, revalidatedParent] = await Promise.all([realpath(workspaceRoot), realpath(parent)]);
    if (revalidatedRoot !== canonicalRoot || revalidatedParent !== canonicalParent) {
      throw new Error("Mission workspace changed during file creation");
    }
    const pathMetadata = await lstat(path);
    if (pathMetadata.isSymbolicLink() || pathMetadata.dev !== opened.dev || pathMetadata.ino !== opened.ino) {
      throw new Error("Mission file path changed during file creation");
    }
    await file.writeFile(content);
  } finally {
    await file.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
