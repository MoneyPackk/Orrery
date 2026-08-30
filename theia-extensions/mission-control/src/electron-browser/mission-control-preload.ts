import { contextBridge, ipcRenderer } from "electron";
import { createMissionControlPreloadApi } from "./mission-control-preload-api";

let exposed = false;

export function preload(): void {
  if (exposed) return;
  contextBridge.exposeInMainWorld(
    "orreryMissionControl",
    createMissionControlPreloadApi((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  );
  exposed = true;
}
