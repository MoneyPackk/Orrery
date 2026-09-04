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
    intakeRepository(input: Parameters<PublicHostService["intakeRepository"]>[0]): ReturnType<PublicHostService["intakeRepository"]>;
    reviewAndPromote(input: Parameters<PublicHostService["reviewAndPromote"]>[0]): ReturnType<PublicHostService["reviewAndPromote"]>;
    registerMcpServer(input: Parameters<PublicHostService["registerMcpServer"]>[0]): ReturnType<PublicHostService["registerMcpServer"]>;
    setMcpToolDecision(input: Parameters<PublicHostService["setMcpToolDecision"]>[0]): ReturnType<PublicHostService["setMcpToolDecision"]>;
    invokeMcpTool(input: Parameters<PublicHostService["invokeMcpTool"]>[0]): ReturnType<PublicHostService["invokeMcpTool"]>;
    sendIntelligenceMessage(input: Parameters<PublicHostService["sendIntelligenceMessage"]>[0]): ReturnType<PublicHostService["sendIntelligenceMessage"]>;
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

  intakeRepository(input: Parameters<HostService["intakeRepository"]>[0], parent: BrowserWindow): ReturnType<HostService["intakeRepository"]> {
    return this.daemon.intakeRepository(input, parent);
  }

  create(input: Parameters<HostService["create"]>[0]): ReturnType<HostService["create"]> { return this.daemon.create(input); }
  run(input: Parameters<HostService["run"]>[0]): ReturnType<HostService["run"]> { return this.daemon.run(input); }
  cancel(input: Parameters<HostService["cancel"]>[0]): ReturnType<HostService["cancel"]> { return this.daemon.cancel(input); }
  inspect(input: Parameters<HostService["inspect"]>[0]): ReturnType<HostService["inspect"]> { return this.daemon.inspect(input); }

  getIntelligenceSettings(): ReturnType<HostService["getIntelligenceSettings"]> { return this.daemon.getIntelligenceSettings(); }
  setIntelligenceSettings(input: Parameters<HostService["setIntelligenceSettings"]>[0]): ReturnType<HostService["setIntelligenceSettings"]> { return this.daemon.setIntelligenceSettings(input); }
  listIntelligenceMessages(input: Parameters<HostService["listIntelligenceMessages"]>[0]): ReturnType<HostService["listIntelligenceMessages"]> { return this.daemon.listIntelligenceMessages(input); }
  sendIntelligenceMessage(input: Parameters<HostService["sendIntelligenceMessage"]>[0]): ReturnType<HostService["sendIntelligenceMessage"]> { return this.daemon.sendIntelligenceMessage(input); }
  clearIntelligenceThread(input: Parameters<HostService["clearIntelligenceThread"]>[0]): ReturnType<HostService["clearIntelligenceThread"]> { return this.daemon.clearIntelligenceThread(input); }
  getIntelligenceTurnStatus(input: Parameters<HostService["getIntelligenceTurnStatus"]>[0]): ReturnType<HostService["getIntelligenceTurnStatus"]> { return this.daemon.getIntelligenceTurnStatus(input); }

  listMcpCatalog(): ReturnType<HostService["listMcpCatalog"]> { return this.daemon.listMcpCatalog(); }
  removeMcpServer(input: Parameters<HostService["removeMcpServer"]>[0]): ReturnType<HostService["removeMcpServer"]> { return this.daemon.removeMcpServer(input); }
  listMcpActivity(): ReturnType<HostService["listMcpActivity"]> { return this.daemon.listMcpActivity(); }
  registerMcpServerInWindow(input: Parameters<HostService["registerMcpServer"]>[0], parent: BrowserWindow): ReturnType<HostService["registerMcpServer"]> {
    return this.daemon.registerMcpServer(input, parent);
  }
  setMcpToolDecisionInWindow(input: Parameters<HostService["setMcpToolDecision"]>[0], parent: BrowserWindow): ReturnType<HostService["setMcpToolDecision"]> {
    return this.daemon.setMcpToolDecision(input, parent);
  }
  invokeMcpToolInWindow(input: Parameters<HostService["invokeMcpTool"]>[0], parent: BrowserWindow): ReturnType<HostService["invokeMcpTool"]> {
    return this.daemon.invokeMcpTool(input, parent);
  }

  /**
   * The model may request a tool call while answering, and each call raises a native
   * confirmation, so the chat turn is bound to the window that asked for it.
   */
  sendIntelligenceMessageInWindow(input: Parameters<HostService["sendIntelligenceMessage"]>[0], parent: BrowserWindow): ReturnType<HostService["sendIntelligenceMessage"]> {
    return this.daemon.sendIntelligenceMessage(input, parent);
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
        return parent ? {
          intakeRepository: input => this.daemon.intakeRepository(input, parent),
          reviewAndPromote: input => this.daemon.reviewAndPromoteInWindow(input, parent),
          registerMcpServer: input => this.daemon.registerMcpServerInWindow(input, parent),
          setMcpToolDecision: input => this.daemon.setMcpToolDecisionInWindow(input, parent),
          invokeMcpTool: input => this.daemon.invokeMcpToolInWindow(input, parent),
          sendIntelligenceMessage: input => this.daemon.sendIntelligenceMessageInWindow(input, parent),
        } : null;
      },
      intakeRepository: input => this.daemon.intakeRepository(input, this.requireWindows().parentWindow() ?? (() => { throw new Error("Trusted Theia window unavailable."); })()),
      create: input => this.daemon.create(input),
      run: input => this.daemon.run(input),
      cancel: input => this.daemon.cancel(input),
      list: () => this.daemon.list(),
      getSnapshot: input => this.daemon.getSnapshot(input),
      inspect: input => this.daemon.inspect(input),
      getIntelligenceSettings: () => this.daemon.getIntelligenceSettings(),
      setIntelligenceSettings: input => this.daemon.setIntelligenceSettings(input),
      listIntelligenceMessages: input => this.daemon.listIntelligenceMessages(input),
      sendIntelligenceMessage: input => this.daemon.sendIntelligenceMessageInWindow(input, this.requireTrustedWindow()),
      clearIntelligenceThread: input => this.daemon.clearIntelligenceThread(input),
      getIntelligenceTurnStatus: input => this.daemon.getIntelligenceTurnStatus(input),
      reviewAndPromote: input => this.daemon.reviewAndPromote(input),
      listMcpCatalog: () => this.daemon.listMcpCatalog(),
      removeMcpServer: input => this.daemon.removeMcpServer(input),
      listMcpActivity: () => this.daemon.listMcpActivity(),
      // These three require a trusted parent window for their confirmation dialog, so the
      // context-free path refuses rather than proceeding without one.
      registerMcpServer: input => this.daemon.registerMcpServerInWindow(input, this.requireTrustedWindow()),
      setMcpToolDecision: input => this.daemon.setMcpToolDecisionInWindow(input, this.requireTrustedWindow()),
      invokeMcpTool: input => this.daemon.invokeMcpToolInWindow(input, this.requireTrustedWindow()),
    };
  }

  private requireTrustedWindow(): BrowserWindow {
    const parent = this.requireWindows().parentWindow();
    if (!parent) throw new Error("Trusted Theia window unavailable.");
    return parent;
  }

  onStart(_application: ElectronMainApplication, electronApp: Pick<typeof app, "on" | "quit" | "exit"> = app): void {
    let quitAfterCleanup = false;
    electronApp.on("before-quit", event => {
      if (quitAfterCleanup) return;
      event.preventDefault();
      void this.disconnect().then(() => {
        quitAfterCleanup = true;
        electronApp.quit();
        setTimeout(() => electronApp.exit(0), 5_000).unref();
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
