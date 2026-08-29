import { spawn } from "node:child_process";
import { readFile, rm, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const smokeRoot = join(repoRoot, ".tmp", "desktop-smoke");
const userDataPath = join(smokeRoot, "user-data");
const resultPath = join(smokeRoot, "result.json");
const executablePath = join(repoRoot, "release", "win-unpacked", "orrery-mission-control.exe");
const timeoutMs = 30_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateResult(value) {
  const expectedChecks = {
    desktopRuntimeExists: true,
    rendererProcessUndefined: true,
    rendererRequireUndefined: true,
  };
  if (typeof value !== "object" || value === null || value.passed !== true) return false;
  if (Object.keys(value).sort().join(",") !== "checks,passed") return false;
  if (typeof value.checks !== "object" || value.checks === null) return false;
  return Object.keys(value.checks).sort().join(",") === Object.keys(expectedChecks).sort().join(",") &&
    Object.entries(expectedChecks).every(([name, expected]) => value.checks[name] === expected);
}

async function waitForResult() {
  while (true) {
    try {
      await access(resultPath, constants.R_OK);
      return JSON.parse(await readFile(resultPath, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw error;
      await delay(50);
    }
  }
}

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(userDataPath, { recursive: true });

let child;
try {
  await access(executablePath, constants.X_OK);
  child = spawn(executablePath, [`--user-data-dir=${userDataPath}`], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ORRERY_SMOKE_TEST: "1",
      ORRERY_SMOKE_RESULT: resultPath,
    },
    stdio: "inherit",
    windowsHide: true,
  });

  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`Desktop smoke timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const result = await Promise.race([waitForResult(), exit.then(({ code, signal }) => {
      throw new Error(`Desktop exited before writing a result (code ${code}, signal ${signal ?? "none"})`);
    }), timeout]);
    const outcome = await Promise.race([exit, timeout]);
    if (outcome.code !== 0 || outcome.signal !== null) {
      throw new Error(`Desktop smoke exited with code ${outcome.code} and signal ${outcome.signal ?? "none"}`);
    }
    if (!validateResult(result)) {
      throw new Error(`Desktop smoke returned an invalid result: ${JSON.stringify(result)}`);
    }
    console.log("Packaged desktop smoke passed.");
  } finally {
    clearTimeout(timeoutHandle);
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
  await rm(smokeRoot, { recursive: true, force: true });
}
