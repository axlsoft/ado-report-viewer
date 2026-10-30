import { expect, openReport, test } from "./support";

interface ProbeResults {
  done: boolean;
  externalFetch?: string;
  externalImage?: string;
  externalResource?: string;
  externalScript?: string;
  hostApiFetch?: number;
  malformedRequest?: string;
  origin: string;
  parentDocument: string;
  parentStorage: string;
  tabDocument: string;
  tabLocation: string;
  topDocument: string;
  topNavigation: string;
}

test("a hostile report cannot escape the sandbox or abuse the message channels", async ({ page, guard }) => {
  // Browsers log the blocked top-level navigation and the Content-Security-Policy violations.
  guard.allowError(/navigat/iu);
  guard.allowError(/Content.Security.Policy|Refused to/iu);
  const report = await openReport(page, "Security probe");
  const resultsText = report.locator("#results");
  await expect(resultsText).not.toBeEmpty();
  const results = JSON.parse((await resultsText.textContent()) ?? "{}") as ProbeResults;

  // Opaque origin: no access to the report frame, the tab (which holds the token), or the ADO page.
  expect(results.origin).toBe("null");
  for (const key of ["parentDocument", "tabDocument", "topDocument", "parentStorage", "tabLocation"] as const) {
    expect(results[key], key).toMatch(/^blocked:/u);
  }

  // Top-level navigation is not allowed by the sandbox.
  expect(page.url()).toMatch(/\/tab\.html$/u);

  // Requests to other origins are blocked by the browser before reaching the network (the guard
  // would also fail the test if any request escaped).
  expect(results.externalFetch).toMatch(/^blocked:/u);
  expect(results.externalImage).toBe("blocked");
  expect(results.externalScript).toBe("blocked");

  // The frame only serves archive files and ignores malformed or unknown requests.
  expect(results.externalResource).toBe("rejected");
  expect(results.malformedRequest).toBeUndefined();
  expect(results.hostApiFetch).toBe(404);

  // A spoofed load-report from the report window is ignored: the probe is still the rendered report.
  await expect(report.getByRole("heading", { name: "Security probe" })).toBeVisible();

  // Messages posted directly to the tab are rejected; only the frame-relayed storage write persists, namespaced.
  await expect(page.locator("#app")).not.toContainText("spoofed-by-report");
  const tabStorage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  expect(Object.values(tabStorage)).not.toContain("spoofed-by-report");
  expect(tabStorage).toMatchObject({ "html-report:security-probe:theme": "probe-dark" });
});
