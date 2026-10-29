import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
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