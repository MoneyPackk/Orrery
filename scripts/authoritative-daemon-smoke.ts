import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { Mission, MissionEvent } from "../packages/mission-control-domain/src/index";
import { MissionControlClient, TcpLineTransport } from "../packages/mission-control-client/src/index";
import { DaemonServer, FileMissionStore } from "../packages/mission-control-daemon/src/index";
import { createDaemonAuthority } from "./daemon-authority-bootstrap";

const execFileAsync = promisify(execFile);
const longVerificationCommand = { executable: process.execPath, args: ["-e", "setTimeout(() => {}, 30_000)"] };
const quickVerificationCommand = { executable: process.execPath, args: ["-e", "process.exit(0)"] };

export interface AuthoritativeDaemonSmokeResult {
  repositoryPath: string;
  runtimePath: string;
  approval: { canonical: boolean; fingerprintMatched: boolean; persistedAfterRestart: boolean };
  target: { unchangedBeforePromotion: boolean; advancedByPromotion: boolean; reviewedFiles: string[]; promotedFiles: string[] };
  replay: { sequences: number[]; kinds: MissionEvent["kind"][]; afterReconnect: boolean; afterRestart: boolean };
  cancellation: { status: Mission["status"]; processAborted: boolean; durableAfterRestart: boolean };
  inspection: { status: Mission["status"]; reviewedFiles: string[] };
}

