import * as React from "@theia/core/shared/react";
import type { IntelligenceProviderKind, IntelligenceSettingsInput, IntelligenceToolCall } from "../common/mission-control-contracts";
import type { OrreryIntelligenceState } from "../common/mission-control-types";

export interface OrreryIntelligenceViewProps {
  readonly state: OrreryIntelligenceState;
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
  readonly onClear: () => void;
  readonly onConfigure: (input: Omit<IntelligenceSettingsInput, "intentId">) => void;
}

const PROVIDER_LABELS: ReadonlyArray<{ readonly value: IntelligenceProviderKind; readonly label: string; readonly placeholder: string }> = [
  { value: "openai-compatible", label: "[OI]-compatible", placeholder: "https://api.openai.com/v1" },
  { value: "anthropic", label: "Anthropic", placeholder: "https://api.anthropic.com" },
  { value: "ollama", label: "Ollama (local)", placeholder: "http://127.0.0.1:11434" },
];

const OUTCOME_LABELS: Readonly<Record<IntelligenceToolCall["outcome"], string>> = {
  ran: "ran",
  error: "reported an error",
  denied: "did not run",
  skipped: "skipped",
};

/**
 * Orrery's own record of what the model ran, rendered outside the model's text.
 *
 * The separation is the guarantee: `message.text` is model-authored and `toolCalls` is not, so
 * a fabricated tool list in the prose cannot appear here. Server-influenced `detail` is
 * rendered as plain text.
 */
function ToolCallRecord({ calls }: { readonly calls: ReadonlyArray<IntelligenceToolCall> }): React.JSX.Element {
  return <section className="orrery-intelligence__tools" aria-label="Tools Orrery ran for this answer">
    <span className="orrery-intelligence__tools-title">Orrery ran {calls.length === 1 ? "1 tool" : `${calls.length} tools`} for this answer</span>
    <ul className="orrery-intelligence__tools-list">
      {calls.map((call, index) => <li key={`${call.serverId}/${call.name}/${index}`} className={`orrery-intelligence__tool orrery-intelligence__tool--${call.outcome}`}>
        <code>{call.serverId}/{call.name}</code>
        <span className="orrery-intelligence__tool-outcome">{OUTCOME_LABELS[call.outcome]}</span>
        {call.detail && <span className="orrery-intelligence__tool-detail">{call.detail}</span>}
      </li>)}
    </ul>
  </section>;
}

