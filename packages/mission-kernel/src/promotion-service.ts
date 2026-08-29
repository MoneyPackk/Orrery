import type { WorkspaceService } from "./ports";
import type { PromotionInput, PromotionPreparation, PromotionReconciliation, PromotionResult, PromotionRetryToken } from "./types";

export interface PromotionServiceOptions {
  workspaceService: WorkspaceService;
}

export class PromotionService {
  constructor(private readonly options: PromotionServiceOptions) {}

  async promote(input: PromotionInput): Promise<PromotionResult> {
    if (input.mission.status !== "ready_for_review") throw new Error("Mission must be ready_for_review");
    if (!input.reviewerId.trim()) throw new Error("Reviewer identity is required");
    assertApprovalActive(input.approvalExpiresAt);
    if (input.workspace.missionId !== input.mission.id || input.workspace.id !== input.mission.workspaceId) throw new Error("Mission workspace does not belong to this mission");
    if (input.planRevisionId !== input.mission.plan.id) throw new Error("Mission plan revision does not match");
    if (input.decision === "rejected") return { status: "rejected" };
    const currentSnapshot = await this.options.workspaceService.inspectChanges(input.workspace);
    if (JSON.stringify(input.changeSnapshot) !== JSON.stringify(currentSnapshot)) throw new Error("Mission change snapshot does not match");
    return this.options.workspaceService.promote(input.workspace, input.mission.targetBranch, input.reviewerId.trim(), input.changeSnapshot, input.approvalExpiresAt);
  }

  async preparePromotion(input: PromotionInput): Promise<PromotionPreparation> {
    if (input.mission.status !== "ready_for_review") throw new Error("Mission must be ready_for_review");
    if (!input.reviewerId.trim()) throw new Error("Reviewer identity is required");
    if (input.workspace.missionId !== input.mission.id || input.workspace.id !== input.mission.workspaceId) {
      throw new Error("Mission workspace does not belong to this mission");
    }
    if (input.planRevisionId !== input.mission.plan.id) throw new Error("Mission plan revision does not match");
    assertApprovalActive(input.approvalExpiresAt);
    if (input.decision === "rejected") return { status: "rejected" };
    const currentSnapshot = await this.options.workspaceService.inspectChanges(input.workspace);
    if (JSON.stringify(input.changeSnapshot) !== JSON.stringify(currentSnapshot)) {
      throw new Error("Mission change snapshot does not match");
    }
    const preparation = await this.options.workspaceService.preparePromotion(
      input.workspace,
      input.mission.targetBranch,
      input.reviewerId.trim(),
      input.changeSnapshot,
    );
    assertApprovalActive(input.approvalExpiresAt);
    return preparation;
  }

  commitPromotion(token: PromotionRetryToken, reviewerId: string, approvalExpiresAt: string): Promise<PromotionResult> {
    return this.promoteRetry(token, reviewerId, approvalExpiresAt);
  }

  async reconcilePromotion(token: PromotionRetryToken, approvalExpiresAt: string): Promise<PromotionReconciliation> {
    assertApprovalActive(approvalExpiresAt);
    if (!this.options.workspaceService.reconcilePromotion) throw new Error("Workspace service cannot reconcile promotions.");
    return this.options.workspaceService.reconcilePromotion(token, approvalExpiresAt);
  }

  async promoteRetry(token: PromotionRetryToken, reviewerId: string, approvalExpiresAt: string): Promise<PromotionResult> {
    if (!reviewerId.trim()) throw new Error("Reviewer identity is required");
    assertApprovalActive(approvalExpiresAt);
    return this.options.workspaceService.promoteRetry(token, reviewerId.trim(), approvalExpiresAt);
  }
}

function assertApprovalActive(approvalExpiresAt: string): void {
  if (typeof approvalExpiresAt !== "string" || !Number.isFinite(Date.parse(approvalExpiresAt))) {
    throw new Error("Promotion approval expiry is required and must be valid.");
  }
  if (Date.parse(approvalExpiresAt) <= Date.now()) throw new Error("Promotion approval expired before target mutation.");
}
