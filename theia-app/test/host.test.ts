import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { Container } from "@theia/core/shared/inversify";
import { ApplicationPackage } from "@theia/application-package";
import { MissionControlHostService } from "@orrery/mission-control-theia";
import { ElectronMainApplicationGlobals } from "@theia/core/lib/electron-main/electron-main-application";
import hostModule, {
  MissionControlDaemonClient,
  MissionControlHostContribution,
  MissionControlWindowTracker,
  canonicalTheiaRendererUrl
} from "../host/src/electron-main/mission-control-host-module";

describe("isolated Theia Electron host", () => {
  it("is discovered with the reusable extension in the generated Electron graph", () => {
    const application = new ApplicationPackage({ projectPath: process.cwd() });
    expect(application.target).toBe("electron");
    expect([...application.electronMainModules.values()]).toEqual([
      "@orrery/mission-control-theia/lib/electron-main/mission-control-electron-main-module",
      "@orrery/theia-host/lib/electron-main/mission-control-host-module"
    ]);
    expect([...application.preloadModules.values()]).toEqual([
      "@theia/core/lib/electron-browser/preload",
      "@orrery/mission-control-theia/lib/electron-browser/mission-control-preload"
    ]);
  });

  it("writes the extension preload and both electron-main composition modules", () => {
    const preload = readFileSync(resolve("src-gen/frontend/preload.js"), "utf8");
    const main = readFileSync(resolve("src-gen/backend/electron-main.js"), "utf8");
    expect(preload).toContain("@orrery/mission-control-theia/lib/electron-browser/mission-control-preload");
    expect(main).toContain("@orrery/mission-control-theia/lib/electron-main/mission-control-electron-main-module");
    expect(main).toContain("@orrery/theia-host/lib/electron-main/mission-control-host-module");
    expect(main.indexOf("@orrery/mission-control-theia")).toBeLessThan(main.indexOf("@orrery/theia-host"));
  });

  it("resolves one daemon client and the narrow host service from DI", () => {
    const container = new Container();
    container.bind(ElectronMainApplicationGlobals).toConstantValue({
      THEIA_APP_PROJECT_PATH: process.cwd(),
      THEIA_BACKEND_MAIN_PATH: "",
      THEIA_FRONTEND_HTML_PATH: resolve("lib/frontend/index.html"),
      THEIA_SECONDARY_WINDOW_HTML_PATH: ""
    });
    container.load(hostModule);
    expect(container.get(MissionControlDaemonClient)).toBe(container.get(MissionControlDaemonClient));
    expect(container.get(MissionControlHostService)).toBe(container.get(MissionControlHostService));
  });

  it("installs the extension physically against the host's single Theia core", () => {
    const require = createRequire(import.meta.url);
    const extensionPackage = resolve(require.resolve("@orrery/mission-control-theia"), "../../../package.json");
    const extensionRequire = createRequire(extensionPackage);
    expect(extensionRequire.resolve("@theia/core/package.json")).toBe(require.resolve("@theia/core/package.json"));
    expect(readFileSync(extensionPackage, "utf8")).toContain('"@theia/core": "1.75.0"');
  });

  it("uses the exact encoded Theia frontend URL and actual main frame", () => {
    const htmlPath = resolve("C:/Orrery Host/lib/frontend/index.html");
    const expected = pathToFileURL(htmlPath).href;
    const window = fakeWindow(`${expected}?port=57595`);
    const tracker = new MissionControlWindowTracker(
      { THEIA_FRONTEND_HTML_PATH: htmlPath } as never,
      { getAllWindows: () => [window] } as never
    );
    expect(tracker.trustedRendererUrl()).toBe(`${expected}?port=57595`);
    expect(tracker.parentWindow()).toBe(window);
    window.webContents.mainFrame.url = `${expected}?port=57595`;
    expect(tracker.parentWindow()).toBe(window);
    window.webContents.mainFrame.url = `${expected}?workspace=test`;
    expect(tracker.parentWindow()).toBeNull();
    window.webContents.mainFrame.url = `${expected}?port=57595&workspace=test`;
    expect(tracker.parentWindow()).toBeNull();
    window.webContents.mainFrame.url = "file:///nested.html";
    expect(tracker.parentWindow()).toBeNull();
  });

  it("binds each same-URL renderer to its exact originating window regardless of enumeration order", async () => {
    const url = `${pathToFileURL(resolve("C:/Orrery Host/lib/frontend/index.html")).href}?port=57595`;
    const trusted = fakeWindow(url);
    const impostor = fakeWindow(url);
    const tracker = new MissionControlWindowTracker(
      { THEIA_FRONTEND_HTML_PATH: resolve("C:/Orrery Host/lib/frontend/index.html") } as never,
      { getAllWindows: () => [impostor, trusted] } as never
    );
    expect(tracker.isTrustedRenderer(trusted.webContents as never, trusted.webContents.mainFrame as never)).toBe(true);
    expect(tracker.isTrustedRenderer(impostor.webContents as never, impostor.webContents.mainFrame as never)).toBe(true);
    expect(tracker.parentWindowFor(trusted.webContents as never)).toBe(trusted);
    expect(tracker.parentWindowFor(impostor.webContents as never)).toBe(impostor);
  });

  it("rejects detached and replaced WebContents even when their URL matches", () => {
    const htmlPath = resolve("C:/Orrery Host/lib/frontend/index.html");
    const url = `${pathToFileURL(htmlPath).href}?port=57595`;
    const original = fakeWindow(url);
    let windows = [original];
    const tracker = new MissionControlWindowTracker(
      { THEIA_FRONTEND_HTML_PATH: htmlPath } as never,
      { getAllWindows: () => windows } as never
    );
    const replacement = fakeWindow(url);

    expect(tracker.parentWindowFor(original.webContents as never)).toBe(original);
    windows = [replacement];
    expect(tracker.isTrustedRenderer(original.webContents as never, original.webContents.mainFrame as never)).toBe(false);
    expect(tracker.parentWindowFor(original.webContents as never)).toBeNull();
    expect(tracker.parentWindowFor(replacement.webContents as never)).toBe(replacement);
  });

  it("binds review to the exact window captured by the IPC request context", async () => {
    const htmlPath = resolve("C:/Orrery Host/lib/frontend/index.html");
    const url = `${pathToFileURL(htmlPath).href}?port=57595`;
    const first = fakeWindow(url);
    const second = fakeWindow(url);
    const daemon = { reviewAndPromoteInWindow: vi.fn(async input => input) };
    const tracker = new MissionControlWindowTracker(
      { THEIA_FRONTEND_HTML_PATH: htmlPath } as never,
      { getAllWindows: () => [second, first] } as never
    );
    const contribution = new MissionControlHostContribution(daemon as never, tracker);

    const context = contribution.hostService.requestContext(first.webContents as never, first.webContents.mainFrame as never);
    await context!.reviewAndPromote({ intentId: "intent-1", missionId: "mission-1", planRevisionId: "plan-1", decision: "accepted" });

    expect(daemon.reviewAndPromoteInWindow).toHaveBeenCalledWith(expect.anything(), first);
  });

  it("delegates through one daemon and disconnects it on host shutdown", async () => {
    const daemon = {
      list: vi.fn(async () => []),
      getSnapshot: vi.fn(async input => input),
      reviewAndPromote: vi.fn(async input => input),
      disconnect: vi.fn(async () => undefined)
    };
    const contribution = new MissionControlHostContribution(daemon as never, {
      trustedRendererUrl: () => "file:///theia/index.html",
      parentWindow: () => null
    } as never);
    await contribution.hostService.list();
    await contribution.hostService.getSnapshot({ missionId: "mission-1" });
    const quit = vi.fn();
    let beforeQuit: ((event: { preventDefault(): void }) => void) | undefined;
    const app = { on: vi.fn((_name: string, listener: typeof beforeQuit) => { beforeQuit = listener; }), quit };
    contribution.onStart({} as never, app as never);
    const preventDefault = vi.fn();
    beforeQuit!({ preventDefault });
    await vi.waitFor(() => expect(daemon.disconnect).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    beforeQuit!({ preventDefault });
    expect(daemon.list).toHaveBeenCalledOnce();
    expect(daemon.getSnapshot).toHaveBeenCalledWith({ missionId: "mission-1" });
    expect(daemon.disconnect).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("does not quit after rejected cleanup and retries on the next quit request", async () => {
    const cleanup = deferred<void>();
    const daemon = { disconnect: vi.fn(() => cleanup.promise) };
    const contribution = new MissionControlHostContribution(daemon as never, {} as never);
    const quit = vi.fn();
    let beforeQuit: ((event: { preventDefault(): void }) => void) | undefined;
    const app = { on: vi.fn((_name: string, listener: typeof beforeQuit) => { beforeQuit = listener; }), quit };
    contribution.onStart({} as never, app as never);

    contribution.onStop();
    beforeQuit!({ preventDefault: vi.fn() });
    expect(daemon.disconnect).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
    cleanup.reject(new Error("disconnect failed"));

    await vi.waitFor(() => expect(daemon.disconnect).toHaveBeenCalledOnce());
    expect(quit).not.toHaveBeenCalled();
    daemon.disconnect.mockResolvedValueOnce(undefined);
    beforeQuit!({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(daemon.disconnect).toHaveBeenCalledTimes(2);
  });

  it("does not quit while daemon cleanup remains incomplete", async () => {
    const daemon = { disconnect: vi.fn(() => new Promise<void>(() => undefined)) };
    const contribution = new MissionControlHostContribution(daemon as never, {} as never);
    const quit = vi.fn();
    let beforeQuit: ((event: { preventDefault(): void }) => void) | undefined;
    contribution.onStart({} as never, { on: (_name: string, listener: typeof beforeQuit) => { beforeQuit = listener; }, quit } as never);

    beforeQuit!({ preventDefault: vi.fn() });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(quit).not.toHaveBeenCalled();
  });

  it("handles cleanup rejection when Theia invokes onStop directly", async () => {
    const error = new Error("disconnect failed");
    const daemon = { disconnect: vi.fn(async () => { throw error; }) };
    const contribution = new MissionControlHostContribution(daemon as never, {} as never);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    contribution.onStop();

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(error));
    consoleError.mockRestore();
  });

  it("publishes host types at the path declared by package metadata", () => {
    const metadata = JSON.parse(readFileSync(resolve("host/package.json"), "utf8"));
    expect(metadata.types).toBe("lib/electron-main/mission-control-host-module.d.ts");
    expect(metadata.files).toContain("lib");
    expect(readFileSync(resolve("host", metadata.types), "utf8")).toContain("MissionControlHostContribution");
  });

  it("contains a relocatable host runtime with declarations and no checkout or source paths", () => {
    const destination = mkdtempSync(resolve(tmpdir(), "orrery-host-relocated-"));
    try {
      cpSync(resolve("host/lib"), resolve(destination, "lib"), { recursive: true });
      const moduleSource = readFileSync(resolve(destination, "lib/electron-main/mission-control-host-module.js"), "utf8");
      const daemonSource = readFileSync(resolve(destination, "lib/resources/mission-control-daemon.cjs"), "utf8");
      expect(readFileSync(resolve(destination, "lib/electron-main/mission-control-host-module.d.ts"), "utf8")).toContain("MissionControlHostContribution");
      expect(`${moduleSource}\n${daemonSource}`).not.toMatch(/C:\\\\Users\\\\blazi\\\\orrery|mission-control-daemon-client\.ts|orrery-daemon\.ts/);
      expect(moduleSource).toContain("mission-control-daemon.cjs");
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it("keeps browser and preload code free of host privileges", () => {
    for (const file of [
      "../theia-extensions/mission-control/src/browser/mission-control-frontend-module.ts",
      "../theia-extensions/mission-control/src/electron-browser/mission-control-preload.ts"
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/electron\/main|mission-control-daemon-client|node:child_process|daemon-lifecycle/);
    }
  });
});

function fakeWindow(url: string) {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      mainFrame: { url }
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
