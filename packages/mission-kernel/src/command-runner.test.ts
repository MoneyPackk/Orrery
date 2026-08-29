import { describe, expect, it } from "vitest";
import { AllowlistedCommandRunner, CommandExecutionError } from "./command-runner";

const cwd = process.cwd();
const node = process.execPath;

function runner(options: Partial<ConstructorParameters<typeof AllowlistedCommandRunner>[0]> = {}) {
  return new AllowlistedCommandRunner({
    worktreePath: cwd,
    allowlist: [{ executable: node, args: ["--version"] }, { executable: node, args: ["-e", "process.stdout.write('x'.repeat(100))"] }, { executable: node, args: ["-e", "process.stderr.write('failure'); process.exit(3)"] }, { executable: node, args: ["-e", "setTimeout(() => {}, 1000)"] }],
    ...options,
  });
}

describe("AllowlistedCommandRunner", () => {
  it("runs an exact allowlisted tuple without a shell and records execution metadata", async () => {
    const result = await runner().run({ executable: node, args: ["--version"], cwd });

    expect(result.executable).toBe(node);
    expect(result.args).toEqual(["--version"]);
    expect(result.cwd).toBe(cwd);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toMatch(/^v\d/);
    expect(result.startedAt).toMatch(/Z$/);
    expect(result.completedAt).toMatch(/Z$/);
    expect(result.truncated).toBe(false);
  });

  it("returns nonzero exits and stderr as command results", async () => {
    const result = await runner().run({ executable: node, args: ["-e", "process.stderr.write('failure'); process.exit(3)"], cwd });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("failure");
  });

  it("bounds output and reports truncation", async () => {
    const limited = runner({ maxOutputBytes: 10 });
    const result = await limited.run({ executable: node, args: ["-e", "process.stdout.write('x'.repeat(100))"], cwd });

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(10);
    expect(result.truncated).toBe(true);
  });

  it("rejects commands that are not allowlisted", async () => {
    await expect(runner().run({ executable: node, args: ["-p", "1"], cwd })).rejects.toThrow(
      "Command is not allowlisted",
    );
  });

  it("rejects a cwd outside the mission worktree", async () => {
    await expect(runner().run({ executable: node, args: ["--version"], cwd: `${cwd}/..` })).rejects.toThrow(
      "cwd must be contained by the mission worktree",
    );
  });

  it("terminates commands at the configured timeout", async () => {
    const timed = runner({ timeoutMs: 20 });

    await expect(timed.run({ executable: node, args: ["-e", "setTimeout(() => {}, 1000)"], cwd })).rejects.toMatchObject({
      code: "COMMAND_TIMEOUT",
    });
  });

  it("terminates commands when cancellation is requested", async () => {
    const controller = new AbortController();
    const promise = runner({ signal: controller.signal }).run({ executable: node, args: ["-e", "setTimeout(() => {}, 1000)"], cwd });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: "COMMAND_CANCELLED" });
  });

  it("terminates a live command with the per-command signal", async () => {
    const controller = new AbortController();
    const promise = runner().run({ executable: node, args: ["-e", "setTimeout(() => {}, 1000)"], cwd, signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: "COMMAND_CANCELLED" });
  });

  it("terminates descendants when a command is cancelled", async () => {
    const marker = `${cwd}/.orrery-descendant-${process.pid}-${Date.now()}.txt`;
    const script = `const fs=require('node:fs'); const child=require('node:child_process').spawn(process.execPath,['-e',\"setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'escaped'),500)\"],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(marker + '.pid')},String(child.pid)); setTimeout(()=>{},1000);`;
    const controller = new AbortController();
    const commandRunner = runner({
      signal: controller.signal,
      allowlist: [{ executable: node, args: ["-e", script] }],
    });
    const promise = commandRunner.run({ executable: node, args: ["-e", script], cwd });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "COMMAND_CANCELLED" });
    await new Promise((resolve) => setTimeout(resolve, 650));
    const { access, rm } = await import("node:fs/promises");
    await expect(access(marker)).rejects.toThrow();
    await rm(marker + ".pid", { force: true });
  });

  it("rejects invalid runner configuration", () => {
    expect(() => new AllowlistedCommandRunner({ worktreePath: cwd, allowlist: [], maxOutputBytes: 0 })).toThrow();
    expect(() => new CommandExecutionError("COMMAND_TIMEOUT", "timed out")).not.toThrow();
  });
});
