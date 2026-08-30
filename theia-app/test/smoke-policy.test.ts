import { describe, expect, it } from "vitest";
import { classifyNativePreparationFailure } from "../scripts/smoke-policy.mjs";

describe("Theia smoke fallback classifier", () => {
  it.each([
    ["Cannot find module @theia/ffmpeg/lib/ffmpeg.node", "@theia/ffmpeg ffmpeg.node"],
    ["error building drivelist: node-gyp rebuild failed", "drivelist native build"],
  ])("recognizes documented native preparation failures", (output, reason) => {
    expect(classifyNativePreparationFailure(output)).toBe(reason);
  });

  it.each([
    "TypeScript error TS2322",
    "webpack compilation failed",
    "Generated electron-main entry is missing",
    "Electron exited with status 0 before readiness",
    "MODULE_NOT_FOUND: ordinary-package",
  ])("does not hide %s", output => {
    expect(classifyNativePreparationFailure(output)).toBeNull();
  });
});
