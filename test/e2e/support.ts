import { expect, test as base, type Frame, type FrameLocator, type Page } from "@playwright/test";

const HARNESS_PATHS = [/^\/tab\.html$/u, /^\/frame\.html$/u, /^\/report-document\.html$/u, /^\/assets\//u, /^\/__fixtures\//u];

export interface Guard {
  /** External URLs a report is known to request (they are still aborted, never fetched). */
  allowExternal(pattern: RegExp): void;
  /** Errors a test expects, such as a browser reporting a blocked action (console or page error). */
  allowError(pattern: RegExp): void;
  /** Requests on the harness origin, by pathname, for cache assertions. */
  readonly harnessRequests: string[];
}

/**
 * Every test runs behind a network and error guard: requests that leave the harness origin or hit an
 * unexpected harness path are aborted and fail the test, as do HTTP errors and uncaught page errors.
 */
export const test = base.extend<{ guard: Guard }>({
  guard: [
    async ({ page, baseURL }, use) => {
      const origin = new URL(baseURL ?? "http://127.0.0.1:4173").origin;
      const allowedExternal: RegExp[] = [];
      const allowedErrors: RegExp[] = [/^Failed to load resource/u];
      const escaped: string[] = [];
      const httpErrors: string[] = [];
      const pageErrors: string[] = [];
      const harnessRequests: string[] = [];

      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        // WebKit also routes blob: and data: URLs; those never touch the network.
        if (url.protocol === "blob:" || url.protocol === "data:") {
          await route.continue();
          return;
        }
        if (url.origin === origin && HARNESS_PATHS.some((path) => path.test(url.pathname))) {
          harnessRequests.push(url.pathname);
          await route.continue();
          return;
        }
        if (!allowedExternal.some((pattern) => pattern.test(url.href))) {
          escaped.push(url.href);
        }
        await route.abort();
      });
      page.on("response", (response) => {
        if (response.status() >= 400) {
          httpErrors.push(`${response.status()} ${response.url()}`);
        }
      });
      page.on("pageerror", (error) => {
        if (!allowedErrors.some((pattern) => pattern.test(error.message))) {
          pageErrors.push(error.message);
        }
      });
      page.on("console", (message) => {
        // Network failures are asserted through the route guard; anything else logged as an error fails.
        if (message.type() === "error" && !allowedErrors.some((pattern) => pattern.test(message.text()))) {
          pageErrors.push(message.text());
        }
      });

      await use({
        allowExternal: (pattern) => allowedExternal.push(pattern),
        allowError: (pattern) => allowedErrors.push(pattern),
        harnessRequests,
      });

      expect(escaped, "requests escaped the report sandbox").toEqual([]);
      expect(httpErrors, "HTTP errors").toEqual([]);
      expect(pageErrors, "uncaught errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Opens the harness tab and selects a fixture report by its display name. */
export async function openReport(page: Page, name: string): Promise<FrameLocator> {
  if (!page.url().endsWith("/tab.html")) {
    await page.goto("/tab.html");
  }
  await page.getByLabel("Select report").selectOption({ label: name });
  return reportLocator(page);
}

export function reportLocator(page: Page): FrameLocator {
  return page.frameLocator("iframe.report-frame").frameLocator("iframe");
}

/** The sandboxed report document, for evaluating assertions inside it. */
export async function reportDocument(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((frame) => frame.url().includes("/report-document.html"))).toBe(true);
  const frame = page.frames().find((candidate) => candidate.url().includes("/report-document.html"));
  if (!frame) {
    throw new Error("Report document frame not found");
  }
  return frame;
}

/** Waits until a video element has a resolved source with loaded metadata. */
export async function expectPlayableVideo(page: Page, scheme: "blob:" | "data:"): Promise<void> {
  const frame = await reportDocument(page);
  await expect
    .poll(() =>
      frame.evaluate(() => {
        const video = document.querySelector("video");
        return video ? `${video.currentSrc.split(":")[0]}: ${video.readyState >= HTMLMediaElement.HAVE_METADATA}` : "none";
      }),
    )
    .toBe(`${scheme} true`);
}

/**
 * Traverses joint session history from the tab. Report pages navigate the nested report-document
 * frame, so `page.goBack()` (which waits for a top-level navigation) does not apply.
 */
export async function historyGo(page: Page, delta: number): Promise<void> {
  await page.evaluate((steps) => history.go(steps), delta);
}
