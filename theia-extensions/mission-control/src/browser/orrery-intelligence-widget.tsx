import * as React from "@theia/core/shared/react";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import type { IntelligenceSettingsInput } from "../common/mission-control-contracts";
import { OrreryIntelligenceService, type OrreryIntelligenceState } from "../common/mission-control-types";
import { OrreryIntelligenceView } from "./orrery-intelligence-view";
import { ensureOrreryIntelligenceStyle } from "./orrery-intelligence-style";

export const ORRERY_INTELLIGENCE_WIDGET_ID = "orrery-intelligence";
export const ORRERY_INTELLIGENCE_THREAD_ID = "main";

@injectable()
export class OrreryIntelligenceWidget extends ReactWidget {
  protected state: OrreryIntelligenceState = {
    threadId: ORRERY_INTELLIGENCE_THREAD_ID,
    messages: [],
    settings: { configured: false, hasCredential: false },
    loading: true,
  };
  private pending = false;

  @inject(OrreryIntelligenceService)
  protected readonly service!: OrreryIntelligenceService;

  @postConstruct()
  protected initialize(): void {
    this.id = ORRERY_INTELLIGENCE_WIDGET_ID;
    this.title.label = "Orrery Intelligence";
    this.title.caption = "Orrery Intelligence";
    this.title.closable = true;
    this.addClass("orrery-intelligence-widget");
    ensureOrreryIntelligenceStyle();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.state = { ...this.state, loading: true, error: undefined };
    this.update();
    await this.settle(() => this.service.load(this.state.threadId), "Unable to load Orrery Intelligence.");
  }

  async send(text: string): Promise<void> {
    if (this.pending || !text.trim()) return;
    this.pending = true;
    this.state = { ...this.state, sending: true, error: undefined };
    this.update();
    try {
      this.state = { ...await this.service.send(this.state.threadId, text.trim()), sending: false };
    } catch (error) {
      this.state = { ...this.state, sending: false, error: message(error, "Orrery Intelligence could not answer.") };
    } finally {
      this.pending = false;
      this.update();
    }
  }

  async clear(): Promise<void> {
    await this.settle(() => this.service.clear(this.state.threadId), "Unable to clear the conversation.");
  }

  async configure(input: Omit<IntelligenceSettingsInput, "intentId">): Promise<void> {
    await this.settle(() => this.service.configure(input), "Unable to save provider settings.");
  }

  private async settle(operation: () => Promise<OrreryIntelligenceState>, fallback: string): Promise<void> {
    if (this.pending) return;
    this.pending = true;
    try {
      this.state = { ...await operation(), loading: false };
    } catch (error) {
      this.state = { ...this.state, loading: false, error: message(error, fallback) };
    } finally {
      this.pending = false;
      this.update();
    }
  }

  protected render(): React.ReactNode {
    return <OrreryIntelligenceView
      state={this.state}
      onSend={text => void this.send(text)}
      onClear={() => void this.clear()}
      onConfigure={input => void this.configure(input)}
    />;
  }
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}
