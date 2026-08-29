import { describe, expect, it } from "vitest";
import { AppendOnlyEvidenceStore, type EvidencePersistence, type EvidenceRecord } from "./evidence-store";

function memoryPersistence(initial: EvidenceRecord[] = []): EvidencePersistence & { records: EvidenceRecord[] } {
  const records = [...initial];
  let pending = Promise.resolve();
  return {
    records,
    reserveAndAppend: (createRecord) => {
      const operation = pending.then(async () => {
        const record = createRecord(records.length + 1);
        records.push({ ...record });
        return record;
      });
      pending = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}

describe("AppendOnlyEvidenceStore", () => {
  it("assigns stable sequence IDs and persists immutable records", async () => {
    const persistence = memoryPersistence();
    const store = new AppendOnlyEvidenceStore({
      now: () => "2026-08-28T00:00:00.000Z",
      maxSummaryLength: 20,
      persistence,
    });

    const first = await store.append({ kind: "command", status: "passed", summary: "command passed", planRevisionId: "plan-1" });
    const second = await store.append({ kind: "test", status: "failed", summary: "test failed", planRevisionId: "plan-1" });

    expect(first).toMatchObject({ id: "evidence-1", timestamp: "2026-08-28T00:00:00.000Z" });
    expect(second.id).toBe("evidence-2");
    expect(persistence.records).toHaveLength(2);
    expect(persistence.records[0].sequence).toBe(1);
    expect(persistence.records[0]).not.toBe(first);
    expect(persistence.records[0].summary).toBe("command passed");
  });

  it("bounds summaries before persistence", async () => {
    const persistence = memoryPersistence();
    const store = new AppendOnlyEvidenceStore({
      persistence,
      maxSummaryLength: 5,
    });

    const result = await store.append({ kind: "log", status: "warning", summary: "123456789", planRevisionId: "plan-1" });

    expect(result.summary).toBe("12345");
    expect(persistence.records[0].summary).toBe("12345");
  });

  it("rejects invalid evidence and does not persist it", async () => {
    const persistence = memoryPersistence();
    const store = new AppendOnlyEvidenceStore({ persistence });

    await expect(store.append({ kind: "command", status: "passed", summary: " ", planRevisionId: "plan-1" })).rejects.toThrow();
    expect(persistence.records).toHaveLength(0);
  });

  it("reopens persisted evidence and continues unique monotonic IDs", async () => {
    const persistence = memoryPersistence();
    const firstStore = new AppendOnlyEvidenceStore({ persistence });
    await firstStore.append({ kind: "command", status: "passed", summary: "first", planRevisionId: "plan-1" });

    const reopenedStore = new AppendOnlyEvidenceStore({ persistence });
    const second = await reopenedStore.append({ kind: "test", status: "passed", summary: "second", planRevisionId: "plan-1" });

    expect(second).toMatchObject({ id: "evidence-2", sequence: 2 });
    expect(persistence.records.map((record) => record.id)).toEqual(["evidence-1", "evidence-2"]);
  });

  it("atomically reserves unique sequences for concurrent appends", async () => {
    const persistence = memoryPersistence();
    const firstStore = new AppendOnlyEvidenceStore({ persistence });
    const secondStore = new AppendOnlyEvidenceStore({ persistence });

    const results = await Promise.all([
      firstStore.append({ kind: "command", status: "passed", summary: "first", planRevisionId: "plan-1" }),
      secondStore.append({ kind: "test", status: "passed", summary: "second", planRevisionId: "plan-1" }),
    ]);

    expect(results.map((record) => record.sequence).sort()).toEqual([1, 2]);
    expect(new Set(results.map((record) => record.id)).size).toBe(2);
  });

  it("does not consume a sequence when persistence fails", async () => {
    const persistence = memoryPersistence();
    const reserveAndAppend = persistence.reserveAndAppend.bind(persistence);
    let fail = true;
    persistence.reserveAndAppend = async (createRecord) => {
      if (fail) {
        fail = false;
        throw new Error("disk full");
      }
      return reserveAndAppend(createRecord);
    };
    const store = new AppendOnlyEvidenceStore({ persistence });

    await expect(store.append({ kind: "command", status: "failed", summary: "failed", planRevisionId: "plan-1" })).rejects.toThrow("disk full");
    await expect(store.append({ kind: "command", status: "passed", summary: "retry", planRevisionId: "plan-1" })).resolves.toMatchObject({
      id: "evidence-1",
      sequence: 1,
    });
  });
});
