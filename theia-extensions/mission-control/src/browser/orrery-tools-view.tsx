import * as React from "@theia/core/shared/react";
import type { McpActivityEntry, McpRegisterInput, McpServerStatus, McpToolDecision, McpToolRisk, McpToolStatus, McpTransportKind } from "../common/mission-control-contracts";
import type { OrreryToolsState } from "../common/mission-control-types";

export interface OrreryToolsViewProps {
  readonly state: OrreryToolsState;
  readonly onRefresh: () => void;
  /** Resolves true when the server was actually added, which is when the form may reset. */
  readonly onRegister: (input: Omit<McpRegisterInput, "intentId">) => Promise<boolean> | void;
  readonly onRemove: (serverId: string) => void;
  readonly onDecide: (serverId: string, name: string, decision: McpToolDecision) => void;
  readonly onInvoke: (serverId: string, name: string, args: Readonly<Record<string, unknown>>) => void;
}

/** Plain-language description of what a risk class permits. */
const RISK_LABEL: Readonly<Record<McpToolRisk, string>> = {
  read: "Reads data",
  write: "Changes data",
  destructive: "Deletes data",
  network: "Sends data out",
  spend: "Can spend money",
};

/** `-` is legal inside both a server id and a tool name; `/` is not, so it cannot collide. */
function toolKey(tool: Pick<McpToolStatus, "serverId" | "name">): string {
  return `${tool.serverId}/${tool.name}`;
}

export function OrreryToolsView(props: OrreryToolsViewProps): React.ReactElement {
  const { state } = props;
  const busy = state.loading === true || state.pending === true;
  return (
    <section className="orrery-tools" aria-label="Orrery Tools" aria-busy={busy || undefined}>
      <header className="orrery-tools__header">
        <div>
          <h2>Orrery Tools</h2>
          <p className="orrery-tools__status">
            {state.loading
              ? "Loading…"
              : `${state.servers.length} ${state.servers.length === 1 ? "server" : "servers"} · ${state.tools.length} ${state.tools.length === 1 ? "tool" : "tools"}`}
          </p>
        </div>
        <div className="orrery-tools__actions">
          <button type="button" onClick={props.onRefresh} disabled={state.pending}>Refresh</button>
        </div>
      </header>

      {state.error ? <p className="orrery-tools__error" role="alert">{state.error}</p> : undefined}
      {state.notice ? <p className="orrery-tools__notice" role="status">{state.notice}</p> : undefined}

      <RegisterForm onRegister={props.onRegister} disabled={state.pending} />

      <section className="orrery-tools__section" aria-labelledby="orrery-tools-servers">
        <h3 id="orrery-tools-servers">Servers</h3>
        {state.servers.length === 0
          ? <p className="orrery-tools__empty">No tool servers yet. Add one above. Orrery asks you to confirm before it runs anything.</p>
          : (
            <ul className="orrery-tools__list" aria-label="Servers">
              {state.servers.map(server => (
                <ServerRow key={server.serverId} server={server} disabled={state.pending === true} onRemove={props.onRemove} />
              ))}
            </ul>
          )}
      </section>

      <section className="orrery-tools__section" aria-labelledby="orrery-tools-catalog">
        <h3 id="orrery-tools-catalog">Tools</h3>
        {state.tools.length === 0
          ? <p className="orrery-tools__empty">No tools discovered. A server must be reachable for Orrery to list what it offers.</p>
          : (
            <ul className="orrery-tools__list" aria-label="Tools">
              {state.tools.map(tool => (
                <ToolRow
                  key={`${toolKey(tool)}#${tool.risk}#${tool.description}`}
                  tool={tool}
                  disabled={state.pending === true}
                  onDecide={props.onDecide}
                  onInvoke={props.onInvoke}
                />
              ))}
            </ul>
          )}
      </section>

      {state.lastResult ? (
        <section className="orrery-tools__section" aria-labelledby="orrery-tools-result" aria-live="polite">
          <h3 id="orrery-tools-result">Last result</h3>
          <p className="orrery-tools__meta">
            {state.lastResult.name} · {state.lastResult.isError ? "reported an error" : "completed"}
            {state.lastResult.truncated ? " · output truncated" : ""}
          </p>
          {/* Untrusted server output: always plain text, never markup. */}
          <pre className="orrery-tools__output">{state.lastResult.content}</pre>
        </section>
      ) : undefined}

      <section className="orrery-tools__section" aria-labelledby="orrery-tools-activity">
        <h3 id="orrery-tools-activity">Activity</h3>
        {state.activity.length === 0
          ? <p className="orrery-tools__empty">Nothing has run yet.</p>
          : (
            <ol className="orrery-tools__activity" aria-label="Activity">
              {[...state.activity].reverse().map(entry => <ActivityRow key={entry.sequence} entry={entry} />)}
            </ol>
          )}
      </section>
    </section>
  );
}

