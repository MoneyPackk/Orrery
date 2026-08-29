import type { Mission, MissionEvent } from "@orrery/mission-control-domain";
import type { MissionListItem } from "@orrery/mission-control-protocol";
import type { SubscriptionState } from "@orrery/mission-control-client";
import { createLocalKeyHandler, installOpenTuiKeymap, type TerminalKeyEvent, type TerminalKeyInput, type TuiCommand } from "./keymap";
import { MissionControlViewModel } from "./view-model";

export interface MissionControlTuiClient {
  listMissions(): Promise<ReadonlyArray<MissionListItem>>;
  getMission(id: string): Promise<Mission>;
  subscribe(id: string, listener: (event: MissionEvent) => void, stateListener?: (state: SubscriptionState) => void, afterSequence?: number): Promise<() => Promise<void>>;
}

interface RootLike { add(child: unknown): unknown; }
export interface RendererLike {
  width: number;
  height: number;
  root: RootLike;
  keyInput?: {
    on(event: "keypress" | "keyrelease", listener: (event: TerminalKeyEvent) => void): unknown;
    off(event: "keypress" | "keyrelease", listener: (event: TerminalKeyEvent) => void): unknown;
  };
  isDestroyed?: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  destroy(): void;
}
interface ContainerLike { add(child: unknown): unknown; }
interface TextLike { content: unknown; }
type ContainerConstructor = new (renderer: RendererLike, options: Record<string, unknown>) => ContainerLike;
type TextConstructor = new (renderer: RendererLike, options: { content?: string; [key: string]: unknown }) => TextLike;

export interface OpenTuiRuntime {
  createCliRenderer(options: Record<string, unknown>): Promise<RendererLike>;
  BoxRenderable: ContainerConstructor;
  TextRenderable: TextConstructor;
  installKeymap(renderer: RendererLike, handler: (event: TerminalKeyInput) => boolean): Promise<() => void>;
}
export interface RunTuiOptions { runtime?: OpenTuiRuntime; signal?: AbortSignal; }

export async function runTui(client: MissionControlTuiClient, options: RunTuiOptions = {}): Promise<void> {
  const runtime = options.runtime ?? await loadOpenTuiRuntime();
  const renderer = await runtime.createCliRenderer({ exitOnCtrlC: false, clearOnShutdown: true, screenMode: "alternate-screen" });
  let removeKeymap: (() => void) | undefined;
  let unsubscribe: (() => Promise<void>) | undefined;
  let resolveQuit: (() => void) | undefined;
  let active = true;
  const quit = new Promise<void>((resolve) => { resolveQuit = resolve; });
  const onAbort = () => { active = false; resolveQuit?.(); };

  try {
    const model = new MissionControlViewModel();
    const output = createLayout(runtime, renderer);
    const redraw = () => {
      if (!active || renderer.isDestroyed) return;
      renderView(output, model, renderer.width);
    };
    const refresh = async () => {
      model.setLoading();
      redraw();
      try {
        const missions = await client.listMissions();
        if (!active) return;
        model.setMissions(missions);
      } catch (error) {
        if (!active) return;
        model.setError(asError(error));
      }
      redraw();
    };
    const inspect = async () => {
      const id = model.selectedMissionId;
      if (!id) return;
      try {
        const snapshot = await client.getMission(id);
        if (!active || model.selectedMissionId !== id) return;
        model.setSnapshot(snapshot);
      } catch (error) {
        if (!active) return;
        model.setError(asError(error));
      }
      redraw();
    };
    const subscribeFrom = async (selectedMissionId: string, afterSequence = 0) => client.subscribe(selectedMissionId, (event) => {
      if (!active || model.selectedMissionId !== selectedMissionId) return;
      model.appendEvent(event);
      redraw();
    }, (state) => {
      if (!active || model.selectedMissionId !== selectedMissionId) return;
      model.setEventHistoryState(state);
      redraw();
      if (state.status === "invalid") void recoverSubscription(selectedMissionId, state);
    }, afterSequence);
    const recoverSubscription = async (selectedMissionId: string, invalid: Extract<SubscriptionState, { status: "invalid" }>) => {
      if (!active || model.selectedMissionId !== selectedMissionId || !unsubscribe) return;
      const oldUnsubscribe = unsubscribe;
      unsubscribe = undefined;
      model.setSubscribed(false);
      await oldUnsubscribe().catch(() => undefined);
      try {
        const snapshot = await client.getMission(selectedMissionId);
        if (!active || model.selectedMissionId !== selectedMissionId) return;
        model.setSnapshot(snapshot);
        model.setEventHistoryState(invalid);
        const finalSequence = snapshot.events.reduce((last, event) => Math.max(last, event.sequence), 0);
        const nextUnsubscribe = await subscribeFrom(selectedMissionId, finalSequence);
        if (!active) {
          await nextUnsubscribe().catch(() => undefined);
          return;
        }
        unsubscribe = nextUnsubscribe;
        model.setSubscribed(true);
        model.setEventHistoryState({ status: "live" });
      } catch (error) {
        if (active) model.setError(asError(error));
      }
      redraw();
    };
    const toggleSubscription = async () => {
      if (unsubscribe) {
        await unsubscribe();
        if (!active) return;
        unsubscribe = undefined;
        model.setSubscribed(false);
      } else if (model.selectedMissionId) {
        const nextUnsubscribe = await subscribeFrom(model.selectedMissionId);
        if (!active) {
          await nextUnsubscribe().catch(() => undefined);
          return;
        }
        unsubscribe = nextUnsubscribe;
        model.setSubscribed(true);
      }
      redraw();
    };
    const dispatch = (command: TuiCommand) => {
      switch (command) {
        case "up": model.moveSelection(-1); redraw(); break;
        case "down": model.moveSelection(1); redraw(); break;
        case "refresh": void refresh(); break;
        case "inspect": void inspect(); break;
        case "subscribe": void toggleSubscription(); break;
        case "quit": active = false; resolveQuit?.(); break;
      }
    };
    renderer.on("resize", redraw);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    removeKeymap = await runtime.installKeymap(renderer, createLocalKeyHandler(dispatch));
    await refresh();
    await quit;
    renderer.off("resize", redraw);
  } finally {
    active = false;
    options.signal?.removeEventListener("abort", onAbort);
    removeKeymap?.();
    if (unsubscribe) await unsubscribe().catch(() => undefined);
    renderer.destroy();
  }
}

