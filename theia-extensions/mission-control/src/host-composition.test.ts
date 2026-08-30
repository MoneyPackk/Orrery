import { describe, expect, it } from "vitest";
import { ApplicationPackage } from "@theia/application-package";
import { ExtensionPackage } from "@theia/application-package/lib/extension-package";
import { NpmRegistry } from "@theia/application-package/lib/npm-registry";
import { createRequire } from "node:module";
import manifest from "../package.json";

describe("Theia 1.75 host composition", () => {
  it("discovers frontend, Electron preload, and Electron main modules from extension metadata", () => {
    const application = new ApplicationPackage({ projectPath: process.cwd(), appTarget: "electron" });
    Object.defineProperty(application, "extensionPackages", {
      value: [new ExtensionPackage(manifest as never, new NpmRegistry())],
    });

    expect([...application.frontendModules.values()]).toEqual([
      "@orrery/mission-control-theia/lib/browser/mission-control-frontend-module",
    ]);
    expect([...application.preloadModules.values()]).toEqual([
      "@orrery/mission-control-theia/lib/electron-browser/mission-control-preload",
    ]);
    expect([...application.electronMainModules.values()]).toEqual([
      "@orrery/mission-control-theia/lib/electron-main/mission-control-electron-main-module",
    ]);
    const require = createRequire(import.meta.url);
    for (const module of [application.frontendModules, application.preloadModules, application.electronMainModules]) {
      expect(() => require.resolve([...module.values()][0])).not.toThrow();
    }
  });
});
