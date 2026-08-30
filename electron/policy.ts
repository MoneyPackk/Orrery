import type { App, BrowserWindowConstructorOptions, Session, WebContents, WebFrameMain } from "electron";
import { dirname, join } from "node:path";

export type RendererSource =
  | { kind: "url"; value: string }
  | { kind: "file"; value: string };

export function createWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      webSecurity: true,
    },
  };
}

export function isAllowedDevServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

export function resolveRendererSource(
  isPackaged: boolean,
  developmentUrl: string | undefined,
  appPath: string,
): RendererSource {
  if (isPackaged) {
    return { kind: "file", value: join(appPath, "dist", "index.html") };
  }

  if (!developmentUrl || !isAllowedDevServerUrl(developmentUrl)) {
    throw new Error("Electron development server must use a loopback HTTP URL");
  }

  return { kind: "url", value: new URL(developmentUrl).href };
}

export function resolvePreloadPath(mainEntryPath: string): string {
  return join(dirname(mainEntryPath), "preload.cjs");
}

export function resolveDaemonEntryPath(mainEntryPath: string): string {
  return join(dirname(mainEntryPath), "resources", "mission-control-daemon.cjs");
}

export function installGracefulShutdown(target: Pick<App, "on" | "quit">, cleanup: () => Promise<void>): void {
  let quitAfterCleanup = false;
  let pending: Promise<void> | undefined;
  target.on("before-quit", event => {
    if (quitAfterCleanup) return;
    event.preventDefault();
    pending ??= cleanup().then(() => {
      quitAfterCleanup = true;
      target.quit();
    }, error => {
      console.error(error);
      pending = undefined;
    });
  });
}

export function isAllowedNavigation(destination: string, rendererUrl: string): boolean {
  return destination === rendererUrl;
}

export function popupPolicy(): { action: "deny" } {
  return { action: "deny" };
}

export function installNavigationPolicy(
  webContents: Pick<WebContents, "on" | "setWindowOpenHandler">,
  getRendererUrl: () => string,
): void {
  webContents.setWindowOpenHandler(popupPolicy);
  const preventUntrustedNavigation = (event: { preventDefault(): void }, destination: string): void => {
    if (!isAllowedNavigation(destination, getRendererUrl())) event.preventDefault();
  };
  webContents.on("will-navigate", preventUntrustedNavigation);
  webContents.on("will-redirect", preventUntrustedNavigation);
}

export function installDefaultDenyPermissions(target: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler">): void {
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
}

export function isTrustedIpcSender(
  senderFrame: Pick<WebFrameMain, "url"> | null,
  mainFrame: Pick<WebFrameMain, "url">,
  rendererUrl: string,
): boolean {
  return senderFrame === mainFrame && senderFrame.url === rendererUrl;
}
