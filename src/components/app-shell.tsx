import { Moon, Planet, Sun } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useMissions } from "../state/mission-context";
import { MissionList } from "./mission-list";
import { NewMissionDialog } from "./new-mission-dialog";
import { PlanCanvas } from "./plan-canvas";
import { ReviewStudio } from "./review-studio";
import { RuntimeTimeline } from "./runtime-timeline";

type Theme = "system" | "dark" | "light";

export function AppShell() {
  const missions = useMissions();
  const [activeId, setActiveId] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => (window.localStorage.getItem("orrery.theme") as Theme) ?? "system");
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const active = missions.missions.find((mission) => mission.id === activeId) ?? missions.missions[0];

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("orrery.theme", theme);
  }, [theme]);

  const openDialog = () => {
    dialogTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    window.setTimeout(() => dialogTrigger.current?.focus(), 0);
  };

  return (
    <div className="app-shell">
      <header className="command-bar">
        <div className="brand"><Planet size={22} weight="duotone" /><span>ORRERY</span><small>MISSION CONTROL / M0</small></div>
        <div className="command-status"><span>LOCAL</span><span>FIXTURE RUNTIME</span><span>{missions.missions.length.toString().padStart(2, "0")} MISSIONS</span></div>
        <label className="theme-control">
          {theme === "light" ? <Sun size={15} /> : <Moon size={15} />}
          <span className="sr-only">Color theme</span>
          <select aria-label="Color theme" value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
            <option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option>
          </select>
        </label>
      </header>
      {(missions.storageError || missions.runtimeError) && (
        <div className="error-banner" role="alert">
          <span>{missions.storageError ?? missions.runtimeError}</span>
          {missions.storageError && <button className="button secondary danger" onClick={missions.resetDemo}>Reset local data</button>}
        </div>
      )}
      <div className="workbench">
        <div className="mission-sidebar-wrap">
          <MissionList missions={missions.missions} activeId={active?.id} onSelect={setActiveId} onCreate={openDialog} onReset={missions.resetDemo} />
          <button className="sidebar-create button primary" onClick={openDialog}>New mission</button>
        </div>
        {active ? (
          <main className="mission-workspace">
            <header className="mission-header">
              <div><span className="eyebrow">{active.mode} mission / {active.id.slice(-5)}</span><h1>{active.title}</h1><p>{active.goal}</p></div>
              <span className={`status large status-${active.status}`}>{active.status.replaceAll("_", " ")}</span>
            </header>
            <div className="workspace-grid">
              <PlanCanvas mission={active} onUpdate={(plan) => missions.updatePlan(active.id, plan)} onApprove={() => missions.approvePlan(active.id)} onStart={() => { void missions.start(active.id); }} onCancel={() => missions.cancel(active.id)} />
              <RuntimeTimeline mission={active} onResolve={(runId, requestId, decision) => missions.resolveCapability(active.id, runId, requestId, decision)} />
              <ReviewStudio mission={active} onReview={(decision) => missions.review(active.id, decision)} />
            </div>
          </main>
        ) : (
          <main className="welcome-state">
            <div className="orbital-mark" aria-hidden="true"><span /><span /><span /></div>
            <span className="eyebrow">No active mission</span><h1>Delegated work,<br />under observation.</h1>
            <p>Create a mission to bind its goal, plan, isolated workspace, permissions, evidence, and review decision.</p>
          </main>
        )}
      </div>
      <NewMissionDialog open={dialogOpen} onClose={closeDialog} onCreate={(input) => { missions.create(input); setActiveId(undefined); }} />
    </div>
  );
}
