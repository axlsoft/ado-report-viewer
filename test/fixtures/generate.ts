import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "../..");
const sourcesRoot = resolve(import.meta.dirname, "sources");
const generatedRoot = resolve(import.meta.dirname, "generated");
const outputRoot = resolve(generatedRoot, "sources");
const bin = (tool: string): string => resolve(projectRoot, "node_modules/.bin", tool);

interface FixtureArchive {
  entry: string;
  generator: string;
  id: string;
  name: string;
  path: string;
}

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Static report fixture</title>
    <link rel="stylesheet" href="assets/styles/site.css" />
  </head>
  <body>
    <main>
      <h1>Static report fixture</h1>
      <img alt="Report logo" id="report-logo" src="assets/images/logo.svg" srcset="assets/images/logo.svg 1x, assets/images/logo@2x.svg 2x" />
      <p id="result">Loading result...</p>
      <nav><a href="pages/details.html">View details</a></nav>
      <a download href="assets/data/results.json">Download result data</a>
    </main>
    <script>
      fetch("assets/data/results.json")
        .then((response) => response.json())
        .then((result) => { document.querySelector("#result").textContent = result.status; });
    </script>
  </body>
</html>
`;

const detailsHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Static report details</title>
    <link rel="stylesheet" href="../assets/styles/site.css" />
  </head>
  <body>
    <main>
      <h1>Details</h1>
      <a href="../index.html">Back to summary</a>
    </main>
  </body>
</html>
`;

const siteCss = `@font-face {
  font-family: FixtureReport;
  src: url("../fonts/report.woff2") format("woff2");
}

body {
  background: url("../images/background.svg") center / cover;
  font-family: FixtureReport, sans-serif;
}
`;

// A hostile report: it tries to escape the sandbox and abuse the message channels, then records what
// happened in #results for test/e2e/security.spec.ts. Everything it attempts must fail or be ignored.
const securityProbeHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Security probe</title></head>
  <body>
    <h1>Security probe</h1>
    <pre id="results"></pre>
    <script>
      const results = {};
      const attempt = (name, action) => {
        try { results[name] = "allowed:" + String(action()); } catch (error) { results[name] = "blocked:" + error.name; }
      };
      attempt("parentDocument", () => parent.document.title);
      attempt("tabDocument", () => parent.parent.document.title);
      attempt("topDocument", () => top.document.title);
      attempt("parentStorage", () => parent.localStorage.length);
      attempt("tabLocation", () => parent.parent.location.href);
      results.origin = self.origin;

      // Spoofed messages straight to the tab and to the report frame.
      parent.parent.postMessage({ type: "frame-status", status: "error", detail: "spoofed-by-report" }, "*");
      parent.parent.postMessage({ type: "storage-write", key: "theme", value: "spoofed-by-report" }, "*");
      parent.postMessage({ type: "load-report", report: { id: "evil", displayName: "evil", entryPath: "index.html" }, archive: new Blob(["x"]) }, "*");
      parent.postMessage({ type: "fetch-with-token", url: "https://dev.azure.com/org/_apis/build/builds" }, "*");
      parent.postMessage({ type: "resource-request", id: 7, documentPath: ["index.html"], reference: 42 }, "*");
      parent.postMessage({ type: "resource-request", id: "external", documentPath: "index.html", reference: "https://dev.azure.com/org/_apis/build/builds" }, "*");
      addEventListener("message", (event) => {
        if (event.data && event.data.id === "external") results.externalResource = event.data.blob ? "served" : "rejected";
        if (event.data && event.data.id === 7) results.malformedRequest = "answered";
      });

      // A host API path resolves inside the archive (missing), never against the network.
      fetch("/_apis/build/builds?api-version=7.1").then((response) => { results.hostApiFetch = response.status; });

      // Beacons to other origins are blocked by the report Content-Security-Policy.
      fetch("https://example.test/beacon").then(() => { results.externalFetch = "allowed"; }, (error) => { results.externalFetch = "blocked:" + error.name; });
      const pixel = new Image();
      pixel.onload = () => { results.externalImage = "allowed"; };
      pixel.onerror = () => { results.externalImage = "blocked"; };
      pixel.src = "https://example.test/pixel.png";
      const remoteScript = document.createElement("script");
      remoteScript.onload = () => { results.externalScript = "allowed"; };
      remoteScript.onerror = () => { results.externalScript = "blocked"; };
      remoteScript.src = "https://example.test/tracker.js";
      document.head.append(remoteScript);

      // The legitimate storage channel: namespaced and persisted by the tab.
      localStorage.setItem("theme", "probe-dark");

      attempt("topNavigation", () => { top.location.href = "https://example.invalid/"; return "attempted"; });

      setTimeout(() => {
        results.done = true;
        document.querySelector("#results").textContent = JSON.stringify(results);
      }, 1000);
    </script>
  </body>
</html>
`;

const backgroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#d9f3ff"/></svg>\n`;
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#0078d4"/><text x="8" y="26" fill="white">report</text></svg>\n`;
const logoLargeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#0078d4"/><text x="16" y="52" fill="white">report 2x</text></svg>\n`;

await main();

