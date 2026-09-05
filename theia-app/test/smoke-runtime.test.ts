import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { waitForTheiaExit, waitForTheiaReadiness } from "../scripts/smoke-runtime.mjs";

describe("Theia smoke runtime readiness", () => {
  it("fails when no window readiness signal arrives", async () => {
    const child = fakeChild();
    await expect(waitForTheiaReadiness(child as never, 5)).rejects.toThrow(/readiness.*5ms/i);
  });

  it("fails when Electron exits before readiness", async () => {
    const child = fakeChild();
    const pending = waitForTheiaReadiness(child as never, 100);
    child.emit("exit", 1, null);
    await expect(pending).rejects.toThrow(/exited before readiness.*code 1/i);
  });

  it("succeeds only after the explicit host readiness marker", async () => {
    const child = fakeChild();
    const pending = waitForTheiaReadiness(child as never, 100);
    child.stdout.emit("data", "booting\nORRERY_THEIA_RENDERED\n");
    await expect(pending).resolves.toContain("ORRERY_THEIA_RENDERED");
  });

  it("does not accept a readiness marker split by unrelated output", async () => {
    const child = fakeChild();
    const pending = waitForTheiaReadiness(child as never, 10);
    child.stdout.emit("data", "ORRERY_THEIA_");
    child.stderr.emit("data", "READY\n");
    await expect(pending).rejects.toThrow(/readiness/i);
  });

  it("waits for a normal zero-exit after readiness", async () => {
    const child = fakeChild();
    const pending = waitForTheiaExit(child as never, 100);
    child.emit("exit", 0, null);
    await expect(pending).resolves.toBeUndefined();
  });

  it("recognizes a normal exit that occurred before the exit waiter attached", async () => {
    const child = fakeChild() as ReturnType<typeof fakeChild> & { exitCode: number; signalCode: null };
    child.exitCode = 0;
    child.signalCode = null;
    await expect(waitForTheiaExit(child as never, 100)).resolves.toBeUndefined();
  });

  it("fails closed when process death occurs before an exit code is observed", async () => {
    const child = fakeChild() as ReturnType<typeof fakeChild> & { pid: number };
    child.pid = 2_147_483_647;
    await expect(waitForTheiaExit(child as never, 100, { isProcessAlive: () => false })).rejects.toThrow(/unobserved_process_death/);
  });

  it("does not misreport a clean exit delivered just after the PID leaves the process table", async () => {
    const child = fakeChild() as ReturnType<typeof fakeChild> & { pid: number };
    child.pid = 2_147_483_646;
    const pending = waitForTheiaExit(child as never, 400, { isProcessAlive: () => false });
    await new Promise(resolve => setTimeout(resolve, 60));
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await expect(pending).resolves.toBeUndefined();
  });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; signalCode: string | null };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}
