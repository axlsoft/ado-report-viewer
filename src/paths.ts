export function normalizeArchivePath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? "";
  const segments: string[] = [];

  for (const segment of withoutQuery.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error("Archive path escapes the report root");
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.join("/");
}

/**
 * Resolves a reference found in a report document (or sent by the runtime shim) to an archive path.
 * References starting with a single "/" are relative to the archive root. URL percent-escapes are
 * decoded because ZIP entry names are stored unescaped.
 */
export function resolveArchivePath(documentPath: string, reference: string): string | undefined {
  if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/iu.test(reference)) {
    return undefined;
  }

  const [pathname] = reference.split(/[?#]/, 1);
  if (!pathname) {
    return normalizeArchivePath(documentPath);
  }

  const base = documentPath.includes("/") ? documentPath.slice(0, documentPath.lastIndexOf("/") + 1) : "";
  return normalizeArchivePath(decodePath(pathname.startsWith("/") ? pathname : `${base}${pathname}`));
}

export function isHtmlPath(path: string): boolean {
  return /\.x?html?$/iu.test(path);
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
