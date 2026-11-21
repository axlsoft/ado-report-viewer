// Entry point of the PublishHtmlReport pipeline task. It has no dependencies beyond Node itself:
// inputs arrive as INPUT_<NAME> environment variables, and results go back as logging commands.
import { loggingCommand } from "./attachment";
import { publishReport, readOptions } from "./publish";

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

Promise.resolve()
  .then(() => publishReport(readOptions(process.env), log))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(loggingCommand("task.logissue", { type: "error" }, message));
    log(loggingCommand("task.complete", { result: "Failed" }, message));
    process.exitCode = 1;
  });
