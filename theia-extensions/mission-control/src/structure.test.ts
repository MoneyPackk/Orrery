import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd().endsWith("mission-control") ? process.cwd() : resolve(process.cwd(), "theia-extensions/mission-control");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("mission control Theia extension structure", () => {
  it("pins every consumed Theia package to 1.75.0 and exposes frontend, preload, and Electron main modules", () => {
    const manifest = JSON.parse(read("package.json"));
    const theiaVersions = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).filter(([name]) => name.startsWith("@theia/"));
    expect(theiaVersions.length).toBeGreaterThan(0);
    expect(theiaVersions.every(([, version]) => version === "1.75.0")).toBe(true);
    expect(manifest.theiaExtensions).toEqual([{
      frontend: "lib/browser/mission-control-frontend-module",
      preload: "lib/electron-browser/mission-control-preload",
      electronMain: "lib/electron-main/mission-control-electron-main-module",
    }]);
    expect(manifest.files).toContain("lib/electron-browser");
    expect(manifest.files).toContain("lib/electron-main");
    expect(Object.values(manifest.dependencies)).not.toContainEqual(expect.stringMatching(/^file:/));
    expect(manifest.dependencies).toEqual({ "@theia/core": "1.75.0", "@theia/electron": "1.75.0" });
  });

  it("keeps browser code outside privileged daemon, kernel, filesystem, process, and Git packages", () => {
    const sources = ["mission-control-desktop-adapter.ts", "mission-control-view.tsx", "mission-control-widget.tsx", "mission-control-widget-factory.ts", "mission-control-contribution.ts", "mission-control-frontend-module.ts",
      "orrery-intelligence-adapter.ts", "orrery-intelligence-view.tsx", "orrery-intelligence-widget.tsx", "orrery-intelligence-contribution.ts", "orrery-intelligence-style.ts"]
      .map((file) => read(`src/browser/${file}`)).join("\n");
    expect(sources).not.toMatch(/mission-control-daemon|mission-kernel|node:fs|node:process|child_process|isomorphic-git|simple-git|from ["'](?:fs|process)["']/);
    expect(sources).not.toMatch(/electron/);
  });

  it("never reads, stores, or transports provider credentials in renderer code", () => {
    const sources = ["orrery-intelligence-adapter.ts", "orrery-intelligence-view.tsx", "orrery-intelligence-widget.tsx"].map(file => read(`src/browser/${file}`)).join("\n");
    expect(sources).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(sources).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/);
    expect(sources).not.toMatch(/Bearer\s+\$|["']x-api-key["']|authorization\s*:/i);
    expect(sources).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    expect(read("src/browser/orrery-intelligence-view.tsx")).toMatch(/type="password"/);
  });

  it("mounts Orrery Intelligence in the right shell with its own command and durable transcript", () => {
    expect(read("src/common/mission-control-commands.ts")).toContain("orrery.intelligence.open");
    expect(read("src/browser/orrery-intelligence-contribution.ts")).toMatch(/area:\s*["']right["']/);
    expect(read("src/browser/orrery-intelligence-widget.tsx")).toContain("extends ReactWidget");
    expect(read("src/browser/orrery-intelligence-adapter.ts")).toContain("window.orreryMissionControl");
  });

  it("defines stable typed command IDs and a ReactWidget contribution in the left shell", () => {
    expect(read("src/common/mission-control-commands.ts")).toContain("orrery.missionControl.open");
    expect(read("src/browser/mission-control-widget.tsx")).toContain("extends ReactWidget");
    expect(read("src/browser/mission-control-contribution.ts")).toMatch(/area:\s*["']left["']/);
  });

  it("uses Theia shared React and reads only the narrowed host capability", () => {
    const sources = read("src/browser/mission-control-view.tsx") + read("src/browser/mission-control-widget.tsx") + read("src/browser/mission-control-desktop-adapter.ts");
    expect(sources).toContain("@theia/core/shared/react");
    expect(sources).not.toMatch(/from ["']react["']/);
    expect(sources).toContain("window.orreryMissionControl");
    expect(sources).not.toContain("window.orreryDesktop");
  });

  it("builds a packaged preload from extension-local narrow runtime code", () => {
    expect(existsSync(resolve(root, "lib/electron-browser/mission-control-preload.js"))).toBe(true);
    const preload = read("src/electron-browser/mission-control-preload.ts");
    const api = read("src/electron-browser/mission-control-preload-api.ts");
    expect(preload).toMatch(/from ["']electron["']/);
    expect(preload).toContain("./mission-control-preload-api");
    expect(preload + api).not.toMatch(/electron\/preload-api|\.\.\/\.\.\/\.\.\/electron|orreryDesktop|approveRepository|approvalNonce|approvalCapability|\binvoke\s*:/i);
    expect(api).toContain("reviewAndPromote");
    expect(api).toContain("getSnapshot");
    expect(api).toContain("list");
  });

  it("builds a host-injected Electron main contribution without root runtime imports", () => {
    expect(existsSync(resolve(root, "lib/electron-main/mission-control-electron-main-module.js"))).toBe(true);
    const sources = read("src/electron-main/mission-control-electron-main-contribution.ts")
      + read("src/electron-main/mission-control-electron-main-module.ts")
      + read("src/common/mission-control-contracts.ts");
    expect(sources).toContain("MissionControlHostService");
    expect(sources).not.toMatch(/\.\.\/\.\.\/\.\.\/|mission-control-daemon|mission-kernel|node:fs|node:process|child_process|simple-git|isomorphic-git/);
    expect(read("README.md")).toContain("It is an extension package, not a standalone application or distribution.");
  });
});
