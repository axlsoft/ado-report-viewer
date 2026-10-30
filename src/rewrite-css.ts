import { resolveArchivePath } from "./paths";

export interface ResourceResolver {
  /** Returns the URL to substitute for an archive path. */
  resourceUrl(path: string): Promise<string>;
}

// `@import "a.css"` (string form) or any `url(...)`, including `@import url(...)`.
const REFERENCE_PATTERN = /@import\s+(['"])(.*?)\1|url\(\s*(['"]?)(.*?)\3\s*\)/giu;

/**
 * Rewrites archive-local `url()` and `@import` references in a stylesheet. References resolve
 * relative to `stylesheetPath` (the CSS file, or the document for inline styles), not the page.
 */
export async function rewriteCss(css: string, stylesheetPath: string, resolver: ResourceResolver): Promise<string> {
  const matches = [...css.matchAll(REFERENCE_PATTERN)];
  const replacements = await Promise.all(
    matches.map(async (match) => {
      const isImport = match[2] !== undefined;
      const reference = (isImport ? match[2] : match[4]).trim();
      const path = resolveArchivePath(stylesheetPath, reference);
      if (!path) {
        return match[0];
      }
      const url = cssString(await resolver.resourceUrl(path));
      return isImport ? `@import url(${url})` : `url(${url})`;
    }),
  );

  let result = css;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const start = match.index ?? 0;
    result = `${result.slice(0, start)}${replacements[index]}${result.slice(start + match[0].length)}`;
  }
  return result;
}

function cssString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\a ")}"`;
}
