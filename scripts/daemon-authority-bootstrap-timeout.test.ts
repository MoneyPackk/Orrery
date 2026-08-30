import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows adversarial persistence timeout budget", () => {
  it("sets 20 seconds only on the two measured adversarial persistence tests", () => {
    const source = readFileSync(resolve(process.cwd(), "scripts/daemon-authority-bootstrap.test.ts"), "utf8");
    expect(source).toMatch(/it\("rejects adversarial approved repository persistence"[\s\S]*?\}, 20_000\);/);
    expect(source).toMatch(/it\("rejects adversarial repository proposal persistence"[\s\S]*?\}, 20_000\);/);
    expect(source.match(/20_000/g)).toHaveLength(2);
  });
});