async function main(): Promise<void> {
  await rm(generatedRoot, { force: true, recursive: true });
  await mkdir(outputRoot, { recursive: true });

  await generateStaticSite(resolve(outputRoot, "static-report"));
  await mkdir(resolve(outputRoot, "security-probe"));
  await writeFile(resolve(outputRoot, "security-probe/index.html"), securityProbeHtml);
  await generatePlaywrightReports();
  await generateAllureReport();
  await generateCoverageReport();

  const archives: FixtureArchive[] = [
    { id: "static-report", name: "Static site", entry: "index.html", generator: "hand-written" },
    { id: "reporting-labs-default", name: "E2E", entry: "index.html", generator: await versionOf("reporting-labs") },
    { id: "reporting-labs-embedded", name: "E2E (embedded video)", entry: "index.html", generator: await versionOf("reporting-labs") },
    { id: "playwright-html", name: "Playwright", entry: "index.html", generator: await versionOf("@playwright/test") },
    { id: "lcov-report", name: "Coverage", entry: "index.html", generator: await versionOf("nyc") },
    { id: "allure-report", name: "Allure", entry: "index.html", generator: await versionOf("allure") },
    { id: "security-probe", name: "Security probe", entry: "index.html", generator: "hand-written" },
  ].map((archive) => ({ ...archive, path: `${archive.id}.zip` }));

  for (const archive of archives) {
    const reportDir = resolve(outputRoot, archive.id);
    await stat(resolve(reportDir, archive.entry));
    await zipFolder(reportDir, resolve(generatedRoot, archive.path));
  }

  await writeFile(resolve(generatedRoot, "manifest.json"), `${JSON.stringify({ archives }, null, 2)}\n`);
  for (const archive of archives) {
    console.log(`Generated ${archive.path} (${archive.generator})`);
  }
}

async function generateStaticSite(reportRoot: string): Promise<void> {
  for (const folder of ["assets/data", "assets/fonts", "assets/images", "assets/styles", "pages"]) {
    await mkdir(resolve(reportRoot, folder), { recursive: true });
  }

  await Promise.all([
    writeFile(resolve(reportRoot, "index.html"), indexHtml),
    writeFile(resolve(reportRoot, "pages/details.html"), detailsHtml),
    writeFile(resolve(reportRoot, "assets/data/results.json"), '{"status":"passed","total":3}\n'),
    // A real WOFF2 file so font-loading assertions are meaningful (MIT, from reporting-labs).
    copyFile(resolve(projectRoot, "node_modules/reporting-labs/fonts/sans-400.woff2"), resolve(reportRoot, "assets/fonts/report.woff2")),
    writeFile(resolve(reportRoot, "assets/images/background.svg"), backgroundSvg),
    writeFile(resolve(reportRoot, "assets/images/logo.svg"), logoSvg),
    writeFile(resolve(reportRoot, "assets/images/logo@2x.svg"), logoLargeSvg),
    writeFile(resolve(reportRoot, "assets/styles/site.css"), siteCss),
  ]);
}

async function generatePlaywrightReports(): Promise<void> {
  // One run feeds reporting-labs (default and embedded video), the Playwright HTML reporter, and Allure results.
  // The suite contains an intentional failure, so a non-zero exit is expected when the reports were written.
  await run(bin("playwright"), ["test", "--config", resolve(sourcesRoot, "playwright-suite/playwright.config.ts")], {
    allowFailure: true,
    env: { CI: "1", FIXTURE_OUTPUT_DIR: generatedRoot },
  });
}

async function generateAllureReport(): Promise<void> {
  await run(bin("allure"), ["generate", resolve(outputRoot, "allure-results"), "--output", resolve(outputRoot, "allure-report")], {
    cwd: outputRoot,
  });
}

async function generateCoverageReport(): Promise<void> {
  const cwd = resolve(sourcesRoot, "coverage");
  await run(
    bin("nyc"),
    [
      "--cwd", cwd,
      "--include", "lib/**",
      "--reporter", "html",
      "--report-dir", resolve(outputRoot, "lcov-report"),
      "--temp-dir", resolve(outputRoot, "nyc-temp"),
      process.execPath, "exercise.cjs",
    ],
    { cwd },
  );
}

async function zipFolder(folder: string, archivePath: string): Promise<void> {
  try {
    await execFileAsync("zip", ["-qr", archivePath, "."], { cwd: folder });
  } catch (error) {
    throw new Error("Fixture generation requires the system 'zip' command.", { cause: error });
  }
}

async function run(
  command: string,
  args: string[],
  options: { allowFailure?: boolean; cwd?: string; env?: Record<string, string> } = {},
): Promise<void> {
  try {
    await execFileAsync(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: { ...process.env, ...options.env },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (!options.allowFailure) {
      throw new Error(`Fixture generator failed: ${command} ${args.join(" ")}`, { cause: error });
    }
  }
}

async function versionOf(packageName: string): Promise<string> {
  const manifest = JSON.parse(await readFile(resolve(projectRoot, "node_modules", packageName, "package.json"), "utf8")) as {
    version: string;
  };
  return `${packageName}@${manifest.version}`;
}
