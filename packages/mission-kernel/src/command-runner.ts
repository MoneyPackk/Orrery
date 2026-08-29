import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { CommandInput, CommandResult } from "./types";
import { assertCommandArgs } from "./ports";

export interface AllowedCommand {
  executable: string;
  args: string[];
}

export interface CommandRunnerOptions {
  worktreePath: string;
  allowlist: AllowedCommand[];
  maxOutputBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => string;
}

export class CommandExecutionError extends Error {
  constructor(public readonly code: "COMMAND_TIMEOUT" | "COMMAND_CANCELLED", message: string) {
    super(message);
    this.name = "CommandExecutionError";
  }
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function isContained(cwd: string, worktreePath: string): boolean {
  const resolvedCwd = resolve(cwd);
  const resolvedRoot = resolve(worktreePath);
  const pathFromRoot = relative(resolvedRoot, resolvedCwd);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

export class AllowlistedCommandRunner {
  private readonly options: Required<Pick<CommandRunnerOptions, "maxOutputBytes" | "timeoutMs" | "now">> & CommandRunnerOptions;

  constructor(options: CommandRunnerOptions) {
    assertCommandArgs(options.allowlist.flatMap((entry) => entry.args));
    if (!options.worktreePath || options.maxOutputBytes === 0 || (options.maxOutputBytes ?? 1) < 0) {
      throw new Error("Invalid command runner configuration");
    }
    if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
      throw new Error("Invalid command runner timeout");
    }
    this.options = {
      ...options,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      now: options.now ?? (() => new Date().toISOString()),
    };
  }

  async run(input: CommandInput): Promise<CommandResult> {
    assertCommandArgs(input.args);
    if (!isContained(input.cwd, this.options.worktreePath)) {
      throw new Error("cwd must be contained by the mission worktree");
    }
    const allowed = this.options.allowlist.some(
      (entry) => entry.executable === input.executable && entry.args.length === input.args.length && entry.args.every((arg, index) => arg === input.args[index]),
    );
    if (!allowed) throw new Error("Command is not allowlisted");

    const cwd = await this.canonicalContainedCwd(input.cwd);
    const startedAt = this.options.now();
    return new Promise<CommandResult>((resolveResult, reject) => {
      const child = spawn(input.executable, input.args, {
        cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signals = [this.options.signal, input.signal].filter((signal): signal is AbortSignal => signal !== undefined);
      const removeAbortListeners = () => signals.forEach((signal) => signal.removeEventListener("abort", onAbort));

      const collect = (target: "stdout" | "stderr", chunk: Buffer | string) => {
        const current = target === "stdout" ? stdout : stderr;
        const available = this.options.maxOutputBytes - Buffer.byteLength(current);
        const bytes = Buffer.from(chunk);
        if (bytes.byteLength > available) truncated = true;
        const value = bytes.subarray(0, Math.max(0, available)).toString();
        if (target === "stdout") stdout += value;
        else stderr += value;
      };
      const finishError = async (error: CommandExecutionError) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        removeAbortListeners();
        await terminateProcessTree(child.pid);
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
        }
        reject(error);
      };
      const onAbort = () => { void finishError(new CommandExecutionError("COMMAND_CANCELLED", "Command execution was cancelled")); };
      if (signals.some((signal) => signal.aborted)) return onAbort();
      signals.forEach((signal) => signal.addEventListener("abort", onAbort, { once: true }));
      child.stdout?.on("data", (chunk: Buffer | string) => collect("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => collect("stderr", chunk));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        removeAbortListeners();
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        removeAbortListeners();
        resolveResult({ ...input, cwd, startedAt, completedAt: this.options.now(), exitCode, signal, stdout, stderr, truncated });
      });
      timer = setTimeout(() => { void finishError(new CommandExecutionError("COMMAND_TIMEOUT", `Command timed out after ${this.options.timeoutMs}ms`)); }, this.options.timeoutMs);
    });
  }

  private async canonicalContainedCwd(cwd: string): Promise<string> {
    const [canonicalCwd, canonicalRoot] = await Promise.all([realpath(cwd), realpath(this.options.worktreePath)]);
    if (!isContained(canonicalCwd, canonicalRoot)) throw new Error("cwd must be contained by the mission worktree");
    return canonicalCwd;
  }
}

async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolveDone) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolveDone());
      killer.once("close", () => resolveDone());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}
