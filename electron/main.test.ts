import { describe, expect, it, vi } from "vitest";
import {
  createWindowOptions,
  installDefaultDenyPermissions,
  installNavigationPolicy,
  isAllowedDevServerUrl,
  isAllowedNavigation,
  popupPolicy,
  isTrustedIpcSender,
  resolvePreloadPath,
  resolveRendererSource,
} from "./policy";

describe("Electron main security policy", () => {
  it("creates a hidden window with explicit secure web preferences", () => {
    expect(createWindowOptions("C:\\app\\preload.js")).toMatchObject({
      show: false,
      webPreferences: {
        preload: "C:\\app\\preload.js",
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        webSecurity: true,
      },
    });
  });

  it.each([
    "http://localhost:5173",
    "http://127.0.0.1:5173/",
    "http://[::1]:5173/app",
  ])("accepts loopback HTTP development URL %s", (url) => {
    expect(isAllowedDevServerUrl(url)).toBe(true);
  });

  it.each([
    "https://localhost:5173",
    "http://example.com:5173",
    "http://127.0.0.2:5173",
    "file:///tmp/index.html",
    "not a URL",
  ])("rejects non-loopback development URL %s", (url) => {
    expect(isAllowedDevServerUrl(url)).toBe(false);
  });

  it("uses a validated loopback URL only for an unpackaged application", () => {
    expect(resolveRendererSource(false, "http://127.0.0.1:5173", "C:\\app")).toEqual({
      kind: "url",
      value: "http://127.0.0.1:5173/",
    });
    expect(() => resolveRendererSource(false, "https://localhost:5173", "C:\\app"))
      .toThrow("Electron development server must use a loopback HTTP URL");
  });

  it("always uses the renderer under app.getAppPath when packaged", () => {
    expect(resolveRendererSource(true, "http://127.0.0.1:5173", "C:\\Program Files\\Orrery\\resources\\app.asar"))
      .toEqual({
        kind: "file",
        value: "C:\\Program Files\\Orrery\\resources\\app.asar\\dist\\index.html",
      });
  });

  it("resolves preload beside the built main entry", () => {
    expect(resolvePreloadPath("C:\\workspace\\dist-electron\\main.js"))
      .toBe("C:\\workspace\\dist-electron\\preload.cjs");
  });

  it("allows only the loaded renderer document to navigate", () => {
    const rendererUrl = "http://localhost:5173/";

    expect(isAllowedNavigation(rendererUrl, rendererUrl)).toBe(true);
    expect(isAllowedNavigation("http://localhost:5173/settings", rendererUrl)).toBe(false);
    expect(isAllowedNavigation("https://example.com/", rendererUrl)).toBe(false);
  });

  it("prevents untrusted navigation and server-side redirects", () => {
    const handlers = new Map<string, (event: { preventDefault(): void }, destination: string) => void>();
    const webContents = {
      on: vi.fn((event: string, handler: (event: { preventDefault(): void }, destination: string) => void) => {
        handlers.set(event, handler);
      }),
      setWindowOpenHandler: vi.fn(),
    };
    installNavigationPolicy(webContents as never, () => "http://localhost:5173/");

    for (const eventName of ["will-navigate", "will-redirect"]) {
      const preventDefault = vi.fn();
      handlers.get(eventName)?.({ preventDefault }, "https://example.com/");
      expect(preventDefault).toHaveBeenCalledOnce();
    }

    const preventDefault = vi.fn();
    handlers.get("will-redirect")?.({ preventDefault }, "http://localhost:5173/");
    expect(preventDefault).not.toHaveBeenCalled();
    expect(webContents.setWindowOpenHandler).toHaveBeenCalledWith(popupPolicy);
  });

  it("denies permission requests and checks by default", () => {
    let requestHandler: ((webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined;
    let checkHandler: (() => boolean) | undefined;
    const target = {
      setPermissionRequestHandler: vi.fn((handler) => { requestHandler = handler; }),
      setPermissionCheckHandler: vi.fn((handler) => { checkHandler = handler; }),
    };
    installDefaultDenyPermissions(target as never);

    const callback = vi.fn();
    requestHandler?.({}, "media", callback);
    expect(callback).toHaveBeenCalledWith(false);
    expect(checkHandler?.()).toBe(false);
  });

  it("denies every popup request", () => {
    expect(popupPolicy()).toEqual({ action: "deny" });
  });

  it("trusts only the main frame at the exact renderer URL", () => {
    const mainFrame = { url: "file:///opt/Orrery/renderer/index.html" };

    expect(isTrustedIpcSender(mainFrame, mainFrame, mainFrame.url)).toBe(true);
    expect(isTrustedIpcSender({ url: mainFrame.url }, mainFrame, mainFrame.url)).toBe(false);
    expect(isTrustedIpcSender(mainFrame, mainFrame, "file:///tmp/index.html")).toBe(false);
  });
});
