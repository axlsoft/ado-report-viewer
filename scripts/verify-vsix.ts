import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const releaseFiles = await readdir("release");
const vsix = releaseFiles.find((file) => file.endsWith(".vsix"));
if (!vsix) {
  throw new Error("No VSIX file found in release/");
}

const { stdout } = await execFileAsync("unzip", ["-Z1", join("release", vsix)]);
const entries = stdout.trim().split("\n");
const forbidden = entries.filter((entry) => /(?:^|\/)(?:src|node_modules|pipeline-templates)(?:\/|$)|\.map$/u.test(entry));
if (forbidden.length > 0) {
  throw new Error(`VSIX includes forbidden files:\n${forbidden.join("\n")}`);
}