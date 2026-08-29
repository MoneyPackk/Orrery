import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MissionStore } from "./authority-ports";
import type { MissionEventRecord, MissionSnapshot } from "./authority-types";
import { MAX_EVENT_FILE_BYTES, MAX_SNAPSHOT_BYTES, assertEvent, assertIdentifier, assertSnapshot, assertSnapshotConsistent, atomicWriteJson, clone, enqueue, initialize, pathsFor, publishEvents, readEvents, readSnapshotFile, removeJournal, replaceEvents, retainedEvents, writeJournal } from "./durable-store-files";

export interface FileMissionStoreOptions { maxEventFileBytes?: number; retainedEventCount?: number }

export class FileMissionStore implements MissionStore {
  constructor(private readonly stateDirectory: string, private readonly options: FileMissionStoreOptions = {}) {}

  create(snapshot: MissionSnapshot): Promise<void> {
    return enqueue(this.stateDirectory, async () => {
      await initialize(this.stateDirectory);
      const copy = clone(snapshot);
      assertSnapshot(copy);
      if (copy.lastEventSequence !== 0) throw new Error("A new mission snapshot must start at event sequence zero.");
      const path = join(pathsFor(this.stateDirectory).missions, `${copy.id}.json`);
      try { await readSnapshotFile(path); throw new Error(`Mission ${copy.id} already exists.`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await atomicWriteJson(path, copy, MAX_SNAPSHOT_BYTES);
    });
  }

  load(missionId: string): Promise<MissionSnapshot | null> {
    return enqueue(this.stateDirectory, async () => {
      await initialize(this.stateDirectory);
      assertIdentifier(missionId, "mission id");
      try {
        const snapshot = await readSnapshotFile(join(pathsFor(this.stateDirectory).missions, `${missionId}.json`));
        if (snapshot.id !== missionId) throw new Error("Corrupt mission snapshot filename.");
        await assertSnapshotConsistent(this.stateDirectory, snapshot);
        return clone(snapshot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    });
  }

  list(): Promise<readonly MissionSnapshot[]> {
    return enqueue(this.stateDirectory, async () => {
      await initialize(this.stateDirectory);
      const directory = pathsFor(this.stateDirectory).missions;
      const entries = await readdir(directory, { withFileTypes: true });
      const snapshots: MissionSnapshot[] = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) throw new Error("Corrupt mission snapshot directory.");
        const missionId = entry.name.slice(0, -5);
        assertIdentifier(missionId, "mission id");
        const snapshot = await readSnapshotFile(join(directory, entry.name));
        if (snapshot.id !== missionId) throw new Error("Corrupt mission snapshot filename.");
        await assertSnapshotConsistent(this.stateDirectory, snapshot);
        snapshots.push(clone(snapshot));
      }
      return snapshots;
    });
  }

  save(snapshot: MissionSnapshot, events: readonly MissionEventRecord[]): Promise<void> {
    return enqueue(this.stateDirectory, async () => {
      await initialize(this.stateDirectory);
      let nextSnapshot = clone(snapshot);
      const nextEvents = clone(events);
      assertSnapshot(nextSnapshot);
      for (const event of nextEvents) assertEvent(event);
      const path = join(pathsFor(this.stateDirectory).missions, `${nextSnapshot.id}.json`);
      let current: MissionSnapshot;
      try { current = await readSnapshotFile(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Mission ${nextSnapshot.id} does not exist.`); throw error; }
      await assertSnapshotConsistent(this.stateDirectory, current);
      const expected = current.lastEventSequence + 1;
      if (nextEvents.some((event, index) => event.missionId !== nextSnapshot.id || event.sequence !== expected + index) || nextSnapshot.lastEventSequence !== current.lastEventSequence + nextEvents.length) throw new Error(`Mission event sequence must be contiguous; expected ${expected}.`);
      const currentEvents = await readEvents(this.stateDirectory, nextSnapshot.id);
      const maximumBytes = this.options.maxEventFileBytes ?? MAX_EVENT_FILE_BYTES;
      const additionsBytes = Buffer.byteLength(nextEvents.map((event) => `${JSON.stringify(event)}\n`).join(""));
      if (additionsBytes > maximumBytes) throw new Error("Mission event append exceeds the event log quota.");
      const retained = await retainedEvents([...currentEvents, ...nextEvents], this.options.retainedEventCount ?? Number.MAX_SAFE_INTEGER, maximumBytes);
      nextSnapshot = { ...nextSnapshot, firstEventSequence: retained[0]?.sequence ?? nextSnapshot.lastEventSequence + 1, events: [...retained] };
      await writeJournal(this.stateDirectory, { payloadVersion: 1, missionId: nextSnapshot.id, snapshot: nextSnapshot, events: nextEvents, retainedEvents: retained });
      await replaceEvents(join(pathsFor(this.stateDirectory).events, `${nextSnapshot.id}.jsonl`), retained);
      await atomicWriteJson(path, nextSnapshot, MAX_SNAPSHOT_BYTES);
      await removeJournal(this.stateDirectory, nextSnapshot.id);
      publishEvents(this.stateDirectory, nextEvents);
    });
  }
}
