import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { promisify } from "node:util";
import type { Mission } from "@orrery/mission-control-domain";
import { afterEach, describe, expect, it } from "vitest";
import type { MissionEventRecord, MissionSnapshot } from "./authority-types";
import { FileMissionEventStore } from "./file-event-store";
import { FileMissionStore } from "./file-mission-store";

const directories: string[] = [];
const execFileAsync = promisify(execFile);
let testIdentity: Promise<string> | undefined;

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => {
    await grantTestAccess(directory);
    await rm(directory, { recursive: true, force: true });
  }));
});

async function grantTestAccess(path: string) {
  if (process.platform !== "win32") return;
  const identity = await (testIdentity ??= execFileAsync("whoami").then(({ stdout }) => stdout.trim()));
  if (!identity) throw new Error("Unable to determine the Windows test identity.");
  await execFileAsync("icacls", [path, "/grant:r", `${identity}:F`, "/T", "/C"]);
}

async function writeFixture(path: string, data: string) {
  const directory = directories.find((candidate) => path.startsWith(candidate));
  if (directory) await grantTestAccess(directory);
  await writeFile(path, data, "utf8");
  await grantTestAccess(path);
}

async function stateDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "orrery-durable-store-"));
  directories.push(directory);
  return directory;
}

function mission(id: string, lastEventSequence = 0): MissionSnapshot {
  const value: Mission = {
    id,
    title: `Mission ${id}`,
    goal: "Persist safely",
    mode: "build",
    status: "draft",
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
    targetBranch: "main",
    plan: {
      id: "plan-1",
      revision: 1,
      approved: false,
      createdAt: "2026-08-28T10:00:00.000Z",
      scope: "Store state",
      actions: ["Write records"],
      acceptanceCriteria: ["Survives restart"],
    },
    events: [],
    changes: [],
    evidence: [],
  };
  return { ...value, repositoryId: "repository-1", fingerprint: "sha256:fingerprint", lastEventSequence, payloadVersion: 1 };
}

function event(missionId: string, sequence: number): MissionEventRecord {
  return {
    id: `${missionId}-event-${sequence}`,
    missionId,
    runId: "run-1",
    sequence,
    timestamp: `2026-08-28T10:00:0${sequence}.000Z`,
    kind: "execution",
    title: `Event ${sequence}`,
    detail: `Detail ${sequence}`,
    payloadVersion: 1,
    recordedAt: `2026-08-28T10:00:0${sequence}.500Z`,
  };
}

/**
 * Exercises real filesystem journaling and fsync, which is slow under parallel disk load even
 * though each case is fast in isolation. Scoped budget for the same reason as the Git suite.
 */
