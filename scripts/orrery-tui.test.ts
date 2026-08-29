import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { ensureDaemon, type EnsuredDaemon } from "./daemon-lifecycle";
import { runCompanionTui } from "./orrery-tui";

describe.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("runCompanionTui %s lifecycle", (signal) => {
  test("awaits TUI, client, and owned-daemon cleanup exactly once", async () => {
    const processEvents = new EventEmitter();
    const rendererStopped = deferred<void>();
    const disconnected = deferred<void>();
    const daemonStopped = deferred<void>();
    const client = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(() => disconnected.promise),
    };
    const daemon = {
      owned: true,
      endpoint: { host: "127.0.0.1", port: 1234, protocol: "1", tokenPath: "token", pid: 1, instanceId: "daemon" },
    } as EnsuredDaemon;
    const stopOwnedDaemon = vi.fn(() => daemonStopped.promise);
    const running = runCompanionTui({
      process: processEvents,
      createRuntimeDirectory: async () => "runtime",
      endpointPaths: () => ({ endpointPath: "endpoint", tokenPath: "token", lockPath: "lock" }),
      readAndProbeDaemon: async () => daemon.endpoint,
      removeStaleDaemonState: async () => true,
      ensureDaemon: async () => daemon,
      readToken: async () => "secret",
      createClient: () => client,
      runTui: async (_client, options) => {
        await new Promise<void>((resolve) => options.signal?.addEventListener("abort", resolve, { once: true }));
        rendererStopped.resolve();
      },
      stopOwnedDaemon,
    });
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1));

    processEvents.emit(signal);
    processEvents.emit(signal);
    await rendererStopped.promise;
    await vi.waitFor(() => expect(client.disconnect).toHaveBeenCalledTimes(1));
    expect(stopOwnedDaemon).not.toHaveBeenCalled();
    let settled = false;
    void running.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    disconnected.resolve();
    await vi.waitFor(() => expect(stopOwnedDaemon).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    daemonStopped.resolve();
    await running;

    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(stopOwnedDaemon).toHaveBeenCalledTimes(1);
  });
});

test("aborts pending owned-daemon startup and awaits child and lock cleanup", async () => {
  const processEvents = new EventEmitter();
  const ownershipEstablished = deferred<void>();
  const releaseLock = deferred<void>();
  const readiness = deferred<EnsuredDaemon["endpoint"]>();
  const cleanup: string[] = [];
  const running = runCompanionTui({
    process: processEvents,
    createRuntimeDirectory: async () => "runtime",
    endpointPaths: () => ({ endpointPath: "endpoint", tokenPath: "token", lockPath: "lock" }),
    readAndProbeDaemon: async () => undefined,
    removeStaleDaemonState: async () => false,
    ensureDaemon: (endpointPath, options) => ensureDaemon(endpointPath, {
      readEndpoint: async () => { throw new Error("missing"); },
      acquireLock: async () => ({
        nonce: "owned-lock",
        verify: async () => true,
        release: async () => {
          cleanup.push("release");
          await releaseLock.promise;
        },
      }),
      spawn: () => {
        ownershipEstablished.resolve();
        return { pid: 4321, kill: (signal) => { cleanup.push(`kill:${signal}`); return true; } };
      },
      waitForReady: () => readiness.promise,
      signal: options.signal,
    }),
    createClient: () => { throw new Error("must not create a client after startup abort"); },
  });
  await ownershipEstablished.promise;

  processEvents.emit("SIGTERM");
  await vi.waitFor(() => expect(cleanup).toEqual(["kill:SIGTERM", "release"]));
  let settled = false;
  void running.finally(() => { settled = true; }).catch(() => undefined);
  await Promise.resolve();
  expect(settled).toBe(false);

  releaseLock.resolve();
  await expect(running).rejects.toMatchObject({ name: "AbortError" });
  expect(cleanup).toEqual(["kill:SIGTERM", "release"]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
