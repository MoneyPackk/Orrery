import { app, BrowserWindow, ipcMain, session } from "electron";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { registerDesktopIpc } from "./ipc";
import {
  createWindowOptions,
  installDefaultDenyPermissions,
  installNavigationPolicy,
  resolvePreloadPath,
  resolveRendererSource,
} from "./policy";
import { isSmokeMode, registerDesktopSmokeIpc } from "./smoke";
import { registerMissionIpc } from "./mission-ipc";
import { MissionControlDaemonClient } from "./mission-control-daemon-client";

let mainWindow: BrowserWindow | null = null;
let rendererUrl = "";
const missionClient = new MissionControlDaemonClient();

async function createMainWindow(): Promise<void> {
  const mainEntryPath = fileURLToPath(import.meta.url);
  const window = new BrowserWindow(createWindowOptions(resolvePreloadPath(mainEntryPath)));
  mainWindow = window;

  window.once("closed", () => {
    mainWindow = null;
  });
  window.once("ready-to-show", () => window.show());
  installNavigationPolicy(window.webContents, () => rendererUrl);

  const source = resolveRendererSource(app.isPackaged, process.env.ORRERY_DEV_SERVER_URL, app.getAppPath());
  if (source.kind === "url") {
    rendererUrl = source.value;
    await window.loadURL(source.value);
  } else {
    rendererUrl = pathToFileURL(source.value).href;
    await window.loadFile(source.value);
  }
}

app.whenReady().then(async () => {
  installDefaultDenyPermissions(session.defaultSession);
  registerDesktopIpc(ipcMain, () => rendererUrl);
  registerMissionIpc(ipcMain, () => rendererUrl, missionClient);
  if (isSmokeMode(process.env.ORRERY_SMOKE_TEST)) {
    const resultPath = process.env.ORRERY_SMOKE_RESULT;
    if (!resultPath) throw new Error("ORRERY_SMOKE_RESULT is required in smoke mode");
    const timeout = setTimeout(() => app.exit(1), 15_000);
    registerDesktopSmokeIpc(ipcMain, () => rendererUrl, resultPath, (exitCode) => {
      clearTimeout(timeout);
      app.exit(exitCode);
    });
  }
  await createMainWindow();

  app.on("activate", () => {
    if (mainWindow === null) void createMainWindow();
  });
}).catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => { void missionClient.disconnect(); });
