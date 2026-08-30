import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@orrery/root-mission-control-daemon-client": new URL("../electron/mission-control-daemon-client.ts", import.meta.url).pathname
    }
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
