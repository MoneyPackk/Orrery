import { Plus, Target, Trash } from "@phosphor-icons/react";
import type { Mission } from "../domain/mission";

export function MissionList({
  missions,
  activeId,
  onSelect,
  onCreate,
  onReset,
}: {
  missions: Mission[];
  activeId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onReset: () => void;
}) {
  return (
    <aside className="mission-sidebar" aria-label="Mission control">
      <header className="sidebar-header">
        <div>
          <span className="eyebrow">Project / Orrery</span>
          <h2>Missions</h2>
        </div>
        <button className="icon-button accent" aria-label="Create mission shortcut" onClick={onCreate}>
          <Plus size={18} weight="bold" />
        </button>
      </header>
      {missions.length === 0 ? (
        <div className="empty-state">
          <Target size={26} weight="duotone" />
          <strong>No missions in this project</strong>
          <p>Define a goal, approve its plan, then run it in an isolated workspace.</p>
          <button className="text-button" onClick={onCreate}>Create the first mission</button>
        </div>
      ) : (
        <nav aria-label="Missions" className="mission-nav">
          {missions.map((mission) => (
            <button
              key={mission.id}
              className="mission-row"
              data-active={mission.id === activeId}
              onClick={() => onSelect(mission.id)}
              aria-label={`${mission.title}, ${mission.status}`}
            >
              <span className="mission-row-top">
                <strong>{mission.title}</strong>
                <span className={`status status-${mission.status}`}>{mission.status.replaceAll("_", " ")}</span>
              </span>
              <span className="mission-goal">{mission.goal}</span>
              <span className="mission-meta">{mission.mode} · rev {mission.plan.revision}</span>
            </button>
          ))}
        </nav>
      )}
      {missions.length > 0 && (
        <footer className="sidebar-footer">
          <button className="text-button danger-text" onClick={onReset}>
            <Trash size={14} /> Reset local demo
          </button>
        </footer>
      )}
    </aside>
  );
}
