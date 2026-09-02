import * as React from "@theia/core/shared/react";
import type { MissionCreateInput, MissionMode, ReviewDecision } from "../common/mission-control-contracts";
import type { MissionControlState } from "../common/mission-control-types";

export interface MissionControlViewProps {
  readonly state: MissionControlState;
  readonly onSelect: (missionId: string) => void;
  readonly onRefresh: () => void;
  readonly onReview: (decision: ReviewDecision) => void;
  readonly onIntake: (path: string) => void;
  readonly onCreate: (input: Omit<MissionCreateInput, "intentId">) => void;
  readonly onRun: () => void;
  readonly onCancel: () => void;
}

const label = (value: string) => value.replaceAll("_", " ");

export function MissionControlView({ state, onSelect, onRefresh, onReview, onIntake, onCreate, onRun, onCancel }: MissionControlViewProps): React.JSX.Element {
  const mission = state.selected;
  const reviewReady = mission?.status === "ready_for_review" && !state.pendingReview;
  return <section className="orrery-mission-control" aria-label="Mission Control" aria-busy={state.loading || undefined}>
    <header>
      <h2>Mission Control</h2>
      <button type="button" onClick={onRefresh} aria-label="Refresh missions">Refresh</button>
    </header>
    {state.error && <p role="alert">{state.error}</p>}
    {state.pendingAction && <p aria-live="polite">{state.pendingAction}</p>}
    {state.repository && <p><strong>Repository:</strong> <code>{state.repository.canonicalRoot}</code></p>}
    <form onSubmit={(event) => { event.preventDefault(); const path = new FormData(event.currentTarget).get("path"); if (typeof path === "string" && path.trim()) onIntake(path.trim()); }}><label>Repository path <input name="path" required /></label><button type="submit" disabled={state.loading}>Approve repository</button></form>
    {state.repository && <form aria-label="Create mission" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const text = (name: string) => String(data.get(name) ?? "").trim();
      const lines = (name: string) => text(name).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      onCreate({ repositoryId: state.repository!.repositoryId, title: text("title"), goal: text("goal"), mode: text("mode") as MissionMode, plan: { scope: text("scope"), actions: lines("actions"), acceptanceCriteria: lines("criteria") } });
    }}>
      <h3>New mission</h3>
      <label>Title <input name="title" required maxLength={8192} /></label>
      <label>Goal <textarea name="goal" required maxLength={8192} /></label>
      <label>Mode <select name="mode" defaultValue="build"><option value="explore">Explore</option><option value="plan">Plan</option><option value="build">Build</option><option value="delegate">Delegate</option></select></label>
      <label>Scope <textarea name="scope" required maxLength={8192} /></label>
      <label>Actions, one per line <textarea name="actions" required maxLength={8192} /></label>
      <label>Acceptance criteria, one per line <textarea name="criteria" required maxLength={8192} /></label>
      <button type="submit" disabled={state.loading}>Create mission</button>
    </form>}
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
        <button type="button" disabled={state.loading || ["running", "queued"].includes(mission.status)} onClick={onRun}>Run mission</button>
        <button type="button" disabled={state.loading || !mission.activeRunId} onClick={onCancel}>Cancel run</button>
        <button type="button" disabled={!reviewReady} onClick={() => onReview("rejected")}>Reject</button>
        <button type="button" disabled={!reviewReady} onClick={() => onReview("revision_requested")}>Request revision</button>
        <button type="button" disabled={!reviewReady} onClick={() => onReview("accepted")}>Accept mission</button>
      </div>
    </article>}
  </section>;
}
