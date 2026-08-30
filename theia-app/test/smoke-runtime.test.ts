import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { waitForTheiaReadiness } from "../scripts/smoke-runtime.mjs";

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
    child.stdout.emit("data", "booting\nORRERY_THEIA_READY\n");
    await expect(pending).resolves.toContain("ORRERY_THEIA_READY");
  });

  it("does not accept a readiness marker split by unrelated output", async () => {
    const child = fakeChild();
    const pending = waitForTheiaReadiness(child as never, 10);
    child.stdout.emit("data", "ORRERY_THEIA_");
    child.stderr.emit("data", "READY\n");
    await expect(pending).rejects.toThrow(/readiness/i);
  });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}
