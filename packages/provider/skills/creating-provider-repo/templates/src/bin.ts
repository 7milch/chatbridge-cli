#!/usr/bin/env bun
// src/bin.ts — the shebang picks the runtime a globally installed bin uses
// (tsc copies it into dist/bin.js unchanged); see "Runtime and shebang" in
// the creating-provider-repo skill.
import { createRequire } from "node:module";
import { createCli } from "@chatbridge/cli";
import provider from "./provider.js";

// Read the vendor package's own version; "../package.json" resolves from
// both src/ (bun) and dist/ (node), which sit one level under it.
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

process.exitCode = await createCli({
  name: "<vendor>",
  version, // `<vendor> --version` / `-V` prints "<vendor> vX.Y.Z"; also the default banner
  provider,
  // Optional `string[]` or `{ lines, colors?, mode? }`. Interactive-mode
  // startup banner, one string per row, any row count, shown centred until
  // the first message; rows wider than the terminal are cut on the right.
  // Used verbatim: no placeholders. A plain `string[]` (or an object
  // without `colors`) is all dim. `colors` takes ANSI palette indexes
  // (0–255) or "#rrggbb" and `mode` picks how they spread: "per-line"
  // (default, row r takes colors[r % n]), "per-char" (cell (r, c) takes
  // colors[(r + c) % n], a diagonal flow) or "gradient" (hex stops only,
  // at least two, mixed down the rows). The object form needs
  // `@chatbridge/cli` >= 0.8.2. Omit for the default (name, version, hint).
  banner: {
    lines: [
      "<Vendor> internal assistant",
      "Conversations are not stored by this CLI.",
    ],
    colors: ["#ff5f87", "#ffaf00"],
    mode: "gradient",
  },
  // Optional `{ leadIn?: string; autoSend?: boolean }`: vendor defaults for
  // `!` shell mode in the interactive TUI. `leadIn` is the first line of
  // the message sent with a command's output (default "Please check the
  // execution result."); `autoSend: false` holds the output back until the
  // user's next message. The user's config.json overrides each key.
  shell: { leadIn: "Here is the output of a command I ran:" },
}).run(process.argv);
