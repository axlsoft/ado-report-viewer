import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const fixturesRoot = resolve(import.meta.dirname, "test/fixtures/generated");

// Serves generated fixture archives to the harness (src/harness.ts) from the dev and preview servers.
// Builds never contain fixtures; the harness code itself is only bundled for dev or VITE_REPORT_HARNESS=1.
function fixtureServer(): Plugin {
  return {
    name: "fixture-server",
    configureServer(server) {
      server.middlewares.use("/__fixtures", serveFixture);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__fixtures", serveFixture);
    },
  };
}

async function serveFixture(request: IncomingMessage, response: ServerResponse, next: () => void): Promise<void> {
  const file = resolve(fixturesRoot, decodeURIComponent((request.url ?? "/").split("?")[0]).slice(1));
  if (!file.startsWith(`${fixturesRoot}${sep}`)) {
    next();
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) {
      throw new Error("Not a file");
    }
    response.setHeader("Content-Length", info.size);
    response.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : "application/zip");
    createReadStream(file).pipe(response);
  } catch {
    response.statusCode = 404;
    response.end();
  }
}

export default defineConfig({
  root: resolve(import.meta.dirname, "src"),
  // Relative asset URLs: Azure DevOps serves extension files from a deep CDN path, not a site root.
  base: "./",
  plugins: [fixtureServer()],
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
        "report-document": resolve(import.meta.dirname, "src/report-document.html"),
      },
    },
  },
});
