import { contextBridge, ipcRenderer } from "electron";
import { createMissionControlPreloadApi } from "./mission-control-preload-api";

let exposed = false;
const HOST_READY_CHANNEL = "mission:v1:host-ready";

export function preload(): void {
  if (exposed) return;
  contextBridge.exposeInMainWorld(
    "orreryMissionControl",
    createMissionControlPreloadApi((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  );
  void ipcRenderer.invoke(HOST_READY_CHANNEL).catch(() => undefined);
  exposed = true;
}
