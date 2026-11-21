import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ATTACHMENT_TYPE, encodeAttachmentName, loggingCommand } from "./attachment";
import { checkLimits, formatBytes, listReportFiles, writeZip } from "./zip-writer";

export type IfMissing = "warn" | "error" | "ignore";

export interface PublishOptions {
  reportDir: string;
  name: string;
  entry: string;
  ifMissing: IfMissing;
  /** Base for a relative `reportDir`. */
  workingDirectory: string;
  /** Where the archive is written; it must outlive the step, because the agent uploads it afterwards. */
  tempDirectory: string;
}

export type Log = (line: string) => void;

/** Reads the task inputs the agent passes as `INPUT_<NAME>` environment variables. */
export function readOptions(env: NodeJS.ProcessEnv): PublishOptions {
  const input = (name: string): string => env[`INPUT_${name.toUpperCase()}`]?.trim() ?? "";
  const ifMissing = input("ifMissing") || "warn";
  if (ifMissing !== "warn" && ifMissing !== "error" && ifMissing !== "ignore") {
    throw new Error(`ifMissing must be warn, error, or ignore (got '${ifMissing}').`);
  }
  return {
    reportDir: input("reportDir"),
    name: input("name"),
    entry: input("entry") || "index.html",
    ifMissing,
    workingDirectory: env.SYSTEM_DEFAULTWORKINGDIRECTORY || process.cwd(),
    tempDirectory: env.AGENT_TEMPDIRECTORY || tmpdir(),
  };
}

/** Zips the report folder and attaches it to the current step for the Reports tab. */
export async function publishReport(options: PublishOptions, log: Log): Promise<void> {
  const { name } = options;
  if (!options.reportDir) {
    throw new Error("reportDir is required.");
  }
  if (!name || name.includes("\0")) {
    throw new Error("name is required and can't contain NUL characters.");
  }
  const entry = options.entry.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");
  if (!entry || entry.includes("\0")) {
    throw new Error("entry can't be empty or contain NUL characters.");
  }

  const reportDir = isAbsolute(options.reportDir) ? options.reportDir : resolve(options.workingDirectory, options.reportDir);
  const info = await stat(reportDir).catch(() => undefined);
  const files = info?.isDirectory() ? await listReportFiles(reportDir) : [];
  if (files.length === 0) {
    const problem = info === undefined ? "doesn't exist" : info.isDirectory() ? "has no files" : "isn't a folder";
    const message = `The ${name} report folder ${reportDir} ${problem}, so no report was attached.`;
    if (options.ifMissing === "error") {
      throw new Error(message);
    }
    log(options.ifMissing === "warn" ? loggingCommand("task.logissue", { type: "warning" }, message) : message);
    return;
  }

  if (!existsSync(join(reportDir, entry))) {
    log(
      loggingCommand(
        "task.logissue",
        { type: "warning" },
        `The ${name} report has no ${entry}; the Reports tab will open index.html or ask which page to open.`,
      ),
    );
  }

  checkLimits(files);
  const archive = join(options.tempDirectory, `html-report-${randomUUID()}.zip`);
  const summary = await writeZip(archive, files);
  log(
    `Zipped ${summary.entries} files from ${reportDir} (${formatBytes(summary.uncompressedBytes)}, ` +
      `${formatBytes(summary.compressedBytes)} compressed).`,
  );
  log(loggingCommand("task.addattachment", { type: ATTACHMENT_TYPE, name: encodeAttachmentName(name, entry) }, archive));
  log(`Attached the ${name} report. Open the run's Reports tab to view it.`);
}
