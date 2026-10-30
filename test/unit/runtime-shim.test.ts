import { describe, expect, it } from "vitest";
import { runtimeShim } from "../../src/runtime-shim";

function scriptBody(markup: string): string {
  return markup.replace(/^<script>/u, "").replace(/<\/script>$/u, "");
}

describe("runtimeShim", () => {
  it("emits syntactically valid JavaScript", () => {
    expect(() => new Function(scriptBody(runtimeShim("index.html", { theme: "dark" })))).not.toThrow();
  });

  it("keeps report-controlled values from closing the script element", () => {
    const markup = runtimeShim("pages/</script><img src=x>.html", { theme: "</script><script>alert(1)</script>" });

    expect(scriptBody(markup)).not.toMatch(/<\/script|<!--/iu);
    expect(() => new Function(scriptBody(markup))).not.toThrow();
  });
});
