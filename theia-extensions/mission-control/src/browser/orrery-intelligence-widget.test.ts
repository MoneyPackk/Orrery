import { describe, expect, it, vi } from "vitest";
import type { OrreryIntelligenceService, OrreryIntelligenceState } from "../common/mission-control-types";
import { ORRERY_INTELLIGENCE_THREAD_ID, ORRERY_INTELLIGENCE_WIDGET_ID, OrreryIntelligenceWidget, TURN_STATUS_POLL_MS } from "./orrery-intelligence-widget";

const state = (overrides: Partial<OrreryIntelligenceState> = {}): OrreryIntelligenceState => ({
  threadId: ORRERY_INTELLIGENCE_THREAD_ID,
  messages: [],
  settings: { configured: true, hasCredential: true, provider: "anthropic", model: "claude-x" },
  ...overrides,
});

function widgetWith(service: Partial<OrreryIntelligenceService>): { widget: OrreryIntelligenceWidget; read: () => OrreryIntelligenceState } {
  class TestWidget extends OrreryIntelligenceWidget {
    // `update` is public on the Theia base widget, so the stub must not narrow its visibility.
    override update(): void {}
    snapshot(): OrreryIntelligenceState { return this.state; }
  }
  const widget = new TestWidget();
  Object.defineProperty(widget, "service", { value: { load: vi.fn(async () => state()), send: vi.fn(async () => state()), clear: vi.fn(async () => state()), configure: vi.fn(async () => state()), turnStatus: vi.fn(async () => ({ threadId: ORRERY_INTELLIGENCE_THREAD_ID, active: false, completed: [], remainingCalls: 5 })), cancelTurn: vi.fn(async () => undefined), ...service } });
  return { widget, read: () => widget.snapshot() };
}

describe("OrreryIntelligenceWidget", () => {
  it("identifies itself and loads the transcript on initialization", async () => {
    const load = vi.fn(async () => state({ messages: [{ id: "m", threadId: "main", sequence: 1, role: "assistant", text: "ready", createdAt: "now" }] }));
    const { widget, read } = widgetWith({ load });
    (widget as unknown as { initialize(): void }).initialize();
    await vi.waitFor(() => expect(read().loading).toBe(false));
    expect(widget.id).toBe(ORRERY_INTELLIGENCE_WIDGET_ID);
    expect(widget.title.label).toBe("Orrery Intelligence");
    expect(load).toHaveBeenCalledWith(ORRERY_INTELLIGENCE_THREAD_ID);
    expect(read().messages).toHaveLength(1);
  });

  it("sends trimmed text and clears the sending flag", async () => {
    const send = vi.fn(async () => state({ messages: [{ id: "m", threadId: "main", sequence: 1, role: "user", text: "question", createdAt: "now" }] }));
    const { widget, read } = widgetWith({ send });
    await widget.send("  question  ");
    expect(send).toHaveBeenCalledWith(ORRERY_INTELLIGENCE_THREAD_ID, "question");
    expect(read().sending).toBe(false);
    expect(read().error).toBeUndefined();
  });

  it("ignores empty prompts", async () => {
    const send = vi.fn();
    const { widget } = widgetWith({ send });
    await widget.send("   ");
    expect(send).not.toHaveBeenCalled();
  });

  it("surfaces provider errors without losing the conversation", async () => {
    const { widget, read } = widgetWith({ send: vi.fn(async () => { throw new Error("Provider rejected the key."); }) });
    await widget.send("question");
    expect(read().error).toBe("Provider rejected the key.");
    expect(read().sending).toBe(false);
  });

  it("reports a fallback message for non-Error failures", async () => {
    const { widget, read } = widgetWith({ load: vi.fn(async () => { throw "boom"; }) });
    await widget.refresh();
    expect(read().error).toBe("Unable to load Orrery Intelligence.");
  });

  it("clears the thread and saves provider settings", async () => {
    const clear = vi.fn(async () => state());
    const configure = vi.fn(async () => state());
    const { widget } = widgetWith({ clear, configure });
    await widget.clear();
    expect(clear).toHaveBeenCalledWith(ORRERY_INTELLIGENCE_THREAD_ID);
    await widget.configure({ provider: "ollama", model: "llama3", baseUrl: "http://127.0.0.1:11434", apiKey: "" });
    expect(configure).toHaveBeenCalledWith({ provider: "ollama", model: "llama3", baseUrl: "http://127.0.0.1:11434", apiKey: "" });
  });

  it("does not run overlapping requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => { await gate; return state(); });
    const { widget } = widgetWith({ send });
    const first = widget.send("one");
    await widget.send("two");
    release();
    await first;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("polls turn status while a turn runs and stops when it finishes", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const turnStatus = vi.fn(async () => ({ threadId: ORRERY_INTELLIGENCE_THREAD_ID, active: true, completed: [], remainingCalls: 4, pendingTool: { serverId: "files", name: "purge", risk: "destructive" } }));
      const { widget, read } = widgetWith({ send: vi.fn(async () => { await gate; return state(); }), turnStatus });
      const sending = widget.send("go");

      await vi.advanceTimersByTimeAsync(TURN_STATUS_POLL_MS * 2);
      expect(turnStatus).toHaveBeenCalled();
      expect(read().turn?.pendingTool?.name).toBe("purge");

      release();
      await sending;
      // The poll must stop, or a disposed widget keeps calling into main forever.
      const afterTurn = turnStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(TURN_STATUS_POLL_MS * 4);
      expect(turnStatus.mock.calls.length).toBe(afterTurn);
      // Stale progress must not survive the turn it described.
      expect(read().turn).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fail a turn when the status read fails", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const turnStatus = vi.fn(async () => { throw new Error("status unavailable"); });
      const { widget, read } = widgetWith({ send: vi.fn(async () => { await gate; return state({ messages: [{ id: "m", threadId: "main", sequence: 1, role: "assistant", text: "done", createdAt: "now" }] }); }), turnStatus });
      const sending = widget.send("go");
      await vi.advanceTimersByTimeAsync(TURN_STATUS_POLL_MS * 2);
      release();
      await sending;
      // Status is only an explanation, so losing it must not surface as a failed answer.
      expect(read().error).toBeUndefined();
      expect(read().messages).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the running turn to stop without reporting it as finished", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cancelTurn = vi.fn(async () => undefined);
    const { widget, read } = widgetWith({ send: vi.fn(async () => { await gate; return state(); }), cancelTurn });
    const sending = widget.send("go");
    await widget.stop();

    expect(cancelTurn).toHaveBeenCalledWith(ORRERY_INTELLIGENCE_THREAD_ID);
    // Still sending: the confirmed work is finishing, and saying otherwise would misreport it.
    expect(read().sending).toBe(true);
    release();
    await sending;
    expect(read().sending).toBe(false);
  });

  it("ignores a stop when no turn is running", async () => {
    const cancelTurn = vi.fn(async () => undefined);
    const { widget } = widgetWith({ cancelTurn });
    await widget.stop();
    expect(cancelTurn).not.toHaveBeenCalled();
  });

  it("surfaces a failed stop without ending the turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { widget, read } = widgetWith({
      send: vi.fn(async () => { await gate; return state(); }),
      cancelTurn: vi.fn(async () => { throw new Error("could not stop"); }),
    });
    const sending = widget.send("go");
    await widget.stop();
    expect(read().error).toBe("could not stop");
    expect(read().sending).toBe(true);
    release();
    await sending;
  });
});
