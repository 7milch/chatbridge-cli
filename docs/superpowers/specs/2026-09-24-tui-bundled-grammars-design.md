# TUI bundled grammars — design

Milestone 22, issue #129. Since v0.11.2 a fenced code block in the interactive
TUI gets a frame, and per-token colours when its language has a tree-sitter
grammar. OpenTUI 0.5.10 bundles JavaScript, TypeScript, Markdown and Zig only.
This milestone ships five more in `@chatbridge/cli`: **Python, Ruby, JSON,
Bash, Go**. Target release v0.11.3.

SQL and HCL were wanted too; `tree-sitter-wasms` ships no prebuilt wasm for
them. YAML was wanted and is in the package, but its wasm is built from
`ikatyang/tree-sitter-yaml` 0.5.0 with language ABI 13 and crashes inside
OpenTUI's web-tree-sitter 0.25.10 (`resolved is not a function` from the
external scanner) on any query, verified 2026-09-24; the other five are ABI 14
and work. All three stay out until a usable wasm exists.

## Facts this design rests on (verified in `@opentui/core` 0.5.10)

- `addDefaultParsers([{ filetype, aliases?, queries: { highlights: [path] }, wasm }])`
  (exported from `@opentui/core`) records overrides that
  `TreeSitterClient.registerDefaultParsers` merges with the bundled set when
  the worker initialises. `getTreeSitterClient()` creates the singleton lazily
  on the first `CodeRenderable`, so registering at TUI start-up is early
  enough. A grammar is loaded by the worker on first use, so registration has
  no start-up cost.
- `resolvePath` keeps URLs, and resolves a relative path against the process
  cwd. Paths must therefore be absolute, derived from `import.meta.url`.
- `infoStringToFiletype` lower-cases the first word of the info string and
  returns it unchanged when no table maps it, so aliases such as `py` must be
  declared on the descriptor.
- `tree-sitter-wasms` 0.1.13 (Unlicense) ships the wasm only, no queries, and
  builds them from these grammar versions: python 0.21.0, ruby 0.20.1,
  json 0.20.2, bash 0.20.5, go 0.20.0. The `highlights.scm` must come from
  the matching tag, not `master`, or node names may not exist in the wasm.
- Those tagged queries use only `#match?`, `#eq?` and `#is-not?`, all handled
  by web-tree-sitter. A spike with the real `TreeSitterClient` highlighted all
  five (python: keyword, function, number, comment; json: string.special.key).
- Current `@chatbridge/cli` tarball: 60 KB. The five wasm files total about
  4.1 MB (python 468 KB, ruby 2.0 MB, json 8 KB, bash 1.4 MB, go 232 KB).

## Assets

`packages/cli/assets/<lang>/` holds, per language:

- `tree-sitter-<lang>.wasm`, copied from `tree-sitter-wasms@0.1.13`
  (`package/out/`). The package is not a dependency; the files are vendored.
- `highlights.scm`, copied from the grammar repository's
  `queries/highlights.scm` at the tag below, with a `;` header comment naming
  the repository, tag and licence.
- `LICENSE`, the grammar repository's licence (all five are MIT).

Sources:

| lang | grammar repository | tag |
|---|---|---|
| python | tree-sitter/tree-sitter-python | v0.21.0 |
| ruby | tree-sitter/tree-sitter-ruby | v0.20.1 |
| json | tree-sitter/tree-sitter-json | v0.20.2 |
| bash | tree-sitter/tree-sitter-bash | v0.20.5 |
| go | tree-sitter/tree-sitter-go | v0.20.0 |

`packages/cli/package.json` `files` gains `"assets"`. tsc is untouched: the
assets are not under `src`, and the code addresses them relative to
`dist/tui/` with `new URL("../../assets/…", import.meta.url)`.

## Registration

New module `packages/cli/src/tui/grammars.ts`:

- `bundledGrammars()`: the five descriptors, `wasm` and `queries.highlights`
  as absolute file paths derived from `import.meta.url`.
- Aliases: `python` ← `py`, `python3`; `ruby` ← `rb`;
  `bash` ← `sh`, `shell`, `zsh`, `console`; `go` ← `golang`;
  `json` ← `jsonc`, `json5`.
- `registerBundledGrammars()`: calls `addDefaultParsers(bundledGrammars())`.
  Idempotent by OpenTUI's own filter (same filetype replaces the earlier entry).

`run-interactive.ts` calls `registerBundledGrammars()` once when the TUI
starts, before the first chat view is built. One-shot mode never renders
Markdown in the terminal and is not touched.

## Theme

`markdownSyntaxStyle()` in `packages/cli/src/tui/theme.ts` already styles
`keyword`, `string`, `comment`, `function`, `number`, `constant`, `type`,
`variable.builtin` and their dotted children fall back to the first segment.
The five grammars add these captures that would otherwise render plain:

| scope | style |
|---|---|
| `escape` | green (2), same as `string` |
| `string.special.key` | blue (4): JSON keys, so a key reads apart from its value |

`label`, `attribute`, `property`, `variable.parameter`, `operator`,
`punctuation.*` stay on the terminal foreground on purpose.
`function.method.builtin`, `string.special.symbol`, `string.special.regex`
land on their base style through the existing fallback.

## Testing

- `grammars.test.ts`: every descriptor's `wasm` and `highlights` paths exist;
  each wasm starts with the `\0asm` magic; every alias is distinct and never
  one of OpenTUI's bundled four filetypes.
- `grammars.integration.test.ts` with the real `TreeSitterClient` (not the
  test renderer's mock): after `registerBundledGrammars()`, `highlightOnce`
  over a short snippet per language (through an alias where one exists)
  returns the expected groups. This proves the worker starts, each wasm loads
  and each query parses.
- `theme.test.ts`: the two new scopes and their slots.
- `bun run check`; then `bun pm pack` in `packages/cli` and confirm the
  tarball lists the five asset directories and is about 4.2 MB.
- Manual pass: one reply with five fenced blocks (`python`, `rb`, `json`,
  `sh`, `go`), each coloured once settled; a JSON key is blue.

## Out of scope

- SQL, HCL/Terraform (no prebuilt wasm); YAML (wasm ABI 13 crashes); Tera
  Term macro (no grammar).
- Injections (for example Bash inside Markdown).
- A Provider-side API to register grammars.
- The VSCode chat view.
- The upgrade guide: nothing a vendor sees changes; the 0.11.3 entry says so.
