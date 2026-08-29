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
  },
});