function ServerRow(props: {
  readonly server: McpServerStatus;
  readonly disabled: boolean;
  readonly onRemove: (serverId: string) => void;
}): React.ReactElement {
  const { server } = props;
  const [confirming, setConfirming] = React.useState(false);

  return (
    <li className="orrery-tools__server">
      <div className="orrery-tools__server-head">
        <span className="orrery-tools__server-name">{server.label}</span>
        {confirming
          ? (
            <span className="orrery-tools__confirm">
              <button
                type="button"
                className="orrery-tools__destructive"
                aria-label={`Confirm removing ${server.label}`}
                onClick={() => { setConfirming(false); props.onRemove(server.serverId); }}
                disabled={props.disabled}
              >
                Remove
              </button>
              <button type="button" onClick={() => setConfirming(false)} disabled={props.disabled}>Keep</button>
            </span>
          )
          : (
            <button
              type="button"
              className="orrery-tools__destructive"
              aria-label={`Remove ${server.label}`}
              onClick={() => setConfirming(true)}
              disabled={props.disabled}
            >
              Remove…
            </button>
          )}
      </div>
      <p className="orrery-tools__meta">
        {server.transport} · {server.origin} · {server.toolCount} {server.toolCount === 1 ? "tool" : "tools"}
        {server.enabled ? "" : " · disabled"}
      </p>
      {confirming
        ? <p className="orrery-tools__warn">Removing this server also discards every permission you granted its tools. This cannot be undone.</p>
        : undefined}
    </li>
  );
}

function ToolRow(props: {
  readonly tool: McpToolStatus;
  readonly disabled: boolean;
  readonly onDecide: (serverId: string, name: string, decision: McpToolDecision) => void;
  readonly onInvoke: (serverId: string, name: string, args: Readonly<Record<string, unknown>>) => void;
}): React.ReactElement {
  const { tool } = props;
  const [args, setArgs] = React.useState("{}");
  const [argsError, setArgsError] = React.useState<string | undefined>(undefined);
  const argsId = `orrery-tool-args-${toolKey(tool)}`;

  const run = () => {
    const source = args.trim().length === 0 ? "{}" : args;
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch {
      setArgsError("Arguments must be valid JSON.");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setArgsError("Arguments must be a JSON object.");
      return;
    }
    setArgsError(undefined);
    // Main re-validates shape, depth, and size, and re-derives risk before asking the user.
    props.onInvoke(tool.serverId, tool.name, parsed as Record<string, unknown>);
  };

  return (
    <li className="orrery-tools__tool">
      <div className="orrery-tools__tool-head">
        <span className="orrery-tools__tool-name">{tool.title.trim().length > 0 ? tool.title : tool.name}</span>
        <span className={`orrery-tools__risk orrery-tools__risk--${tool.risk}`}>{RISK_LABEL[tool.risk] ?? tool.risk}</span>
      </div>
      <p className="orrery-tools__meta">{tool.serverId} · {tool.name}</p>
      {tool.description ? <p className="orrery-tools__description">{tool.description}</p> : undefined}

      <label className="orrery-tools__field" htmlFor={argsId}>
        Arguments (JSON)
        <textarea
          id={argsId}
          rows={2}
          value={args}
          spellCheck={false}
          maxLength={8000}
          disabled={props.disabled}
          onChange={event => { setArgs(event.target.value); setArgsError(undefined); }}
        />
      </label>
      {argsError ? <p className="orrery-tools__error" role="alert">{argsError}</p> : undefined}

      <div className="orrery-tools__tool-actions">
        <button type="button" aria-label={`Run ${tool.name}`} onClick={run} disabled={props.disabled}>Run…</button>
        {tool.alwaysAsk
          ? <span className="orrery-tools__always">Asks every time</span>
          : (
            <label className="orrery-tools__permission" htmlFor={`orrery-tool-decision-${toolKey(tool)}`}>
              Permission
              <select
                id={`orrery-tool-decision-${toolKey(tool)}`}
                aria-label={`Permission for ${tool.name}`}
                value={tool.decision}
                disabled={props.disabled}
                onChange={event => props.onDecide(tool.serverId, tool.name, event.target.value as McpToolDecision)}
              >
                <option value="ask">Ask every time</option>
                <option value="allow">Always allow</option>
                <option value="deny">Never allow</option>
              </select>
            </label>
          )}
      </div>
    </li>
  );
}

