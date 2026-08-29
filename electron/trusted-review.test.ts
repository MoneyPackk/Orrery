import { describe, expect, it } from "vitest";
import { trustedReviewDetail, trustedReviewWindowOptions } from "./trusted-review";

describe("trusted native review content", () => {
  it("renders every exact daemon-provided path, diff, binary marker, evidence item, and digest", () => {
    const detail = trustedReviewDetail({
      missionId: "mission-1", planRevisionId: "plan-1", changeRevision: "change-1", contentDigest: "a".repeat(64), decision: "accepted",
      review: { changes: [{ path: "src/<unsafe>.bin", additions: 0, deletions: 0, binary: true, diff: "Binary files differ" }], evidence: [{ id: "e1", kind: "test", status: "passed", summary: "<verified>", planRevisionId: "plan-1", timestamp: "2026-08-29T10:00:00.000Z" }] },
    });
    expect(JSON.parse(detail)).toEqual(expect.objectContaining({ contentDigest: "a".repeat(64), changes: [expect.objectContaining({ path: "src/<unsafe>.bin", binary: true, diff: "Binary files differ" })], evidence: [expect.objectContaining({ summary: "<verified>" })] }));
  });
  it("uses a modal sandbox without preload or Node access", () => {
    const options = trustedReviewWindowOptions({} as never);
    expect(options).toMatchObject({ modal: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, webSecurity: true } });
    expect(options.webPreferences).not.toHaveProperty("preload");
  });
});