async function loadOpenTuiRuntime(): Promise<OpenTuiRuntime> {
  assertNativeNodeRuntime();
  const core = await import("@opentui/core");
  return {
    createCliRenderer: core.createCliRenderer as unknown as OpenTuiRuntime["createCliRenderer"],
    BoxRenderable: core.BoxRenderable as unknown as ContainerConstructor,
    TextRenderable: core.TextRenderable as unknown as TextConstructor,
    installKeymap: installOpenTuiKeymap,
  };
}
function assertNativeNodeRuntime(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 26 || (major === 26 && minor < 4)) throw new Error("Orrery Mission Control TUI requires Node.js 26.4.0+ with --experimental-ffi.");
  if (!process.execArgv.includes("--experimental-ffi")) throw new Error("Orrery Mission Control TUI requires Node.js --experimental-ffi.");
}
function createLayout(runtime: OpenTuiRuntime, renderer: RendererLike): Record<"status" | "missions" | "detail" | "events" | "evidence" | "help", TextLike> {
  const root = new runtime.BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column", gap: 0, rowGap: 0 });
  const body = new runtime.BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row", gap: 0, columnGap: 0 });
  const left = new runtime.BoxRenderable(renderer, { width: "36%", flexDirection: "column", gap: 0, rowGap: 0, border: ["right"] });
  const right = new runtime.BoxRenderable(renderer, { flexGrow: 1, flexDirection: "column", gap: 0, rowGap: 0 });
  const status = new runtime.TextRenderable(renderer, { content: "", height: 1 });
  const missions = new runtime.TextRenderable(renderer, { content: "", flexGrow: 1 });
  const detail = new runtime.TextRenderable(renderer, { content: "", height: 5 });
  const events = new runtime.TextRenderable(renderer, { content: "", flexGrow: 1 });
  const evidence = new runtime.TextRenderable(renderer, { content: "", height: 4 });
  const help = new runtime.TextRenderable(renderer, { content: "", height: 1 });
  left.add(missions); right.add(detail); right.add(events); right.add(evidence); body.add(left); body.add(right);
  root.add(status); root.add(body); root.add(help); renderer.root.add(root);
  return { status, missions, detail, events, evidence, help };
}
function renderView(output: Record<"status" | "missions" | "detail" | "events" | "evidence" | "help", TextLike>, model: MissionControlViewModel, width: number): void {
  const view = model.view(width);
  output.status.content = ` ORRERY  ${view.connection.label}`;
  output.missions.content = `MISSIONS\n${view.missionRows.join("\n")}`;
  output.detail.content = `MISSION\n${view.detailLines.join("\n")}`;
  output.events.content = `EVENTS${view.subscribed ? " [DURABLE]" : ""}\n${view.eventLines.join("\n")}`;
  output.evidence.content = `EVIDENCE\n${view.evidenceLines.join("\n")}`;
  output.help.content = " ↑/↓ select  r refresh  i/enter inspect  s subscribe  q quit";
}
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
