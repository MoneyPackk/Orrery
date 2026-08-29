import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runAuthoritativeDaemonSmoke } from "./authoritative-daemon-smoke";

describe("authoritative daemon smoke", () => {
  it("drives durable authority, cancellation, restart, inspection, and exact promotion", async () => {
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
