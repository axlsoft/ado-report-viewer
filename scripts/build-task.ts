// Builds the PublishHtmlReport pipeline task into dist-task/PublishHtmlReport: one self-contained
// CommonJS file for the agent's Node handlers, the task manifest, and the icon.
//
// Agents cache tasks by version, so every extension release must ship a new task version. The
// manifest's Major stays fixed (it's the @1 in YAML); Minor and Patch are stamped from the extension
// version (EXTENSION_VERSION or package.json): Minor = major * 1000 + minor, Patch = patch.
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";

const projectRoot = resolve(import.meta.dirname, "..");
const outDir = resolve(projectRoot, "dist-task/PublishHtmlReport");
const version =
  process.env.EXTENSION_VERSION?.trim() ||
  (JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8")) as { version: string }).version;

const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
if (!match) {
  throw new Error(`Extension version must be major.minor.patch (got '${version}').`);
}
const [major, minor, patch] = match.slice(1).map(Number);
if (minor >= 1000) {
  throw new Error(`Extension minor version ${minor} doesn't fit the task version scheme (minor < 1000).`);
}

await rm(outDir, { recursive: true, force: true });
await build({
  configFile: false,
  root: projectRoot,
  logLevel: "warn",
  build: {
    ssr: resolve(projectRoot, "task/src/index.ts"),
    outDir,
    emptyOutDir: false,
    // The oldest Node the task declares (Node20_1); agents with the Node24 handler use that instead.
    target: "node20",
    sourcemap: false,
    minify: false,
    rollupOptions: {
      output: { format: "cjs", entryFileNames: "index.js" },
    },
  },
  ssr: { noExternal: true },
});

const manifest = JSON.parse(await readFile(resolve(projectRoot, "task/task.json"), "utf8")) as {
  version: { Major: number; Minor: number; Patch: number };
};
manifest.version = { Major: manifest.version.Major, Minor: major * 1000 + minor, Patch: patch };
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, "task.json"), `${JSON.stringify(manifest, null, 2)}\n`);
// Pins index.js to CommonJS whatever package.json sits above the task folder (this repo's is ESM).
await writeFile(resolve(outDir, "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
await copyFile(resolve(projectRoot, "images/icon.png"), resolve(outDir, "icon.png"));
console.log(`Built PublishHtmlReport@${manifest.version.Major}.${manifest.version.Minor}.${manifest.version.Patch}`);
