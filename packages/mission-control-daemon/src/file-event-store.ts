import type { EventReplay, EventSubscription, MissionEventStore, MissionEventSubscriber } from "./authority-ports";
import type { MissionEventRecord } from "./authority-types";
import { appendEventsDirect, clone, enqueue, initialize, publishEvents, readEvents, subscribeToEvents } from "./durable-store-files";

export interface FileMissionEventStoreOptions { maxEventFileBytes?: number; retainedEventCount?: number }

export class FileMissionEventStore implements MissionEventStore {
  constructor(private readonly stateDirectory: string, private readonly options: FileMissionEventStoreOptions = {}) {}

  append(events: readonly MissionEventRecord[]): Promise<void> {
    return enqueue(this.stateDirectory, async () => {
      await initialize(this.stateDirectory);
      const copies = clone(events);
      await appendEventsDirect(this.stateDirectory, copies, this.options);
      publishEvents(this.stateDirectory, copies);
    });
  }

  readAfter(missionId: string, sequence: number): Promise<readonly MissionEventRecord[]>;
  readAfter(missionId: string, sequence: number, throughSequence: number): Promise<EventReplay>;
  readAfter(missionId: string, sequence: number, throughSequence?: number): Promise<readonly MissionEventRecord[] | EventReplay> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return Promise.reject(new Error("Event cursor must be a non-negative safe integer."));
    return enqueue(this.stateDirectory, async () => {
      await initialize(this.stateDirectory);
      const history = await readEvents(this.stateDirectory, missionId);
      const events = history.filter((event) => event.sequence > sequence && event.sequence <= (throughSequence ?? Number.MAX_SAFE_INTEGER));
      if (throughSequence === undefined) return clone(events);
      const firstAvailableSequence = history[0]?.sequence ?? throughSequence + 1;
      return clone({
        events,
        cursor: throughSequence,
        highWaterMark: throughSequence,
        ...(sequence < firstAvailableSequence - 1 ? { overflow: { firstAvailableSequence } } : {}),
      });
    });
  }

  highWaterMark(missionId: string): Promise<number> {
    return enqueue(this.stateDirectory, async () => {
      await initialize(this.stateDirectory);
      return (await readEvents(this.stateDirectory, missionId)).at(-1)?.sequence ?? 0;
    });
  }

  subscribe(missionId: string, subscriber: MissionEventSubscriber): EventSubscription {
    return subscribeToEvents(this.stateDirectory, missionId, subscriber);
  }
}