export async function runAuthoritativeDaemonSmoke(trustedReviewer = "daemon-smoke-reviewer"): Promise<AuthoritativeDaemonSmokeResult> {
  const parent = await mkdtemp(join(tmpdir(), "orrery-authoritative-smoke-"));
  const repositoryPath = join(parent, "repository");
  const runtimePath = join(parent, "runtime");
  let server: DaemonServer | undefined;
  const clients = new Set<MissionControlClient>();
  let stage = "start";

  try {
    await mkdir(repositoryPath);
    await git(["init", "--initial-branch", "main"], repositoryPath);
    await git(["config", "user.email", "daemon-smoke@orrery.local"], repositoryPath);
    await git(["config", "user.name", "Orrery Daemon Smoke"], repositoryPath);
    await writeFile(join(repositoryPath, "fixture.txt"), "initial\n", "utf8");
    await mkdir(join(repositoryPath, "scripts"));
    await git(["add", "fixture.txt"], repositoryPath);
    await git(["commit", "-m", "fixture"], repositoryPath);

    const canonicalRepository = await realpath(repositoryPath);
    let bootstrap = await createDaemonAuthority(runtimePath, {
      trustedVerificationCommands: [longVerificationCommand, quickVerificationCommand],
      verificationCommandResolver: (_repository, context) => context.title === "Cancel active verification"
        ? longVerificationCommand
        : quickVerificationCommand,
      trustedApprovalContext: { reviewerId: () => trustedReviewer },
    });
    ({ server } = await startServer(runtimePath, bootstrap));
    const first = await connectClient(server, runtimePath);
    clients.add(first);

    stage = "propose";
    const proposal = await first.proposeRepository({ intentId: id("propose"), localPath: repositoryPath });
    stage = "approve";
    const approval = await first.approveRepository({
      intentId: id("approve"),
      proposalId: proposal.proposalId,
      fingerprint: proposal.fingerprint,
      approvalNonce: proposal.approvalNonce,
    });
    stage = "create-cancel";
    const cancelledMission = await first.createMission(ordinary({
      intentId: id("create-cancel"),
      repositoryId: approval.repositoryId,
      title: "Cancel active verification",
      goal: "Prove the daemon aborts owned work.",
      mode: "build" as const,
      plan: plan("Cancel a controlled long verification."),
    }, repositoryPath));

    const cancellationCursor = cancelledMission.events.at(-1)?.sequence ?? 0;
    const runStartedAt = Date.now();
    stage = "run-cancel";
    const runPromise = first.runMission(ordinary({
      intentId: id("run-cancel"),
      missionId: cancelledMission.id,
      planRevisionId: cancelledMission.plan.id,
    }, repositoryPath));
    const runOutcome = runPromise.then(() => "completed" as const, () => "aborted" as const);
    const canceller = await connectClient(server, runtimePath);
    clients.add(canceller);
    const activeRunId = await Promise.race([
      pollForActiveRun(canceller, cancelledMission.id),
      runPromise.then(
        () => Promise.reject(new Error("Long verification completed before cancellation.")),
        (error) => Promise.reject(new Error("Long verification failed before cancellation.", { cause: error })),
      ),
    ]);
    stage = "cancel";
    const cancelled = await canceller.cancelMission(ordinary({
      intentId: id("cancel"),
      missionId: cancelledMission.id,
      runId: activeRunId,
    }, repositoryPath));
    const cancellationEvents = await replayUntil(canceller, cancelledMission.id, cancellationCursor, (event) => event.kind === "cancellation" && event.runId === activeRunId);
    const processAborted = await runOutcome === "aborted" && Date.now() - runStartedAt < 20_000 && cancellationEvents.some((event) => event.kind === "cancellation" && event.runId === activeRunId);
    await canceller.disconnect();
    clients.delete(canceller);

    stage = "create-promote";
    const initialRevision = await revision(repositoryPath);

    const mission = await first.createMission(ordinary({
      intentId: id("create-promote"),
      repositoryId: approval.repositoryId,
      title: "Promote exact reviewed change",
      goal: "Prove durable review and explicit promotion.",
      mode: "build" as const,
      plan: plan("Create and promote only the mission output."),
    }, repositoryPath));
    stage = "run-promote";
    const run = await first.runMission(ordinary({
      intentId: id("run-promote"),
      missionId: mission.id,
      planRevisionId: mission.plan.id,
    }, repositoryPath));
    assert(run.mission.status === "ready_for_review", `Expected ready_for_review, received ${run.mission.status}.`);
    const targetUnchanged = await revision(repositoryPath) === initialRevision && await status(repositoryPath) === "";

    stage = "reconnect-replay";
    await first.disconnect();
    clients.delete(first);
    const reconnected = await connectClient(server, runtimePath);
    clients.add(reconnected);
    const replayAfterReconnect = await replay(reconnected, mission.id, run.mission.events.length);

    stage = "restart";
    await reconnected.disconnect();
    clients.delete(reconnected);
    await server.stop();
    server = undefined;
    bootstrap = await createDaemonAuthority(runtimePath, {
      trustedVerificationCommands: [quickVerificationCommand],
      verificationCommandResolver: () => undefined,
      trustedApprovalContext: { reviewerId: () => trustedReviewer },
    });
    ({ server } = await startServer(runtimePath, bootstrap));
    const restarted = await connectClient(server, runtimePath);
    clients.add(restarted);
    const listed = await restarted.listMissions();
    const cancelledAfterRestart = await restarted.getMission(cancelledMission.id);
    assert(cancelledAfterRestart.status === "cancelled" && cancelledAfterRestart.events.some((event) => event.kind === "cancellation"), "Cancellation was not durable after restart.");
    const replayAfterRestart = await replay(restarted, mission.id, run.mission.events.length);
    stage = "inspect";
    const inspection = await restarted.inspectMission(ordinary({ missionId: mission.id, planRevisionId: mission.plan.id }, repositoryPath));
    const reviewedFiles = inspection.mission.changes.map((change) => change.path).sort();
    const durableMission = await new FileMissionStore(runtimePath).load(mission.id);
    assert(durableMission?.currentChangeSnapshot, "Durable reviewed change snapshot is missing.");
    assert(equal(reviewedFiles, durableMission.currentChangeSnapshot.files.map((file) => file.path).sort()), "Inspection and durable reviewed files differ.");
    assert(await revision(repositoryPath) === initialRevision && await status(repositoryPath) === "", "Target changed before authenticated promotion.");
    stage = "promote";
    assert(bootstrap.promotionApprovalIssuer, "Headless smoke approval issuer is unavailable.");
    const approvalCapability = bootstrap.promotionApprovalIssuer.issue({
      missionId: mission.id,
      planRevisionId: mission.plan.id,
      changeRevision: durableMission.currentChangeSnapshot.revision,
      decision: "accepted",
    });
    const promoted = await restarted.promoteMission(ordinary({
      intentId: id("promote"),
      missionId: mission.id,
      planRevisionId: mission.plan.id,
      changeRevision: durableMission.currentChangeSnapshot.revision,
      decision: "accepted" as const,
      approvalCapability,
    }, repositoryPath));
    const promotedRevision = await revision(repositoryPath);
    const promotedFiles = (await git(["diff", "--name-only", `${initialRevision}..${promotedRevision}`], repositoryPath)).stdout.trim().split(/\r?\n/).filter(Boolean).sort();

    return {
      repositoryPath,
      runtimePath,
      approval: {
        canonical: proposal.canonicalRoot === canonicalRepository,
        fingerprintMatched: approval.fingerprint === proposal.fingerprint,
        persistedAfterRestart: listed.some((item) => item.id === mission.id),
      },
      target: {
        unchangedBeforePromotion: targetUnchanged,
        advancedByPromotion: promoted.result === "promoted" && promotedRevision !== initialRevision,
        reviewedFiles,
        promotedFiles,
      },
      replay: {
        sequences: replayAfterRestart.map((event) => event.sequence),
        kinds: replayAfterRestart.map((event) => event.kind),
        afterReconnect: equal(replayAfterReconnect, replayAfterRestart),
        afterRestart: replayAfterRestart.length === run.mission.events.length,
      },
      cancellation: {
        status: cancelled.mission.status,
        processAborted,
        durableAfterRestart: cancelledAfterRestart.status === "cancelled" && cancelledAfterRestart.events.some((event) => event.kind === "cancellation"),
      },
      inspection: { status: inspection.mission.status, reviewedFiles },
    };
  } catch (error) {
    throw new Error(`Authoritative daemon smoke failed during ${stage}.`, { cause: error });
  } finally {
    await Promise.all([...clients].map((client) => client.disconnect().catch(() => undefined)));
    await server?.stop().catch(() => undefined);
    await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function startServer(runtimePath: string, bootstrap: Awaited<ReturnType<typeof createDaemonAuthority>>) {
  const server = new DaemonServer({
    registry: bootstrap.registry,
    authority: bootstrap.authority,
    eventSource: bootstrap.eventSource,
    recoverOnStartup: bootstrap.recoverActiveMissions,
    tokenPath: join(runtimePath, "daemon-smoke.token"),
  });
  await server.start();
  return { server };
}

async function connectClient(server: DaemonServer, runtimePath: string) {
  const endpoint = await server.start();
  const token = await readFile(join(runtimePath, basename(endpoint.tokenPath)), "utf8");
  const client = new MissionControlClient(new TcpLineTransport());
  await client.connect(endpoint, token);
  return client;
}

async function replay(client: MissionControlClient, missionId: string, count: number): Promise<MissionEvent[]> {
  const events: MissionEvent[] = [];
  let complete!: () => void;
  const completed = new Promise<void>((resolveDone) => { complete = resolveDone; });
  const unsubscribe = await client.subscribe(missionId, (event) => {
    events.push(event);
    if (events.length === count) complete();
  });
  if (count === 0) complete();
  await withTimeout(completed, 10_000, "Durable event replay did not complete.");
  await unsubscribe();
  return events;
}

async function pollForActiveRun(client: MissionControlClient, missionId: string): Promise<string> {
  return withTimeout((async () => {
    while (true) {
      const snapshot = await client.getMission(missionId);
      const verification = snapshot.events.find((event) => event.title === "Verification started");
      if (snapshot.status === "running" && snapshot.activeRunId && verification?.runId === snapshot.activeRunId) return snapshot.activeRunId;
      if (["failed", "cancelled", "ready_for_review"].includes(snapshot.status)) {
        throw new Error(`Run became ${snapshot.status} before cancellation: ${snapshot.completionSummary ?? snapshot.events.at(-1)?.detail ?? "no detail"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })(), 15_000, "Long verification did not become active.");
}

async function replayUntil(client: MissionControlClient, missionId: string, afterSequence: number, matches: (event: MissionEvent) => boolean): Promise<MissionEvent[]> {
  const events: MissionEvent[] = [];
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => { complete = resolve; });
  const unsubscribe = await client.subscribe(missionId, (event) => {
    events.push(event);
    if (matches(event)) complete();
  }, undefined, afterSequence);
  await withTimeout(completed, 10_000, "Durable cancellation event replay did not complete.");
  await unsubscribe();
  return events;
}

function ordinary<T extends object>(input: T, rawPath: string): T {
  const serialized = JSON.stringify(input);
  assert(!serialized.includes(rawPath), "An ordinary daemon request contains the raw repository path.");
  assert(!/(repositoryRoot|worktreePath|\"cwd\")/.test(serialized), "An ordinary daemon request contains a path-bearing field.");
  return input;
}

function plan(action: string) {
  return { scope: "orrery-mission.txt", actions: [action], acceptanceCriteria: ["Verification passes and only the reviewed file is promoted."] };
}

function id(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }
function equal(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right); }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function revision(cwd: string) { return (await git(["rev-parse", "HEAD"], cwd)).stdout.trim(); }
async function status(cwd: string) { return (await git(["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":!.orrery/"], cwd)).stdout; }
async function git(args: string[], cwd: string) { return execFileAsync("git", args, { cwd }); }
async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

if (!process.env.VITEST) {
  const result = await runAuthoritativeDaemonSmoke();
  console.log("Authoritative daemon smoke passed.");
  console.log(JSON.stringify(result, null, 2));
}
