import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { canonicalize, digestToolArguments, ToolApprovalService, toolApprovalPrincipal } from "./tool-approval";

const request = { serverId: "files", name: "write_file", risk: "write", argumentsDigest: digestToolArguments({ path: "a.txt" }) };

/** A shared keypair, so clock and replay checks are exercised without a signature mismatch. */
function sharedKeys(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("tool approval capability", () => {
  it("issues a capability that verifies against the exact request", () => {
    const service = new ToolApprovalService();
    const capability = service.issue(request);
    const verified = service.verify({ ...request, capability });
    expect(verified.approverId).toBe(toolApprovalPrincipal(service.publicKey));
    expect(verified.nonce).toMatch(/[A-Za-z0-9_-]/);
  });

  it("refuses a capability whose arguments no longer match, so an approved call cannot be swapped", () => {
    const service = new ToolApprovalService();
    const capability = service.issue(request);
    const tampered = { ...request, argumentsDigest: digestToolArguments({ path: "/etc/passwd" }) };
    expect(() => service.verify({ ...tampered, capability })).toThrow(/does not match/);
  });

  it("refuses a capability replayed for a different tool or server or risk", () => {
    const service = new ToolApprovalService();
    const capability = service.issue(request);
    expect(() => service.verify({ ...request, name: "delete_file", capability })).toThrow(/does not match/);
    expect(() => service.verify({ ...request, serverId: "other", capability })).toThrow(/does not match/);
    expect(() => service.verify({ ...request, risk: "read", capability })).toThrow(/does not match/);
  });

  it("spends a capability exactly once", () => {
    const service = new ToolApprovalService();
    const capability = service.issue(request);
    expect(service.verify({ ...request, capability }).nonce).toBeTruthy();
    expect(() => service.verify({ ...request, capability })).toThrow(/already used/);
  });

  it("rejects a forged or truncated capability", () => {
    const service = new ToolApprovalService();
    const capability = service.issue(request);
    const [encoded, signature] = capability.split(".");
    expect(() => service.verify({ ...request, capability: encoded })).toThrow(/signature is invalid/);
    expect(() => service.verify({ ...request, capability: `${encoded}.${signature}.extra` })).toThrow(/signature is invalid/);
    expect(() => service.verify({ ...request, capability: `${encoded}.${"A".repeat(86)}` })).toThrow(/signature is invalid/);
  });

  it("rejects a capability signed by a different key", () => {
    const attacker = new ToolApprovalService();
    const victim = new ToolApprovalService();
    const capability = attacker.issue(request);
    expect(() => victim.verify({ ...request, capability })).toThrow(/signature is invalid/);
  });

  it("expires a capability and refuses one issued in the future", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const service = new ToolApprovalService({ now: () => new Date(now).toISOString(), maximumTtlMs: 60_000 });
    const capability = service.issue(request);
    now += 61_000;
    expect(() => service.verify({ ...request, capability })).toThrow(/expired/);
  });

  it("refuses a capability issued beyond the tolerated clock skew, using the same key", () => {
    // Share one keypair so the clock check is what fails, not the signature check.
    const keys = sharedKeys();
    const future = new ToolApprovalService({ ...keys, now: () => "2026-01-01T00:01:00.000Z" });
    const verifier = new ToolApprovalService({ ...keys, now: () => "2026-01-01T00:00:00.000Z" });
    const capability = future.issue(request);
    expect(() => verifier.verify({ ...request, capability })).toThrow(/clock is invalid/);
  });

  it("refuses a capability whose own payload claims a lifetime beyond the maximum", () => {
    const keys = sharedKeys();
    const generous = new ToolApprovalService({ ...keys, maximumTtlMs: 600_000, now: () => "2026-01-01T00:00:00.000Z" });
    const strict = new ToolApprovalService({ ...keys, maximumTtlMs: 60_000, now: () => "2026-01-01T00:00:01.000Z" });
    const capability = generous.issue(request);
    expect(() => strict.verify({ ...request, capability })).toThrow(/lifetime exceeds the maximum/);
  });

  it("refuses to sign a malformed request", () => {
    const service = new ToolApprovalService();
    expect(() => service.issue({ ...request, serverId: "" })).toThrow(/request is invalid/);
    expect(() => service.issue({ ...request, risk: "elevated" })).toThrow(/request is invalid/);
    expect(() => service.issue({ ...request, argumentsDigest: "short" })).toThrow(/request is invalid/);
    expect(() => service.issue({ ...request, name: "../escape" })).toThrow(/request is invalid/);
  });

  it("rejects a non-positive TTL", () => {
    expect(() => new ToolApprovalService({ maximumTtlMs: 0 })).toThrow(/must be positive/);
    expect(() => new ToolApprovalService({ maximumTtlMs: -1 })).toThrow(/must be positive/);
  });

  it("digests arguments independently of key order so consent is stable", () => {
    expect(digestToolArguments({ a: 1, b: 2 })).toBe(digestToolArguments({ b: 2, a: 1 }));
    expect(digestToolArguments({ a: { x: 1, y: 2 } })).toBe(digestToolArguments({ a: { y: 2, x: 1 } }));
  });

  it("digests distinguishable argument sets differently", () => {
    expect(digestToolArguments({ path: "a" })).not.toBe(digestToolArguments({ path: "b" }));
    expect(digestToolArguments({ a: "1" })).not.toBe(digestToolArguments({ a: 1 }));
    expect(digestToolArguments({ a: [1, 2] })).not.toBe(digestToolArguments({ a: [2, 1] }));
    expect(digestToolArguments({ a: { b: 1 } })).not.toBe(digestToolArguments({ "a.b": 1 }));
  });

  it("fails closed on values it cannot represent rather than signing an ambiguous digest", () => {
    expect(() => canonicalize(undefined)).toThrow(/unsupported value/);
    expect(() => canonicalize(() => undefined)).toThrow(/unsupported value/);
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});
