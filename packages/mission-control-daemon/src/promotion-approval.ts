export interface PromotionApprovalRequest {
  readonly missionId: string;
  readonly planRevisionId: string;
  readonly changeRevision: string;
  readonly decision: "accepted" | "rejected";
}

export interface PromotionApprovalVerifier {
  consume(input: PromotionApprovalRequest & { readonly capability: string }): { readonly reviewerId: string };
}

export interface PromotionApprovalIssuer { issue(input: PromotionApprovalRequest): string }

export interface TrustedApprovalContext {
  readonly reviewerId: () => string;
  readonly now?: () => string;
  readonly id?: () => string;
  readonly maximumTtlMs?: number;
}

interface Approval extends PromotionApprovalRequest { readonly reviewerId: string; readonly expiresAt: string; used: boolean }

export class TrustedApprovalService implements PromotionApprovalIssuer, PromotionApprovalVerifier {
  private readonly approvals = new Map<string, Approval>();
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly maximumTtlMs: number;

  constructor(private readonly context: TrustedApprovalContext) {
    this.now = context.now ?? (() => new Date().toISOString());
    this.id = context.id ?? (() => crypto.randomUUID());
    this.maximumTtlMs = context.maximumTtlMs ?? 60_000;
    if (!Number.isSafeInteger(this.maximumTtlMs) || this.maximumTtlMs <= 0) throw new Error("Promotion approval maximum TTL must be positive.");
  }

  issue(input: PromotionApprovalRequest): string {
    const reviewerId = this.context.reviewerId().trim();
    if (!reviewerId) throw new Error("Trusted promotion reviewer identity is unavailable.");
    const capability = this.id();
    this.approvals.set(capability, { ...input, reviewerId, expiresAt: new Date(Date.parse(this.now()) + this.maximumTtlMs).toISOString(), used: false });
    return capability;
  }

  consume(input: PromotionApprovalRequest & { readonly capability: string }): { readonly reviewerId: string } {
    const approval = this.approvals.get(input.capability);
    if (!approval) throw new Error("Promotion approval capability is invalid.");
    if (approval.used) throw new Error("Promotion approval capability was already used.");
    if (Date.parse(approval.expiresAt) <= Date.parse(this.now())) throw new Error("Promotion approval capability expired.");
    if (approval.missionId !== input.missionId || approval.planRevisionId !== input.planRevisionId || approval.changeRevision !== input.changeRevision || approval.decision !== input.decision) throw new Error("Promotion approval capability does not match the request.");
    approval.used = true;
    return { reviewerId: approval.reviewerId };
  }
}
