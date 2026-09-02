import { describe, expect, it } from "vitest";
import { trustedRepositoryHtml, trustedRepositoryWindowOptions } from "./trusted-repository";

describe("trusted repository window", () => {
  it("uses a modal sandboxed context-isolated window", () => {
    const parent = {} as never;
    const options = trustedRepositoryWindowOptions(parent);
    expect(options).toMatchObject({ parent, modal: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, webSecurity: true } });
  });
  it("allows the purpose-specific confirm and cancel navigation links", () => {
    const html = trustedRepositoryHtml({ canonicalRoot: "C:/repo", fingerprint: "a".repeat(64), expiresAt: "2026-09-01T01:00:00.000Z" });
    expect(html).not.toContain("navigate-to 'none'");
    expect(html).toContain('href="orrery-repository://confirm"');
    expect(html).toContain('href="orrery-repository://cancel"');
  });
});
