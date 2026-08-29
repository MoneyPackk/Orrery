import type { DesktopApi, DesktopRuntime } from "../electron/contract";

export async function getDesktopRuntime(
  api: DesktopApi | undefined = window.orreryDesktop,
): Promise<DesktopRuntime | null> {
  return api ? api.getRuntime() : null;
}

export async function reportDesktopSmokeReadiness(
  api: DesktopApi | undefined = window.orreryDesktop,
  rendererGlobals: { process?: unknown; require?: unknown } = globalThis,
): Promise<void> {
  if (!api?.reportSmokeReadiness) return;
  const runtime = await api.getRuntime();
  await api.reportSmokeReadiness({
    desktopRuntimeExists: runtime !== null,
    processType: typeof rendererGlobals.process,
    requireType: typeof rendererGlobals.require,
  });
}
