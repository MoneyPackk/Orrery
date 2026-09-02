import { describe, expect, it } from "vitest";
import { ensureOrreryIntelligenceStyle, ORRERY_INTELLIGENCE_STYLE } from "./orrery-intelligence-style";

describe("Orrery Intelligence design contract", () => {
  it("injects the stylesheet exactly once per document", () => {
    const created: Array<{ id: string; textContent: string }> = [];
    const head = { appendChild: (node: { id: string; textContent: string }) => created.push(node) };
    const target = {
      getElementById: (id: string) => created.find(node => node.id === id) ?? null,
      createElement: () => ({ id: "", textContent: "" }),
      head,
    } as unknown as Document;
    ensureOrreryIntelligenceStyle(target);
    ensureOrreryIntelligenceStyle(target);
    expect(created).toHaveLength(1);
    expect(created[0].id).toBe("orrery-intelligence-style");
    expect(created[0].textContent).toBe(ORRERY_INTELLIGENCE_STYLE);
  });

  it("tolerates a missing document", () => {
    expect(() => ensureOrreryIntelligenceStyle(undefined)).not.toThrow();
  });

  it("follows theme variables instead of hardcoded brand colors", () => {
    expect(ORRERY_INTELLIGENCE_STYLE).toContain("var(--theia-foreground)");
    expect(ORRERY_INTELLIGENCE_STYLE).toContain("var(--theia-editorGroup-border)");
    expect(ORRERY_INTELLIGENCE_STYLE.replace(/var\(--orrery-accent, #3794ff\)|#3794ff/g, "")).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("animates only compositor-friendly properties and never uses transition: all", () => {
    expect(ORRERY_INTELLIGENCE_STYLE).not.toMatch(/transition:\s*all/);
    expect(ORRERY_INTELLIGENCE_STYLE).not.toMatch(/will-change:\s*all/);
    expect(ORRERY_INTELLIGENCE_STYLE).not.toMatch(/transition-property:[^;]*\b(width|height|top|left|margin|padding)\b/);
  });

  it("uses ease-out entrances under 300ms and never scales from zero", () => {
    expect(ORRERY_INTELLIGENCE_STYLE).toContain("--orrery-ease-out: cubic-bezier(0.23, 1, 0.32, 1)");
    expect(ORRERY_INTELLIGENCE_STYLE).not.toMatch(/scale\(0\)/);
    expect(ORRERY_INTELLIGENCE_STYLE).not.toMatch(/\bease-in\b(?!-out)/);
    const durations = [...ORRERY_INTELLIGENCE_STYLE.matchAll(/(\d+)ms/g)].map(match => Number(match[1]));
    expect(durations.length).toBeGreaterThan(0);
    expect(Math.max(...durations)).toBeLessThanOrEqual(300);
  });

  it("gives pressable controls tactile feedback and usable hit areas", () => {
    expect(ORRERY_INTELLIGENCE_STYLE).toMatch(/button:active:not\(:disabled\)\s*\{\s*transform:\s*scale\(0\.97\)/);
    expect(ORRERY_INTELLIGENCE_STYLE).toMatch(/min-height:\s*26px/);
  });

  it("gates hover behind a fine pointer so touch does not latch hover", () => {
    expect(ORRERY_INTELLIGENCE_STYLE).toContain("@media (hover: hover) and (pointer: fine)");
  });

  it("respects reduced motion by removing movement but keeping opacity", () => {
    expect(ORRERY_INTELLIGENCE_STYLE).toContain("@media (prefers-reduced-motion: reduce)");
    const reduced = ORRERY_INTELLIGENCE_STYLE.slice(ORRERY_INTELLIGENCE_STYLE.indexOf("prefers-reduced-motion"));
    expect(reduced).toContain("transform: none");
    expect(reduced).toContain("orrery-intelligence-fade");
  });

  it("applies concentric radii, tabular numerals, and balanced text", () => {
    expect(ORRERY_INTELLIGENCE_STYLE).toContain("--orrery-radius-inner: 4px");
    expect(ORRERY_INTELLIGENCE_STYLE).toContain("--orrery-radius-outer: 7px");
    expect(ORRERY_INTELLIGENCE_STYLE).toContain("font-variant-numeric: tabular-nums");
    expect(ORRERY_INTELLIGENCE_STYLE).toContain("text-wrap: balance");
    expect(ORRERY_INTELLIGENCE_STYLE).toContain("text-wrap: pretty");
    expect(ORRERY_INTELLIGENCE_STYLE).toContain("-webkit-font-smoothing: antialiased");
  });
});
