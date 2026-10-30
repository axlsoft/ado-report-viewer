import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const generated = process.env.FIXTURE_OUTPUT_DIR ?? resolve(import.meta.dirname, "../../generated");
const sources = resolve(generated, "sources");

export default defineConfig({
  testDir: import.meta.dirname,
  outputDir: resolve(sources, "test-results"),
  retries: 0,
  workers: 1,
  use: {
    screenshot: "on",
    trace: "on",
    video: "on",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  reporter: [
    ["list"],
    [
      "reporting-labs",
      {
        history: { file: resolve(sources, "reporting-labs-default.history.json") },
        open: "never",
        outputFolder: resolve(sources, "reporting-labs-default"),
      },
    ],
    [
      "reporting-labs",
      {
        embedVideos: true,
        history: { file: resolve(sources, "reporting-labs-embedded.history.json") },
        open: "never",
        outputFolder: resolve(sources, "reporting-labs-embedded"),
      },
    ],
    ["html", { open: "never", outputFolder: resolve(sources, "playwright-html") }],
    ["allure-playwright", { resultsDir: resolve(sources, "allure-results") }],
  ],
});
