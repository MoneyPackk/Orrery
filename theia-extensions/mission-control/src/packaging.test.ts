import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = process.cwd().endsWith("mission-control") ? process.cwd() : resolve(process.cwd(), "theia-extensions/mission-control");
const temporaryRoots: string[] = [];
const npmCli = process.env.npm_execpath;

function npm(args: ReadonlyArray<string>, cwd: string): void {
  if (!npmCli) throw new Error("npm_execpath is required for the packaging test.");
  execFileSync(process.execPath, [npmCli, ...args], { cwd, stdio: "pipe" });
}

describe("published extension package", () => {
  afterAll(() => temporaryRoots.forEach((path) => rmSync(path, { recursive: true, force: true })));

  it("installs from its tarball in an unrelated consumer without repository paths", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "orrery-theia-pack-"));
    temporaryRoots.push(temporaryRoot);
    const packageCopy = join(temporaryRoot, "package");
    mkdirSync(packageCopy);
    for (const path of ["package.json", "package-lock.json", "tsconfig.json"]) cpSync(join(root, path), join(packageCopy, path));
    cpSync(join(root, "src"), join(packageCopy, "src"), { recursive: true });
    expect(existsSync(join(packageCopy, "lib"))).toBe(false);
    expect(existsSync(join(packageCopy, "node_modules"))).toBe(false);
    npm(["ci", "--ignore-scripts"], packageCopy);
    npm(["pack", "--silent"], packageCopy);
    const tarball = join(packageCopy, "orrery-mission-control-theia-0.0.0.tgz");
    const consumer = join(temporaryRoot, "consumer");
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, dependencies: { "@orrery/mission-control-theia": `file:${tarball.replaceAll("\\", "/")}` } }));
    npm(["install", "--ignore-scripts", "--package-lock=false"], consumer);
    const installedRoot = join(consumer, "node_modules/@orrery/mission-control-theia");
    const installed = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
    expect(installed.dependencies).toEqual({ "@theia/core": "1.75.0", "@theia/electron": "1.75.0" });
    expect(JSON.stringify(installed)).not.toContain("file:../../");
    expect(readdirSync(installedRoot).sort()).toEqual(["lib", "package.json"]);
    expect(readFileSync(join(installedRoot, "lib/common/mission-control-contracts.d.ts"), "utf8")).not.toContain("@orrery/");
    expect(readFileSync(join(installedRoot, "lib/electron-browser/mission-control-preload.d.ts"), "utf8")).toContain("export declare function preload(): void");
    const metadata = installed.theiaExtensions[0] as Record<"frontend" | "preload" | "electronMain", string>;
    const metadataPaths = Object.values(metadata);
    const resolutionScript = [
      `const Module = require("node:module")`,
      `const originalLoad = Module._load`,
      `let exposureCount = 0`,
      `let exposedApi`,
      `Module._load = function (request) { if (request === "electron") return { contextBridge: { exposeInMainWorld: (name, api) => { if (name !== "orreryMissionControl") throw new Error("Unexpected preload key: " + name); exposureCount += 1; exposedApi = api; } }, ipcRenderer: { invoke: async () => undefined } }; return originalLoad.apply(this, arguments); }`,
      `require(${JSON.stringify("@orrery/mission-control-theia")})`,
      ...metadataPaths.map((path) => `require.resolve(${JSON.stringify(`@orrery/mission-control-theia/${path}`)})`),
      `require(${JSON.stringify(`@orrery/mission-control-theia/${metadata.electronMain}`)})`,
      `const preload = require(${JSON.stringify(`@orrery/mission-control-theia/${metadata.preload}`)})`,
      `if (exposureCount !== 0) throw new Error("Installed preload exposed during import")`,
      `if (typeof preload.preload !== "function") throw new Error("Installed preload does not export preload()")`,
      `preload.preload()`,
      `preload.preload()`,
      `if (exposureCount !== 1) throw new Error("Installed preload did not expose exactly once")`,
      `if (Object.keys(exposedApi).join(",") !== "intakeRepository,create,run,cancel,list,getSnapshot,inspect,reviewAndPromote,getIntelligenceSettings,setIntelligenceSettings,listIntelligenceMessages,sendIntelligenceMessage,clearIntelligenceThread,listMcpCatalog,registerMcpServer,removeMcpServer,setMcpToolDecision,invokeMcpTool,listMcpActivity") throw new Error("Installed preload exposed an unexpected API")`,
    ].join(";");
    execFileSync(process.execPath, ["-e", resolutionScript], { cwd: consumer, stdio: "pipe" });
  }, 120_000);
});