describe("filesystem mission persistence", { timeout: 30_000 }, () => {
  it("creates, loads, and lists snapshots without retaining mutable references", async () => {
    const directory = await stateDirectory();
    const store = new FileMissionStore(directory);
    const first = mission("mission-a");
    const second = mission("mission-b");

    await store.create(first);
    await store.create(second);
    first.plan.actions[0] = "corrupted caller value";
    const loaded = await store.load("mission-a");
    loaded!.plan.actions[0] = "corrupted loaded value";

    expect((await store.load("mission-a"))!.plan.actions).toEqual(["Write records"]);
    expect((await store.list()).map((item) => item.id)).toEqual(["mission-a", "mission-b"]);
    await expect(store.create(mission("mission-a"))).rejects.toThrow(/already exists/i);
  });

  it("persists intent digests and durable operation states across store restart", async () => {
    const directory = await stateDirectory();
    const store = new FileMissionStore(directory);
    const snapshot: MissionSnapshot = { ...mission("mission-operation"), operations: {
      "run-1": { operation: "run", requestDigest: "a".repeat(64), state: "in_progress", runId: "run-1" },
      "promote-expired": { operation: "promote", requestDigest: "b".repeat(64), state: "expired", reviewerId: "reviewer-1", approvalNonce: "nonce-1", approvalExpiresAt: "2026-08-29T10:01:00.000Z" },
    } };
    await store.create(snapshot);

    const restarted = new FileMissionStore(directory);
    expect((await restarted.load(snapshot.id))!.operations).toEqual(snapshot.operations);
  });

  it("rejects malformed discriminated intent outcomes and nested results", async () => {
    const validRunResult = {
      missionId: "mission-a", runId: "run-1", planRevisionId: "plan-1:1", status: "ready_for_review",
      mission: mission("mission-a"), workspace: { handle: "workspace-1" },
      changeSnapshot: { revision: "a".repeat(40), files: [], unifiedDiff: "" },
    };
    const validPromotionResult = {
      mission: mission("mission-a"), reviewerId: "reviewer-1", result: { status: "promoted", revision: "b".repeat(40) },
    };
    const cases: unknown[] = [
      { operation: "invented", requestDigest: "a".repeat(64), result: mission("mission-a") },
      { operation: "run", requestDigest: "a".repeat(64), result: { ...validRunResult, workspace: { handle: "bad handle" } } },
      { operation: "run", requestDigest: "a".repeat(64), result: { ...validRunResult, unexpected: true } },
      { operation: "promote", requestDigest: "a".repeat(64), result: { ...validPromotionResult, result: { status: "rejected", revision: "forbidden" } } },
      { operation: "promote", requestDigest: "a".repeat(64), result: { ...validPromotionResult, result: { status: "conflict", reason: "changed", retry: { missionRevision: "x", expectedTargetRevision: "y" } } } },
    ];
    for (const [index, outcome] of cases.entries()) {
      const directory = await stateDirectory();
      await mkdir(join(directory, "missions"), { recursive: true });
      await writeFixture(join(directory, "missions", "mission-a.json"), `${JSON.stringify({ ...mission("mission-a"), intentOutcomes: { [`intent-${index}`]: outcome } })}\n`);
      await expect(new FileMissionStore(directory).load("mission-a")).rejects.toThrow(/corrupt|invalid/i);
    }
  });

  it("enforces required and forbidden operation fields for every state", async () => {
    const runResult = {
      missionId: "mission-a", runId: "run-1", planRevisionId: "plan-1:1", status: "ready_for_review",
      mission: mission("mission-a"), workspace: { handle: "workspace-1" },
      changeSnapshot: { revision: "a".repeat(40), files: [], unifiedDiff: "" },
    };
    const token = {
      missionRevision: "a".repeat(40), expectedTargetRevision: "b".repeat(40), targetBranch: "main",
      workspace: { id: "workspace-1", missionId: "mission-a", repositoryRoot: "C:/repo", worktreePath: "C:/worktree", targetBranch: "main", missionBranch: "orrery/mission-a", initialRevision: "c".repeat(40) },
      missionParent: "d".repeat(40), missionTree: "e".repeat(40),
    };
    const promotionResult = { mission: mission("mission-a"), reviewerId: "reviewer-1", result: { status: "conflict", reason: "changed", retry: token } };
    const cases: unknown[] = [
      { operation: "run", requestDigest: "a".repeat(64), state: "prepared", runId: "run-1", result: runResult },
      { operation: "run", requestDigest: "a".repeat(64), state: "committed", runId: "run-1" },
      { operation: "run", requestDigest: "a".repeat(64), state: "in_progress", runId: "bad run id" },
      { operation: "promote", requestDigest: "a".repeat(64), state: "prepared", reviewerId: "reviewer-1", approvalNonce: "nonce-1", approvalExpiresAt: "2026-08-29T10:01:00.000Z", token },
      { operation: "promote", requestDigest: "a".repeat(64), state: "in_progress", reviewerId: "reviewer-1" },
      { operation: "promote", requestDigest: "a".repeat(64), state: "committed", reviewerId: "reviewer-1", token, result: promotionResult },
      { operation: "promote", requestDigest: "a".repeat(64), state: "committed", reviewerId: "bad reviewer", result: promotionResult },
    ];
    for (const [index, operation] of cases.entries()) {
      const directory = await stateDirectory();
      await mkdir(join(directory, "missions"), { recursive: true });
      await writeFixture(join(directory, "missions", "mission-a.json"), `${JSON.stringify({ ...mission("mission-a"), operations: { [`operation-${index}`]: operation } })}\n`);
      await expect(new FileMissionStore(directory).load("mission-a")).rejects.toThrow(/corrupt|invalid/i);
    }
  });

  it("creates private persistence directories", async () => {
    const directory = await stateDirectory();
    const state = join(directory, "authority");
    await new FileMissionStore(state).list();

    if (process.platform !== "win32") {
      expect((await stat(state)).mode & 0o777).toBe(0o700);
      expect((await stat(join(state, "missions"))).mode & 0o777).toBe(0o700);
    }
  });

  it("commits append-only events and a snapshot with contiguous sequences", async () => {
    const directory = await stateDirectory();
    const missions = new FileMissionStore(directory);
    const events = new FileMissionEventStore(directory);
    await missions.create(mission("mission-a"));

    await missions.save({ ...mission("mission-a", 2), events: [event("mission-a", 1), event("mission-a", 2)] }, [event("mission-a", 1), event("mission-a", 2)]);

    expect((await events.readAfter("mission-a", 0)).map((item) => item.sequence)).toEqual([1, 2]);
    expect((await missions.load("mission-a"))!.lastEventSequence).toBe(2);
    await expect(missions.save(mission("mission-a", 4), [event("mission-a", 4)]))
      .rejects.toThrow(/contiguous/i);
    await expect(events.append([event("mission-a", 2)])).rejects.toThrow(/contiguous/i);
  });

  it("replays strictly after a cursor and publishes committed records", async () => {
    const directory = await stateDirectory();
    const store = new FileMissionEventStore(directory);
    const published: number[] = [];
    const unsubscribe = store.subscribe("mission-a", (record) => published.push(record.sequence));

    await store.append([event("mission-a", 1), event("mission-a", 2), event("mission-a", 3)]);
    unsubscribe.unsubscribe();
    await store.append([event("mission-a", 4)]);

    expect((await store.readAfter("mission-a", 2)).map((item) => item.sequence)).toEqual([3, 4]);
    expect(published).toEqual([1, 2, 3]);
  });

  it("does not report a durable append as failed when a subscriber throws", async () => {
    const directory = await stateDirectory();
    const store = new FileMissionEventStore(directory);
    store.subscribe("mission-a", () => { throw new Error("broken subscriber"); });

    await expect(store.append([event("mission-a", 1)])).resolves.toBeUndefined();
    expect((await store.readAfter("mission-a", 0)).map((item) => item.sequence)).toEqual([1]);
  });

  it("serializes concurrent appends without dropping or duplicating records", async () => {
    const directory = await stateDirectory();
    const first = new FileMissionEventStore(directory);
    const second = new FileMissionEventStore(directory);

    const results = await Promise.allSettled([
      first.append([event("mission-a", 1)]),
      second.append([event("mission-a", 1)]),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await first.readAfter("mission-a", 0)).map((item) => item.sequence)).toEqual([1]);
  });

  it("completes an interrupted intact journal idempotently on restart", async () => {
    const directory = await stateDirectory();
    const missions = new FileMissionStore(directory);
    await missions.create(mission("mission-a"));
    const nextEvent = event("mission-a", 1);
    const nextSnapshot = { ...mission("mission-a", 1), events: [nextEvent] };
    await mkdir(join(directory, "transactions"), { recursive: true });
    await writeFile(
      join(directory, "transactions", "mission-a.json"),
      `${JSON.stringify({ payloadVersion: 1, missionId: "mission-a", snapshot: nextSnapshot, events: [nextEvent] })}\n`,
      "utf8",
    );
    await mkdir(join(directory, "events"), { recursive: true });
    await writeFile(join(directory, "events", "mission-a.jsonl"), `${JSON.stringify(nextEvent)}\n`, "utf8");

    const recovered = new FileMissionStore(directory);
    expect((await recovered.load("mission-a"))!.lastEventSequence).toBe(1);
    expect((await new FileMissionEventStore(directory).readAfter("mission-a", 0))).toEqual([nextEvent]);
    await expect(readFile(join(directory, "transactions", "mission-a.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses unexplained snapshot/event mismatch and malformed journals", async () => {
    const directory = await stateDirectory();
    const missions = new FileMissionStore(directory);
    await missions.create(mission("mission-a"));
    await mkdir(join(directory, "events"), { recursive: true });
    await writeFixture(join(directory, "events", "mission-a.jsonl"), `${JSON.stringify(event("mission-a", 1))}\n`);

    await expect(new FileMissionStore(directory).load("mission-a")).rejects.toThrow(/inconsistent|corrupt/i);

    const otherDirectory = await stateDirectory();
    await mkdir(join(otherDirectory, "transactions"), { recursive: true });
    await writeFixture(join(otherDirectory, "transactions", "mission-a.json"), "{not json");
    await expect(new FileMissionStore(otherDirectory).list()).rejects.toThrow(/journal|json|corrupt/i);
  });

  it("refuses structurally malformed snapshot and event records", async () => {
    const directory = await stateDirectory();
    await mkdir(join(directory, "missions"), { recursive: true });
    await writeFixture(
      join(directory, "missions", "mission-a.json"),
      `${JSON.stringify({ ...mission("mission-a"), plan: null })}\n`,
    );
    await expect(new FileMissionStore(directory).load("mission-a")).rejects.toThrow(/corrupt/i);

    const otherDirectory = await stateDirectory();
    await mkdir(join(otherDirectory, "events"), { recursive: true });
    await writeFixture(
      join(otherDirectory, "events", "mission-a.jsonl"),
      `${JSON.stringify({ ...event("mission-a", 1), kind: "invented" })}\n`,
    );
    await expect(new FileMissionEventStore(otherDirectory).readAfter("mission-a", 0)).rejects.toThrow(/corrupt/i);
  });

  it("recursively rejects unknown fields in snapshots, events, capabilities, workspaces, changes, and outcomes", async () => {
    const cases: Array<[string, MissionSnapshot]> = [
      ["plan", { ...mission("mission-a"), plan: { ...mission("mission-a").plan, unexpected: true } } as MissionSnapshot],
      ["event", { ...mission("mission-a"), events: [{ ...event("mission-a", 1), unexpected: true }] } as unknown as MissionSnapshot],
      ["capability", { ...mission("mission-a"), events: [{ ...event("mission-a", 1), kind: "capability_request", capability: { requestId: "request-1", runId: "run-1", capability: "network", scope: "docs", reason: "lookup", unexpected: true } }] } as unknown as MissionSnapshot],
      ["workspace", { ...mission("mission-a"), currentWorkspace: { id: "workspace-1", missionId: "mission-a", repositoryRoot: "C:/private/repo", worktreePath: "C:/private/worktree", targetBranch: "main", missionBranch: "orrery/mission-a", initialRevision: "abc", unexpected: true } } as MissionSnapshot],
      ["change", { ...mission("mission-a"), currentChangeSnapshot: { revision: "change-1", files: [{ path: "a.ts", additions: 1, deletions: 0, binary: false, diff: "+x", unexpected: true }], unifiedDiff: "+x" } } as unknown as MissionSnapshot],
      ["outcome", { ...mission("mission-a"), intentOutcomes: { intent: { operation: "cancel", requestDigest: "digest", result: { ...mission("mission-a"), unexpected: true } } } } as unknown as MissionSnapshot],
    ];
    for (const [name, snapshot] of cases) {
      const directory = await stateDirectory();
      await mkdir(join(directory, "missions"), { recursive: true });
      await writeFixture(join(directory, "missions", "mission-a.json"), `${JSON.stringify(snapshot)}\n`);
      await expect(new FileMissionStore(directory).load("mission-a"), name).rejects.toThrow(/corrupt|unknown/i);
    }
  });

  it("requires snapshot event payloads to equal the durable event log", async () => {
    const directory = await stateDirectory();
    const snapshot = { ...mission("mission-a", 1), events: [{ ...event("mission-a", 1), detail: "snapshot detail" }] };
    await mkdir(join(directory, "missions"), { recursive: true });
    await mkdir(join(directory, "events"), { recursive: true });
    await writeFixture(join(directory, "missions", "mission-a.json"), `${JSON.stringify(snapshot)}\n`);
    await writeFixture(join(directory, "events", "mission-a.jsonl"), `${JSON.stringify(event("mission-a", 1))}\n`);

    await expect(new FileMissionStore(directory).load("mission-a")).rejects.toThrow(/inconsistent|differs|corrupt/i);
  });

  it("bounds snapshot and event parsing before JSON decoding", async () => {
    const directory = await stateDirectory();
    await mkdir(join(directory, "missions"), { recursive: true });
    await writeFixture(join(directory, "missions", "mission-a.json"), " ".repeat(16 * 1024 * 1024 + 1));
    await expect(new FileMissionStore(directory).load("mission-a")).rejects.toThrow(/too large/i);

    const otherDirectory = await stateDirectory();
    await mkdir(join(otherDirectory, "events"), { recursive: true });
    await writeFixture(join(otherDirectory, "events", "mission-a.jsonl"), `${" ".repeat(1024 * 1024 + 1)}\n`);
    await expect(new FileMissionEventStore(otherDirectory).readAfter("mission-a", 0)).rejects.toThrow(/too large/i);
  });

  it("enforces event-log quota before append and retains a contiguous replay checkpoint", async () => {
    const directory = await stateDirectory();
    const store = new FileMissionEventStore(directory, { maxEventFileBytes: 700, retainedEventCount: 2 });
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      await store.append([{ ...event("mission-a", sequence), detail: "x".repeat(180) }]);
    }

    const replay = await store.readAfter("mission-a", 0, 4);

    expect(replay).toMatchObject({ cursor: 4, highWaterMark: 4, overflow: { firstAvailableSequence: 4 } });
    expect(replay.events.map((item) => item.sequence)).toEqual([4]);
    expect((await stat(join(directory, "events", "mission-a.jsonl"))).size).toBeLessThanOrEqual(700);
  });

  it("saves, loads, and continues a mission after transactionally retaining its event suffix", async () => {
    const directory = await stateDirectory();
    const missions = new FileMissionStore(directory, { maxEventFileBytes: 900, retainedEventCount: 2 });
    await missions.create(mission("mission-retained"));

    let snapshot = mission("mission-retained");
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      const next = { ...event("mission-retained", sequence), detail: "x".repeat(180) };
      snapshot = { ...snapshot, lastEventSequence: sequence, events: [...snapshot.events, next] };
      await missions.save(snapshot, [next]);
      snapshot = (await missions.load("mission-retained"))!;
    }

    const restarted = new FileMissionStore(directory, { maxEventFileBytes: 900, retainedEventCount: 2 });
    const retained = await restarted.load("mission-retained");
    expect(retained).toMatchObject({ firstEventSequence: 3, lastEventSequence: 4 });
    expect(retained!.events.map((item) => item.sequence)).toEqual([3, 4]);

    const fifth = { ...event("mission-retained", 5), detail: "x".repeat(180) };
    await restarted.save({ ...retained!, lastEventSequence: 5, events: [...retained!.events, fifth] }, [fifth]);
    await expect(restarted.load("mission-retained")).resolves.toMatchObject({ lastEventSequence: 5 });
  });

  it.runIf(process.platform !== "win32")("refuses state directories that cannot remain private", async () => {
    const directory = await stateDirectory();
    await chmod(directory, 0o755);
    await new FileMissionStore(directory).list();
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });
});
