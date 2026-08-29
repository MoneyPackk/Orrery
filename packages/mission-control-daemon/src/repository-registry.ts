import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { GitInspector, RepositoryRegistry, RepositoryRegistryPersistence } from "./authority-ports";
import type { ApprovedRepository, RepositoryApprovalInput, RepositoryProposal, RepositoryProposalResult } from "./authority-types";

const NONCE_BYTES = 32;

export class FileRepositoryRegistry implements RepositoryRegistry {
  private readonly proposals = new Map<string, RepositoryProposal>();
  private readonly entries = new Map<string, ApprovedRepository>();
  private readonly loaded: Promise<void>;
  private approvalQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    persistence: RepositoryRegistryPersistence;
    gitInspector: GitInspector;
    now: () => number;
    proposalTtlMs: number;
  }) {
    this.loaded = Promise.all([options.persistence.load(), options.persistence.loadProposals()]).then(([entries, proposals]) => {
      entries.forEach((entry) => this.entries.set(entry.repositoryId, entry));
      proposals.filter((proposal) => options.now() < Date.parse(proposal.expiresAt)).forEach((proposal) => this.proposals.set(proposal.proposalId, proposal));
    });
  }

  async propose(localPath: string): Promise<RepositoryProposalResult> {
    await this.loaded;
    const canonicalPath = await realpath(localPath);
    const identity = await this.options.gitInspector.inspect(canonicalPath);
    if (identity.canonicalRoot !== canonicalPath) throw new Error("Inspected path is not the canonical Git root.");
    const fingerprint = fingerprintFor(identity);
    const proposalId = randomBytes(16).toString("hex");
    const approvalNonce = randomBytes(NONCE_BYTES).toString("hex");
    const proposal: RepositoryProposal = {
      proposalId, canonicalRoot: identity.canonicalRoot, fingerprint, gitIdentity: identity.gitIdentity,
      approvalNonceHash: hash(approvalNonce), expiresAt: new Date(this.options.now() + this.options.proposalTtlMs).toISOString(), payloadVersion: 1,
    };
    await this.options.persistence.saveProposal(proposal);
    this.proposals.set(proposalId, proposal);
    return { proposalId, canonicalRoot: proposal.canonicalRoot, fingerprint, gitIdentity: proposal.gitIdentity, approvalNonce, expiresAt: proposal.expiresAt, payloadVersion: 1 };
  }

  async ready(): Promise<void> { await this.loaded; }

  async approve(input: RepositoryApprovalInput): Promise<ApprovedRepository> {
    await this.loaded;
    const previous = this.approvalQueue;
    let release: () => void = () => undefined;
    this.approvalQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.approveSerialized(input);
    } finally {
      release();
    }
  }

  private async approveSerialized(input: RepositoryApprovalInput): Promise<ApprovedRepository> {
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal) throw new Error("Proposal not found or already used.");
    if (this.options.now() >= Date.parse(proposal.expiresAt)) throw new Error("Proposal expired.");
    if (input.fingerprint !== proposal.fingerprint) throw new Error("Proposal fingerprint does not match.");
    if (!constantTimeHashEqual(input.approvalNonce, proposal.approvalNonceHash)) throw new Error("Proposal approval nonce is invalid.");
    const identity = await this.options.gitInspector.inspect(proposal.canonicalRoot);
    if (identity.canonicalRoot !== proposal.canonicalRoot || fingerprintFor(identity) !== proposal.fingerprint) throw new Error("Repository identity changed.");
    const approvedAt = new Date(this.options.now()).toISOString();
    const entry: ApprovedRepository = { repositoryId: randomBytes(16).toString("hex"), ...proposalIdentity(proposal), approvedAt, lastVerifiedAt: approvedAt, payloadVersion: 1 };
    await this.options.persistence.approveProposal(input.proposalId, [...this.entries.values(), entry]);
    this.entries.set(entry.repositoryId, entry);
    this.proposals.delete(input.proposalId);
    return structuredClone(entry);
  }

  async resolve(repositoryId: string): Promise<ApprovedRepository> {
    await this.loaded;
    const entry = this.entries.get(repositoryId);
    if (!entry) throw new Error("Approved repository not found.");
    const identity = await this.options.gitInspector.inspect(entry.canonicalRoot);
    if (identity.canonicalRoot !== entry.canonicalRoot || fingerprintFor(identity) !== entry.fingerprint) throw new Error("Repository identity changed.");
    return structuredClone(entry);
  }
}

function proposalIdentity(proposal: RepositoryProposal): Pick<ApprovedRepository, "canonicalRoot" | "fingerprint" | "gitIdentity"> {
  return { canonicalRoot: proposal.canonicalRoot, fingerprint: proposal.fingerprint, gitIdentity: proposal.gitIdentity };
}

function fingerprintFor(identity: { canonicalRoot: string; gitIdentity: string }): string {
  return createHash("sha256").update(JSON.stringify([identity.canonicalRoot, identity.gitIdentity]), "utf8").digest("hex");
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function constantTimeHashEqual(candidate: string, expectedHash: string): boolean {
  const candidateHash = Buffer.from(hash(candidate), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return candidateHash.length === expected.length && timingSafeEqual(candidateHash, expected);
}
