import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@orrery/mission-control-domain": resolve(__dirname, "packages/mission-control-domain/src/index.ts"),
      "@orrery/mission-control-protocol": resolve(__dirname, "packages/mission-control-protocol/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "packages/**/*.test.ts", "electron/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "http://localhost/" } },
    setupFiles: "./src/test-setup.ts",
    css: true,
    env: {
      /*
       * Several suites drive real Git, daemon, and Electron processes and wait for them to
       * become ready. Those waits are wall-clock, so running the whole suite in parallel made
       * correct code fail, which trained everyone to dismiss red as flaky and is exactly how a
       * real regression slips through unnoticed.
       *
       * Readiness budgets are scaled here rather than at each call site. This applies to every
       * `vitest` run, including a single file, so it buys reliability at the cost of detecting a
       * genuine 3x slowdown in a daemon handshake. That trade is deliberate: a false red costs
       * more than a slow-but-correct handshake, and the underlying operations are still bounded.
       * Override with ORRERY_TEST_TIMEOUT_SCALE=1 to measure true readiness cost.
       */
      ORRERY_TEST_TIMEOUT_SCALE: "3",
    },
  },
});
