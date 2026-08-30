import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    minify: false,
    outDir: "dist-electron/resources",
    rollupOptions: {
      input: "scripts/orrery-daemon.ts",
      output: {
        entryFileNames: "mission-control-daemon.cjs",
        format: "cjs",
      },
    },
    sourcemap: true,
    ssr: "scripts/orrery-daemon.ts",
  },
});
