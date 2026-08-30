import * as React from "@theia/core/shared/react";
import type { ReviewDecision } from "../common/mission-control-contracts";
import type { MissionControlState } from "../common/mission-control-types";

export interface MissionControlViewProps {
  readonly state: MissionControlState;
  readonly onSelect: (missionId: string) => void;
  readonly onRefresh: () => void;
  readonly onReview: (decision: ReviewDecision) => void;
}

const label = (value: string) => value.replaceAll("_", " ");

export function MissionControlView({ state, onSelect, onRefresh, onReview }: MissionControlViewProps): React.JSX.Element {
  const mission = state.selected;
  const reviewReady = mission?.status === "ready_for_review" && !state.pendingReview;
  return <section className="orrery-mission-control" aria-label="Mission Control" aria-busy={state.loading || undefined}>
    <header>
      <h2>Mission Control</h2>
      <button type="button" onClick={onRefresh} aria-label="Refresh missions">Refresh</button>
    </header>
    {state.error && <p role="alert">{state.error}</p>}
    {!state.loading && state.missions.length === 0 && <p>No missions are available from the desktop daemon.</p>}
    <ul aria-label="Missions">
      {state.missions.map((item) => <li key={item.id}>
        <button type="button" aria-current={item.id === state.selectedId ? "true" : undefined} onClick={() => onSelect(item.id)}>
          <span>{item.title}</span> <small>{label(item.status)}</small>
        </button>
      </li>)}
    </ul>
    {mission && <article aria-labelledby="orrery-mission-title">
      <header><p>{mission.mode}</p><h3 id="orrery-mission-title">{mission.title}</h3><strong>{label(mission.status)}</strong></header>
      <p>{mission.goal}</p>
      <dl>
        <dt>Target</dt><dd>{mission.targetBranch}</dd>
        <dt>Mission branch</dt><dd>{mission.missionBranch ?? "Not assigned"}</dd>
        <dt>Plan revision</dt><dd>{mission.plan.revision}</dd>
      </dl>
      {mission.completionSummary && <section aria-labelledby="orrery-summary"><h4 id="orrery-summary">Completion</h4><p>{mission.completionSummary}</p></section>}
      <section aria-labelledby="orrery-changes"><h4 id="orrery-changes">Changes</h4>
        {mission.changes.length === 0 ? <p>No changed files recorded.</p> : <ul>{mission.changes.map((change) => <li key={change.path}><code>{change.path}</code> <span>+{change.additions} -{change.deletions}</span></li>)}</ul>}
      </section>
      <section aria-labelledby="orrery-evidence"><h4 id="orrery-evidence">Evidence</h4>
        {mission.evidence.length === 0 ? <p>No evidence recorded.</p> : <ul>{mission.evidence.map((evidence) => <li key={evidence.id}><strong>{label(evidence.status)}</strong> {evidence.summary}</li>)}</ul>}
      </section>
      <div role="group" aria-label="Mission review">
        <button type="button" disabled={!reviewReady} onClick={() => onReview("rejected")}>Reject</button>
        <button type="button" disabled={!reviewReady} onClick={() => onReview("revision_requested")}>Request revision</button>
        <button type="button" disabled={!reviewReady} onClick={() => onReview("accepted")}>Accept mission</button>
      </div>
    </article>}
  </section>;
}
