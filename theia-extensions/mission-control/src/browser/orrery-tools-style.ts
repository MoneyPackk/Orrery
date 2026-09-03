const STYLE_ELEMENT_ID = "orrery-tools-style";

/**
 * Orrery Tools styling.
 * Injected at runtime because the extension ships a `tsc`-only build with no CSS asset pipeline.
 * Uses Theia theme variables so the surface follows the active light or dark theme.
 */
export const ORRERY_TOOLS_STYLE = `
.orrery-tools {
  --orrery-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --orrery-radius-inner: 4px;
  --orrery-radius-outer: 7px;
  --orrery-accent: var(--theia-focusBorder, #3794ff);
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  padding: 14px 14px 18px;
  box-sizing: border-box;
  overflow-y: auto;
  overscroll-behavior: contain;
  font-size: var(--theia-ui-font-size1);
  color: var(--theia-foreground);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.orrery-tools__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--theia-editorGroup-border);
}
.orrery-tools__header h2 {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  text-wrap: balance;
}
.orrery-tools h3 {
  margin: 0 0 8px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  opacity: 0.72;
}
.orrery-tools__status,
.orrery-tools__meta {
  margin: 5px 0 0;
  font-size: 11px;
  opacity: 0.72;
  font-variant-numeric: tabular-nums;
  text-wrap: pretty;
}
.orrery-tools__actions { display: flex; gap: 6px; flex: 0 0 auto; }
.orrery-tools button {
  font: inherit;
  min-height: 26px;
  padding: 5px 11px;
  color: var(--theia-foreground);
  background: transparent;
  border: 1px solid var(--theia-editorGroup-border);
  border-radius: var(--orrery-radius-inner);
  cursor: pointer;
  transition-property: transform, background-color, color, opacity;
  transition-duration: 140ms;
  transition-timing-function: var(--orrery-ease-out);
}
.orrery-tools__register button[type="submit"] {
  color: var(--theia-button-foreground);
  background: var(--theia-button-background);
  border-color: transparent;
}
@media (hover: hover) and (pointer: fine) {
  .orrery-tools button:hover:not(:disabled) {
    background: var(--theia-button-hoverBackground);
    color: var(--theia-button-foreground);
  }
}
.orrery-tools button:active:not(:disabled) { transform: scale(0.97); }
.orrery-tools button:disabled { opacity: 0.45; cursor: default; }
.orrery-tools__error,
.orrery-tools__notice {
  margin: 0;
  padding: 9px 11px;
  border-left: 2px solid var(--theia-errorForeground);
  border-radius: 0 var(--orrery-radius-inner) var(--orrery-radius-inner) 0;
  background: var(--theia-editorWidget-background);
  color: var(--theia-errorForeground);
  font-size: 12px;
  text-wrap: pretty;
  animation: orrery-tools-enter 200ms var(--orrery-ease-out) both;
}
.orrery-tools__notice {
  border-left-color: var(--orrery-accent);
  color: var(--theia-foreground);
}
.orrery-tools__register,
.orrery-tools__section {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px;
  border: 1px solid var(--theia-editorGroup-border);
  border-radius: var(--orrery-radius-outer);
  background: var(--theia-editorWidget-background);
}
.orrery-tools__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  opacity: 0.8;
}
.orrery-tools input,
.orrery-tools select,
.orrery-tools textarea {
  font: inherit;
  min-height: 26px;
  padding: 5px 8px;
  color: var(--theia-input-foreground);
  background: var(--theia-input-background);
  border: 1px solid var(--theia-editorGroup-border);
  border-radius: var(--orrery-radius-inner);
  text-transform: none;
  letter-spacing: normal;
  font-weight: 400;
  transition: border-color 140ms var(--orrery-ease-out);
}
.orrery-tools textarea { resize: vertical; }
.orrery-tools__note,
.orrery-tools__empty,
.orrery-tools__description {
  margin: 0;
  font-size: 11px;
  line-height: 1.55;
  opacity: 0.72;
  text-wrap: pretty;
}
.orrery-tools__description { opacity: 0.85; }
.orrery-tools__list,
.orrery-tools__activity {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.orrery-tools__server,
.orrery-tools__tool {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 11px;
  border: 1px solid var(--theia-editorGroup-border);
  border-radius: var(--orrery-radius-inner);
  animation: orrery-tools-enter 220ms var(--orrery-ease-out) both;
}
.orrery-tools__server-head,
.orrery-tools__tool-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.orrery-tools__server-name,
.orrery-tools__tool-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.orrery-tools__risk {
  flex: 0 0 auto;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 3px 7px;
  border-radius: 999px;
  border: 1px solid currentColor;
  white-space: nowrap;
}
.orrery-tools__risk--read { opacity: 0.7; }
.orrery-tools__risk--write,
.orrery-tools__risk--network { color: var(--theia-editorWarning-foreground, var(--theia-foreground)); }
.orrery-tools__risk--destructive,
.orrery-tools__risk--spend { color: var(--theia-errorForeground); }
.orrery-tools__tool-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.orrery-tools__permission {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.7;
}
.orrery-tools__always {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.85;
  color: var(--theia-editorWarning-foreground, var(--theia-foreground));
}
.orrery-tools__destructive { color: var(--theia-errorForeground); border-color: currentColor; }
@media (hover: hover) and (pointer: fine) {
  .orrery-tools__destructive:hover:not(:disabled) {
    background: var(--theia-errorForeground);
    color: var(--theia-button-foreground);
  }
}
.orrery-tools__confirm { display: flex; gap: 6px; flex: 0 0 auto; }
.orrery-tools__warn {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--theia-errorForeground);
  text-wrap: pretty;
}
.orrery-tools__output {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--theia-editorGroup-border);
  border-radius: var(--orrery-radius-inner);
  background: var(--theia-editor-background);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 260px;
  overflow: auto;
  font-family: var(--theia-code-font-family);
  font-size: 12px;
  line-height: 1.5;
}
.orrery-tools__entry {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-left: 2px solid var(--theia-editorGroup-border);
  animation: orrery-tools-enter 200ms var(--orrery-ease-out) both;
}
.orrery-tools__entry--allowed { border-left-color: var(--orrery-accent); }
.orrery-tools__entry--denied { border-left-color: var(--theia-editorWarning-foreground, var(--theia-foreground)); }
.orrery-tools__entry--failed { border-left-color: var(--theia-errorForeground); }
.orrery-tools__entry-name { font-weight: 600; overflow-wrap: anywhere; }
.orrery-tools input:focus-visible,
.orrery-tools select:focus-visible,
.orrery-tools textarea:focus-visible,
.orrery-tools button:focus-visible {
  outline: 1px solid var(--theia-focusBorder);
  outline-offset: 1px;
  border-color: var(--theia-focusBorder);
}
@keyframes orrery-tools-enter {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .orrery-tools__server,
  .orrery-tools__tool,
  .orrery-tools__entry,
  .orrery-tools__error,
  .orrery-tools__notice {
    animation: orrery-tools-fade 160ms ease both;
  }
  .orrery-tools button:active:not(:disabled) { transform: none; }
}
@keyframes orrery-tools-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
`;

/** Adds the stylesheet once per document. Safe to call from every widget instance. */
export function ensureOrreryToolsStyle(target: Pick<Document, "getElementById" | "createElement" | "head"> | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!target || target.getElementById(STYLE_ELEMENT_ID)) return;
  const style = target.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = ORRERY_TOOLS_STYLE;
  target.head.appendChild(style);
}
