import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyNativePreparationFailure } from "./smoke-policy.mjs";
import { waitForTheiaReadiness } from "./smoke-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required for the Theia smoke.");
const npmArgs = args => [npmCli, ...args];
const full = spawnSync(process.execPath, npmArgs(["run", "build:full"]), { cwd: root, encoding: "utf8" });
if (full.status === 0) {
  const launch = spawn(process.execPath, npmArgs(["start", "--", "--electronUserData=.tmp/theia-smoke"]), {
    cwd: root,
    env: { ...process.env, ORRERY_THEIA_SMOKE: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForTheiaReadiness(launch, 15_000);
    launch.kill();
    console.log("Theia smoke passed: full build completed and the trusted renderer confirmed host readiness.");
    process.exit(0);
  } catch (error) {
    launch.kill();
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
