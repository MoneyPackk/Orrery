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

export function waitForTheiaExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`Theia Electron exited after readiness with code ${child.exitCode}, signal ${child.signalCode ?? "none"}.`));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Theia Electron did not exit after readiness within ${timeoutMs}ms.`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Theia Electron exited after readiness with code ${code}, signal ${signal ?? "none"}.`));
    });
  });
}
