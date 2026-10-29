import { describe, expect, it } from "vitest";
import { normalizeArchivePath, resolveArchivePath } from "../../src/paths";

describe("archive paths", () => {
  it("normalizes report-local paths", () => {
    expect(normalizeArchivePath("assets/../images/./screen shot.png")).toBe("images/screen shot.png");
    expect(resolveArchivePath("pages/detail.html", "../data/result.json?x=1#item")).toBe("data/result.json");
  });

  it("rejects paths that leave the report root", () => {
    expect(() => normalizeArchivePath("../../token.txt")).toThrow("escapes the report root");
  });

  it("leaves absolute and fragment references outside archive resolution", () => {
    expect(resolveArchivePath("index.html", "https://example.test/a")).toBeUndefined();
    expect(resolveArchivePath("index.html", "#section")).toBeUndefined();
  });
});