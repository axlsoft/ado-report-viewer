import { expect, test } from "@playwright/test";

test("renders the static report fixture and its nested resources", async ({ page }) => {
  await page.goto("/tab.html");
  await page.getByLabel("Choose a report archive").setInputFiles("test/fixtures/generated/static-report.zip");

  const report = page.frameLocator("iframe.report-frame").frameLocator("iframe");
  await expect(report.getByRole("heading", { name: "Static report fixture" })).toBeVisible();
  await expect(report.locator("#result")).toHaveText("passed");
  await expect(report.locator("#report-logo")).toHaveJSProperty("naturalWidth", 80);
});