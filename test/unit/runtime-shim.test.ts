import { describe, expect, it } from "vitest";
import { runtimeShim } from "../../src/runtime-shim";

const SCRIPT_OPEN = "<script>";
const SCRIPT_CLOSE = "</script>";

/** Strips the exact wrapper runtimeShim emits; anything else fails the test. */
function scriptBody(markup: string): string {
  expect(markup.startsWith(SCRIPT_OPEN) && markup.endsWith(SCRIPT_CLOSE), "script wrapper").toBe(true);
  return markup.slice(SCRIPT_OPEN.length, -SCRIPT_CLOSE.length);
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
