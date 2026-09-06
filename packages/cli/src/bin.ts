#!/usr/bin/env node
import { createCli } from "./create-cli.js";

// Set exitCode instead of calling process.exit(): on a pipe, stdout writes are
// asynchronous and process.exit() would drop pending output.
process.exitCode = await createCli({ name: "chatbridge" }).run(process.argv);
