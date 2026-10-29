# HTML Report Tab

View static HTML reports (test results, coverage, and similar) directly on an Azure Pipelines run, without downloading artifacts or hosting the reports anywhere.

The extension adds a **Reports** tab to the pipeline run page. Any pipeline step can attach a report folder to the run, and the tab opens it in place, with its styles, scripts, images, videos, and links between pages intact.

## Features

- **Reports where the run is.** Every attached report appears in the run's Reports tab. Switch between them with buttons, or with a drop-down list when there are more than four.
- **Live while the run is in progress.** Reports attached by later stages appear without reloading the page.
- **Matrix-friendly.** Reports with the same name from different jobs are labeled with the job name, such as `E2E · Linux` and `E2E · Windows`.
- **Remembers your place.** The tab reopens the report you last viewed for each pipeline, and keeps report settings such as a dark or light theme.
- **Full reports, not screenshots.** Multi-page reports, client-side routing, embedded media, and file downloads all work.
- **Download the original.** **Download .zip** saves the complete report archive.
- **Isolated by design.** Reports never get access to Azure DevOps, your credentials, or the internet (see [Security](#security)).

## Getting Started

The extension is private. It has to be shared with your Azure DevOps organization before it can be installed.

1. Once it has been shared, an organization administrator installs it from **Organization settings → Extensions → Shared**.
2. Add the report template to the pipelines that produce reports (see [Attach a Report](#attach-a-report)).
3. Open a pipeline run and select the **Reports** tab.

## Attach a Report

Copy [`pipeline-templates/publish-html-report.yml`](pipeline-templates/publish-html-report.yml) into the repository whose pipeline produces the report. Then add it as a step after the step that writes the report:

```yaml
steps:
  - script: npx playwright test
    displayName: Run tests

  - template: pipeline-templates/publish-html-report.yml
    parameters:
      reportDir: playwright-report
      name: Playwright
```

The template zips the folder and attaches it to the run. It runs even when earlier steps fail, so failing runs still have their reports.

| Parameter | Required | Description |
| --- | --- | --- |
| `reportDir` | Yes | Folder that contains the report, such as `playwright-report` or `coverage/lcov-report`. |
| `name` | Yes | Name shown in the Reports tab. Use a different name for each report attached by the same job. |
| `entry` | No | Page to open first, relative to `reportDir`. Defaults to `index.html`. |

Attach as many reports as you like, from any stage or job:

```yaml
- template: pipeline-templates/publish-html-report.yml
  parameters:
    reportDir: coverage/lcov-report
    name: Coverage

- template: pipeline-templates/publish-html-report.yml
  parameters:
    reportDir: reports/e2e
    name: E2E
    entry: summary.html
```

If the entry page is missing from the archive, the tab opens `index.html`. If that's missing too, it opens the only HTML page at the top of the archive, or asks you to choose when there are several.

## Supported Reports

Any self-contained static HTML report should work. These report types are tested in Chromium, Firefox, and WebKit (Safari):

| Report | What is covered |
| --- | --- |
| Playwright HTML reporter | Test details, screenshots, videos, attachment downloads |
| reporting-labs | Test views, screenshots, videos (separate or embedded), large attachments, trace downloads, theme switching |
| Istanbul / nyc `lcov-report` | Directory and file drill-down, syntax highlighting, back and forward navigation |
| Allure 3 (static) | Single-page app and test details |
| Hand-written static sites | Stylesheets, web fonts, responsive images, data loaded with `fetch`, multiple pages, downloads |

## Security

Report archives can contain arbitrary HTML and JavaScript, so each report runs in an isolated sandbox:

- The report cannot read or change the Azure DevOps page, the Reports tab, or other reports.
- Only the Reports tab holds the Azure DevOps access token, and it is never passed to the report.
- The report can only load files from its own archive. Requests to any other address, including Azure DevOps and the internet, are blocked by the browser before they are sent.

## Limitations

- **No external resources.** Scripts, stylesheets, fonts, or images loaded from a CDN or another site are blocked, and so are analytics (for example, Allure 3's Google Analytics). Reports that bundle their assets are not affected.
- **JavaScript modules.** Scripts that `import` other files from the report don't work. Bundled scripts and classic scripts do.
- **Workers.** Module workers and service workers aren't supported. This means the Playwright trace viewer can't open in place, but trace files still download.
- **Nested pages.** A report page shown inside an `<iframe>` of another report page can't load other files from the archive.
- **Safari.** Reports that change the page path with the browser history API keep the original path. Reports that use `#` routes, which includes the ones listed above, are not affected.
- **Archive size.** Up to 10,000 files, 512 MB per file, and 2 GB in total (uncompressed). ZIP64 archives aren't supported.

## Contributing

To build, test, or release the extension, see [CONTRIBUTING.md](CONTRIBUTING.md).
