#!/usr/bin/env bun
import { createCli } from "./create-cli";

process.exit(await createCli({ name: "chatbridge" }).run(process.argv));
