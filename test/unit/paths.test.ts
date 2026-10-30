import { describe, expect, it } from "vitest";
import { normalizeArchivePath, resolveArchivePath } from "../../src/paths";

describe("archive paths", () => {
  it("normalizes report-local paths", () => {
    expect(normalizeArchivePath("assets/../images/./screen shot.png")).toBe("images/screen shot.png");
    expect(resolveArchivePath("pages/detail.html", "../data/result.json?x=1#item")).toBe("data/result.json");
  });

  it("rejects paths that leave the report root", () => {
    expect(() => normalizeArchivePath("../../token.txt")).toThrow("escapes the report root");
    expect(() => resolveArchivePath("index.html", "%2e%2e/token.txt")).toThrow("escapes the report root");
  });

  it("decodes percent-escapes, keeps Unicode, and treats a leading slash as the archive root", () => {
    expect(resolveArchivePath("pages/a.html", "screen%20shot.png")).toBe("pages/screen shot.png");
    expect(resolveArchivePath("pages/a.html", "r\u00e9sum\u00e9.json")).toBe("pages/r\u00e9sum\u00e9.json");
    expect(resolveArchivePath("pages/a.html", "/assets/site.css")).toBe("assets/site.css");
  });

  it("leaves absolute and fragment references outside archive resolution", () => {
    expect(resolveArchivePath("index.html", "https://example.test/a")).toBeUndefined();
    expect(resolveArchivePath("index.html", "#section")).toBeUndefined();
    for (const reference of ["data:text/plain,x", "blob:null/1", "mailto:a@example.test", "//cdn.example/x.js"]) {
      expect(resolveArchivePath("index.html", reference)).toBeUndefined();
    }
  });
});