function ActivityRow(props: { readonly entry: McpActivityEntry }): React.ReactElement {
  const { entry } = props;
  return (
    <li className={`orrery-tools__entry orrery-tools__entry--${entry.outcome}`}>
      <span className="orrery-tools__entry-name">{entry.name}</span>
      <span className="orrery-tools__meta">
        {entry.outcome} · {entry.serverId} · {entry.at}
      </span>
      {entry.reason ? <span className="orrery-tools__meta">{entry.reason}</span> : undefined}
    </li>
  );
}

function RegisterForm(props: {
  readonly onRegister: (input: Omit<McpRegisterInput, "intentId">) => Promise<boolean> | void;
  readonly disabled?: boolean;
}): React.ReactElement {
  const [transport, setTransport] = React.useState<McpTransportKind>("stdio");
  const [serverId, setServerId] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [command, setCommand] = React.useState("");
  const [args, setArgs] = React.useState("");
  const [endpoint, setEndpoint] = React.useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const base = { serverId: serverId.trim(), label: label.trim(), transport };
    const input = transport === "stdio"
      ? { ...base, command: command.trim(), args: args.split("\n").map(item => item.trim()).filter(item => item.length > 0) }
      : { ...base, endpoint: endpoint.trim() };
    // Clear only once the server is actually registered. Re-registering an existing id
    // discards its remembered permissions, so an accidental second submit is destructive.
    void Promise.resolve(props.onRegister(input)).then(added => {
      if (added !== true) return;
      setServerId("");
      setLabel("");
      setCommand("");
      setArgs("");
      setEndpoint("");
    });
  };

  const complete = serverId.trim().length > 0 && label.trim().length > 0
    && (transport === "stdio" ? command.trim().length > 0 : endpoint.trim().length > 0);

  return (
    <form className="orrery-tools__register" onSubmit={submit}>
      <p className="orrery-tools__note">
        Adding a server lets Orrery run it on this machine. You will be asked to confirm, and shown the exact command.
      </p>
      <label className="orrery-tools__field" htmlFor="orrery-tools-transport">
        Transport
        <select id="orrery-tools-transport" value={transport} disabled={props.disabled} onChange={event => setTransport(event.target.value as McpTransportKind)}>
          <option value="stdio">Local program (stdio)</option>
          <option value="http">Remote endpoint (https)</option>
        </select>
      </label>
      <label className="orrery-tools__field" htmlFor="orrery-tools-id">
        Identifier
        <input id="orrery-tools-id" value={serverId} disabled={props.disabled} onChange={event => setServerId(event.target.value)} />
      </label>
      <label className="orrery-tools__field" htmlFor="orrery-tools-label">
        Name
        <input id="orrery-tools-label" value={label} disabled={props.disabled} onChange={event => setLabel(event.target.value)} />
      </label>
      {transport === "stdio" ? (
        <>
          <label className="orrery-tools__field" htmlFor="orrery-tools-command">
            Program (absolute path)
            <input id="orrery-tools-command" value={command} disabled={props.disabled} onChange={event => setCommand(event.target.value)} />
          </label>
          <label className="orrery-tools__field" htmlFor="orrery-tools-args">
            Arguments (one per line)
            <textarea id="orrery-tools-args" rows={2} value={args} spellCheck={false} disabled={props.disabled} onChange={event => setArgs(event.target.value)} />
          </label>
        </>
      ) : (
        <label className="orrery-tools__field" htmlFor="orrery-tools-endpoint">
          Endpoint
          <input id="orrery-tools-endpoint" value={endpoint} disabled={props.disabled} onChange={event => setEndpoint(event.target.value)} />
        </label>
      )}
      <button type="submit" disabled={props.disabled || !complete}>Add server…</button>
    </form>
  );
}
