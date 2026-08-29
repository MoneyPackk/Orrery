import { describe, expect, it } from "vitest";
import { PinnedApprovalVerifier, TrustedApprovalService, approvalPrincipal } from "./promotion-approval";

const request = { missionId: "mission-1", planRevisionId: "plan-1", changeRevision: "change-1", decision: "accepted" as const, contentDigest: "a".repeat(64) };

describe("native promotion approval", () => {
  it("pins verification material and derives a canonical reviewer principal from it", () => {
    const issuer = new TrustedApprovalService({ now: () => "2026-08-29T10:00:00.000Z", id: () => "nonce-1" });
    const verifier = new PinnedApprovalVerifier(issuer.publicKey, { now: () => "2026-08-29T10:00:01.000Z" });
    expect(verifier.verify({ ...request, capability: issuer.issue(request) })).toEqual({
      nonce: "nonce-1", expiresAt: "2026-08-29T10:01:00.000Z", reviewerId: approvalPrincipal(issuer.publicKey),
    });
    expect(approvalPrincipal(issuer.publicKey)).toMatch(/^electron-[0-9a-f]{32}$/);
  });

  it("does not reload or accept replacement verification material", () => {
    const first = new TrustedApprovalService({ now: () => "2026-08-29T10:00:00.000Z" });
    const replacement = new TrustedApprovalService({ now: () => "2026-08-29T10:00:00.000Z" });
    const verifier = new PinnedApprovalVerifier(first.publicKey, { now: () => "2026-08-29T10:00:01.000Z" });
    expect(() => verifier.verify({ ...request, capability: replacement.issue(request) })).toThrow(/signature/i);
  });

  it("enforces exact schema, signature, tuple, digest, clock, and maximum lifetime", () => {
    let now = "2026-08-29T10:00:00.000Z";
    const issuer = new TrustedApprovalService({ now: () => now, maximumTtlMs: 1_000 });
    const verifier = new PinnedApprovalVerifier(issuer.publicKey, { now: () => now, maximumTtlMs: 1_000, maximumClockSkewMs: 100 });
    const valid = issuer.issue(request);
    expect(() => verifier.verify({ ...request, contentDigest: "b".repeat(64), capability: valid })).toThrow(/match/i);
    const [encoded, signature] = valid.split(".");
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const extra = `${Buffer.from(JSON.stringify({ ...payload, reviewerId: "attacker" })).toString("base64url")}.${signature}`;
    expect(() => verifier.verify({ ...request, capability: extra })).toThrow(/signature|schema/i);
    now = "2026-08-29T10:00:01.000Z";
    expect(() => verifier.verify({ ...request, capability: valid })).toThrow(/expired/i);
  });

  it("rejects capabilities issued too far in the future or beyond maximum TTL", () => {
    const issuer = new TrustedApprovalService({ now: () => "2026-08-29T10:00:01.000Z", maximumTtlMs: 2_000 });
    const verifier = new PinnedApprovalVerifier(issuer.publicKey, { now: () => "2026-08-29T10:00:00.000Z", maximumTtlMs: 1_000, maximumClockSkewMs: 100 });
    expect(() => verifier.verify({ ...request, capability: issuer.issue(request) })).toThrow(/clock|lifetime/i);
  });
});
