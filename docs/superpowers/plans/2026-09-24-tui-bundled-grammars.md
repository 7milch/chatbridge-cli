# TUI Bundled Grammars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fenced `python`, `ruby`, `json`, `bash` and `go` blocks in the
interactive TUI get per-token colours, by shipping those five tree-sitter
grammars in `@chatbridge/cli` (#129).

**Architecture:** Five grammar directories are vendored under
`packages/cli/assets/<lang>/` (wasm from `tree-sitter-wasms@0.1.13`, the
grammar's own `highlights.scm` at the tag matching that wasm, its LICENSE).
A new `packages/cli/src/tui/grammars.ts` builds OpenTUI `FiletypeParserOptions`
descriptors with absolute paths and registers them through
`addDefaultParsers`; `run-interactive.ts` calls that once at TUI start-up.
`theme.ts` gains the two scopes those grammars emit that the theme cannot
reach by fallback. Nothing outside `packages/cli` changes.

**Tech Stack:** TypeScript, Bun test runner, `@opentui/core` 0.5.10
(`addDefaultParsers`, `TreeSitterClient`, `getDataPaths`,
`FiletypeParserOptions`, all exported from the package root), curl + npm pack
for the one-time asset fetch.

**Spec:** `docs/superpowers/specs/2026-09-24-tui-bundled-grammars-design.md`

## Global Constraints

- Branch `issue-129`. Tracking issue #129. Commit messages in English, ending
  with the attribution lines the session provides. Comments in English.
- `bun run check` must pass before every commit (lint + build + all tests).
- Languages: exactly `python`, `ruby`, `json`, `bash`, `go`. YAML, SQL and
  HCL stay out (spec says why).
- wasm source: `tree-sitter-wasms@0.1.13` (`package/out/tree-sitter-<lang>.wasm`).
  Query and LICENSE source, per language, at the **tag** matching the wasm:
  python `tree-sitter/tree-sitter-python` `v0.21.0`; ruby
  `tree-sitter/tree-sitter-ruby` `v0.20.1`; json `tree-sitter/tree-sitter-json`
  `v0.20.2`; bash `tree-sitter/tree-sitter-bash` `v0.20.5`; go
  `tree-sitter/tree-sitter-go` `v0.20.0`. Never `master`.
- Aliases: `python` ← `py`, `python3`; `ruby` ← `rb`; `bash` ← `sh`,
  `shell`, `zsh`, `console`; `go` ← `golang`; `json` ← `jsonc`, `json5`.
- Paths handed to OpenTUI must be absolute (a relative path resolves against
  the process cwd). Derive them from `import.meta.url`; `dist/tui/` and
  `src/tui/` are both two levels below `packages/cli/`, so
  `new URL("../../assets/", import.meta.url)` works in tests and in dist.
- Colours are ANSI indices via `RGBA.fromIndex(n)`: green 2, blue 4.
- `packages/cli/package.json` `files` must list `assets`.
- After each commit, `gh issue comment 129` (English) with what landed and
  "What's next".

---

### Task 1: Vendor the five grammars and describe them in `grammars.ts`

**Files:**
- Create: `packages/cli/assets/{python,ruby,json,bash,go}/tree-sitter-<lang>.wasm`
- Create: `packages/cli/assets/{python,ruby,json,bash,go}/highlights.scm`
- Create: `packages/cli/assets/{python,ruby,json,bash,go}/LICENSE`
- Create: `packages/cli/src/tui/grammars.ts`
- Modify: `packages/cli/package.json` (`files`, line 26)
- Test: `packages/cli/src/tui/grammars.test.ts`

**Interfaces:**
- Consumes: `addDefaultParsers`, `FiletypeParserOptions` from `@opentui/core`.
- Produces: `BUNDLED_LANGUAGES: readonly ["python","ruby","json","bash","go"]`,
  `bundledGrammars(): FiletypeParserOptions[]`,
  `registerBundledGrammars(): void`. Task 2 calls `registerBundledGrammars()`
  and the integration test uses `bundledGrammars()` only indirectly.

- [ ] **Step 1: Fetch the assets**

Run from the repository root. The scratch directory is outside the repo.

```bash
set -e
ROOT=$(pwd)
TMP=$(mktemp -d)
cd "$TMP"
npm pack tree-sitter-wasms@0.1.13 --quiet
tar xzf tree-sitter-wasms-0.1.13.tgz
cd "$ROOT"
fetch() { # lang repo tag
  d="packages/cli/assets/$1"; mkdir -p "$d"
  cp "$TMP/package/out/tree-sitter-$1.wasm" "$d/"
  curl -sSfL "https://raw.githubusercontent.com/$2/$3/LICENSE" -o "$d/LICENSE"
  {
    echo "; Vendored from https://github.com/$2 at $3 (queries/highlights.scm), MIT."
    echo "; The wasm next to it is tree-sitter-wasms@0.1.13's build of the same grammar version."
    curl -sSfL "https://raw.githubusercontent.com/$2/$3/queries/highlights.scm"
  } > "$d/highlights.scm"
}
fetch python tree-sitter/tree-sitter-python v0.21.0
fetch ruby   tree-sitter/tree-sitter-ruby   v0.20.1
fetch json   tree-sitter/tree-sitter-json   v0.20.2
fetch bash   tree-sitter/tree-sitter-bash   v0.20.5
fetch go     tree-sitter/tree-sitter-go     v0.20.0
ls -la packages/cli/assets/*/
head -c 4 packages/cli/assets/python/tree-sitter-python.wasm | xxd
```

Expected: five directories with three files each; the `xxd` line shows
`0000 6173 6d` (`\0asm`). Approximate wasm sizes: python 468 KB, ruby 2.0 MB,
json 8 KB, bash 1.4 MB, go 232 KB. Every LICENSE should say MIT.

- [ ] **Step 2: Add `assets` to the package files**

In `packages/cli/package.json` change

```json
  "files": ["dist", "README.md", "LICENSE"],
```

to

```json
  "files": ["dist", "assets", "README.md", "LICENSE"],
```

- [ ] **Step 3: Write the failing test**

Create `packages/cli/src/tui/grammars.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { BUNDLED_LANGUAGES, bundledGrammars } from "./grammars.js";

// The four filetypes OpenTUI 0.5.10 bundles itself; an alias on one of
// them would silently replace the built-in grammar.
const OPENTUI_BUNDLED = ["javascript", "typescript", "markdown", "zig"];

describe("bundledGrammars", () => {
  test("describes exactly the five languages, in order", () => {
    expect(bundledGrammars().map((g) => g.filetype)).toEqual([
      ...BUNDLED_LANGUAGES,
    ]);
    expect([...BUNDLED_LANGUAGES]).toEqual([
      "python",
      "ruby",
      "json",
      "bash",
      "go",
    ]);
  });

  test.each(bundledGrammars().map((g) => [g.filetype, g] as const))(
    "%s: absolute paths to an existing wasm and a non-empty query",
    (_name, g) => {
      expect(isAbsolute(g.wasm)).toBe(true);
      expect(existsSync(g.wasm)).toBe(true);
      const magic = readFileSync(g.wasm).subarray(0, 4);
      expect([...magic]).toEqual([0x00, 0x61, 0x73, 0x6d]);
      expect(g.queries.highlights).toHaveLength(1);
      const query = g.queries.highlights[0] ?? "";
      expect(isAbsolute(query)).toBe(true);
      expect(readFileSync(query, "utf8").trim().length).toBeGreaterThan(0);
    },
  );

  test("aliases match the spec", () => {
    const aliases = Object.fromEntries(
      bundledGrammars().map((g) => [g.filetype, g.aliases]),
    );
    expect(aliases).toEqual({
      python: ["py", "python3"],
      ruby: ["rb"],
      json: ["jsonc", "json5"],
      bash: ["sh", "shell", "zsh", "console"],
      go: ["golang"],
    });
  });

  test("filetypes and aliases are unique and never an OpenTUI built-in", () => {
    const all = bundledGrammars().flatMap((g) => [
      g.filetype,
      ...(g.aliases ?? []),
    ]);
    expect(new Set(all).size).toBe(all.length);
    for (const reserved of OPENTUI_BUNDLED) expect(all).not.toContain(reserved);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun test packages/cli/src/tui/grammars.test.ts`
Expected: fails to import `./grammars.js` (module not found).

- [ ] **Step 5: Write `grammars.ts`**

Create `packages/cli/src/tui/grammars.ts`:

```ts
import { addDefaultParsers, type FiletypeParserOptions } from "@opentui/core";
import { fileURLToPath } from "node:url";

/** Grammars this package ships on top of the four OpenTUI (0.5.10) bundles
 * (javascript, typescript, markdown, zig). Each lives in
 * `packages/cli/assets/<lang>/`: the wasm from tree-sitter-wasms@0.1.13, the
 * grammar's own highlights.scm at the tag that wasm was built from, and its
 * LICENSE. YAML is not here: the only prebuilt wasm is language ABI 13 and
 * crashes in OpenTUI's web-tree-sitter. */
export const BUNDLED_LANGUAGES = [
  "python",
  "ruby",
  "json",
  "bash",
  "go",
] as const;

export type BundledLanguage = (typeof BUNDLED_LANGUAGES)[number];

/** Info-string names that map onto a bundled filetype. OpenTUI's
 * `infoStringToFiletype` returns an unknown name unchanged, so every alias
 * has to be declared here. */
const ALIASES: Record<BundledLanguage, string[]> = {
  python: ["py", "python3"],
  ruby: ["rb"],
  json: ["jsonc", "json5"],
  bash: ["sh", "shell", "zsh", "console"],
  go: ["golang"],
};

// `src/tui/` and `dist/tui/` both sit two levels below `packages/cli/`, so
// this resolves to `packages/cli/assets/` from the test runner and from the
// published package alike.
const ASSETS = new URL("../../assets/", import.meta.url);

function assetPath(lang: BundledLanguage, file: string): string {
  return fileURLToPath(new URL(`${lang}/${file}`, ASSETS));
}

/** The descriptors OpenTUI needs, with absolute paths: a relative path would
 * be resolved against the process cwd. */
export function bundledGrammars(): FiletypeParserOptions[] {
  return BUNDLED_LANGUAGES.map((filetype) => ({
    filetype,
    aliases: ALIASES[filetype],
    queries: { highlights: [assetPath(filetype, "highlights.scm")] },
    wasm: assetPath(filetype, `tree-sitter-${filetype}.wasm`),
  }));
}

/** Registers the bundled grammars with OpenTUI's tree-sitter client. Must run
 * before the first CodeRenderable creates the client; the worker then loads a
 * grammar lazily the first time a block names it. Calling it twice is
 * harmless: OpenTUI replaces an override with the same filetype. */
export function registerBundledGrammars(): void {
  addDefaultParsers(bundledGrammars());
}
```

If `FiletypeParserOptions` is not exported from `@opentui/core`'s root
(`lib/index.d.ts` re-exports `./tree-sitter/index.js`, so it should be), use
`Parameters<typeof addDefaultParsers>[0][number]` in its place.

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test packages/cli/src/tui/grammars.test.ts`
Expected: all tests pass.

- [ ] **Step 7: Full check and commit**

Run: `bun run check`. Biome does not parse `.scm`, `.wasm` or `LICENSE`, so
the assets need no ignore entry; if Biome does complain about a file under
`assets/`, add `"packages/cli/assets"` to `files.ignore` in the root
`biome.json` and say so in the report.

```bash
git add packages/cli/assets packages/cli/package.json packages/cli/src/tui/grammars.ts packages/cli/src/tui/grammars.test.ts
git commit -m "feat: ship Python, Ruby, JSON, Bash and Go tree-sitter grammars in @chatbridge/cli (Refs #129)"
```

Then `gh issue comment 129`: assets and descriptors landed; what's next is
registration, theme scopes and the worker integration test (Task 2).

---

### Task 2: Register at TUI start-up, theme scopes, worker integration test

**Files:**
- Modify: `packages/cli/src/tui/run-interactive.ts` (imports at top; the
  start of `runInteractive`, line 159 onward)
- Modify: `packages/cli/src/tui/theme.ts` (`markdownSyntaxStyle`)
- Test: `packages/cli/src/tui/theme.test.ts` (describe `markdownSyntaxStyle`)
- Test: `packages/cli/src/tui/grammars.integration.test.ts` (new)

**Interfaces:**
- Consumes: `registerBundledGrammars()` from Task 1; `TreeSitterClient`,
  `getDataPaths` from `@opentui/core`.
- Produces: nothing new; `markdownSyntaxStyle()` keeps its signature.

- [ ] **Step 1: Write the failing theme test**

In `packages/cli/src/tui/theme.test.ts`, inside
`describe("markdownSyntaxStyle", ...)`, add after the
"registers the code scopes the bundled JS and TS grammars emit" test:

```ts
  // Captures the five grammars shipped in packages/cli/assets emit that
  // neither the theme nor the first-segment fallback would style: `escape`
  // has no base, and `string.special.key` (a JSON key) should not read as
  // an ordinary string.
  test("registers the scopes the shipped grammars add", () => {
    const style = markdownSyntaxStyle();
    try {
      expect(style.getStyle("escape")?.fg?.intent).toBe("indexed");
      expect(style.getStyle("escape")?.fg?.slot).toBe(2);
      expect(style.getStyle("string.special.key")?.fg?.intent).toBe("indexed");
      expect(style.getStyle("string.special.key")?.fg?.slot).toBe(4);
    } finally {
      style.destroy();
    }
  });
```

- [ ] **Step 2: Write the failing integration test**

Create `packages/cli/src/tui/grammars.integration.test.ts`:

```ts
import { afterAll, expect, test } from "bun:test";
import { TreeSitterClient, getDataPaths } from "@opentui/core";
import { registerBundledGrammars } from "./grammars.js";

// The real worker, not the test renderer's MockTreeSitterClient: this is the
// only test that proves each wasm loads in OpenTUI's web-tree-sitter and
// each highlights.scm compiles against it. A grammar from the wrong tag, or
// an ABI 13 wasm (see the YAML note in grammars.ts), fails here.
registerBundledGrammars();
const client = new TreeSitterClient({
  dataPath: getDataPaths().globalDataPath,
});

afterAll(async () => {
  await client.destroy();
});

async function groups(source: string, filetype: string): Promise<Set<string>> {
  const result = await client.highlightOnce(source, filetype);
  if (result.error) throw new Error(`${filetype}: ${result.error}`);
  return new Set((result.highlights ?? []).map((h) => h[2]));
}

test.each([
  [
    "python",
    "def f(x):\n  return x + 1  # hi\n",
    ["keyword", "function", "number", "comment"],
  ],
  ["rb", "def f(x)\n  x + 1\nend\n", ["keyword", "function.method", "number"]],
  [
    "json",
    '{"a": 1, "b": true}\n',
    ["string.special.key", "number", "constant.builtin"],
  ],
  [
    "sh",
    'if [ -f "$f" ]; then\n  echo "hi $f" # c\nfi\n',
    ["keyword", "string", "comment"],
  ],
  ["go", "func main() { return }\n", ["keyword", "function"]],
] as const)(
  "%s highlights through the real worker",
  async (filetype, source, expected) => {
    const got = await groups(source, filetype);
    for (const group of expected) expect(got).toContain(group);
  },
  20_000,
);
```

The `rb` and `sh` rows go through aliases on purpose.

- [ ] **Step 3: Run both tests to verify they fail**

Run: `bun test packages/cli/src/tui/theme.test.ts packages/cli/src/tui/grammars.integration.test.ts`
Expected: the theme test fails on `escape` (`undefined`); the integration
test passes already if Task 1's assets are correct (it exercises Task 1, not
this task's wiring) — that is fine, note it in the report. If it fails, the
failure names the language and the worker error; fix the asset before going
on, do not weaken the test.

- [ ] **Step 4: Add the scopes to the theme**

In `packages/cli/src/tui/theme.ts`, inside `markdownSyntaxStyle()`, add to the
object passed to `SyntaxStyle.fromStyles`, after `"constant.builtin": literal,`:

```ts
    // From the grammars shipped in packages/cli/assets: an escape sequence
    // inside a string, and a JSON object key.
    escape: string,
    "string.special.key": { fg: RGBA.fromIndex(ANSI.blue) },
```

(`string` is the local `{ fg: RGBA.fromIndex(ANSI.green) }` already defined
in that function.) Extend the doc comment's sentence about bundled grammars
to say the package also ships Python, Ruby, JSON, Bash and Go (see
`grammars.ts`).

- [ ] **Step 5: Register at TUI start-up**

In `packages/cli/src/tui/run-interactive.ts` add the import next to the other
`./` imports:

```ts
import { registerBundledGrammars } from "./grammars.js";
```

and as the first statement of `runInteractive`, before the progress buffer
setup:

```ts
  // Before any Markdown body exists: the first CodeRenderable creates the
  // tree-sitter client, which reads the registered grammars once.
  registerBundledGrammars();
```

One-shot mode never reaches this function and is unchanged.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test packages/cli/src/tui/theme.test.ts packages/cli/src/tui/grammars.integration.test.ts packages/cli/src/tui/run-interactive.test.ts`
Expected: all pass; the run-interactive tests still pass with the extra
call (it only records overrides).

- [ ] **Step 7: Full check and commit**

Run: `bun run check`.

```bash
git add packages/cli/src/tui/run-interactive.ts packages/cli/src/tui/theme.ts packages/cli/src/tui/theme.test.ts packages/cli/src/tui/grammars.integration.test.ts
git commit -m "feat: TUI registers the shipped grammars at start-up and colours escapes and JSON keys (Refs #129)"
```

Then `gh issue comment 129`: registration, theme scopes and the worker test
landed; what's next is the tarball check, the manual pass and the PR (Task 3).

---

### Task 3: Tarball check, manual pass, pull request

**Files:**
- None modified unless a check finds a defect.

- [ ] **Step 1: Check the published tarball**

```bash
cd packages/cli && bun pm pack --destination /tmp --quiet && cd ../..
tar tzf /tmp/chatbridge-cli-0.11.2.tgz | grep '^package/assets/' | sort
du -h /tmp/chatbridge-cli-0.11.2.tgz
```

Expected: fifteen asset paths (five languages × wasm, highlights.scm,
LICENSE); size about 4.2 MB (was 60 KB). If the assets are missing, `files`
in `packages/cli/package.json` is wrong.

- [ ] **Step 2: Manual pass**

In a vendor CLI on this build (the Rakuten AI repo via the preview-tarball
procedure in the memory note, or the dummy provider), ask for one reply with
five fenced blocks: ` ```python `, ` ```rb `, ` ```json `, ` ```sh `, ` ```go `.
Once the reply settles every block is framed and coloured: `def` / `func` /
`if` in magenta, strings green, comments dim italic, a JSON key blue. A
` ```yaml ` block stays plain inside its frame. Record the outcome in the
issue comment.

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base main --head issue-129 --label enhancement \
  --title "Python, Ruby, JSON, Bash and Go fenced blocks in the interactive TUI get syntax colours" \
  --body "$(cat <<'EOF'
Closes #129

OpenTUI 0.5.10 bundles JavaScript, TypeScript, Markdown and Zig grammars only, so every other fenced block was plain text inside its frame. `@chatbridge/cli` now ships five more grammars under `assets/<lang>/` (wasm from `tree-sitter-wasms@0.1.13`, the grammar's own `highlights.scm` at the matching tag, its MIT LICENSE) and registers them at TUI start-up. Info-string aliases such as `py`, `rb`, `sh`, `golang` map onto them. The theme colours escape sequences and JSON keys.

YAML was wanted too but the only prebuilt wasm is language ABI 13 and crashes in OpenTUI's web-tree-sitter; SQL and HCL have no prebuilt wasm. The spec records this.

Package size: the cli tarball grows from 60 KB to about 4.2 MB; grammars load lazily on first use.

Nothing a vendor sees changes, so no upgrade-guide entry.

Spec: `docs/superpowers/specs/2026-09-24-tui-bundled-grammars-design.md`
Plan: `docs/superpowers/plans/2026-09-24-tui-bundled-grammars.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01N2sTvTiiLqaLj8W8KDd4Qf
EOF
)"
```

- [ ] **Step 4: Sync the issue**

`gh issue comment 129` with the PR link and "What's next: whole-branch
review, merge, release v0.11.3".
