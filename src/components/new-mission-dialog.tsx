import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "@phosphor-icons/react";
import type { CreateMissionInput, MissionMode } from "../domain/mission";

export function NewMissionDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: CreateMissionInput) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<MissionMode>("build");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      titleRef.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onCreate({
      title: String(form.get("title")),
      goal: String(form.get("goal")),
      mode,
    });
    event.currentTarget.reset();
    setMode("build");
    onClose();
  };

  return (
    <dialog ref={dialogRef} className="mission-dialog" onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
      <form onSubmit={submit}>
        <header className="dialog-header">
          <div>
            <span className="eyebrow">Mission intake</span>
            <h2>Define the outcome</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="dialog-body">
          <label>
            Mission title
            <input ref={titleRef} name="title" required placeholder="e.g. Stabilize workspace search" />
          </label>
          <label>
            Goal
            <textarea
              name="goal"
              required
              rows={3}
              placeholder="State the observable result, not the implementation."
            />
          </label>
          <fieldset>
            <legend>Execution mode</legend>
            <div className="mode-grid">
              {(["explore", "plan", "build", "delegate"] as const).map((item) => (
                <label className="mode-option" key={item}>
                  <input
                    type="radio"
                    name="mode"
                    value={item}
                    checked={mode === item}
                    onChange={() => setMode(item)}
                  />
                  <span>{item}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <footer className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="button primary">Create mission</button>
        </footer>
      </form>
    </dialog>
  );
}
