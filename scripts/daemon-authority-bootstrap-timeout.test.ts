import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows adversarial persistence timeout budget", () => {
  it("scales only on the two measured adversarial persistence tests", () => {
    const source = readFileSync(resolve(process.cwd(), "scripts/daemon-authority-bootstrap.test.ts"), "utf8");
    // Both budgets must come from the shared scale-aware constant so a loaded machine gets
    // proportional headroom without anyone raising the base or scattering one-off numbers.
    expect(source).toMatch(/it\("rejects adversarial approved repository persistence"[\s\S]*?\}, ADVERSARIAL_PERSISTENCE_BUDGET_MS\);/);
    expect(source).toMatch(/it\("rejects adversarial repository proposal persistence"[\s\S]*?\}, ADVERSARIAL_PERSISTENCE_BUDGET_MS\);/);
    expect(source.match(/ADVERSARIAL_PERSISTENCE_BUDGET_MS/g)).toHaveLength(3);
    // The base stays 20 seconds: scale gives headroom, not permission to loosen the budget.
    expect(source).toMatch(/ADVERSARIAL_PERSISTENCE_BUDGET_MS = 20_000 \*/);
  });
});
