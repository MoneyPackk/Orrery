import { describe, expect, it } from "vitest";
import {
  createSmokeResult,
  isSmokeMode,
  isValidSmokeReadiness,
} from "./smoke";

describe("packaged desktop smoke contract", () => {
  it("enables smoke mode only for the exact opt-in value", () => {
    expect(isSmokeMode("1")).toBe(true);
    expect(isSmokeMode(undefined)).toBe(false);
    expect(isSmokeMode("")).toBe(false);
    expect(isSmokeMode("true")).toBe(false);
  });

  it("accepts only the exact readiness payload", () => {
    expect(isValidSmokeReadiness({
      desktopRuntimeExists: true,
      processType: "undefined",
      requireType: "undefined",
    })).toBe(true);
    expect(isValidSmokeReadiness({
      desktopRuntimeExists: true,
      processType: "object",
      requireType: "undefined",
    })).toBe(false);
    expect(isValidSmokeReadiness({
      desktopRuntimeExists: true,
      processType: "undefined",
      requireType: "undefined",
      unexpected: true,
    })).toBe(false);
    expect(isValidSmokeReadiness(null)).toBe(false);
  });

  it("passes only when the runtime exists and Node globals are absent", () => {
    expect(createSmokeResult({
      desktopRuntimeExists: true,
      processType: "undefined",
      requireType: "undefined",
    })).toEqual({
      passed: true,
      checks: {
        desktopRuntimeExists: true,
        rendererProcessUndefined: true,
        rendererRequireUndefined: true,
      },
    });

    expect(createSmokeResult({
      desktopRuntimeExists: false,
      processType: "undefined",
      requireType: "undefined",
    }).passed).toBe(false);
  });
});
