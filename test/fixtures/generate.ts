import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const generatedRoot = resolve(import.meta.dirname, "generated");
const reportRoot = resolve(generatedRoot, "static-report");
const archivePath = resolve(generatedRoot, "static-report.zip");

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

const backgroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#d9f3ff"/></svg>\n`;
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#0078d4"/><text x="8" y="26" fill="white">report</text></svg>\n`;
const logoLargeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#0078d4"/><text x="16" y="52" fill="white">report 2x</text></svg>\n`;

await main();

async function main(): Promise<void> {
  await rm(generatedRoot, { force: true, recursive: true });
  await mkdir(resolve(reportRoot, "assets/data"), { recursive: true });
  await mkdir(resolve(reportRoot, "assets/fonts"), { recursive: true });
  await mkdir(resolve(reportRoot, "assets/images"), { recursive: true });
  await mkdir(resolve(reportRoot, "assets/styles"), { recursive: true });
  await mkdir(resolve(reportRoot, "pages"), { recursive: true });

  await Promise.all([
    writeFile(resolve(reportRoot, "index.html"), indexHtml),
    writeFile(resolve(reportRoot, "pages/details.html"), detailsHtml),
    writeFile(resolve(reportRoot, "assets/data/results.json"), '{"status":"passed","total":3}\n'),
    writeFile(resolve(reportRoot, "assets/fonts/report.woff2"), "fixture-font"),
    writeFile(resolve(reportRoot, "assets/images/background.svg"), backgroundSvg),
    writeFile(resolve(reportRoot, "assets/images/logo.svg"), logoSvg),
    writeFile(resolve(reportRoot, "assets/images/logo@2x.svg"), logoLargeSvg),
    writeFile(resolve(reportRoot, "assets/styles/site.css"), siteCss),
  ]);

  try {
    await execFileAsync("zip", ["-qr", archivePath, "."], { cwd: reportRoot });
  } catch (error) {
    throw new Error("Fixture generation requires the system 'zip' command.", { cause: error });
  }

  await writeFile(
    resolve(generatedRoot, "manifest.json"),
    JSON.stringify(
      {
        archives: [
          {
            entry: "index.html",
            id: "static-report",
            path: "static-report.zip",
            producer: "hand-written static site",
          },
        ],
      },
      null,
      2,
    ).concat("\n"),
  );

  console.log(`Generated ${archivePath}`);
}