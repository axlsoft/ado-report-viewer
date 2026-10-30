import { readFile, stat } from "node:fs/promises";
import { expect, expectPlayableVideo, historyGo, openReport, reportDocument, test } from "./support";

test.describe("hand-written static site", () => {
  test("renders CSS, fonts, srcset images, and fetched data", async ({ page }) => {
    const report = await openReport(page, "Static site");

    await expect(report.getByRole("heading", { name: "Static report fixture" })).toBeVisible();
    await expect(report.locator("#result")).toHaveText("passed");
    await expect(report.locator("#report-logo")).toHaveJSProperty("naturalWidth", 80);

    const frame = await reportDocument(page);
    await expect
      .poll(() =>
        frame.evaluate(async () => {
          await document.fonts.load("16px FixtureReport");
          return [...document.fonts].some(
            (font) => font.family.replaceAll('"', "") === "FixtureReport" && font.status === "loaded",
          );
        }),
      )
      .toBe(true);
    expect(await frame.evaluate(() => getComputedStyle(document.body).backgroundImage)).toMatch(/^url\("blob:/u);
  });

  test("navigates to a second page and back with history", async ({ page }) => {
    const report = await openReport(page, "Static site");
    // Let the page's own fetch settle; WebKit reports a fetch aborted by navigation as an unhandled rejection.
    await expect(report.locator("#result")).toHaveText("passed");

    await report.getByRole("link", { name: "View details" }).click();
    await expect(report.getByRole("heading", { name: "Details" })).toBeVisible();
    await historyGo(page, -1);
    await expect(report.getByRole("heading", { name: "Static report fixture" })).toBeVisible();
    await historyGo(page, 1);
    await expect(report.getByRole("heading", { name: "Details" })).toBeVisible();
    await report.getByRole("link", { name: "Back to summary" }).click();
    await expect(report.locator("#result")).toHaveText("passed");
  });

  test("downloads report files from the archive", async ({ page }) => {
    const report = await openReport(page, "Static site");

    const download = page.waitForEvent("download");
    await report.getByRole("link", { name: "Download result data" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("results.json");
    expect(JSON.parse(await readFile(await file.path(), "utf8"))).toEqual({ status: "passed", total: 3 });
  });
});

test.describe("reporting-labs", () => {
  test("default options: hash routes, screenshot, asset video, and trace download", async ({ page }) => {
    const report = await openReport(page, "E2E");

    await expect(report.getByText("Pass rate").first()).toBeVisible();
    await report.getByText("shows the order confirmation number").first().click();
    await expect.poll(async () => new URL((await reportDocument(page)).url()).hash).toContain("view=tests");

    await expect(report.locator("img[src^='data:image/png']").first()).toBeVisible();
    await expectPlayableVideo(page, "blob:");

    const download = page.waitForEvent("download");
    await report.getByRole("link", { name: "Download trace" }).click();
    expect((await download).suggestedFilename()).toMatch(/trace-\d+\.zip$/u);
  });

  test("default options: large attachments stay in assets and switch theme without storage errors", async ({ page }) => {
    const report = await openReport(page, "E2E");

    await report.getByText("attaches a large diagnostic dump").first().click();
    const download = page.waitForEvent("download");
    await report.locator("a[href*='diagnostics.bin']").first().click();
    expect((await stat(await (await download).path())).size).toBe(3 * 1024 * 1024);

    await report.locator("button", { hasText: "◐" }).click();
  });

  test("embedded videos", async ({ page }) => {
    const report = await openReport(page, "E2E (embedded video)");

    await report.getByText("shows the order confirmation number").first().click();
    await expectPlayableVideo(page, "data:");
  });
});

test.describe("Playwright HTML reporter", () => {
  test("hash-routed test details with screenshot, video, and attachment downloads", async ({ page }) => {
    const report = await openReport(page, "Playwright");

    await report.getByText("shows the order confirmation number").first().click();
    await expect.poll(async () => new URL((await reportDocument(page)).url()).hash).toMatch(/^#\?testId=/u);

    const frame = await reportDocument(page);
    await expect
      .poll(() =>
        frame.evaluate(() =>
          [...document.images].some((image) => image.currentSrc.startsWith("blob:") && image.naturalWidth > 0),
        ),
      )
      .toBe(true);
    await expectPlayableVideo(page, "blob:");

    const download = page.waitForEvent("download");
    await report.getByRole("link", { name: "trace", exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.zip$/u);
  });
});

test.describe("istanbul lcov-report", () => {
  test("drills down through directory and file pages and back", async ({ page }) => {
    const report = await openReport(page, "Coverage");

    await expect(report.getByText("All files")).toBeVisible();
    await report.getByRole("link", { name: "pricing" }).click();
    await report.getByRole("link", { name: "cart.cjs" }).click();
    // Syntax highlighting proves prettify.js loaded before the inline script that calls it.
    await expect(report.locator("pre.prettyprint span.kwd").first()).toBeVisible();

    await historyGo(page, -1);
    await expect(report.getByRole("link", { name: "cart.cjs" })).toBeVisible();
    await historyGo(page, -1);
    await expect(report.getByRole("link", { name: "pricing" })).toBeVisible();
  });
});

test.describe("Allure", () => {
  test("renders the single-page app and routes to test details", async ({ page, guard }) => {
    // The report references a script on another origin; the report Content-Security-Policy blocks it before
    // any request is made, so only the violation is logged and the guard sees no escaped request.
    guard.allowError(/Content.Security.Policy|Refused to/iu);
    const report = await openReport(page, "Allure");

    await report.getByText("shows the order confirmation number").first().click();
    await expect(report.getByText("Playwright Trace").first()).toBeVisible();
    await expect.poll(async () => new URL((await reportDocument(page)).url()).hash).not.toBe("");
  });
});