export function OrreryIntelligenceView({ state, onSend, onStop, onClear, onConfigure }: OrreryIntelligenceViewProps): React.JSX.Element {
  const [provider, setProvider] = React.useState<IntelligenceProviderKind>(state.settings.provider ?? "openai-compatible");
  const [settingsOpen, setSettingsOpen] = React.useState(!state.settings.configured);
  const busy = Boolean(state.loading || state.sending);
  const placeholder = PROVIDER_LABELS.find(entry => entry.value === provider)?.placeholder ?? "";

  return <section className="orrery-intelligence" aria-label="Orrery Intelligence" aria-busy={busy || undefined}>
    <header className="orrery-intelligence__header">
      <div>
        <h2>Orrery Intelligence</h2>
        <p className="orrery-intelligence__status">
          {state.settings.configured
            ? <>Connected to <strong>{state.settings.model}</strong>{state.settings.endpointHost ? <> via <code>{state.settings.endpointHost}</code></> : null}</>
            : <>Bring your own key to begin.</>}
        </p>
      </div>
      <div className="orrery-intelligence__actions">
        <button type="button" onClick={() => setSettingsOpen(open => !open)} aria-expanded={settingsOpen}>
          {settingsOpen ? "Hide settings" : "Settings"}
        </button>
        <button type="button" onClick={onClear} disabled={busy || state.messages.length === 0}>Clear</button>
      </div>
    </header>

    {state.error && <p className="orrery-intelligence__error" role="alert">{state.error}</p>}

    {settingsOpen && <form className="orrery-intelligence__settings" aria-label="Provider settings" onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const text = (name: string) => String(data.get(name) ?? "").trim();
      onConfigure({ provider: text("provider") as IntelligenceProviderKind, model: text("model"), baseUrl: text("baseUrl"), apiKey: String(data.get("apiKey") ?? "") });
      event.currentTarget.reset();
    }}>
      <label>Provider
        <select name="provider" value={provider} onChange={event => setProvider(event.currentTarget.value as IntelligenceProviderKind)}>
          {PROVIDER_LABELS.map(entry => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
        </select>
      </label>
      <label>Model <input name="model" required maxLength={200} defaultValue={state.settings.model ?? ""} placeholder="model name" /></label>
      <label>Endpoint <input name="baseUrl" required maxLength={2048} placeholder={placeholder} /></label>
      <label>API key <input name="apiKey" type="password" maxLength={4096} autoComplete="off" placeholder={provider === "ollama" ? "not required" : "stored locally, never shown again"} /></label>
      <p className="orrery-intelligence__note">Your key stays on this machine, is protected by the same file permissions as the daemon token, and is never sent to the Orrery interface or any Orrery service.</p>
      <button type="submit" disabled={busy}>Save provider</button>
    </form>}

    <ol className="orrery-intelligence__transcript" aria-label="Conversation">
      {state.messages.map(message => <li key={message.id} className={`orrery-intelligence__message orrery-intelligence__message--${message.role}`}>
        <span className="orrery-intelligence__role">{message.role === "user" ? "You" : "Orrery Intelligence"}</span>
        {message.toolCalls && message.toolCalls.length > 0 && <ToolCallRecord calls={message.toolCalls} />}
        <p className="orrery-intelligence__text">{message.text}</p>
        {message.truncated && <small>Response truncated.</small>}
      </li>)}
    </ol>

    {!busy && state.messages.length === 0 && state.settings.configured && <p className="orrery-intelligence__empty">
      Ask about this repository, a mission plan, or a failure. Orrery Intelligence can explain, plan, and draft. It cannot edit files, run commands, or promote changes.
    </p>}
    {state.sending && <div className="orrery-intelligence__pending" aria-live="polite">
      {state.turn?.pendingTool
        ? <>
          <span>Waiting for you to confirm <code>{state.turn.pendingTool.serverId}/{state.turn.pendingTool.name}</code></span>
          <span className={`orrery-intelligence__pending-risk orrery-intelligence__pending-risk--${state.turn.pendingTool.risk}`}>
            {state.turn.pendingTool.risk}
          </span>
        </>
        : <span>Working. If Orrery needs a tool, it will ask you to confirm before anything runs.</span>}
      {state.turn && state.turn.completed.length > 0 && <span className="orrery-intelligence__pending-progress">
        {state.turn.completed.length} of {state.turn.completed.length + state.turn.remainingCalls} tool calls used
      </span>}
      {state.turn?.stopping
        // Deliberately not "stopped": a confirmed call is still finishing, and saying otherwise
        // would misreport what ran.
        ? <span className="orrery-intelligence__pending-progress">Stopping after the current tool call.</span>
        : <button type="button" className="orrery-intelligence__stop" onClick={onStop}>Stop</button>}
    </div>}

    <form className="orrery-intelligence__composer" aria-label="Send message" onSubmit={event => {
      event.preventDefault();
      const field = event.currentTarget.elements.namedItem("prompt");
      const value = field instanceof HTMLTextAreaElement ? field.value.trim() : "";
      if (!value) return;
      onSend(value);
      event.currentTarget.reset();
    }}>
      <label className="orrery-intelligence__composer-label" htmlFor="orrery-intelligence-prompt">Message</label>
      <textarea id="orrery-intelligence-prompt" name="prompt" rows={3} maxLength={8000} required
        placeholder={state.settings.configured ? "Ask Orrery Intelligence" : "Add your provider key to start"}
        disabled={busy || !state.settings.configured}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }} />
      <button type="submit" disabled={busy || !state.settings.configured}>Send</button>
    </form>
  </section>;
}
