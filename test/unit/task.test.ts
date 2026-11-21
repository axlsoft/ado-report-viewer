import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeAttachmentName } from "../../src/reports";
import { ZipArchive } from "../../src/zip";
import { encodeAttachmentName, loggingCommand } from "../../task/src/attachment";
import { type PublishOptions, publishReport, readOptions } from "../../task/src/publish";
import { checkLimits, crc32, listReportFiles, writeZip } from "../../task/src/zip-writer";

const execFileAsync = promisify(execFile);

const FILES: Record<string, string | Buffer> = {
  "index.html": "<!doctype html><h1>Report</h1>",
  "assets/styles/site.css": "body { color: red; }\n".repeat(500),
  "assets/résumé 报告.json": '{"passed":true}',
  "assets/shot.png": Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 7919) % 256)),
  "empty.txt": "",
  "deep/a/b/c/d.txt": "nested",
};

let workspace: string;
let report: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "publish-task-"));
  report = join(workspace, "report");
  for (const [path, content] of Object.entries(FILES)) {
    await mkdir(join(report, path, ".."), { recursive: true });
    await writeFile(join(report, path), content);
  }
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("attachment name", () => {
  it("round-trips through the Reports tab decoder, including Unicode and long names", () => {
    for (const [name, entry] of [
      ["Playwright", "index.html"],
      ["E2E · Linux 报告", "pages/summary page.html"],
      ["x".repeat(300), "index.html"],
    ]) {
      expect(decodeAttachmentName(encodeAttachmentName(name, entry))).toEqual({ name, entryPath: entry });
    }
  });

  it("escapes logging-command metacharacters", () => {
    expect(loggingCommand("task.logissue", { type: "a;b]c" }, "50%\r\ndone")).toBe("##vso[task.logissue type=a%3Bb%5Dc;]50%AZP25%0D%0Adone");
  });
});

describe("zip writer", () => {
  it("computes standard CRC-32, including across chunks", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf4_3926);
    expect(crc32(Buffer.from("6789"), crc32(Buffer.from("12345")))).toBe(0xcbf4_3926);
  });

  it("writes archives the Reports tab reads, with deflated and stored entries", async () => {
    const archivePath = join(workspace, "report.zip");
    const files = await listReportFiles(report);
    const summary = await writeZip(archivePath, files);

    expect(summary.entries).toBe(Object.keys(FILES).length);
    const archive = await ZipArchive.open(new Blob([await readFile(archivePath)]));
    expect([...archive.list()].sort()).toEqual(Object.keys(FILES).sort());
    for (const [path, content] of Object.entries(FILES)) {
      expect(Buffer.from(await (await archive.read(path)).arrayBuffer())).toEqual(Buffer.from(content));
    }
  });

  it("writes archives that unzip verifies", async (context) => {
    const archivePath = join(workspace, "report.zip");
    await writeZip(archivePath, await listReportFiles(report));
    try {
      const { stdout } = await execFileAsync("unzip", ["-t", archivePath]);
      expect(stdout).toContain("No errors detected");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        context.skip();
      }
      throw error;
    }
  });

  it("follows links to files but not to folders, and clamps pre-1980 timestamps", async () => {
    await symlink(join(report, "index.html"), join(report, "linked.html"));
    await symlink(report, join(report, "loop"));
    await utimes(join(report, "empty.txt"), 0, 0);

    const files = await listReportFiles(report);
    expect(files.map((file) => file.name)).toContain("linked.html");
    expect(files.some((file) => file.name.startsWith("loop/"))).toBe(false);

    const archivePath = join(workspace, "report.zip");
    await writeZip(archivePath, files);
    const archive = await ZipArchive.open(new Blob([await readFile(archivePath)]));
    await expect(archive.read("linked.html").then((blob) => blob.text())).resolves.toBe(FILES["index.html"]);
  });

  it("rejects reports over the Reports tab limits", async () => {
    const files = await listReportFiles(report);
    expect(() => checkLimits(files, { maxEntries: 2, maxEntryBytes: 1e9, maxTotalBytes: 1e9 })).toThrow("at most 2");
    expect(() => checkLimits(files, { maxEntries: 100, maxEntryBytes: 100, maxTotalBytes: 1e9 })).toThrow("files up to");
    expect(() => checkLimits(files, { maxEntries: 100, maxEntryBytes: 1e9, maxTotalBytes: 100 })).toThrow("reports up to");
  });
});

describe("publishReport", () => {
  function options(overrides: Partial<PublishOptions> = {}): PublishOptions {
    return {
      reportDir: "report",
      name: "E2E",
      entry: "index.html",
      ifMissing: "warn",
      workingDirectory: workspace,
      tempDirectory: join(workspace, "temp"),
      ...overrides,
    };
  }

  beforeEach(async () => {
    await mkdir(join(workspace, "temp"));
  });

  it("zips the folder and attaches it with the encoded name", async () => {
    const lines: string[] = [];
    await publishReport(options({ entry: "./deep\\a/b/c/d.txt" }), (line) => lines.push(line));

    const command = lines.find((line) => line.startsWith("##vso[task.addattachment"));
    const match = /^##vso\[task\.addattachment type=html-report;name=([^;]+);\](.+)$/u.exec(command ?? "");
    expect(match).not.toBeNull();
    expect(decodeAttachmentName(match![1])).toEqual({ name: "E2E", entryPath: "deep/a/b/c/d.txt" });
    expect(match![2].startsWith(join(workspace, "temp"))).toBe(true);
    const archive = await ZipArchive.open(new Blob([await readFile(match![2])]));
    expect(archive.has("deep/a/b/c/d.txt")).toBe(true);
  });

  it("warns when the entry page is missing but still attaches the report", async () => {
    const lines: string[] = [];
    await publishReport(options({ entry: "summary.html" }), (line) => lines.push(line));
    expect(lines.some((line) => line.startsWith("##vso[task.logissue type=warning;]") && line.includes("no summary.html"))).toBe(true);
    expect(lines.some((line) => line.startsWith("##vso[task.addattachment"))).toBe(true);
  });

  it("handles a missing report folder according to ifMissing", async () => {
    const missing = { reportDir: "nope" };
    const lines: string[] = [];
    await publishReport(options({ ...missing, ifMissing: "warn" }), (line) => lines.push(line));
    expect(lines).toEqual([expect.stringMatching(/^##vso\[task\.logissue type=warning;\].*doesn't exist/u)]);

    lines.length = 0;
    await publishReport(options({ ...missing, ifMissing: "ignore" }), (line) => lines.push(line));
    expect(lines).toEqual([expect.not.stringContaining("##vso")]);

    await expect(publishReport(options({ ...missing, ifMissing: "error" }), () => {})).rejects.toThrow("doesn't exist");
    expect(await readdir(join(workspace, "temp"))).toEqual([]);
  });

  it("validates the name and reads inputs from the agent environment", async () => {
    await expect(publishReport(options({ name: "" }), () => {})).rejects.toThrow("name is required");
    expect(
      readOptions({
        INPUT_REPORTDIR: " coverage ",
        INPUT_NAME: "Coverage",
        INPUT_IFMISSING: "error",
        SYSTEM_DEFAULTWORKINGDIRECTORY: "/work",
        AGENT_TEMPDIRECTORY: "/tmp/agent",
      }),
    ).toEqual({
      reportDir: "coverage",
      name: "Coverage",
      entry: "index.html",
      ifMissing: "error",
      workingDirectory: "/work",
      tempDirectory: "/tmp/agent",
    });
    expect(() => readOptions({ INPUT_IFMISSING: "maybe" })).toThrow("ifMissing");
  });
});
