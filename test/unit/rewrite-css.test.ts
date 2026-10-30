import { describe, expect, it } from "vitest";
import { rewriteCss } from "../../src/rewrite-css";

const resolver = { resourceUrl: async (path: string) => `blob:${path}` };

describe("rewriteCss", () => {
  it("resolves url() and @import relative to the stylesheet, not the page", async () => {
    const css = `@import "theme.css";
@import url('../base.css');
@font-face { src: url(../fonts/report.woff2) format("woff2"); }
body { background: url( "images/bg.svg" ); }`;

    await expect(rewriteCss(css, "assets/styles/site.css", resolver)).resolves.toBe(`@import url("blob:assets/styles/theme.css");
@import url("blob:assets/base.css");
@font-face { src: url("blob:assets/fonts/report.woff2") format("woff2"); }
body { background: url("blob:assets/styles/images/bg.svg"); }`);
  });

  it("decodes escaped names and keeps queries and fragments out of archive paths", async () => {
    await expect(rewriteCss("a { b: url(img/screen%20shot.png?v=2#x) }", "site.css", resolver)).resolves.toBe(
      'a { b: url("blob:img/screen shot.png") }',
    );
  });

  it("leaves absolute, data, blob, and fragment references untouched", async () => {
    const css = `a { b: url(https://cdn.example/x.png); c: url(data:image/png;base64,AA==); d: url(blob:null/1); e: url(#mask); f: url(//cdn.example/y.png); }`;
    await expect(rewriteCss(css, "site.css", resolver)).resolves.toBe(css);
  });

  it("does not rewrite a token it produced for @import", async () => {
    const tokens = { resourceUrl: async () => "__report_resource_0__" };
    await expect(rewriteCss('@import "a.css";', "site.css", tokens)).resolves.toBe('@import url("__report_resource_0__");');
  });
});
