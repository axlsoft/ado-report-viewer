import { describe, expect, it } from "vitest";
import { runtimeShim } from "../../src/runtime-shim";

describe("runtimeShim", () => {
  it("emits syntactically valid JavaScript", () => {
    const script = runtimeShim("index.html", { theme: "dark" })
      .replace(/^<script>/u, "")
      .replace(/<\/script>$/u, "");

    expect(() => new Function(script)).not.toThrow();
  });

  it("preserves regex escapes in the emitted script", () => {
    const script = runtimeShim("index.html", {});

    expect(script).toContain(String.raw`/url\(\s*(['"]?)(.*?)\1\s*\)/giu`);
    expect(script).toContain(String.raw`split(/\s+/u)`);
    expect(script).not.toContain("split(/s+/u)");
  });
});