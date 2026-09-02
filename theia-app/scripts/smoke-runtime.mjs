import { spawnSync } from "node:child_process";

export const THEIA_READY_MARKER = "ORRERY_THEIA_READY";

export function waitForTheiaReadiness(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = "";
    const streams = new Map([[child.stdout, ""], [child.stderr, ""]]);
    const timeout = setTimeout(() => finish(new Error(`Theia Electron readiness was not observed within ${timeoutMs}ms.\n${output}`)), timeoutMs);
    const onData = function (chunk) {
      output += chunk.toString();
      const streamOutput = `${streams.get(this) ?? ""}${chunk.toString()}`;
      streams.set(this, streamOutput);
      if (streamOutput.split(/\r?\n/).some(line => line.trim() === THEIA_READY_MARKER)) finish();
    };
    const onExit = (code, signal) => finish(new Error(`Theia Electron exited before readiness (code ${code}, signal ${signal ?? "none"}).\n${output}`));
    const finish = error => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error); else resolve(output);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

export function waitForTheiaExit(child, timeoutMs, dependencies = {}) {
  if (child.exitCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`Theia Electron exited after readiness with code ${child.exitCode}, signal ${child.signalCode ?? "none"}.`));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Theia Electron did not exit after readiness within ${timeoutMs}ms.`)), timeoutMs);
    const finish = (code, signal) => {
      clearTimeout(timeout);
      clearInterval(poll);
      if (code === 0) resolve();
      else reject(new Error(`Theia Electron exited after readiness with code ${code}, signal ${signal ?? "none"}.`));
    };
    const poll = setInterval(() => {
      if (child.exitCode !== null) finish(child.exitCode, child.signalCode);
      else if (child.pid && !(dependencies.isProcessAlive ?? isProcessAlive)(child.pid)) finish(1, "unobserved_process_death");
    }, 25);
    child.once("exit", finish);
    child.once("close", finish);
    if (child.exitCode !== null) finish(child.exitCode, child.signalCode);
  });
}

function isProcessAlive(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return result.status === 0 && result.stdout.includes(`"${pid}"`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
