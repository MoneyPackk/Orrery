import type { ApprovedRepository, MissionEventRecord, MissionSnapshot, RepositoryApprovalInput, RepositoryProposal, RepositoryProposalResult } from "./authority-types";

export interface RepositoryRegistry {
  propose(localPath: string): Promise<RepositoryProposalResult>;
  approve(input: RepositoryApprovalInput): Promise<ApprovedRepository>;
  resolve(repositoryId: string): Promise<ApprovedRepository>;
}

export interface GitInspector {
  inspect(localPath: string): Promise<{ canonicalRoot: string; gitIdentity: string }>;
}

export interface RepositoryRegistryPersistence {
  load(): Promise<readonly ApprovedRepository[]>;
  loadProposals(): Promise<readonly RepositoryProposal[]>;
  save(entries: readonly ApprovedRepository[]): Promise<void>;
  saveProposal(proposal: RepositoryProposal): Promise<void>;
  approveProposal(proposalId: string, entries: readonly ApprovedRepository[]): Promise<void>;
}

export type MissionEventSubscriber = (event: MissionEventRecord) => void;
export type EventListener = MissionEventSubscriber;

export interface EventSubscription { unsubscribe(): void }

export interface MissionEventStore {
  append(events: readonly MissionEventRecord[]): Promise<void>;
  readAfter(missionId: string, sequence: number, throughSequence?: number): Promise<readonly MissionEventRecord[] | EventReplay>;
  highWaterMark?(missionId: string): Promise<number>;
  subscribe(missionId: string, subscriber: MissionEventSubscriber): EventSubscription;
}

export interface EventReplay {
  readonly events: readonly MissionEventRecord[];
  readonly cursor: number;
  readonly highWaterMark: number;
  readonly overflow?: { readonly firstAvailableSequence: number };
}

export interface MissionStore {
  create(snapshot: MissionSnapshot): Promise<void>;
  load(missionId: string): Promise<MissionSnapshot | null>;
  list(): Promise<readonly MissionSnapshot[]>;
  save(snapshot: MissionSnapshot, events: readonly MissionEventRecord[]): Promise<void>;
}
