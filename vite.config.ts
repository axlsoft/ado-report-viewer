import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: resolve(import.meta.dirname, "src"),
  test: {
    root: import.meta.dirname,
    include: ["test/unit/**/*.test.ts"],
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    target: "baseline-widely-available",
    sourcemap: false,
    rollupOptions: {
      input: {
        tab: resolve(import.meta.dirname, "src/tab.html"),
        frame: resolve(import.meta.dirname, "src/frame.html"),
      },
    },
  },
});