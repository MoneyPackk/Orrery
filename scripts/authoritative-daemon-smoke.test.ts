import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runAuthoritativeDaemonSmoke } from "./authoritative-daemon-smoke";

// This suite drives a real daemon through bootstrap, cancellation, restart, and promotion. Its
// wall-clock cost exceeds vitest's 60s test default under full-suite load even though each phase
// is individually budgeted below it, so the suite carries its own budget.
describe("authoritative daemon smoke", { timeout: 300_000 }, () => {
  // The per-`it` timeout is what vitest enforces; a `describe`-level budget is overridden by the
  // runner's default for an `it` that does not carry its own, which is how this test still died
  // at 60s under load despite the suite-level budget above.
  it("drives durable authority, cancellation, restart, inspection, and exact promotion", { timeout: 300_000 }, async () => {
    const result = await runAuthoritativeDaemonSmoke();

    expect(result.approval).toMatchObject({
      canonical: true,
      fingerprintMatched: true,
      persistedAfterRestart: true,
    });
    expect(result.target).toMatchObject({
      unchangedBeforePromotion: true,
      advancedByPromotion: true,
      reviewedFiles: ["orrery-mission.txt"],
      promotedFiles: ["orrery-mission.txt"],
    });
    expect(result.replay.sequences).toEqual(
      Array.from({ length: result.replay.sequences.length }, (_, index) => index + 1),
    );
    expect(result.replay.kinds).toEqual([
      "workspace",
      "change",
      "verification",
      "execution",
      "verification",
      "completion",
    ]);
    expect(result.replay.afterReconnect).toBe(true);
    expect(result.replay.afterRestart).toBe(true);
    expect(result.cancellation).toMatchObject({
      status: "cancelled",
      processAborted: true,
      durableAfterRestart: true,
    });
    expect(result.inspection).toMatchObject({
      status: "ready_for_review",
      reviewedFiles: ["orrery-mission.txt"],
    });
    await expect(access(result.repositoryPath)).rejects.toThrow();
    await expect(access(result.runtimePath)).rejects.toThrow();
  }, 60_000);
});
