import { Minus, Play, Plus, SealCheck, Stop } from "@phosphor-icons/react";
import { useEffect, useState, type FormEvent } from "react";
import type { Mission, PlanContent } from "../domain/mission";

export function PlanCanvas({
  mission,
  onUpdate,
  onApprove,
  onStart,
  onCancel,
}: {
  mission: Mission;
  onUpdate: (plan: PlanContent) => void;
  onApprove: () => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  const [scope, setScope] = useState(mission.plan.scope);
  const [actions, setActions] = useState(mission.plan.actions.length ? mission.plan.actions : [""]);
  const [criteria, setCriteria] = useState(mission.plan.acceptanceCriteria.length ? mission.plan.acceptanceCriteria : [""]);
  const editable = mission.mode !== "explore" && ["draft", "planning", "revision_requested"].includes(mission.status);

  useEffect(() => {
    setScope(mission.plan.scope);
    setActions(mission.plan.actions.length ? mission.plan.actions : [""]);
    setCriteria(mission.plan.acceptanceCriteria.length ? mission.plan.acceptanceCriteria : [""]);
  }, [mission.id, mission.plan]);

  const save = (event: FormEvent) => {
    event.preventDefault();
    onUpdate({ scope, actions, acceptanceCriteria: criteria });
  };

  return (
    <section className="plan-canvas" aria-labelledby="plan-title">
      <header className="panel-header">
        <div>
          <span className="eyebrow">Plan canvas / revision {mission.plan.revision}</span>
          <h2 id="plan-title">Execution contract</h2>
        </div>
        <span className={mission.plan.approved ? "approval approved" : "approval"}>
          <SealCheck size={15} weight={mission.plan.approved ? "fill" : "regular"} />
          {mission.plan.approved ? "Approved" : "Unapproved"}
        </span>
      </header>
      <form className="plan-form" onSubmit={save}>
        <label>
          <span><b>Scope</b><small>What changes and what remains untouched</small></span>
          <textarea aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value)} disabled={!editable} rows={4} required />
        </label>
        {actions.map((action, index) => (
          <label key={`action-${index}`}>
            <span><b>Action {index + 1}</b><small>Ordered execution step</small></span>
            <span className="plan-array-input"><input aria-label={`Action ${index + 1}`} value={action} onChange={(e) => setActions((items) => items.map((item, itemIndex) => itemIndex === index ? e.target.value : item))} disabled={!editable} required /><button type="button" className="icon-button" aria-label={`Remove action ${index + 1}`} disabled={!editable || actions.length === 1} onClick={() => setActions((items) => items.filter((_, itemIndex) => itemIndex !== index))}><Minus size={13} /></button></span>
          </label>
        ))}
        {editable && <button type="button" className="text-button plan-add" onClick={() => setActions((items) => [...items, ""])}><Plus size={13} /> Add action</button>}
        {criteria.map((criterion, index) => (
          <label key={`criterion-${index}`}>
            <span><b>Acceptance criterion {index + 1}</b><small>Observable proof of completion</small></span>
            <span className="plan-array-input"><input aria-label={`Acceptance criterion ${index + 1}`} value={criterion} onChange={(e) => setCriteria((items) => items.map((item, itemIndex) => itemIndex === index ? e.target.value : item))} disabled={!editable} required /><button type="button" className="icon-button" aria-label={`Remove acceptance criterion ${index + 1}`} disabled={!editable || criteria.length === 1} onClick={() => setCriteria((items) => items.filter((_, itemIndex) => itemIndex !== index))}><Minus size={13} /></button></span>
          </label>
        ))}
        {editable && <button type="button" className="text-button plan-add" onClick={() => setCriteria((items) => [...items, ""])}><Plus size={13} /> Add acceptance criterion</button>}
        <div className="plan-actions">
          <button type="submit" className="button secondary" disabled={!editable}>Save plan</button>
          <button
            type="button"
            className="button secondary"
            onClick={onApprove}
            disabled={!editable || !mission.plan.scope.trim() || mission.plan.actions.some((item) => !item.trim()) || mission.plan.acceptanceCriteria.some((item) => !item.trim())}
          >
            Approve plan
          </button>
          <button
            type="button"
            className="button primary"
            onClick={onStart}
            disabled={mission.status !== "queued" || mission.mode !== "build"}
          >
            <Play size={15} weight="fill" /> Start fixture run
          </button>
          <button
            type="button"
            className="button secondary danger"
            onClick={onCancel}
            disabled={!mission.activeRunId && mission.status !== "blocked"}
          >
            <Stop size={15} weight="fill" /> Cancel run
          </button>
        </div>
      </form>
      <dl className="workspace-ledger">
        <div><dt>Target</dt><dd>{mission.targetBranch}</dd></div>
        <div><dt>Mission branch</dt><dd>{mission.missionBranch ?? "Reserved on start"}</dd></div>
        <div><dt>Workspace</dt><dd>{mission.workspaceId ?? "Isolation pending"}</dd></div>
      </dl>
    </section>
  );
}
