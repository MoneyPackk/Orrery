import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

export interface PromotionApprovalRequest {
  readonly missionId: string;
  readonly planRevisionId: string;
  readonly changeRevision: string;
  readonly decision: "accepted" | "rejected";
  readonly contentDigest: string;
}

export interface VerifiedPromotionApproval { readonly nonce: string; readonly expiresAt: string; readonly reviewerId: string }
export interface PromotionApprovalVerifier { verify(input: PromotionApprovalRequest & { readonly capability: string }): VerifiedPromotionApproval }
export interface PromotionApprovalIssuer { issue(input: PromotionApprovalRequest): string }
export interface TrustedApprovalContext { readonly now?: () => string; readonly id?: () => string; readonly maximumTtlMs?: number; readonly privateKey?: string; readonly publicKey?: string }

interface SignedApproval extends PromotionApprovalRequest { readonly issuedAt: string; readonly expiresAt: string; readonly nonce: string }
const FIELDS = ["missionId", "planRevisionId", "changeRevision", "decision", "contentDigest", "issuedAt", "expiresAt", "nonce"];
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export class TrustedApprovalService implements PromotionApprovalIssuer {
  readonly publicKey: string;
  private readonly privateKey: ReturnType<typeof createPrivateKey>;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly maximumTtlMs: number;

  constructor(context: TrustedApprovalContext = {}) {
    this.now = context.now ?? (() => new Date().toISOString());
    this.id = context.id ?? (() => crypto.randomUUID());
    this.maximumTtlMs = context.maximumTtlMs ?? 60_000;
    if (!Number.isSafeInteger(this.maximumTtlMs) || this.maximumTtlMs <= 0) throw new Error("Promotion approval maximum TTL must be positive.");
    const keys = context.privateKey && context.publicKey ? { privateKey: createPrivateKey(context.privateKey), publicKey: createPublicKey(context.publicKey) } : generateKeyPairSync("ed25519");
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  issue(input: PromotionApprovalRequest): string {
    validateRequest(input);
    const issuedAt = this.now();
    const payload: SignedApproval = { ...input, issuedAt, expiresAt: new Date(Date.parse(issuedAt) + this.maximumTtlMs).toISOString(), nonce: this.id() };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${sign(null, Buffer.from(encoded), this.privateKey).toString("base64url")}`;
  }
}

export class PinnedApprovalVerifier implements PromotionApprovalVerifier {
  private readonly key: ReturnType<typeof createPublicKey>;
  private readonly reviewerId: string;
  private readonly now: () => string;
  private readonly maximumTtlMs: number;
  private readonly maximumClockSkewMs: number;

  constructor(publicKey: string, options: { now?: () => string; maximumTtlMs?: number; maximumClockSkewMs?: number } = {}) {
    this.key = createPublicKey(publicKey);
    this.reviewerId = approvalPrincipal(publicKey);
    this.now = options.now ?? (() => new Date().toISOString());
    this.maximumTtlMs = options.maximumTtlMs ?? 60_000;
    this.maximumClockSkewMs = options.maximumClockSkewMs ?? 5_000;
  }

  verify(input: PromotionApprovalRequest & { readonly capability: string }): VerifiedPromotionApproval {
    validateRequest(input);
    const [encoded, signature, extra] = input.capability.split(".");
    if (!encoded || !signature || extra || !verify(null, Buffer.from(encoded), this.key, Buffer.from(signature, "base64url"))) throw new Error("Promotion approval signature is invalid.");
    let payload: unknown;
    try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw new Error("Promotion approval schema is invalid."); }
    assertPayload(payload);
    if (payload.missionId !== input.missionId || payload.planRevisionId !== input.planRevisionId || payload.changeRevision !== input.changeRevision || payload.decision !== input.decision || payload.contentDigest !== input.contentDigest) throw new Error("Promotion approval does not match the request.");
    const now = Date.parse(this.now());
    const issuedAt = Date.parse(payload.issuedAt);
    const expiresAt = Date.parse(payload.expiresAt);
    if (issuedAt > now + this.maximumClockSkewMs) throw new Error("Promotion approval clock is invalid.");
    if (expiresAt - issuedAt > this.maximumTtlMs) throw new Error("Promotion approval lifetime exceeds the maximum.");
    if (expiresAt <= now) throw new Error("Promotion approval expired.");
    return { nonce: payload.nonce, expiresAt: payload.expiresAt, reviewerId: this.reviewerId };
  }
}

export function approvalPrincipal(publicKey: string): string {
  return `electron-${createHash("sha256").update(createPublicKey(publicKey).export({ type: "spki", format: "der" })).digest("hex").slice(0, 32)}`;
}
export function approvalKeyFingerprint(publicKey: string): string {
  return createHash("sha256").update(createPublicKey(publicKey).export({ type: "spki", format: "der" })).digest("hex");
}

function validateRequest(value: PromotionApprovalRequest): void {
  if (!ID.test(value.missionId) || !ID.test(value.planRevisionId) || !ID.test(value.changeRevision) || !DIGEST.test(value.contentDigest) || (value.decision !== "accepted" && value.decision !== "rejected")) throw new Error("Promotion approval request is invalid.");
}

function assertPayload(value: unknown): asserts value is SignedApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Promotion approval schema is invalid.");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== FIELDS.length || !FIELDS.every((field) => Object.hasOwn(item, field)) || !ID.test(String(item.missionId)) || !ID.test(String(item.planRevisionId)) || !ID.test(String(item.changeRevision)) || !ID.test(String(item.nonce)) || !DIGEST.test(String(item.contentDigest)) || (item.decision !== "accepted" && item.decision !== "rejected") || !isTimestamp(item.issuedAt) || !isTimestamp(item.expiresAt)) throw new Error("Promotion approval schema is invalid.");
}

function isTimestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
