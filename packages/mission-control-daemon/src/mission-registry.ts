import type { Mission } from "@orrery/mission-control-domain";
import type { MissionListItem } from "@orrery/mission-control-protocol";
import type { MissionStore, RepositoryRegistry } from "./authority-ports";
import type { RepositoryApprovalInput, RepositoryProposalResult, ApprovedRepository } from "./authority-types";
import type { MissionSnapshot } from "./authority-types";
import { publicMission } from "./public-mission";

export interface MissionSnapshotRepository {
  list(): Promise<ReadonlyArray<Mission>> | ReadonlyArray<Mission>;
  get(id: string): Promise<Mission | null> | Mission | null;
}

export class MissionRegistry {
  constructor(private readonly repository: MissionSnapshotRepository) {}

  async list(): Promise<ReadonlyArray<MissionListItem>> {
    const missions = await this.repository.list();
    return missions.map(({ id, title, status, updatedAt }) => structuredClone({ id, title, status, updatedAt }));
  }

  async get(id: string): Promise<Mission | null> {
    const mission = await this.repository.get(id);
    return mission === null ? null : structuredClone(mission);
  }

  async propose(localPath: string): Promise<RepositoryProposalResult> {
    const registry = this.repository as MissionSnapshotRepository & Partial<RepositoryRegistry>;
    if (!registry.propose) throw new Error("Repository authority is unavailable.");
    return structuredClone(await registry.propose(localPath));
  }

  async approve(input: RepositoryApprovalInput): Promise<ApprovedRepository> {
    const registry = this.repository as MissionSnapshotRepository & Partial<RepositoryRegistry>;
    if (!registry.approve) throw new Error("Repository authority is unavailable.");
    return structuredClone(await registry.approve(input));
  }
}

export function missionStoreRepository(store: MissionStore): MissionSnapshotRepository {
  return {
    list: async () => (await store.list()).map(publicMission),
    get: async (id) => {
      const mission = await store.load(id);
      return mission === null ? null : publicMission(mission);
    },
  };
}
