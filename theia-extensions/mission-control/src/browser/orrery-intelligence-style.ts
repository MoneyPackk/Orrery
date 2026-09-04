const STYLE_ELEMENT_ID = "orrery-intelligence-style";

/**
 * Orrery Intelligence brand styling.
 * Injected at runtime because the extension ships a `tsc`-only build with no CSS asset pipeline.
 * Uses Theia theme variables so the surface follows the active light or dark theme.
 */
export const ORRERY_INTELLIGENCE_STYLE = `
.orrery-intelligence {
  --orrery-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --orrery-radius-inner: 4px;
  --orrery-radius-outer: 7px;
  --orrery-accent: var(--theia-focusBorder, #3794ff);
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 12px;
  padding: 14px 14px 10px;
  box-sizing: border-box;
  font-size: var(--theia-ui-font-size1);
  color: var(--theia-foreground);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.orrery-intelligence__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--theia-editorGroup-border);
}
.orrery-intelligence__header h2 {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  text-wrap: balance;
}
.orrery-intelligence__status {
  margin: 5px 0 0;
  font-size: 11px;
  opacity: 0.72;
  text-wrap: pretty;
  font-variant-numeric: tabular-nums;
}
.orrery-intelligence__status code {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--theia-editorWidget-background);
}
.orrery-intelligence__actions { display: flex; gap: 6px; flex: 0 0 auto; }
.orrery-intelligence button {
  font: inherit;
  min-height: 26px;
  padding: 5px 11px;
  color: var(--theia-button-foreground);
  background: var(--theia-button-background);
  border: none;
  border-radius: var(--orrery-radius-inner);
  cursor: pointer;
  transition-property: transform, background-color, color, opacity;
  transition-duration: 140ms;
  transition-timing-function: var(--orrery-ease-out);
}
.orrery-intelligence__actions button {
  color: var(--theia-foreground);
  background: transparent;
  border: 1px solid var(--theia-editorGroup-border);
}
@media (hover: hover) and (pointer: fine) {
  .orrery-intelligence button:hover:not(:disabled) {
    background: var(--theia-button-hoverBackground);
    color: var(--theia-button-foreground);
  }
}
.orrery-intelligence button:active:not(:disabled) { transform: scale(0.97); }
.orrery-intelligence button:disabled { opacity: 0.45; cursor: default; }
.orrery-intelligence__error {
  margin: 0;
  padding: 9px 11px;
  border-left: 2px solid var(--theia-errorForeground);
  border-radius: 0 var(--orrery-radius-inner) var(--orrery-radius-inner) 0;
  background: var(--theia-editorWidget-background);
  color: var(--theia-errorForeground);
  font-size: 12px;
  text-wrap: pretty;
  animation: orrery-intelligence-enter 200ms var(--orrery-ease-out) both;
}
.orrery-intelligence__settings {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px;
  border: 1px solid var(--theia-editorGroup-border);
  border-radius: var(--orrery-radius-outer);
  background: var(--theia-editorWidget-background);
  animation: orrery-intelligence-enter 200ms var(--orrery-ease-out) both;
}
.orrery-intelligence__settings label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  opacity: 0.8;
}
.orrery-intelligence__settings input,
.orrery-intelligence__settings select {
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
.orrery-intelligence__note { margin: 0; font-size: 11px; line-height: 1.5; opacity: 0.68; text-wrap: pretty; }
.orrery-intelligence__transcript {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.orrery-intelligence__message {
  padding: 10px 12px;
  border-radius: var(--orrery-radius-outer);
  border: 1px solid var(--theia-editorGroup-border);
  background: var(--theia-editorWidget-background);
  animation: orrery-intelligence-enter 220ms var(--orrery-ease-out) both;
}
.orrery-intelligence__message--user { border-left: 2px solid var(--orrery-accent); }
.orrery-intelligence__message--assistant { border-left: 2px solid color-mix(in srgb, var(--orrery-accent) 45%, transparent); }
.orrery-intelligence__role {
  display: block;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  opacity: 0.6;
  margin-bottom: 6px;
}
.orrery-intelligence__text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; text-wrap: pretty; }
/*
 * Orrery's tool record. Deliberately unlike the message body: model prose is plain text on the
 * panel background, this sits in its own inset block. The visual difference carries the trust
 * boundary, so a model that writes a lookalike list in its text cannot reproduce this frame.
 */
.orrery-intelligence__tools {
  margin: 0 0 8px;
  padding: 7px 9px;
  border: 1px solid color-mix(in srgb, var(--orrery-accent) 28%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--orrery-accent) 7%, transparent);
}
.orrery-intelligence__tools-title {
  display: block;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.75;
  margin-bottom: 5px;
}
.orrery-intelligence__tools-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.orrery-intelligence__tool { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 11px; }
.orrery-intelligence__tool code { font-size: 11px; overflow-wrap: anywhere; }
.orrery-intelligence__tool-outcome { font-size: 10px; opacity: 0.7; }
.orrery-intelligence__tool-detail { flex-basis: 100%; font-size: 10px; opacity: 0.65; overflow-wrap: anywhere; }
/* A call that did not run is the security-relevant case, so it is marked, not just listed. */
.orrery-intelligence__tool--denied .orrery-intelligence__tool-outcome,
.orrery-intelligence__tool--error .orrery-intelligence__tool-outcome { opacity: 0.95; font-weight: 600; }
.orrery-intelligence__message small { display: block; margin-top: 6px; font-size: 10px; opacity: 0.6; }
.orrery-intelligence__empty {
  margin: 0;
  font-size: 12px;
  opacity: 0.66;
  line-height: 1.55;
  text-wrap: pretty;
}
.orrery-intelligence__pending {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.72;
  flex-wrap: wrap;
}
.orrery-intelligence__pending code { font-size: 11px; text-transform: none; letter-spacing: 0; overflow-wrap: anywhere; }
/* An elevated risk is marked, because that is the case where confirming matters most. The
   severity split matches the tools surface, so one risk never reads as milder in chat. */
.orrery-intelligence__pending-risk { font-size: 9px; letter-spacing: 0.08em; border: 1px solid currentColor; border-radius: 3px; padding: 1px 5px; opacity: 0.8; }
.orrery-intelligence__pending-risk--write,
.orrery-intelligence__pending-risk--network { color: var(--theia-editorWarning-foreground, var(--theia-foreground)); opacity: 1; }
.orrery-intelligence__pending-risk--destructive,
.orrery-intelligence__pending-risk--spend { color: var(--theia-errorForeground); opacity: 1; }
.orrery-intelligence__pending-progress { flex-basis: 100%; font-size: 10px; letter-spacing: 0; text-transform: none; opacity: 0.65; }
.orrery-intelligence__pending::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  animation: orrery-intelligence-pulse 1.4s ease-in-out infinite;
}
.orrery-intelligence__composer {
  display: flex;
  flex-direction: column;
  gap: 7px;
  flex: 0 0 auto;
  padding-top: 10px;
  border-top: 1px solid var(--theia-editorGroup-border);
}
.orrery-intelligence__composer-label {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  opacity: 0.6;
}
.orrery-intelligence__composer textarea {
  font: inherit;
  resize: vertical;
  padding: 8px 10px;
  color: var(--theia-input-foreground);
  background: var(--theia-input-background);
  border: 1px solid var(--theia-editorGroup-border);
  border-radius: var(--orrery-radius-inner);
  transition: border-color 140ms var(--orrery-ease-out);
}
.orrery-intelligence__composer textarea:disabled { opacity: 0.55; }
.orrery-intelligence__composer textarea:focus-visible,
.orrery-intelligence__settings input:focus-visible,
.orrery-intelligence__settings select:focus-visible,
.orrery-intelligence button:focus-visible {
  outline: 1px solid var(--theia-focusBorder);
  outline-offset: 1px;
  border-color: var(--theia-focusBorder);
}
@keyframes orrery-intelligence-enter {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes orrery-intelligence-pulse {
  0%, 100% { opacity: 0.35; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .orrery-intelligence__message,
  .orrery-intelligence__settings,
  .orrery-intelligence__error {
    animation: orrery-intelligence-fade 160ms ease both;
  }
.orrery-intelligence__pending::before { animation: none; opacity: 0.7; }
  .orrery-intelligence button:active:not(:disabled) { transform: none; }
}
@keyframes orrery-intelligence-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
`;

/** Adds the stylesheet once per document. Safe to call from every widget instance. */
export function ensureOrreryIntelligenceStyle(target: Pick<Document, "getElementById" | "createElement" | "head"> | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!target || target.getElementById(STYLE_ELEMENT_ID)) return;
  const style = target.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = ORRERY_INTELLIGENCE_STYLE;
  target.head.appendChild(style);
}