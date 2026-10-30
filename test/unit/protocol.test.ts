import { describe, expect, it } from "vitest";
import { isDocumentToFrameMessage, isFrameToTabMessage, isLoadReportMessage } from "../../src/protocol";

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

  it("accepts a theme for the frame and rejects a malformed one", () => {
    const message = { type: "load-report", archive: new Blob(["zip"]), report: { id: "report", displayName: "E2E", entryPath: "index.html" } };
    const appearance = { accent: "#0078d4", color: "rgb(255, 255, 255)", fontFamily: "Segoe UI" };

    expect(isLoadReportMessage({ ...message, appearance })).toBe(true);
    expect(isLoadReportMessage({ ...message, appearance: { ...appearance, color: 1 } })).toBe(false);
    expect(isLoadReportMessage({ ...message, appearance: "dark" })).toBe(false);
  });

  it("rejects unknown frame commands", () => {
    expect(isFrameToTabMessage({ type: "fetch-with-token", url: "https://example.test" })).toBe(false);
  });

  it("accepts only well-formed messages from the report document", () => {
    expect(isDocumentToFrameMessage({ type: "resource-request", id: "1", documentPath: "index.html", reference: "a.css" })).toBe(true);
    expect(isDocumentToFrameMessage({ type: "navigate", documentPath: "index.html", reference: "b.html#x" })).toBe(true);
    expect(isDocumentToFrameMessage({ type: "resource-request", id: 7, documentPath: ["index.html"], reference: 42 })).toBe(false);
    expect(isDocumentToFrameMessage({ type: "load-report", archive: new Blob(["x"]) })).toBe(false);
    expect(isDocumentToFrameMessage(null)).toBe(false);
  });
});
