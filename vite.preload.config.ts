import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@orrery/mission-control-domain": resolve(__dirname, "packages/mission-control-domain/src/index.ts"),
    },
  },
  build: {
    emptyOutDir: false,
    lib: {
      entry: "electron/preload.ts",
      formats: ["cjs"],
      fileName: () => "preload.cjs",
    },
    minify: false,
    outDir: "dist-electron",
    rollupOptions: {
      external: ["electron"],
    },
    sourcemap: true,
    ssr: "electron/preload.ts",
  },
});
