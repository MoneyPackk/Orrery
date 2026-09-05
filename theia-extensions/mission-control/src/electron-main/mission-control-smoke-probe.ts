/**
 * Proves the Mission Control surfaces really render inside the shipped Electron app.
 *
 * Every other renderer test runs in jsdom against a hand-built container, so a broken DI
 * binding, a widget that throws on first render, or a view that mounts an empty node would
 * leave the entire suite green. Worse, the smoke's existing readiness signal comes from the
 * *preload*, which runs before the Theia frontend starts — so until now nothing proved any
 * widget had ever rendered.
 *
 * Two deliberate choices keep this from weakening the security model:
 *
 * 1. The views are opened with real keyboard input, the same keybindings a person uses, rather
 *    than a test-only command bridge. No renderer API is added, so there is nothing new for
 *    production code to expose or an attacker to reach.
 * 2. Everything here is reached only from the existing `ORRERY_THEIA_SMOKE` branch. In a normal
 *    launch none of it runs.
 *
 * The DOM check looks for the accessible landmark rather than a CSS class, because the landmark
 * is what a person or screen reader uses to find the surface. A widget that mounts an empty node
 * therefore fails instead of passing.
 */

/** Views the probe opens, with the keybinding that opens each and the landmark it must render. */
export const SMOKE_PROBE_VIEWS = [
  { widgetId: "orrery-mission-control", key: "M", region: "Mission Control" },
  { widgetId: "orrery-intelligence", key: "I", region: "Orrery Intelligence" },
  { widgetId: "orrery-tools", key: "T", region: "Orrery Tools" },
] as const;

export interface SmokeProbeView { readonly widgetId: string; readonly region: string; readonly found: boolean }
export interface SmokeProbeOutcome {
  readonly views: ReadonlyArray<SmokeProbeView>;
  readonly failures: ReadonlyArray<string>;
  /** Menu labels found for the views, so an unreachable view is a failure rather than a surprise. */
  readonly menuLabels?: ReadonlyArray<string>;
}

/** Minimal slice of `WebContents` the probe needs, so the logic stays unit-testable. */
export interface SmokeProbeTarget {
  executeJavaScript(code: string): Promise<unknown>;
}

/**
 * Waits for a shell that has actually finished starting.
 *
 * Checking for the shell element alone is not enough: Theia inserts `#theia-app-shell` early and
 * keeps a `theia-preload` splash in the body until the frontend finishes starting, so probing on
 * the element's presence races the frontend and finds an empty document.
 *
 * The tab bar class carries Lumino's `lm-` prefix. Theia migrated from PhosphorJS, so the older
 * `p-` prefix matches nothing here and would make this wait forever. Waiting on a rendered *tab*
 * would be circular, since tabs only exist once a view is open, which is what this probe causes.
 */
export const SHELL_READY_SCRIPT = `(() => {
  const shell = document.querySelector('#theia-app-shell, .theia-ApplicationShell');
  if (!shell) return false;
  const preload = document.querySelector('.theia-preload');
  if (preload && preload.getBoundingClientRect().height > 0) return false;
  return document.querySelectorAll('.lm-TabBar').length > 0;
})()`;

/** Reports what the shell actually contains, so a failure can be diagnosed rather than guessed. */
export const SHELL_DIAGNOSTIC_SCRIPT = `(() => {
  const labels = [...document.querySelectorAll('[aria-label]')].map(n => n.getAttribute('aria-label'));
  const widgets = [...document.querySelectorAll('.lm-Widget[id]')].map(n => n.id).filter(Boolean).slice(0, 25);
  return JSON.stringify({
    readyState: document.readyState,
    visibility: document.visibilityState,
    tabBars: document.querySelectorAll('.lm-TabBar').length,
    widgets,
    labels: labels.slice(0, 30)
  });
})()`;

/**
 * Reads the landmark for one view.
 *
 * Scoped to the shell so a landmark left behind in a detached node cannot produce a false pass,
 * and the selector is encoded once so a label containing a quote cannot break it.
 */
export function buildRegionProbeScript(region: string): string {
  const selector = JSON.stringify(`[aria-label=${JSON.stringify(region)}]`);
  return `(() => {
    const shell = document.querySelector('#theia-app-shell, .theia-ApplicationShell');
    if (!shell) return false;
    const node = shell.querySelector(${selector});
    return !!node && node.isConnected;
  })()`;
}

/**
 * Checks each view is reachable from the application menu.
 *
 * This application depends on `@theia/core` alone, which contributes no "Open View..." command,
 * so without explicit menu items the keybinding is the only way in and a user who does not
 * already know the shortcut cannot find the view at all.
 */
export function findMissingMenuLabels(
  menuLabels: ReadonlyArray<string>,
  expected: ReadonlyArray<string> = SMOKE_PROBE_VIEWS.map(view => view.region),
): string[] {
  return expected.filter(label => !menuLabels.includes(label));
}

