import { describe, expect, it } from "vitest";
import { isFrameToTabMessage, isLoadReportMessage } from "../../src/protocol";

describe("postMessage protocol", () => {
  it("accepts a complete report load message", () => {
    expect(
      isLoadReportMessage({
        type: "load-report",
        archive: new Blob(["zip"]),
        report: { id: "report", displayName: "E2E", entryPath: "index.html" },
      }),
    ).toBe(true);
  });

  it("rejects unknown frame commands", () => {
    expect(isFrameToTabMessage({ type: "fetch-with-token", url: "https://example.test" })).toBe(false);
  });
});