export type TuiCommand = "up" | "down" | "refresh" | "inspect" | "subscribe" | "quit";

export interface TerminalKeyEvent {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  super?: boolean;
  hyper?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  readonly propagationStopped: boolean;
}

type KeyListener = (event: TerminalKeyEvent) => void;

export type TerminalKeyInput = Pick<TerminalKeyEvent, "name"> & Partial<Omit<TerminalKeyEvent, "name">>;

interface KeyInputLike {
  on(event: "keypress" | "keyrelease", listener: KeyListener): unknown;
  off(event: "keypress" | "keyrelease", listener: KeyListener): unknown;
}

interface KeymapRenderer {
  root: object;
  keyInput?: KeyInputLike;
  isDestroyed?: boolean;
  on(event: "destroy", listener: () => void): unknown;
  off(event: "destroy", listener: () => void): unknown;
}

const COMMANDS: ReadonlyArray<{ keys: ReadonlyArray<{ name: string; ctrl?: boolean }>; command: TuiCommand }> = [
  { keys: [{ name: "up" }, { name: "k" }], command: "up" },
  { keys: [{ name: "down" }, { name: "j" }], command: "down" },
  { keys: [{ name: "r" }], command: "refresh" },
  { keys: [{ name: "i" }, { name: "return" }], command: "inspect" },
  { keys: [{ name: "s" }], command: "subscribe" },
  { keys: [{ name: "q" }, { name: "escape" }, { name: "c", ctrl: true }], command: "quit" },
];

export function createLocalKeyHandler(dispatch: (command: TuiCommand) => void): (event: TerminalKeyInput) => boolean {
  return (event) => {
    const binding = COMMANDS.find(({ keys }) => keys.some((key) =>
      key.name === event.name && Boolean(key.ctrl) === Boolean(event.ctrl),
    ));
    if (!binding) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    dispatch(binding.command);
    return true;
  };
}

export async function installOpenTuiKeymap(
  renderer: KeymapRenderer,
  handler: (event: TerminalKeyInput) => boolean,
): Promise<() => void> {
  if (!renderer.keyInput) return installLocalRendererHandler(renderer, handler);

  try {
    const { Keymap } = await import("@opentui/keymap");
    const destroyListeners = new Set<() => void>();
    const onDestroy = (listener: () => void) => {
      destroyListeners.add(listener);
      renderer.on("destroy", listener);
      return () => {
        destroyListeners.delete(listener);
        renderer.off("destroy", listener);
      };
    };
    const host = {
      metadata: {
        platform: process.platform === "win32" ? "windows" as const : process.platform === "darwin" ? "macos" as const : "linux" as const,
        primaryModifier: process.platform === "darwin" ? "super" as const : "ctrl" as const,
        modifiers: { ctrl: "supported" as const, shift: "supported" as const, meta: "supported" as const, super: "supported" as const, hyper: "unknown" as const },
      },
      rootTarget: renderer.root,
      get isDestroyed() { return Boolean(renderer.isDestroyed); },
      getFocusedTarget: () => null,
      getParentTarget: () => null,
      isTargetDestroyed: () => false,
      onKeyPress: (listener: KeyListener) => subscribe(renderer.keyInput!, "keypress", listener),
      onKeyRelease: (listener: KeyListener) => subscribe(renderer.keyInput!, "keyrelease", listener),
      onFocusChange: () => () => undefined,
      onDestroy,
      onTargetDestroy: () => () => undefined,
      createCommandEvent: () => commandEvent(),
    };
    const keymap = new Keymap(host);
    const removeLayer = keymap.registerLayer({
      priority: 100,
      bindings: COMMANDS.flatMap(({ keys, command }) => keys.map((key) => ({
        key: { name: key.name, ctrl: Boolean(key.ctrl) },
        cmd: ({ event }: { event: TerminalKeyEvent }) => handler(event),
        command,
      }))),
    });
    return () => {
      removeLayer();
      for (const listener of destroyListeners) renderer.off("destroy", listener);
      destroyListeners.clear();
    };
  } catch {
    return installLocalRendererHandler(renderer, handler);
  }
}

function installLocalRendererHandler(renderer: KeymapRenderer, handler: (event: TerminalKeyInput) => boolean): () => void {
  if (!renderer.keyInput) throw new Error("OpenTUI renderer does not expose keyboard input.");
  const listener = (event: TerminalKeyEvent) => handler(event);
  renderer.keyInput.on("keypress", listener);
  return () => renderer.keyInput?.off("keypress", listener);
}

function subscribe(input: KeyInputLike, event: "keypress" | "keyrelease", listener: KeyListener): () => void {
  input.on(event, listener);
  return () => input.off(event, listener);
}

function commandEvent(): Required<Pick<TerminalKeyEvent, "name" | "ctrl" | "shift" | "meta" | "super" | "hyper">> & TerminalKeyEvent {
  let stopped = false;
  return {
    name: "",
    ctrl: false,
    shift: false,
    meta: false,
    super: false,
    hyper: false,
    preventDefault() {},
    stopPropagation() { stopped = true; },
    get propagationStopped() { return stopped; },
  };
}
