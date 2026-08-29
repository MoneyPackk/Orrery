import type { Mission } from "@orrery/mission-control-domain";
import type { MissionSnapshot } from "./authority-types";

export function publicMission(snapshot: MissionSnapshot): Mission {
  const {
    repositoryId: _repositoryId,
    fingerprint: _fingerprint,
    firstEventSequence: _firstEventSequence,
    lastEventSequence: _lastEventSequence,
    payloadVersion: _payloadVersion,
    currentChangeSnapshot: _currentChangeSnapshot,
    currentWorkspace: _currentWorkspace,
    intentOutcomes: _intentOutcomes,
    operations: _operations,
    ...mission
  } = snapshot;
  return structuredClone({
    ...mission,
    events: mission.events.map((event) => {
      const { payloadVersion: _eventPayloadVersion, recordedAt: _recordedAt, ...publicEvent } = event as typeof event & { payloadVersion?: number; recordedAt?: string };
      return publicEvent;
    }),
    changes: mission.changes.map(({ path, additions, deletions, diff }) => ({ path, additions, deletions, diff })),
    evidence: mission.evidence.map(({ id, kind, status, summary, criterion, planRevisionId, timestamp }) => ({
      id, kind, status, summary, ...(criterion === undefined ? {} : { criterion }), planRevisionId, timestamp,
    })),
  });
}
