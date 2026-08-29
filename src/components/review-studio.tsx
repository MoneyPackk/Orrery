import { CheckCircle, FileCode, GitDiff, Info, Warning, XCircle } from "@phosphor-icons/react";
import type { Mission } from "../domain/mission";

export function ReviewStudio({
  mission,
  onReview,
}: {
  mission: Mission;
  onReview: (decision: "accept" | "reject" | "request_revision") => void;
}) {
  const ready = mission.status === "ready_for_review";
  return (
    <section className="review-studio" aria-labelledby="review-title">
      <header className="panel-header compact">
        <div><span className="eyebrow">Change snapshot</span><h2 id="review-title">Review studio</h2></div>
        <GitDiff size={19} />
      </header>
      {!mission.completionSummary ? (
        <div className="inline-empty"><Warning size={18} /><p>Review unlocks when execution records a completion summary and evidence.</p></div>
      ) : (
        <>
          <div className="completion-summary"><span className="eyebrow">Completion reason</span><p>{mission.completionSummary}</p></div>
          <div className="review-grid">
            <section aria-labelledby="changes-title">
              <h3 id="changes-title">Changed files <span>{mission.changes.length}</span></h3>
              {mission.changes.map((change) => (
                <details key={change.path} open>
                  <summary><FileCode size={15} /><span>{change.path}</span><small>+{change.additions} −{change.deletions}</small></summary>
                  <pre>{change.diff}</pre>
                </details>
              ))}
            </section>
            <section aria-labelledby="evidence-title">
              <h3 id="evidence-title">Evidence <span>{mission.evidence.length}</span></h3>
              {mission.evidence.map((evidence) => (
                <div className={`evidence evidence-${evidence.status}`} key={evidence.id} role="status" aria-label={`${evidence.status} evidence`}>
                  {evidence.status === "passed" ? <CheckCircle size={17} weight="fill" aria-hidden="true" /> :
                    evidence.status === "failed" ? <XCircle size={17} weight="fill" aria-hidden="true" /> :
                    evidence.status === "warning" ? <Warning size={17} weight="fill" aria-hidden="true" /> :
                    <Info size={17} weight="fill" aria-hidden="true" />}
                  <div><strong>{evidence.summary}</strong><small>{evidence.criterion ?? evidence.kind}</small></div>
                </div>
              ))}
            </section>
          </div>
        </>
      )}
      <footer className="review-actions">
        <button className="button secondary danger" disabled={!ready} onClick={() => onReview("reject")}>Reject</button>
        <button className="button secondary" disabled={!ready} onClick={() => onReview("request_revision")}>Request revision</button>
        <button className="button primary" disabled={!ready} onClick={() => onReview("accept")}>Accept mission</button>
      </footer>
    </section>
  );
}
