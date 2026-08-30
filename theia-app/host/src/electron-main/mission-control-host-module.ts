import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  ElectronMainApplicationContribution,
  ElectronMainApplicationGlobals,
  type ElectronMainApplication,
  type ElectronMainApplicationGlobals as TheiaElectronGlobals
} from "@theia/core/lib/electron-main/electron-main-application";
import { ContainerModule, inject, injectable } from "@theia/core/shared/inversify";
import { app, BrowserWindow, type WebContents } from "@theia/core/electron-shared/electron";
import { MissionControlHostService, type MissionControlHostService as PublicHostService } from "@orrery/mission-control-theia";
import { MissionControlDaemonClient as OwnedDaemonClient } from "@orrery/root-mission-control-daemon-client";

interface HostService extends PublicHostService {
  requestContext(sender: object, senderFrame: object | null): {
    reviewAndPromote(input: Parameters<PublicHostService["reviewAndPromote"]>[0]): ReturnType<PublicHostService["reviewAndPromote"]>;
  } | null;
}

@injectable()
export class MissionControlDaemonClient {
  private readonly daemon: OwnedDaemonClient;

  constructor(parentWindow: () => BrowserWindow | null = () => null) {
    this.daemon = new OwnedDaemonClient({
      parentWindow,
      daemonEntryPath: resolve(__dirname, "../resources/mission-control-daemon.cjs")
    });
  }

  list(): ReturnType<HostService["list"]> {
    return this.daemon.list();
  }

  getSnapshot(input: Parameters<HostService["getSnapshot"]>[0]): ReturnType<HostService["getSnapshot"]> {
    return this.daemon.getSnapshot(input);
  }

  reviewAndPromote(input: Parameters<HostService["reviewAndPromote"]>[0]): ReturnType<HostService["reviewAndPromote"]> {
    return this.daemon.reviewAndPromote(input);
  }

  reviewAndPromoteInWindow(input: Parameters<HostService["reviewAndPromote"]>[0], parent: BrowserWindow): ReturnType<HostService["reviewAndPromote"]> {
    return this.daemon.reviewAndPromoteInWindow(input, parent);
  }

  disconnect(): Promise<void> {
    return this.daemon.disconnect();
  }
}

export function canonicalTheiaRendererUrl(globals: Pick<TheiaElectronGlobals, "THEIA_FRONTEND_HTML_PATH">): string {
  return pathToFileURL(globals.THEIA_FRONTEND_HTML_PATH).href;
}

@injectable()
export class MissionControlWindowTracker {
  private readonly frontendUrl: string;

  constructor(
    @inject(ElectronMainApplicationGlobals) globals: TheiaElectronGlobals,
    private readonly windows: Pick<typeof BrowserWindow, "getAllWindows"> = BrowserWindow
  ) {
    this.frontendUrl = canonicalTheiaRendererUrl(globals);
  }

  trustedRendererUrl(): string {
    return this.mainFrame()?.url ?? this.frontendUrl;
  }

  isTrustedRenderer(sender: WebContents, senderFrame: WebContents["mainFrame"] | null): boolean {
    return senderFrame === sender.mainFrame && this.parentWindowFor(sender) !== null;
  }

  parentWindowFor(sender: WebContents): BrowserWindow | null {
    return this.windows.getAllWindows().find(window =>
      !window.isDestroyed()
      && !window.webContents.isDestroyed()
      && window.webContents === sender
      && this.isTheiaMainFrame(sender.mainFrame.url)
    ) ?? null;
  }

  parentWindow(): BrowserWindow | null {
    const frame = this.mainFrame();
    return frame ? this.findWindow(frame) : null;
  }

  private mainFrame(): WebContents["mainFrame"] | undefined {
    return this.findTrustedWindow()?.webContents.mainFrame;
  }

  private findTrustedWindow(): BrowserWindow | undefined {
    return this.windows.getAllWindows()
      .filter(window => !window.isDestroyed() && !window.webContents.isDestroyed())
      .find(window => this.isTheiaMainFrame(window.webContents.mainFrame.url));
  }

  private findWindow(frame: WebContents["mainFrame"]): BrowserWindow | null {
    return this.windows.getAllWindows().find(window => window.webContents.mainFrame === frame) ?? null;
  }

  private isTheiaMainFrame(url: string): boolean {
    try {
      const candidate = new URL(url);
      const expected = new URL(this.frontendUrl);
      const port = candidate.searchParams.get("port");
      return candidate.protocol === expected.protocol
        && candidate.host === expected.host
        && candidate.pathname === expected.pathname
        && candidate.hash === expected.hash
        && [...candidate.searchParams.keys()].length === 1
        && port !== null
        && /^\d+$/.test(port)
        && Number(port) > 0
        && Number(port) <= 65535;
    } catch {
      return false;
    }
  }
}

@injectable()
export class MissionControlHostContribution implements ElectronMainApplicationContribution {
  readonly hostService: HostService;
  private cleanup?: Promise<void>;

  constructor(
    @inject(MissionControlDaemonClient) private readonly daemon: MissionControlDaemonClient,
    @inject(MissionControlWindowTracker) private readonly windows?: MissionControlWindowTracker
  ) {
    this.hostService = {
      requestContext: (sender, frame) => {
        const contents = sender as WebContents;
        const parent = this.requireWindows().isTrustedRenderer(contents, frame as WebContents["mainFrame"] | null)
          ? this.requireWindows().parentWindowFor(contents)
          : null;
        return parent ? { reviewAndPromote: input => this.daemon.reviewAndPromoteInWindow(input, parent) } : null;
      },
      list: () => this.daemon.list(),
      getSnapshot: input => this.daemon.getSnapshot(input),
      reviewAndPromote: input => this.daemon.reviewAndPromote(input),
    };
  }

  onStart(_application: ElectronMainApplication, electronApp: Pick<typeof app, "on" | "quit"> = app): void {
    let quitAfterCleanup = false;
    electronApp.on("before-quit", event => {
      if (quitAfterCleanup) return;
      event.preventDefault();
      void this.disconnect().then(() => {
        quitAfterCleanup = true;
        electronApp.quit();
      }, error => console.error(error));
    });
  }

  onStop(): void {
    void this.disconnect().catch(error => console.error(error));
  }

  private disconnect(): Promise<void> {
    return this.cleanup ??= this.daemon.disconnect().catch(error => {
      this.cleanup = undefined;
      throw error;
    });
  }

  private requireWindows(): MissionControlWindowTracker {
    if (!this.windows) throw new Error("Theia main-window tracking is unavailable.");
    return this.windows;
  }
}

export default new ContainerModule(bind => {
  bind(MissionControlWindowTracker).toSelf().inSingletonScope();
  bind(MissionControlDaemonClient).toDynamicValue(context => new MissionControlDaemonClient(
    () => context.container.get(MissionControlWindowTracker).parentWindow()
  )).inSingletonScope();
  bind(MissionControlHostContribution).toSelf().inSingletonScope();
  bind(ElectronMainApplicationContribution).toService(MissionControlHostContribution);
  bind(MissionControlHostService).toDynamicValue(context => context.container.get(MissionControlHostContribution).hostService).inSingletonScope();
});
