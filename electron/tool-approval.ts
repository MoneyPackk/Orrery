import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

/**
 * A tool invocation bound to a signed, expiring, single-use capability.
 *
 * This is the sibling of TrustedApprovalService for promotion: the renderer never
 * mints one, and the capability commits to a digest of the exact arguments the
 * human saw, so an approved call cannot be swapped for a different one.
 */
export interface ToolApprovalRequest {
  readonly serverId: string;
  readonly name: string;
  readonly risk: string;
  /** sha256 over the canonical form of the arguments displayed for consent. */
  readonly argumentsDigest: string;
}

export interface VerifiedToolApproval {
  readonly nonce: string;
  readonly expiresAt: string;
  readonly approverId: string;
}

export interface ToolApprovalContext {
  readonly now?: () => string;
  readonly id?: () => string;
  readonly maximumTtlMs?: number;
  readonly privateKey?: string;
  readonly publicKey?: string;
}

interface SignedToolApproval extends ToolApprovalRequest {
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

const FIELDS = ["serverId", "name", "risk", "argumentsDigest", "issuedAt", "expiresAt", "nonce"];
const ID = /^[A-Za-z0-9_.-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const RISKS = new Set(["read", "write", "destructive", "network", "spend"]);

/**
 * Canonical digest of tool arguments: keys sorted at every depth so an identical
 * argument set always produces an identical digest regardless of key order.
 */
export function digestToolArguments(args: unknown): string {
  return createHash("sha256").update(canonicalize(args)).digest("hex");
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  }
  // undefined and functions are not representable: fail closed rather than sign an ambiguous digest.
  throw new Error("Tool arguments contain an unsupported value.");
}

export class ToolApprovalService {
  readonly publicKey: string;
  private readonly privateKey: ReturnType<typeof createPrivateKey>;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly maximumTtlMs: number;
  /** Spent nonce to its expiry, so eviction can be limited to unreplayable entries. */
  private readonly spent = new Map<string, number>();

  constructor(context: ToolApprovalContext = {}) {
    this.now = context.now ?? (() => new Date().toISOString());
    this.id = context.id ?? (() => crypto.randomUUID());
    this.maximumTtlMs = context.maximumTtlMs ?? 60_000;
    if (!Number.isSafeInteger(this.maximumTtlMs) || this.maximumTtlMs <= 0) throw new Error("Tool approval maximum TTL must be positive.");
    const keys = context.privateKey && context.publicKey
      ? { privateKey: createPrivateKey(context.privateKey), publicKey: createPublicKey(context.publicKey) }
      : generateKeyPairSync("ed25519");
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  issue(input: ToolApprovalRequest): string {
    validateRequest(input);
    const issuedAt = this.now();
    const payload: SignedToolApproval = {
      serverId: input.serverId,
      name: input.name,
      risk: input.risk,
      argumentsDigest: input.argumentsDigest,
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + this.maximumTtlMs).toISOString(),
      nonce: this.id(),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${sign(null, Buffer.from(encoded), this.privateKey).toString("base64url")}`;
  }

  /**
   * Verifies and atomically spends a capability. A second call with the same
   * capability always fails, so an approved invocation cannot be replayed.
   */
  verify(input: ToolApprovalRequest & { readonly capability: string }): VerifiedToolApproval {
    validateRequest(input);
    const [encoded, signature, extra] = input.capability.split(".");
    if (!encoded || !signature || extra) throw new Error("Tool approval signature is invalid.");
    let verified = false;
    try {
      verified = verify(null, Buffer.from(encoded), createPublicKey(this.publicKey), Buffer.from(signature, "base64url"));
    } catch {
      verified = false;
    }
    if (!verified) throw new Error("Tool approval signature is invalid.");
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    } catch {
      throw new Error("Tool approval schema is invalid.");
    }
    assertPayload(payload);
    if (payload.serverId !== input.serverId || payload.name !== input.name || payload.risk !== input.risk || payload.argumentsDigest !== input.argumentsDigest) {
      throw new Error("Tool approval does not match the request.");
    }
    const now = Date.parse(this.now());
    const issuedAt = Date.parse(payload.issuedAt);
    const expiresAt = Date.parse(payload.expiresAt);
    if (issuedAt > now + 5_000) throw new Error("Tool approval clock is invalid.");
    if (expiresAt - issuedAt > this.maximumTtlMs) throw new Error("Tool approval lifetime exceeds the maximum.");
    if (expiresAt <= now) throw new Error("Tool approval expired.");
    if (this.spent.has(payload.nonce)) throw new Error("Tool approval was already used.");
    this.spent.set(payload.nonce, expiresAt);
    this.forgetExpired(now);
    return { nonce: payload.nonce, expiresAt: payload.expiresAt, approverId: toolApprovalPrincipal(this.publicKey) };
  }

  /**
   * Evicts only nonces that can no longer be replayed. Clearing indiscriminately would
   * reopen replay for every capability still inside its validity window.
   */
  private forgetExpired(now: number): void {
    for (const [nonce, expiresAt] of this.spent) {
      if (expiresAt <= now) this.spent.delete(nonce);
    }
  }
}

export function toolApprovalPrincipal(publicKey: string): string {
  return `electron-${createHash("sha256").update(createPublicKey(publicKey).export({ type: "spki", format: "der" })).digest("hex").slice(0, 32)}`;
}

function validateRequest(value: ToolApprovalRequest): void {
  if (!ID.test(value.serverId) || !ID.test(value.name) || !RISKS.has(value.risk) || !DIGEST.test(value.argumentsDigest)) {
    throw new Error("Tool approval request is invalid.");
  }
}

function assertPayload(value: unknown): asserts value is SignedToolApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool approval schema is invalid.");
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== FIELDS.length
    || !FIELDS.every(field => Object.hasOwn(item, field))
    || !ID.test(String(item.serverId))
    || !ID.test(String(item.name))
    || !ID.test(String(item.nonce))
    || !RISKS.has(String(item.risk))
    || !DIGEST.test(String(item.argumentsDigest))
    || !isTimestamp(item.issuedAt)
    || !isTimestamp(item.expiresAt)
  ) {
    throw new Error("Tool approval schema is invalid.");
  }
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
