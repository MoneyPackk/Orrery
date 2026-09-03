import { describe, expect, it } from "vitest";
import { ensureOrreryToolsStyle, ORRERY_TOOLS_STYLE } from "./orrery-tools-style";

describe("Orrery Tools design contract", () => {
  it("injects the stylesheet exactly once per document", () => {
    const created: Array<{ id: string; textContent: string }> = [];
    const head = { appendChild: (node: { id: string; textContent: string }) => created.push(node) };
    const target = {
      getElementById: (id: string) => created.find(node => node.id === id) ?? null,
      createElement: () => ({ id: "", textContent: "" }),
      head,
    } as unknown as Document;
    ensureOrreryToolsStyle(target);
    ensureOrreryToolsStyle(target);
    expect(created).toHaveLength(1);
    expect(created[0].id).toBe("orrery-tools-style");
    expect(created[0].textContent).toBe(ORRERY_TOOLS_STYLE);
  });

  it("tolerates a missing document", () => {
    expect(() => ensureOrreryToolsStyle(undefined)).not.toThrow();
  });

  it("follows theme variables instead of hardcoded brand colors", () => {
    expect(ORRERY_TOOLS_STYLE).toContain("var(--theia-foreground)");
    expect(ORRERY_TOOLS_STYLE).toContain("var(--theia-editorGroup-border)");
    expect(ORRERY_TOOLS_STYLE.replace(/var\(--theia-focusBorder, #3794ff\)|#3794ff/g, "")).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("animates only compositor-friendly properties and never uses transition: all", () => {
    expect(ORRERY_TOOLS_STYLE).not.toMatch(/transition:\s*all/);
    expect(ORRERY_TOOLS_STYLE).toMatch(/transition-property:\s*transform, background-color, color, opacity/);
  });

  it("distinguishes the risk classes that can cost or destroy from the ones that only read", () => {
    expect(ORRERY_TOOLS_STYLE).toMatch(/\.orrery-tools__risk--destructive[\s\S]*?var\(--theia-errorForeground\)/);
    expect(ORRERY_TOOLS_STYLE).toContain(".orrery-tools__risk--spend");
    expect(ORRERY_TOOLS_STYLE).toContain(".orrery-tools__risk--read");
  });

  it("keeps a visible focus ring on every interactive control", () => {
    for (const selector of [".orrery-tools input:focus-visible", ".orrery-tools select:focus-visible", ".orrery-tools textarea:focus-visible", ".orrery-tools button:focus-visible"]) {
      expect(ORRERY_TOOLS_STYLE).toContain(selector);
    }
    expect(ORRERY_TOOLS_STYLE).toContain("var(--theia-focusBorder)");
  });

  it("gates hover behind a real pointer and keeps a press affordance", () => {
    expect(ORRERY_TOOLS_STYLE).toContain("@media (hover: hover) and (pointer: fine)");
    expect(ORRERY_TOOLS_STYLE).toMatch(/button:active:not\(:disabled\) \{ transform: scale\(0\.97\); \}/);
  });

  it("uses concentric radii so nested corners do not look wrong", () => {
    expect(ORRERY_TOOLS_STYLE).toContain("--orrery-radius-outer: 7px");
    expect(ORRERY_TOOLS_STYLE).toContain("--orrery-radius-inner: 4px");
  });

  it("aligns numeric metadata with tabular figures", () => {
    expect(ORRERY_TOOLS_STYLE).toContain("font-variant-numeric: tabular-nums");
  });

  it("wraps untrusted output instead of letting a long line break the layout", () => {
    expect(ORRERY_TOOLS_STYLE).toMatch(/\.orrery-tools__output \{[\s\S]*?white-space: pre-wrap;[\s\S]*?overflow-wrap: anywhere;/);
  });

  it("honors a reduced-motion preference", () => {
    const reduced = ORRERY_TOOLS_STYLE.slice(ORRERY_TOOLS_STYLE.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("orrery-tools-fade");
    expect(reduced).toMatch(/button:active:not\(:disabled\) \{ transform: none; \}/);
  });
});
