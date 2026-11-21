/** Attachment type the Reports tab lists. */
export const ATTACHMENT_TYPE = "html-report";

/**
 * Encodes `html-report-v1-<base64url(display name, NUL, entry path)>`, the name the Reports tab
 * decodes (see decodeAttachmentName in src/reports.ts). base64url keeps logging-command separators
 * out of the name.
 */
export function encodeAttachmentName(displayName: string, entryPath: string): string {
  return `${ATTACHMENT_TYPE}-v1-${Buffer.from(`${displayName}\0${entryPath}`, "utf8").toString("base64url")}`;
}

/** `##vso[area.action key=value;]data` with the agent's escaping rules. */
export function loggingCommand(command: string, properties: Record<string, string>, data = ""): string {
  const props = Object.entries(properties)
    .map(([key, value]) => `${key}=${escapeProperty(value)};`)
    .join("");
  return `##vso[${command}${props ? ` ${props}` : ""}]${escapeData(data)}`;
}

function escapeData(value: string): string {
  return value.replaceAll("%", "%AZP25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(value: string): string {
  return escapeData(value).replaceAll("]", "%5D").replaceAll(";", "%3B");
}
