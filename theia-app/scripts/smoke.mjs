import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { classifyNativePreparationFailure } from "./smoke-policy.mjs";
import { describeStaleInstall, findStaleInstalledFiles, resolveExtensionPaths } from "./smoke-freshness.mjs";
import { waitForTheiaExit, waitForTheiaReadiness } from "./smoke-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required for the Theia smoke.");
const npmArgs = args => [npmCli, ...args];

// `build:full` bundles the installed copy of the extension, not its source. Refuse to run
// against a stale copy: a passing smoke would otherwise say nothing about the current code.
const extensionPaths = resolveExtensionPaths(root);
const stale = findStaleInstalledFiles(extensionPaths.built, extensionPaths.installed);
if (stale.length > 0) {
  process.stderr.write(`${describeStaleInstall(stale)}\n`);
  process.exit(1);
}

const full = spawnSync(process.execPath, npmArgs(["run", "build:full"]), { cwd: root, encoding: "utf8" });
if (full.status === 0) {
  const smokeRoot = resolve(tmpdir(), "orrery-theia-smoke-");
  mkdirSync(smokeRoot, { recursive: true });
  const userData = mkdtempSync(smokeRoot);
  const localAppData = resolve(process.env.LOCALAPPDATA ?? tmpdir(), `OrrerySmoke-${randomUUID()}`);
  mkdirSync(localAppData, { recursive: true });
  const electronExecutable = resolve(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "Electron");
  const launch = spawn(electronExecutable, [root, `--electronUserData=${userData}`], {
    cwd: root,
    detached: process.platform !== "win32",
    env: { ...process.env, LOCALAPPDATA: localAppData, ORRERY_THEIA_SMOKE: "1", ORRERY_THEIA_SMOKE_USER_DATA: userData },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    // Readiness now means "every view rendered", which requires the whole Theia frontend to
    // start and three widgets to mount, not just the preload script. That is a genuinely longer
    // wait than the old preload-time signal, so the budget reflects real frontend startup.
    await waitForTheiaReadiness(launch, 120_000);
    await waitForTheiaExit(launch, 30_000);
    terminateProcessTree(launch.pid);
    removeSmokeUserData(userData);
    removeSmokeUserData(localAppData);
    console.log("Theia smoke passed: full build completed and every Mission Control view rendered in the real renderer.");
    process.exit(0);
  } catch (error) {
    terminateProcessTree(launch.pid);
    removeSmokeUserData(userData);
    removeSmokeUserData(localAppData);
    throw error;
  }
} else {
  const output = `${full.stderr}\n${full.stdout}`;
  const nativeReason = classifyNativePreparationFailure(output);
  if (!nativeReason) {
    process.stderr.write(output);
    process.exit(full.status ?? 1);
  }
  console.warn(`Theia smoke fallback: real build/launch is unavailable under Node ${process.versions.node} on ${process.platform} (${nativeReason}).`);
  console.warn("Falling back to generated application metadata and DI validation.");
}

function removeSmokeUserData(path) {
  // Chromium can release profile WAL handles just after Electron emits exit.
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    // Windows may release Chromium profile handles asynchronously after taskkill.
    spawnSync("cmd.exe", ["/c", "rmdir", "/s", "/q", path], { stdio: "ignore" });
  }
}

function terminateProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The process group exited after SIGTERM.
    }
  }
}

const fallback = spawnSync(process.execPath, npmArgs(["run", "build"]), { cwd: root, stdio: "inherit" });
if (fallback.status !== 0) process.exit(fallback.status ?? 1);
const test = spawnSync(process.execPath, npmArgs(["test"]), { cwd: root, stdio: "inherit" });
if (test.status !== 0) process.exit(test.status ?? 1);

const main = readFileSync(resolve(root, "src-gen/backend/electron-main.js"), "utf8");
const preload = readFileSync(resolve(root, "src-gen/frontend/preload.js"), "utf8");
if (!main.includes("@orrery/theia-host") || !main.includes("@orrery/mission-control-theia") || !preload.includes("@orrery/mission-control-theia")) {
  throw new Error("Generated Theia host wiring is incomplete.");
}
console.log("Theia smoke fallback passed: host generation, DI tests, renderer identity tests, and preload/main wiring checks passed.");
