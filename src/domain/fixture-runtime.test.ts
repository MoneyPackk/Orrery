import { describe, expect, it } from "vitest";
import {
  createFixtureRun,
  resolveFixtureCapability,
  type RuntimeSignal,
} from "./fixture-runtime";

const plan = {
  scope: "Implement approved fixture behavior.",
  actions: ["Index the approved scope", "Apply the fixture change"],
  acceptanceCriteria: ["The captured revision passes its fixture checks"],
};
const planRevisionId = "plan-revision-02";

async function collect(decision: "allowed" | "denied") {
  const signals: RuntimeSignal[] = [];
  const run = createFixtureRun("mission-01", { delay: 0, plan, planRevisionId });

  for await (const signal of run.signals) {
    signals.push(signal);
    if (signal.type === "capability_request") {
      resolveFixtureCapability(signal.runId, signal.requestId, decision);
    }
  }

  return signals;
}

describe("fixture runtime", () => {
  it("emits stable, ordered sequence numbers", async () => {
    const signals = await collect("denied");

    expect(signals.map((signal) => signal.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(signals.map((signal) => signal.type)).toEqual([
      "event",
      "event",
      "event",
      "event",
      "capability_request",
      "event",
      "change",
      "event",
      "evidence",
      "complete",
    ]);
  });

  it("executes the captured approved plan actions and binds evidence to its revision", async () => {
    const mutablePlan = structuredClone(plan);
    const run = createFixtureRun("mission-01", { delay: 0, plan: mutablePlan, planRevisionId });
    mutablePlan.actions[0] = "Mutated after start";
    mutablePlan.actions.push("Late action");
    const signals: RuntimeSignal[] = [];

    for await (const signal of run.signals) {
      signals.push(signal);
      if (signal.type === "capability_request") {
        resolveFixtureCapability(signal.runId, signal.requestId, "denied");
      }
    }

    const executionEvents = signals.filter((signal) => signal.event.kind === "execution");
    expect(executionEvents.map((signal) => signal.event.detail)).toEqual(plan.actions);
    expect(executionEvents.map((signal) => signal.event.title)).toEqual([
      "Action 1 of 2",
      "Action 2 of 2",
    ]);
    expect(signals.find((signal) => signal.type === "evidence")).toMatchObject({
      type: "evidence",
      evidence: {
        planRevisionId,
        criterion: plan.acceptanceCriteria[0],
      },
    });
  });

  it("waits for the guarded network decision", async () => {
    const run = createFixtureRun("mission-01", { delay: 0, plan, planRevisionId });
    const iterator = run.signals[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.next();
    await iterator.next();
    await iterator.next();
    const request = await iterator.next();
    const continuation = iterator.next();

    expect(request.value?.type).toBe("capability_request");
    expect(request.value?.capability.capability).toBe("network");
    expect(request.value?.requestId).toMatch(/^[0-9a-f-]{36}$/i);

    resolveFixtureCapability(request.value!.runId, request.value!.requestId, "denied");
    await expect(continuation).resolves.toMatchObject({ done: false });
  });

  it("rejects stale, duplicate, and wrong-request capability decisions", async () => {
    const run = createFixtureRun("mission-01", { delay: 0, plan, planRevisionId });
    const iterator = run.signals[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await iterator.next();
    await iterator.next();
    const request = await iterator.next();

    expect(() =>
      resolveFixtureCapability(run.runId, "wrong-request", "allowed"),
    ).toThrow(/pending capability request/i);
    resolveFixtureCapability(run.runId, request.value!.requestId, "denied");
    expect(() =>
      resolveFixtureCapability(run.runId, request.value!.requestId, "allowed"),
    ).toThrow(/pending capability request/i);
    expect(() =>
      resolveFixtureCapability("stale-run", request.value!.requestId, "allowed"),
    ).toThrow(/pending capability request/i);
  });

  it("cancels a run with AbortError and clears its pending decision", async () => {
    const run = createFixtureRun("mission-01", { delay: 0, plan, planRevisionId });
    const iterator = run.signals[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await iterator.next();
    await iterator.next();
    const request = await iterator.next();
    const continuation = iterator.next();

    run.cancel();
    await expect(continuation).rejects.toMatchObject({ name: "AbortError" });
    expect(() =>
      resolveFixtureCapability(run.runId, request.value!.requestId, "allowed"),
    ).toThrow(/pending capability request/i);
  });

  it("uses a safe local fallback when network is denied", async () => {
    const signals = await collect("denied");

    expect(signals.find((signal) => signal.event.kind === "fallback")).toMatchObject({
      type: "event",
      event: { kind: "fallback", title: "Using local fixture" },
    });
    expect(signals.filter((signal) => signal.type === "change")).toHaveLength(1);
    expect(signals.filter((signal) => signal.type === "evidence")).toHaveLength(1);
  });

  it("records approved network access before completing", async () => {
    const signals = await collect("allowed");

    expect(signals.find((signal) => signal.event.kind === "capability_resolution")).toMatchObject({
      type: "event",
      event: { kind: "capability_resolution", title: "Network access allowed" },
    });
    expect(signals.at(-1)).toMatchObject({
      type: "complete",
      summary: "Fixture implementation complete. One file changed and verification passed.",
    });
    expect(signals.every((signal) => signal.runId === signals[0].runId)).toBe(true);
  });
});
