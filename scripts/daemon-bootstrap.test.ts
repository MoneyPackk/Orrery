import { generateKeyPairSync } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { approvalKeyFingerprint } from "../packages/mission-control-daemon/src/promotion-approval";
import { createBootstrapFrame, readBootstrapChallenge, readBootstrapFrame, writeBootstrapFrame } from "./daemon-bootstrap";

const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const binding = { handoffNonce: "lock-nonce", parentPid: 100, childPid: 200, instanceId: "instance-1", challenge: "a".repeat(64) };

describe("managed daemon inherited bootstrap", () => {
  it("round-trips one bounded exact frame with matching key fingerprint", async () => {
    const pipe = new PassThrough();
    const frame = createBootstrapFrame({ ...binding, approvalPublicKey: publicKey });
    writeBootstrapFrame(pipe, frame);
    await expect(readBootstrapFrame(pipe, binding)).resolves.toEqual(frame);
  });

  it.each([
    ["parentPid", 101], ["childPid", 201], ["handoffNonce", "wrong"], ["challenge", "b".repeat(64)], ["instanceId", "instance-2"],
  ] as const)("rejects mismatched %s", async (field, value) => {
    const pipe = new PassThrough();
    writeBootstrapFrame(pipe, createBootstrapFrame({ ...binding, [field]: value, approvalPublicKey: publicKey }));
    await expect(readBootstrapFrame(pipe, binding)).rejects.toThrow(/bootstrap.*match/i);
  });

  it("rejects malformed, duplicate, oversized, and fingerprint-mismatched frames", async () => {
    const malformed = new PassThrough(); malformed.end("{}\n");
    await expect(readBootstrapFrame(malformed, binding)).rejects.toThrow(/bootstrap/i);
    const duplicate = new PassThrough(); const frame = createBootstrapFrame({ ...binding, approvalPublicKey: publicKey }); duplicate.end(`${JSON.stringify(frame)}\n${JSON.stringify(frame)}\n`);
    await expect(readBootstrapFrame(duplicate, binding)).rejects.toThrow(/single|duplicate/i);
    const oversized = new PassThrough(); oversized.end(`${"x".repeat(70_000)}\n`);
    await expect(readBootstrapFrame(oversized, binding)).rejects.toThrow(/large/i);
    const fingerprint = new PassThrough(); fingerprint.end(`${JSON.stringify({ ...frame, approvalKeyFingerprint: "0".repeat(64) })}\n`);
    await expect(readBootstrapFrame(fingerprint, binding)).rejects.toThrow(/fingerprint/i);
    expect(frame.approvalKeyFingerprint).toBe(approvalKeyFingerprint(publicKey));
  });

  it("rejects trailing bytes after the single bootstrap frame", async () => {
    const pipe = new PassThrough();
    const frame = createBootstrapFrame({ ...binding, approvalPublicKey: publicKey });
    pipe.end(`${JSON.stringify(frame)}\ntrailing`);

    await expect(readBootstrapFrame(pipe, binding)).rejects.toThrow(/single frame/i);
  });

  it("rejects trailing bytes after the single bootstrap challenge", async () => {
    const pipe = new PassThrough();
    const challenge = { type: "promotion_bootstrap_challenge", version: 1, parentPid: 100, childPid: 200, instanceId: "instance-1", challenge: "a".repeat(64) } as const;
    pipe.end(`${JSON.stringify(challenge)}\ntrailing`);

    await expect(readBootstrapChallenge(pipe)).rejects.toThrow(/single frame/i);
  });

  it("times out when the bootstrap challenge frame never reaches EOF", async () => {
    const pipe = new PassThrough();
    const challenge = { type: "promotion_bootstrap_challenge", version: 1, parentPid: 100, childPid: 200, instanceId: "instance-1", challenge: "a".repeat(64) } as const;
    pipe.write(`${JSON.stringify(challenge)}\n`);

    await expect(readBootstrapChallenge(pipe, 10)).rejects.toThrow(/timed out/i);
    pipe.destroy();
  });

  it.each([
    ["no data", ""],
    ["partial data", "{"],
    ["complete frame without EOF", `${JSON.stringify(createBootstrapFrame({ ...binding, approvalPublicKey: publicKey }))}\n`],
  ])("times out and cleans up a response pipe with %s", async (_name, data) => {
    const pipe = new PassThrough();
    if (data) pipe.write(data);

    await expect(readBootstrapFrame(pipe, binding, 10)).rejects.toThrow(/timed out/i);
    expect(pipe.destroyed).toBe(true);
  });
});
