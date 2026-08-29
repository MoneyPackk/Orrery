import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@orrery/mission-control-domain": resolve(__dirname, "packages/mission-control-domain/src/index.ts"),
      "@orrery/mission-control-protocol": resolve(__dirname, "packages/mission-control-protocol/src/index.ts"),
      "@orrery/mission-control-client": resolve(__dirname, "packages/mission-control-client/src/index.ts"),
    },
  },
  build: {
    emptyOutDir: false,
    lib: {
      entry: "electron/main.ts",
      formats: ["es"],
      fileName: () => "main.js",
    },
    minify: false,
    outDir: "dist-electron",
    rollupOptions: {
      external: ["electron"],
    },
    sourcemap: true,
    ssr: "electron/main.ts",
  },
});
