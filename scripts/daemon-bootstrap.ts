import type { ChildProcess } from "node:child_process";
import type { Duplex, Readable, Writable } from "node:stream";
import { approvalKeyFingerprint } from "../packages/mission-control-daemon/src/promotion-approval";

const MAX_BOOTSTRAP_BYTES = 64 * 1024;
const BOOTSTRAP_TIMEOUT_MS = 5_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const FIELDS = ["type", "version", "handoffNonce", "parentPid", "childPid", "instanceId", "challenge", "approvalPublicKey", "approvalKeyFingerprint"];

export interface BootstrapBinding { handoffNonce: string; parentPid: number; childPid: number; instanceId: string; challenge: string }
export interface PromotionBootstrapFrame extends BootstrapBinding { type: "promotion_bootstrap"; version: 1; approvalPublicKey: string; approvalKeyFingerprint: string }
export interface BootstrapChallenge { type: "promotion_bootstrap_challenge"; version: 1; parentPid: number; childPid: number; instanceId: string; challenge: string }

export function createBootstrapFrame(input: BootstrapBinding & { approvalPublicKey: string }): PromotionBootstrapFrame {
  return { type: "promotion_bootstrap", version: 1, ...input, approvalKeyFingerprint: approvalKeyFingerprint(input.approvalPublicKey) };
}

export function writeBootstrapFrame(stream: Writable, frame: PromotionBootstrapFrame): void { stream.end(`${JSON.stringify(frame)}\n`); }

export async function readBootstrapFrame(stream: Readable, expected: BootstrapBinding, timeoutMs = BOOTSTRAP_TIMEOUT_MS): Promise<PromotionBootstrapFrame> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const text = await Promise.race([
    boundedFrame(stream),
    new Promise<never>((_, reject) => { timer = setTimeout(() => { stream.destroy(); reject(new Error("Managed daemon bootstrap response timed out.")); }, timeoutMs); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Managed daemon bootstrap is malformed."); }
  assertFrame(value);
  if (value.handoffNonce !== expected.handoffNonce || value.parentPid !== expected.parentPid || value.childPid !== expected.childPid || value.instanceId !== expected.instanceId || value.challenge !== expected.challenge) throw new Error("Managed daemon bootstrap does not match process ownership.");
  if (approvalKeyFingerprint(value.approvalPublicKey) !== value.approvalKeyFingerprint) throw new Error("Managed daemon bootstrap key fingerprint is invalid.");
  return value;
}

export function writeBootstrapChallenge(stream: Writable, challenge: BootstrapChallenge): Promise<void> { return new Promise((resolve, reject) => stream.end(`${JSON.stringify(challenge)}\n`, (error?: Error | null) => error ? reject(error) : resolve())); }

export async function readBootstrapChallenge(stream: Readable, timeoutMs = BOOTSTRAP_TIMEOUT_MS): Promise<BootstrapChallenge> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const text = await Promise.race([
    boundedFrame(stream),
    new Promise<never>((_, reject) => { timer = setTimeout(() => { stream.destroy(); reject(new Error("Managed daemon bootstrap challenge timed out.")); }, timeoutMs); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Managed daemon bootstrap challenge is malformed."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Managed daemon bootstrap challenge is malformed.");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 6 || item.type !== "promotion_bootstrap_challenge" || item.version !== 1 || !validPid(item.parentPid) || !validPid(item.childPid) || !ID.test(String(item.instanceId)) || !HEX64.test(String(item.challenge))) throw new Error("Managed daemon bootstrap challenge is malformed.");
  return item as unknown as BootstrapChallenge;
}

async function boundedFrame(stream: Readable): Promise<string> { return firstLine(stream, true); }
async function firstLine(stream: Readable, requireEof: boolean): Promise<string> {
  let data = "";
  for await (const chunk of stream) {
    data += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(data) > MAX_BOOTSTRAP_BYTES) throw new Error("Managed daemon bootstrap frame is too large.");
  }
  const lines = data.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || (requireEof && !data.endsWith("\n"))) throw new Error("Managed daemon bootstrap must contain a single frame.");
  return lines[0];
}
function assertFrame(value: unknown): asserts value is PromotionBootstrapFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Managed daemon bootstrap is malformed.");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== FIELDS.length || !FIELDS.every((field) => Object.hasOwn(item, field)) || item.type !== "promotion_bootstrap" || item.version !== 1 || !ID.test(String(item.handoffNonce)) || !validPid(item.parentPid) || !validPid(item.childPid) || !ID.test(String(item.instanceId)) || !HEX64.test(String(item.challenge)) || typeof item.approvalPublicKey !== "string" || item.approvalPublicKey.length > 4096 || !HEX64.test(String(item.approvalKeyFingerprint))) throw new Error("Managed daemon bootstrap is malformed.");
}
function validPid(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }

export type BootstrapDuplex = Duplex;

export function completeParentBootstrap(child: ChildProcess, handoffNonce: string, approvalPublicKey: string, parentPid = process.pid): Promise<{ instanceId: string; approvalKeyFingerprint: string }> {
  const challengePipe = child.stdio[3] as Readable | null;
  const responsePipe = child.stdio[4] as Writable | null;
  if (!challengePipe || !responsePipe || !child.pid) throw new Error("Managed daemon bootstrap pipe is unavailable.");
  return readBootstrapChallenge(challengePipe).then((challenge) => {
    if (challenge.parentPid !== parentPid || challenge.childPid !== child.pid) throw new Error("Managed daemon bootstrap challenge does not match the child process.");
    const frame = createBootstrapFrame({ handoffNonce, parentPid, childPid: child.pid!, instanceId: challenge.instanceId, challenge: challenge.challenge, approvalPublicKey });
    writeBootstrapFrame(responsePipe, frame);
    return { instanceId: challenge.instanceId, approvalKeyFingerprint: frame.approvalKeyFingerprint };
  });
}
