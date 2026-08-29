import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SmokeReadiness, SmokeResult } from "./contract";
import { DESKTOP_SMOKE_READY_CHANNEL } from "./channels";
import { isTrustedIpcSender } from "./policy";

export function isSmokeMode(value: string | undefined): boolean {
  return value === "1";
}

export function isValidSmokeReadiness(value: unknown): value is SmokeReadiness {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 &&
    typeof record.desktopRuntimeExists === "boolean" &&
    record.processType === "undefined" &&
    record.requireType === "undefined";
}

export function createSmokeResult(readiness: SmokeReadiness): SmokeResult {
  const checks = {
    desktopRuntimeExists: readiness.desktopRuntimeExists,
    rendererProcessUndefined: readiness.processType === "undefined",
    rendererRequireUndefined: readiness.requireType === "undefined",
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
  };
}

export function registerDesktopSmokeIpc(
  ipcMain: IpcMain,
  getRendererUrl: () => string,
  resultPath: string,
  finish: (exitCode: number) => void,
): void {
  ipcMain.removeHandler(DESKTOP_SMOKE_READY_CHANNEL);
  ipcMain.handle(DESKTOP_SMOKE_READY_CHANNEL, async (event: IpcMainInvokeEvent, payload: unknown) => {
    if (!isTrustedIpcSender(event.senderFrame, event.sender.mainFrame, getRendererUrl())) {
      throw new Error("Rejected untrusted desktop smoke IPC request");
    }
    if (!isValidSmokeReadiness(payload)) {
      throw new Error("Rejected invalid desktop smoke readiness payload");
    }

    const result = createSmokeResult(payload);
    await mkdir(dirname(resultPath), { recursive: true });
    const temporaryResultPath = `${resultPath}.tmp`;
    await writeFile(temporaryResultPath, `${JSON.stringify(result)}\n`, "utf8");
    await rename(temporaryResultPath, resultPath);
    finish(result.passed ? 0 : 1);
  });
}
