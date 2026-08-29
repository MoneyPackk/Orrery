import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { DesktopRuntime } from "./contract";
import { isTrustedIpcSender } from "./policy";
import { DESKTOP_GET_RUNTIME_CHANNEL } from "./channels";

export { DESKTOP_GET_RUNTIME_CHANNEL } from "./channels";

export function isValidRuntimeRequest(args: unknown[]): boolean {
  return args.length === 0;
}

function assertTrustedRequest(event: IpcMainInvokeEvent, rendererUrl: string, args: unknown[]): void {
  if (!isValidRuntimeRequest(args) || !isTrustedIpcSender(event.senderFrame, event.sender.mainFrame, rendererUrl)) {
    throw new Error("Rejected untrusted desktop IPC request");
  }
}

export function registerDesktopIpc(ipcMain: IpcMain, getRendererUrl: () => string): void {
  ipcMain.removeHandler(DESKTOP_GET_RUNTIME_CHANNEL);
  ipcMain.handle(DESKTOP_GET_RUNTIME_CHANNEL, (event, ...args): DesktopRuntime => {
    assertTrustedRequest(event, getRendererUrl(), args);
    return {
      platform: process.platform,
      versions: {
        chrome: process.versions.chrome,
        electron: process.versions.electron,
      },
    };
  });
}
