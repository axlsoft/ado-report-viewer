import { resolveArchivePath } from "./paths";

export interface ResourceResolver {
  resourceUrl(path: string): Promise<string>;
}

const URL_PATTERN = /url\(\s*(['"]?)(.*?)\1\s*\)/giu;
const IMPORT_PATTERN = /@import\s+(?:url\(\s*)?(['"])(.*?)\1\s*\)?/giu;

export async function rewriteCss(css: string, documentPath: string, resolver: ResourceResolver): Promise<string> {
  const imports = await replaceAsync(css, IMPORT_PATTERN, async (match, _quote: string, reference: string) => {
    const path = resolveArchivePath(documentPath, reference);
    return path ? `@import url("${await resolver.resourceUrl(path)}")` : match;
  });

  return replaceAsync(imports, URL_PATTERN, async (match, _quote: string, reference: string) => {
    const path = resolveArchivePath(documentPath, reference);
    return path ? `url("${await resolver.resourceUrl(path)}")` : match;
  });
}

async function replaceAsync(
  source: string,
  expression: RegExp,
  replacement: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...source.matchAll(expression)];
  const replacements = await Promise.all(matches.map((match) => replacement(match[0], ...match.slice(1))));
  let result = source;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    result = `${result.slice(0, match.index)}${replacements[index]}${result.slice((match.index ?? 0) + match[0].length)}`;
  }
  return result;
}