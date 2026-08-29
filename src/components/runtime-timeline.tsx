import { Check, Clock, ShieldWarning, X } from "@phosphor-icons/react";
import type { Mission } from "../domain/mission";

export function RuntimeTimeline({
  mission,
  onResolve,
}: {
  mission: Mission;
  onResolve: (runId: string, requestId: string, decision: "allowed" | "denied") => void;
}) {
  const pending = ["running", "blocked"].includes(mission.status) && mission.activeRunId
    ? [...mission.events]
        .reverse()
        .find(
          (event) =>
            event.kind === "capability_request" &&
            event.runId === mission.activeRunId &&
            !event.capability?.resolved,
        )
    : undefined;

  return (
    <section className="timeline-panel" aria-labelledby="timeline-title">
      <header className="panel-header compact">
        <div>
          <span className="eyebrow">Durable event log</span>
          <h2 id="timeline-title">Runtime timeline</h2>
        </div>
        <span className="event-count">{mission.events.length.toString().padStart(2, "0")}</span>
      </header>
      {pending?.capability && (
        <section className="permission-prompt" aria-label="Permission required">
          <div className="permission-title">
            <ShieldWarning size={20} weight="duotone" />
            <div><span className="eyebrow">Guarded capability</span><h3>Permission required</h3></div>
          </div>
          <dl>
            <div><dt>Capability</dt><dd>{pending.capability.capability}</dd></div>
            <div><dt>Scope</dt><dd>{pending.capability.scope}</dd></div>
            <div><dt>Reason</dt><dd>{pending.capability.reason}</dd></div>
          </dl>
          <div className="permission-actions">
            <button className="button secondary" onClick={() => onResolve(pending.capability!.runId, pending.capability!.requestId, "denied")}><X size={14} /> Deny</button>
            <button className="button primary" onClick={() => onResolve(pending.capability!.runId, pending.capability!.requestId, "allowed")}><Check size={14} /> Allow once</button>
          </div>
        </section>
      )}
      {mission.events.length === 0 ? (
        <div className="inline-empty"><Clock size={19} /><p>Activity will appear here after the fixture run starts.</p></div>
      ) : (
        <ol className="event-list">
          {mission.events.map((event) => (
            <li key={event.id} data-kind={event.kind}>
              <span className="event-sequence">{event.sequence.toString().padStart(2, "0")}</span>
              <div><strong>{event.title}</strong><p>{event.detail}</p></div>
              <time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
