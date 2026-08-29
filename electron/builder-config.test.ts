import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const config = require("../electron-builder.config.cjs") as Record<string, unknown>;

describe("electron-builder configuration", () => {
  it("packages the secure desktop outputs with the Orrery identity", () => {
    expect(config).toMatchObject({
      appId: "com.orrery.mission-control",
      productName: "Orrery Mission Control",
      asar: true,
      directories: { output: "release" },
      files: ["dist/**/*", "dist-electron/**/*", "package.json"],
      win: { target: ["nsis", "portable", "zip"], signAndEditExecutable: false },
      mac: { target: ["dmg", "zip"], identity: null },
      linux: { target: ["AppImage", "deb"] },
    });
  });

  it("does not configure publishing or updates and disables signing", () => {
    expect(config).not.toHaveProperty("publish");
    expect(config).not.toHaveProperty("afterSign");
    expect(config).not.toHaveProperty("afterAllArtifactBuild");
    expect(config).not.toHaveProperty("electronUpdaterCompatibility");
    expect(config).toMatchObject({ forceCodeSigning: false });
  });
});
