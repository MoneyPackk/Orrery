import { contextBridge, ipcRenderer } from "electron";
import { createDesktopApi } from "./preload-api";

contextBridge.exposeInMainWorld(
  "orreryDesktop",
  createDesktopApi(
    (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    process.env.ORRERY_SMOKE_TEST === "1",
  ),
);
