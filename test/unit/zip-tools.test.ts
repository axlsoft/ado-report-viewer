import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZipArchive } from "../../src/zip";

const execFileAsync = promisify(execFile);

// Archives produced by real tools. A tool missing from the machine skips its case.
const FILES: Record<string, string> = {
  "index.html": "<!doctype html><h1>Report</h1>",
  "assets/styles/site.css": "body { color: red; }\n".repeat(200),
  "assets/résumé 报告.json": '{"passed":true}',
  "empty.txt": "",
  "deep/a/b/c/d.txt": "nested",
};

const TOOLS: { name: string; command: string; args: (archive: string) => string[]; shell?: boolean }[] = [
  { name: "zip", command: "zip", args: (archive) => ["-qr", archive, "."] },
  // Piping stdout (non-seekable) forces streamed entries with data descriptors (general-purpose flag bit 3).
  { name: "zip (streamed, data descriptors)", command: "sh", args: (archive) => ["-c", `zip -qr - . | cat > '${archive}'`] },
  // 7-Zip is what ArchiveFiles@2 uses on Windows agents.
  { name: "7-Zip", command: "7z", args: (archive) => ["a", "-tzip", "-bd", "-bso0", archive, "."] },
  {
    name: "PowerShell Compress-Archive",
    command: "pwsh",
    args: (archive) => ["-NoProfile", "-Command", `Compress-Archive -Path ./* -DestinationPath '${archive}'`],
  },
];

let workspace: string;
let source: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "report-zip-"));
  source = join(workspace, "report");
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(join(source, path, ".."), { recursive: true });
    await writeFile(join(source, path), text);
  }
});

afterAll(async () => {
  await rm(workspace, { force: true, recursive: true });
});

// Starting a tool can take several seconds on a cold CI runner (notably pwsh and its archive module).
const TOOL_TIMEOUT_MS = 30_000;

describe.each(TOOLS)("archives from $name", (tool) => {
  it("lists and reads every entry", { timeout: TOOL_TIMEOUT_MS }, async (context) => {
    const archivePath = join(workspace, `${tool.name.replace(/\W+/gu, "-")}.zip`);
    try {
      await execFileAsync(tool.command, tool.args(archivePath), { cwd: source });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || /not found/u.test(String((error as { stderr?: string }).stderr))) {
        context.skip(`${tool.command} is not installed`);
      }
      throw error;
    }

    const bytes = await readFile(archivePath);
    if (tool.name.includes("data descriptors")) {
      // Directory entries never use data descriptors (their size is known), and directory order
      // differs by platform, so check every file entry rather than the first local header.
      const fileEntries = [...centralDirectoryFlags(bytes)].filter(([name]) => !name.endsWith("/"));
      expect(fileEntries.length, "file entries").toBe(Object.keys(FILES).length);
      for (const [name, flags] of fileEntries) {
        expect(flags & 0x08, `data-descriptor flag of ${name}`).toBe(0x08);
      }
    }
    const archive = await ZipArchive.open(new Blob([bytes]));
    expect([...archive.list()].sort()).toEqual(Object.keys(FILES).sort());
    for (const [path, text] of Object.entries(FILES)) {
      await expect(archive.read(path).then((blob) => blob.text()), path).resolves.toBe(text);
    }
  });
});

/** General-purpose bit flags of each central directory entry, by entry name. */
function centralDirectoryFlags(bytes: Buffer): Map<string, number> {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const flags = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    flags.set(name, bytes.readUInt16LE(offset + 8));
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return flags;
}
