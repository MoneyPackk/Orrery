import type { Evidence } from "@orrery/mission-control-domain";
import type { EvidenceInput } from "./types";
import { assertNonEmptyId } from "./ports";

export interface EvidenceRecord extends Evidence {
  sequence: number;
}

export interface EvidencePersistence {
  reserveAndAppend(createRecord: (sequence: number) => EvidenceRecord): Promise<EvidenceRecord>;
}

export interface EvidenceStoreOptions {
  persistence: EvidencePersistence;
  maxSummaryLength?: number;
  now?: () => string;
}

export class AppendOnlyEvidenceStore {
  private readonly maxSummaryLength: number;
  private readonly now: () => string;

  constructor(private readonly options: EvidenceStoreOptions) {
    this.maxSummaryLength = options.maxSummaryLength ?? 4096;
    this.now = options.now ?? (() => new Date().toISOString());
    if (this.maxSummaryLength <= 0) throw new Error("Invalid evidence summary limit");
  }

  async append(input: EvidenceInput): Promise<EvidenceRecord> {
    this.validate(input);
    return this.options.persistence.reserveAndAppend((sequence) =>
      Object.freeze({
        ...input,
        id: `evidence-${sequence}`,
        sequence,
        timestamp: this.now(),
        summary: input.summary.slice(0, this.maxSummaryLength),
      }),
    );
  }

  private validate(input: EvidenceInput): void {
    if (!input || !input.summary.trim()) throw new Error("Evidence summary is required");
    assertNonEmptyId(input.planRevisionId, "planRevisionId");
    if (!["command", "test", "diagnostic", "screenshot", "log", "manual"].includes(input.kind)) throw new Error("Invalid evidence kind");
    if (!["passed", "failed", "warning", "informational"].includes(input.status)) throw new Error("Invalid evidence status");
  }
}
