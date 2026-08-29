import { describe, expect, it, vi } from "vitest";
import { getDesktopRuntime, reportDesktopSmokeReadiness } from "./desktop";

describe("optional desktop runtime", () => {
  it("returns null in the standalone browser", async () => {
    await expect(getDesktopRuntime(undefined)).resolves.toBeNull();
  });

  it("uses the narrow desktop API when it is present", async () => {
    const runtime = {
      platform: "linux",
      versions: { chrome: "128.0.0", electron: "44.0.0" },
    };
    const getRuntime = vi.fn().mockResolvedValue(runtime);

    await expect(getDesktopRuntime({ getRuntime, missions: {} as never })).resolves.toEqual(runtime);
    expect(getRuntime).toHaveBeenCalledOnce();
  });

  it("reports renderer isolation after confirming the desktop runtime", async () => {
    const runtime = {
      platform: "win32",
      versions: { chrome: "128.0.0", electron: "44.0.0" },
    };
    const reportSmokeReadiness = vi.fn().mockResolvedValue(undefined);

    await reportDesktopSmokeReadiness({
      getRuntime: vi.fn().mockResolvedValue(runtime),
      reportSmokeReadiness,
      missions: {} as never,
    }, {});

    expect(reportSmokeReadiness).toHaveBeenCalledWith({
      desktopRuntimeExists: true,
      processType: "undefined",
      requireType: "undefined",
    });
  });

  it("does nothing when the smoke-only bridge is absent", async () => {
    const getRuntime = vi.fn();

    await reportDesktopSmokeReadiness({ getRuntime, missions: {} as never });

    expect(getRuntime).not.toHaveBeenCalled();
  });
});
