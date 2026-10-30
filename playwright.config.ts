import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  // Runs against a production build (plus the fixture harness), not the dev server, so packaging
  // details such as relative asset URLs and the built report-document host are covered.
  use: {
    baseURL: "http://127.0.0.1:4173",
  },
  webServer: {
    command: "npm run harness",
    reuseExistingServer: !process.env.CI,
    url: "http://127.0.0.1:4173/tab.html",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
