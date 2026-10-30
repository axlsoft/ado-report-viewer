import { describe, expect, it } from "vitest";
import { decodeAttachmentName, disambiguateReports } from "../../src/reports";

function encode(displayName: string, entryPath: string): string {
  const bytes = new TextEncoder().encode(`${displayName}\0${entryPath}`);
  return `html-report-v1-${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

describe("disambiguateReports", () => {
  it("leaves unique names alone and labels duplicates with their job", () => {
    const labels = disambiguateReports([
      { displayName: "E2E", jobName: "Linux" },
      { displayName: "E2E", jobName: "Windows" },
      { displayName: "Coverage", jobName: "Linux" },
    ]).map((report) => report.displayName);

    expect(labels).toEqual(["E2E · Linux", "E2E · Windows", "Coverage"]);
  });

  it("numbers reports that stay ambiguous", () => {
    const labels = disambiguateReports([
      { displayName: "E2E", jobName: "Linux" },
      { displayName: "E2E", jobName: "Linux" },
      { displayName: "Coverage" },
      { displayName: "Coverage" },
    ]).map((report) => report.displayName);

    expect(labels).toEqual(["E2E · Linux (1)", "E2E · Linux (2)", "Coverage (1)", "Coverage (2)"]);
  });
});

describe("decodeAttachmentName", () => {
  it("decodes the pipeline template encoding, including Unicode", () => {
    expect(decodeAttachmentName(encode("Résumé E2E", "reports/index.html"))).toEqual({ name: "Résumé E2E", entryPath: "reports/index.html" });
  });

  it("rejects other names and malformed payloads", () => {
    expect(decodeAttachmentName("E2E@index.html.zip")).toBeUndefined();
    expect(decodeAttachmentName("html-report-v1-!!")).toBeUndefined();
    expect(decodeAttachmentName(encode("E2E", ""))).toBeUndefined();
    expect(decodeAttachmentName(encode("E2E", "index.html\0extra"))).toBeUndefined();
  });
});
