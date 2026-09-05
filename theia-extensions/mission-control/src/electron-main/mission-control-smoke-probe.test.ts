import { describe, expect, it } from "vitest";
import {
  SHELL_READY_SCRIPT,
  SMOKE_PROBE_VIEWS,
  buildRegionProbeScript,
  describeSmokeProbe,
  runSmokeRenderProbe,
  smokeProbePassed,
  type SmokeProbeTarget,
} from "./mission-control-smoke-probe";

const sleep = () => Promise.resolve();
const OPENER = "window.__orreryOpenViews ? window.__orreryOpenViews().then(l => l.join(' ;; ')) : 'no opener'";

/** A fake renderer: a view's landmark only appears once the extension's opener has been called. */
function target(options: {
  shellAfter?: number;
  rendered?: ReadonlySet<string>;
  renderOnOpen?: boolean;
  failShell?: boolean;
  failOpen?: boolean;
} = {}) {
  const rendered = new Set(options.rendered ?? SMOKE_PROBE_VIEWS.map(view => view.region));
  let openedAll = false;
  let opens = 0;
  let shellReads = 0;
  const api: SmokeProbeTarget = {
    async executeJavaScript(code: string) {
      if (code === SHELL_READY_SCRIPT) {
        if (options.failShell) throw new Error("frontend navigating");
        shellReads += 1;
        return shellReads > (options.shellAfter ?? 0);
      }
      if (code === OPENER) {
        if (options.failOpen) throw new Error("opener rejected");
        opens += 1;
        openedAll = true;
        return "opened";
      }
      return [...rendered].some(region =>
        code.includes(JSON.stringify(`[aria-label=${JSON.stringify(region)}]`))
        && (!options.renderOnOpen || openedAll));
    },
  };
  return { api, opens: () => opens };
}

describe("mission control smoke render probe", () => {
  it("passes only when every view renders its landmark in the real shell", async () => {
    const fake = target({ renderOnOpen: true });
    const outcome = await runSmokeRenderProbe(fake.api, { sleep, pollIntervalMs: 0 });
    expect(smokeProbePassed(outcome)).toBe(true);
    expect(outcome.views.map(view => view.widgetId)).toEqual(SMOKE_PROBE_VIEWS.map(view => view.widgetId));
    // The opener is called once and builds every view through the real container.
    expect(fake.opens()).toBe(1);
  });

  it("fails, naming the view, when a widget mounts without its landmark", async () => {
    const fake = target({ rendered: new Set(["Mission Control", "Orrery Tools"]) });
    const outcome = await runSmokeRenderProbe(fake.api, { sleep, pollIntervalMs: 0, regionTimeoutMs: 0 });
    expect(smokeProbePassed(outcome)).toBe(false);
    expect(describeSmokeProbe(outcome)).toContain('FAIL orrery-intelligence: no rendered region labelled "Orrery Intelligence"');
    // The other two still report success, so a failure localises the defect.
    expect(describeSmokeProbe(outcome)).toContain('ok   orrery-mission-control');
  });

  it("fails loudly instead of reporting three missing views when the shell never starts", async () => {
    const fake = target({ shellAfter: Number.MAX_SAFE_INTEGER });
    const outcome = await runSmokeRenderProbe(fake.api, { sleep, pollIntervalMs: 0, shellTimeoutMs: 0 });
    expect(smokeProbePassed(outcome)).toBe(false);
    expect(outcome.views).toEqual([]);
    expect(outcome.failures[0]).toContain("never appeared");
  });

  it("waits for a shell that appears late rather than probing too early", async () => {
    const fake = target({ shellAfter: 3, renderOnOpen: true });
    const outcome = await runSmokeRenderProbe(fake.api, { sleep, pollIntervalMs: 0, shellTimeoutMs: 5_000 });
    expect(smokeProbePassed(outcome)).toBe(true);
  });

  it("treats a rejected read as not-ready, because the frontend can be mid-navigation", async () => {
    const fake = target({ failShell: true });
    const outcome = await runSmokeRenderProbe(fake.api, { sleep, pollIntervalMs: 0, shellTimeoutMs: 0 });
    expect(outcome.failures[0]).toContain("never appeared");
  });

  it("encodes the landmark exactly once so the selector matches a real attribute", () => {
    const script = buildRegionProbeScript("Orrery Intelligence");
    expect(script).toContain('"[aria-label=\\"Orrery Intelligence\\"]"');
    // Re-encoding would search for a quoted string and silently never match.
    expect(script).not.toContain("JSON.stringify(\"");
  });

  it("survives a landmark containing a quote", () => {
    const script = buildRegionProbeScript('Say "hi"');
    expect(() => new Function(`return ${script}`)).not.toThrow();
  });

  it("scopes the query to the shell so a detached leftover node cannot pass", () => {
    const script = buildRegionProbeScript("Mission Control");
    expect(script).toContain("theia-ApplicationShell");
    expect(script).toContain("isConnected");
    expect(script).not.toMatch(/^\s*document\.querySelector\('\[aria-label/m);
  });

  it("reports a probe error against the view that caused it", async () => {
    const fake = target({ renderOnOpen: true, failOpen: true });
    const outcome = await runSmokeRenderProbe(fake.api, { sleep, pollIntervalMs: 0, regionTimeoutMs: 0 });
    expect(smokeProbePassed(outcome)).toBe(false);
    expect(outcome.failures.some(failure => failure.includes("opener rejected"))).toBe(true);
  });


  it("covers every view the extension contributes", () => {
    expect(SMOKE_PROBE_VIEWS.map(view => view.key)).toEqual(["M", "I", "T"]);
    expect(new Set(SMOKE_PROBE_VIEWS.map(view => view.region)).size).toBe(SMOKE_PROBE_VIEWS.length);
  });
});
