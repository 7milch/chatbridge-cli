#!/usr/bin/env node
import { createRequire } from "node:module";
import { createCli } from "./create-cli.js";

// Works from src/ (bun) and dist/ (node): both sit one level under the package.
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

// Set exitCode instead of calling process.exit(): on a pipe, stdout writes are
// asynchronous and process.exit() would drop pending output.
process.exitCode = await createCli({ name: "chatbridge", version }).run(
  process.argv,
);
