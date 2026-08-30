import { contextBridge, ipcRenderer } from "electron";
import { createDesktopApi } from "./preload-api";

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld(
  "orreryDesktop",
  createDesktopApi(invoke, process.env.ORRERY_SMOKE_TEST === "1"),
);
