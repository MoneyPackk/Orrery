import { describe, expect, it, vi } from "vitest";
import type { OrreryIntelligenceService, OrreryIntelligenceState } from "../common/mission-control-types";
import { ORRERY_INTELLIGENCE_THREAD_ID, ORRERY_INTELLIGENCE_WIDGET_ID, OrreryIntelligenceWidget } from "./orrery-intelligence-widget";

const state = (overrides: Partial<OrreryIntelligenceState> = {}): OrreryIntelligenceState => ({
  threadId: ORRERY_INTELLIGENCE_THREAD_ID,
  messages: [],
  settings: { configured: true, hasCredential: true, provider: "anthropic", model: "claude-x" },
  ...overrides,
});

function widgetWith(service: Partial<OrreryIntelligenceService>): { widget: OrreryIntelligenceWidget; read: () => OrreryIntelligenceState } {
  class TestWidget extends OrreryIntelligenceWidget {
    protected override update(): void {}
    snapshot(): OrreryIntelligenceState { return this.state; }
  }
  const widget = new TestWidget();
  Object.defineProperty(widget, "service", { value: { load: vi.fn(async () => state()), send: vi.fn(async () => state()), clear: vi.fn(async () => state()), configure: vi.fn(async () => state()), ...service } });
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
});
