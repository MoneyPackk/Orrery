import * as React from "@theia/core/shared/react";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import type { IntelligenceSettingsInput } from "../common/mission-control-contracts";
import { OrreryIntelligenceService, type OrreryIntelligenceState } from "../common/mission-control-types";
import { OrreryIntelligenceView } from "./orrery-intelligence-view";
import { ensureOrreryIntelligenceStyle } from "./orrery-intelligence-style";

export const ORRERY_INTELLIGENCE_WIDGET_ID = "orrery-intelligence";
export const ORRERY_INTELLIGENCE_THREAD_ID = "main";
/** Frequent enough to explain a modal that is already on screen, slow enough to stay cheap. */
export const TURN_STATUS_POLL_MS = 400;

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
    this.state = { ...this.state, sending: true, error: undefined, turn: undefined };
    this.update();
    // Polled rather than pushed: every other channel is request/response, and a push surface
    // would be a larger security change than this status warrants. The poll is stopped in
    // `finally` so a failed turn cannot leave a timer running against a disposed widget.
    const polling = this.pollTurnStatus();
    try {
      this.state = { ...await this.service.send(this.state.threadId, text.trim()), sending: false };
    } catch (error) {
      this.state = { ...this.state, sending: false, error: message(error, "Orrery Intelligence could not answer.") };
    } finally {
      clearInterval(polling);
      this.pending = false;
      this.state = { ...this.state, turn: undefined };
      this.update();
    }
  }

  /** Refreshes in-flight turn status so the surface can explain a native confirmation. */
  private pollTurnStatus(): ReturnType<typeof setInterval> {
    return setInterval(() => {
      void this.service.turnStatus(this.state.threadId).then(
        turn => {
          // Ignored once the turn is done, so a late poll cannot resurrect stale state.
          if (!this.state.sending) return;
          this.state = { ...this.state, turn };
          this.update();
        },
        // A failed status read must never fail the turn: it is only an explanation.
        () => undefined,
      );
    }, TURN_STATUS_POLL_MS);
  }

  /**
   * Asks the running turn to stop.
   *
   * Does not clear `sending`: the turn is still finishing the work it already confirmed, and
   * reporting it as done would misrepresent what is happening. The surface learns it stopped
   * through turn status, and the turn resolves normally with whatever it managed to do.
   */
  async stop(): Promise<void> {
    if (!this.state.sending) return;
    try {
      await this.service.cancelTurn(this.state.threadId);
    } catch (error) {
      this.state = { ...this.state, error: message(error, "Unable to stop this turn.") };
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
      onStop={() => void this.stop()}
      onClear={() => void this.clear()}
      onConfigure={input => void this.configure(input)}
    />;
  }
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}
