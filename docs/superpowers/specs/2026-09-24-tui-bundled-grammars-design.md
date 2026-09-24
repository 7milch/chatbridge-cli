# TUI bundled grammars — design

Milestone 22, issue #129. Since v0.11.2 a fenced code block in the interactive
TUI gets a frame, and per-token colours when its language has a tree-sitter
grammar. OpenTUI 0.5.10 bundles JavaScript, TypeScript, Markdown and Zig only.
This milestone ships six more in `@chatbridge/cli`: **Python, Ruby, JSON,
YAML, Bash, Go**. Target release v0.11.3.

SQL and HCL were wanted too; `tree-sitter-wasms` ships no prebuilt wasm for
them, so they stay out (decided 2026-09-24).

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
- The six grammars' official `highlights.scm` use only `#match?`, `#eq?` and
  `#is-not?`, all handled by web-tree-sitter. No nvim-only predicate.
- `tree-sitter-wasms` 0.1.13 (Unlicense) ships the wasm only, no queries.
- Current `@chatbridge/cli` tarball: 60 KB. The six wasm files total about
  4.3 MB (python 468 KB, ruby 2.0 MB, json 8 KB, yaml 180 KB, bash 1.4 MB,
  go 232 KB).

## Assets

`packages/cli/assets/<lang>/` holds, per language:

- `tree-sitter-<lang>.wasm`, copied from `tree-sitter-wasms@0.1.13`
  (`package/out/`). The package is not a dependency; the files are vendored.
- `highlights.scm`, copied from the grammar repository's
  `queries/highlights.scm` at the commit noted in the file's header comment.
- `LICENSE`, the grammar repository's licence (all six are MIT).

Sources:

| lang | grammar repository |
|---|---|
| python | tree-sitter/tree-sitter-python |
| ruby | tree-sitter/tree-sitter-ruby |
| json | tree-sitter/tree-sitter-json |
| yaml | tree-sitter-grammars/tree-sitter-yaml |
| bash | tree-sitter/tree-sitter-bash |
| go | tree-sitter/tree-sitter-go |

`packages/cli/package.json` `files` gains `"assets"`. tsc is untouched: the
assets are not under `src`, and the code addresses them relative to
`dist/tui/` with `new URL("../../assets/…", import.meta.url)`.

## Registration

New module `packages/cli/src/tui/grammars.ts`:

- `BUNDLED_GRAMMARS`: the six descriptors, `wasm` and `queries.highlights`
  as absolute file paths.
- Aliases: `python` ← `py`, `python3`; `ruby` ← `rb`; `yaml` ← `yml`;
  `bash` ← `sh`, `shell`, `zsh`, `console`; `go` ← `golang`;
  `json` ← `jsonc`, `json5`.
- `registerBundledGrammars()`: calls `addDefaultParsers(BUNDLED_GRAMMARS)`.
  Idempotent by OpenTUI's own filter (same filetype replaces the earlier entry).

`run-interactive.ts` calls `registerBundledGrammars()` once when the TUI
starts, before the first chat view is built. One-shot mode never renders
Markdown in the terminal and is not touched.

## Theme

`markdownSyntaxStyle()` in `packages/cli/src/tui/theme.ts` already styles
`keyword`, `string`, `comment`, `function`, `number`, `constant`, `type`,
`variable.builtin` and their dotted children fall back to the first segment.
The six grammars add these captures that would otherwise render plain:

| scope | style |
|---|---|
| `boolean` | yellow (3), same as `number` / `constant` |
| `escape` | green (2), same as `string` |
| `string.special.key` | blue (4): YAML and JSON keys, so a key reads apart from its value |

`label`, `attribute`, `property`, `variable.parameter`, `operator`,
`punctuation.*` stay on the terminal foreground on purpose.
`function.method.builtin`, `string.special.symbol`, `string.special.regex`
land on their base style through the existing fallback.

## Testing

- `grammars.test.ts`: every descriptor's `wasm` and `highlights` paths exist;
  each wasm starts with the `\0asm` magic; every alias is distinct and maps to
  a listed filetype; no descriptor filetype collides with OpenTUI's bundled
  four.
- One integration test with the real `TreeSitterClient` (not the test
  renderer's mock): after `registerBundledGrammars()`, `highlightOnce` of a
  short Python snippet returns a highlight whose group is `keyword`. This
  proves the worker starts, the wasm loads and the query parses. Skip with a
  clear message if the worker cannot start in CI, but it is expected to run.
- `theme.test.ts`: the three new scopes and their slots.
- `bun run check`; then `bun pm pack` in `packages/cli` and confirm the
  tarball lists the six asset directories and is about 4.4 MB.
- Manual pass: one reply with six fenced blocks (`python`, `rb`, `json`,
  `yml`, `sh`, `go`), each coloured once settled; a YAML key is blue.

## Out of scope

- SQL, HCL/Terraform (no prebuilt wasm); Tera Term macro (no grammar).
- Injections (for example Bash inside YAML).
- A Provider-side API to register grammars.
- The VSCode chat view.
- The upgrade guide: nothing a vendor sees changes; the 0.11.3 entry says so.
