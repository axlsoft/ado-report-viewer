// Packages (`create`) or publishes (`publish`) the extension with tfx. The publisher identity is not
// committed: it comes from the environment, set in a local .env file (see .env.example) or as CI
// variables. `create` needs EXTENSION_PUBLISHER; `publish` also needs EXTENSION_SHARE_WITH and
// AZURE_DEVOPS_EXT_PAT. EXTENSION_VERSION (set by the release workflow) overrides package.json.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const tfx = resolve(projectRoot, "node_modules/.bin/tfx");
const version =
  process.env.EXTENSION_VERSION?.trim() ||
  (JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8")) as { version: string }).version;
const { id } = JSON.parse(await readFile(resolve(projectRoot, "vss-extension.json"), "utf8")) as { id: string };
const publisher = required("EXTENSION_PUBLISHER");

switch (process.argv[2]) {
  case "create":
    run([
      "extension", "create",
      "--manifest-globs", "vss-extension.json",
      "--publisher", publisher,
      "--override", JSON.stringify({ version }),
      "--output-path", "release",
    ]);
    break;
  case "publish":
    run([
      "extension", "publish",
      "--vsix", join("release", `${publisher}.${id}-${version}.vsix`),
      "--share-with", ...required("EXTENSION_SHARE_WITH").split(/[\s,]+/u),
      "--token", required("AZURE_DEVOPS_EXT_PAT"),
      "--no-prompt",
    ]);
    break;
  default:
    throw new Error("Usage: node scripts/extension.ts <create|publish>");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. Add it to .env (see .env.example) or to the CI variables.`);
  }
  return value;
}

function run(args: string[]): void {
  const result = spawnSync(tfx, args, { cwd: projectRoot, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
