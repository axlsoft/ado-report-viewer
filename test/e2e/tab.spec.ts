import { expect, openReport, reportDocument, reportLocator, test } from "./support";

test("switching reports reuses downloaded archives", async ({ page, guard }) => {
  let report = await openReport(page, "Static site");
  await expect(report.locator("#result")).toHaveText("passed");

  report = await openReport(page, "Coverage");
  await expect(report.getByText("All files")).toBeVisible();

  report = await openReport(page, "Static site");
  await expect(report.locator("#result")).toHaveText("passed");
  expect(guard.harnessRequests.filter((path) => path === "/__fixtures/static-report.zip")).toHaveLength(1);
});

test("a report requested again while it downloads is downloaded once", async ({ page, guard }) => {
  // Hold the archive until the report has been requested three ways: on load, by selecting it again,
  // and with the download button.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/__fixtures/static-report.zip", async (route) => {
    await held;
    await route.fallback();
  });
  await page.goto("/tab.html");
  await page.getByLabel("Select report").selectOption({ label: "Static site" });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download .zip" }).click();
  release();

  expect((await download).suggestedFilename()).toBe("Static site.zip");
  await expect(reportLocator(page).locator("#result")).toHaveText("passed");
  expect(guard.harnessRequests.filter((path) => path === "/__fixtures/static-report.zip")).toHaveLength(1);
});

test("an in-progress run shows its reports and picks up new ones without reloading the open report", async ({ page }) => {
  await page.goto("/tab.html?scenario=in-progress");
  await expect(page.getByText("Run in progress: more reports may appear.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Static site", pressed: true })).toBeVisible();
  await expect(reportLocator(page).locator("#result")).toHaveText("passed");
  const frame = await reportDocument(page);
  await frame.evaluate(() => Object.assign(window, { untouched: true }));

  await page.evaluate(() => window.completeHarnessRun?.());

  const selector = page.getByLabel("Select report");
  await expect(selector.locator("option")).toHaveCount(7);
  await expect(selector).toHaveValue("static-report");
  await expect(page.getByText("Run in progress: more reports may appear.")).toBeHidden();
  expect(await frame.evaluate(() => (window as { untouched?: boolean }).untouched)).toBe(true);
});

test("a run without reports points to the pipeline template", async ({ page }) => {
  await page.goto("/tab.html?scenario=empty");
  await expect(page.getByText("No HTML reports are attached to this run.")).toBeVisible();
  await expect(page.getByText("publish-html-report.yml")).toBeVisible();
});

test("duplicate report names are labeled by job, and the selection is remembered per pipeline", async ({ page }) => {
  await page.goto("/tab.html?scenario=matrix");
  const switcher = page.getByRole("group", { name: "Select report" });
  await expect(switcher.getByRole("button")).toHaveText(["Static site · Linux", "Static site · Windows", "Coverage (1)", "Coverage (2)"]);

  await switcher.getByRole("button", { name: "Coverage (2)" }).click();
  await expect(reportLocator(page).getByText("All files")).toBeVisible();

  await page.reload();
  await expect(switcher.getByRole("button", { name: "Coverage (2)", pressed: true })).toBeVisible();
  await expect(reportLocator(page).getByText("All files")).toBeVisible();
});