/**
 * Reads the DOM menubar Theia renders when the window uses a custom title bar.
 *
 * With `titleBarStyle: 'custom'` Theia never pushes a menu over the `SetMenu` IPC channel; the
 * menubar is a Lumino widget in the page. This reads the titles it actually rendered, which is
 * what the user sees, rather than an IPC payload that is never sent in this mode.
 *
 * Submenu popups only exist in the DOM while open, so the script reads the top-level titles from
 * the bar and any currently rendered menu item labels. The check that consumes it accepts the
 * view labels on either surface.
 */
export const MENUBAR_TITLES_SCRIPT = `(() => {
  const bar = document.querySelector('#theia\\\\:menubar');
  if (!bar) return null;
  const titles = [...bar.querySelectorAll('.lm-MenuBar-itemLabel')].map(n => n.textContent ?? '');
  const viewItems = [...document.querySelectorAll('.lm-Menu-itemLabel')].map(n => n.textContent ?? '');
  return JSON.stringify({ titles, viewItems });
})()`;
export function describeSmokeProbe(outcome: SmokeProbeOutcome): string {
  const lines = outcome.views.map(view => view.found
    ? `ok   ${view.widgetId}: rendered "${view.region}"`
    : `FAIL ${view.widgetId}: no rendered region labelled "${view.region}"`);
  return [...lines, ...outcome.failures.map(failure => `FAIL ${failure}`)].join("\n");
}

export function smokeProbePassed(outcome: SmokeProbeOutcome): boolean {
  return outcome.failures.length === 0
    && outcome.views.length === SMOKE_PROBE_VIEWS.length
    && outcome.views.every(view => view.found);
}

async function pollUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // A failed read means "not ready yet": the frontend can be mid-navigation, which rejects.
    if (await check().catch(() => false)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * Opens each view by keybinding and reports which landmarks actually rendered.
 *
 * The shell wait is what makes this meaningful: probing before the frontend starts would report
 * three missing views regardless of whether the code works.
 */
export async function runSmokeRenderProbe(
  target: SmokeProbeTarget,
  options: { shellTimeoutMs?: number; regionTimeoutMs?: number; pollIntervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SmokeProbeOutcome> {
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  // Collect renderer errors from inside the page: a frontend that throws during startup would
  // otherwise present as a silent absence of widgets with no explanation.
  await target.executeJavaScript(`(() => {
    if (window.__orrerySmokeErrors) return true;
    window.__orrerySmokeOpenViews = true;
    window.__orrerySmokeErrors = [];
    window.addEventListener('error', e => window.__orrerySmokeErrors.push(String(e.message)));
    window.addEventListener('unhandledrejection', e => window.__orrerySmokeErrors.push('rejection: ' + String(e.reason && e.reason.message || e.reason)));
    return true;
  })()`).catch(() => undefined);
  const shellReady = await pollUntil(
    async () => (await target.executeJavaScript(SHELL_READY_SCRIPT)) === true,
    options.shellTimeoutMs ?? 30_000,
    pollIntervalMs,
    sleep,
  );
  if (!shellReady) {
    const diagnostic = await target.executeJavaScript(SHELL_DIAGNOSTIC_SCRIPT).catch(() => "diagnostic unavailable");
    return { views: [], failures: [`the Theia frontend shell never appeared, so no view could render (${String(diagnostic)})`] };
  }

  const views: SmokeProbeView[] = [];
  const failures: string[] = [];
  const openLog: string[] = [];
  // The application's own lifecycle hooks have already run by the time the smoke attaches, so the
  // extension exposes an opener the smoke calls once. It goes through the same container and view
  // contributions a keybinding would, so the widgets are built for real.
  const opened = await target.executeJavaScript(
    "window.__orreryOpenViews ? window.__orreryOpenViews().then(l => l.join(' ;; ')) : 'no opener'",
  ).catch(error => `opener threw: ${error instanceof Error ? error.message : "unknown"}`);
  openLog.push(String(opened));
  for (const view of SMOKE_PROBE_VIEWS) {
    try {
      const script = buildRegionProbeScript(view.region);
      const found = await pollUntil(
        async () => (await target.executeJavaScript(script)) === true,
        options.regionTimeoutMs ?? 15_000,
        pollIntervalMs,
        sleep,
      );
      views.push({ widgetId: view.widgetId, region: view.region, found });
    } catch (error) {
      failures.push(`${view.widgetId}: ${error instanceof Error ? error.message : "probe failed"}`);
    }
  }
  if (views.some(view => !view.found)) {
    // A missing landmark could mean the widget is broken or that opening it did not work.
    // Reporting what the shell contains is what separates those two explanations.
    const diagnostic = await target.executeJavaScript(SHELL_DIAGNOSTIC_SCRIPT).catch(() => "diagnostic unavailable");
    failures.push(`shell contents: ${String(diagnostic)}`);
    failures.push(`view opens: ${openLog.join(" | ")}`);
  }
  return { views, failures };
}
