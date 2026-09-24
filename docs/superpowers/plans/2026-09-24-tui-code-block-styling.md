# TUI Code Block Styling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fenced code block in the interactive TUI gets a muted left-border
frame once the reply has settled, and per-token ANSI colours when its language
has a bundled grammar (#127).

**Architecture:** Two one-file changes in `packages/cli/src/tui/`, each with its
test. Task 1 adds the code scopes the bundled JavaScript and TypeScript
tree-sitter grammars emit to `markdownSyntaxStyle()` in `theme.ts`. Task 2
extends the `renderNode` hook in `text.ts`'s `markdown()` so a `CodeRenderable`
is wrapped in a bordered `BoxRenderable` only while the MarkdownRenderable is
not streaming. Nothing outside `packages/cli` changes.

**Tech Stack:** TypeScript, Bun test runner, `@opentui/core` 0.5.10
(`SyntaxStyle`, `MarkdownRenderable`, `CodeRenderable`, `BoxRenderable`,
`createTestRenderer` from `@opentui/core/testing`).

**Spec:** `docs/superpowers/specs/2026-09-24-tui-code-block-styling-design.md`

## Global Constraints

- Branch `issue-127`. Tracking issue #127. Commit messages in English, ending
  with the attribution lines the session provides.
- `bun run check` must pass before every commit (lint + build + all tests).
- Every colour is an ANSI palette index via `RGBA.fromIndex(n)`; never a fixed
  truecolour value. Existing indices in `theme.ts`: red 1, green 2, yellow 3,
  blue 4, bright black 8, bright white 15. This plan adds magenta 5 and cyan 6.
- `SyntaxStyle.getStyle` falls back only to the first dot segment of a scope
  (`string.special` → `string`), so a multi-segment scope that needs a style
  distinct from its base must be registered exactly.
- Run one package's tests with `bun test packages/cli`.
- After each commit, post a comment to issue #127 (in English) with what
  landed and "What's next".

---

### Task 1: Code scopes in `markdownSyntaxStyle()`

**Files:**
- Modify: `packages/cli/src/tui/theme.ts` (the `ANSI` table around line 18,
  the `markdownSyntaxStyle` doc comment and body around lines 72–100)
- Test: `packages/cli/src/tui/theme.test.ts` (the `markdownSyntaxStyle`
  describe blocks)

**Interfaces:**
- Consumes: `SyntaxStyle.fromStyles`, `RGBA.fromIndex`, `DEFAULT_FG`,
  `MUTED_COLOR` — all already in `theme.ts`.
- Produces: `markdownSyntaxStyle(): SyntaxStyle` (unchanged signature) that
  also styles `keyword`, `string`, `string.special`, `comment`, `function`,
  `function.method`, `function.builtin`, `constructor`, `number`, `constant`,
  `constant.builtin`, `type`, `variable.builtin`.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/tui/theme.test.ts`, replace the whole
`describe("markdownSyntaxStyle", ...)` block with the following. The first
test keeps its markup list; the comment is corrected (fenced code does not go
through `markup.raw.block`) and two tests for the code scopes are added.

```ts
describe("markdownSyntaxStyle", () => {
  // These are the capture names @opentui/core's bundled tree-sitter query
  // (assets/markdown/highlights.scm, plus markdown_inline) emits, not the
  // names the theme happens to define. The style lookup only falls back to
  // the first dot segment, so a missing exact key renders as plain text.
  // The list is the scopes the theme styles, not every capture the grammar
  // has: link URLs, task markers and strikethrough fall back to `default` on
  // purpose. `markup.raw.block` covers code the markdown grammar highlights
  // itself (indented code, blockquote content); a fenced block is its own
  // CodeRenderable highlighted by the language grammar, see the code scopes
  // below.
  test("registers the markup scopes the bundled grammar emits for the styled constructs", () => {
    const style = markdownSyntaxStyle();
    try {
      for (const scope of [
        "markup.heading.1",
        "markup.heading.2",
        "markup.heading.3",
        "markup.heading.4",
        "markup.heading.5",
        "markup.heading.6",
        "markup.heading",
        "markup.strong",
        "markup.italic",
        "markup.raw",
        "markup.raw.block",
        "markup.link",
        "markup.list",
        "markup.quote",
      ]) {
        expect(style.getStyle(scope)).toBeDefined();
      }
    } finally {
      style.destroy();
    }
  });

  // The capture names assets/javascript/highlights.scm and
  // assets/typescript/highlights.scm emit for a fenced block whose info
  // string names a bundled grammar. Scopes left out (`property`, `variable`,
  // `operator`, `punctuation.*`, `embedded`) fall to `default` on purpose.
  test("registers the code scopes the bundled JS and TS grammars emit", () => {
    const style = markdownSyntaxStyle();
    try {
      for (const scope of [
        "keyword",
        "string",
        "string.special",
        "comment",
        "function",
        "function.method",
        "function.builtin",
        "constructor",
        "number",
        "constant",
        "constant.builtin",
        "type",
        "variable.builtin",
      ]) {
        expect(style.getStyle(scope)).toBeDefined();
      }
    } finally {
      style.destroy();
    }
  });

  test("code scope colours come from the ANSI palette", () => {
    const style = markdownSyntaxStyle();
    try {
      const slot = (scope: string) => {
        const s = style.getStyle(scope);
        expect(s?.fg?.intent).toBe("indexed");
        return s?.fg?.slot;
      };
      expect(slot("keyword")).toBe(5);
      expect(slot("string")).toBe(2);
      expect(slot("string.special")).toBe(2);
      expect(slot("comment")).toBe(8);
      expect(style.getStyle("comment")?.italic).toBe(true);
      expect(slot("function")).toBe(4);
      expect(slot("function.method")).toBe(4);
      expect(slot("function.builtin")).toBe(4);
      expect(slot("constructor")).toBe(4);
      expect(slot("number")).toBe(3);
      expect(slot("constant")).toBe(3);
      expect(slot("constant.builtin")).toBe(3);
      expect(slot("type")).toBe(6);
      expect(slot("variable.builtin")).toBe(6);
      // Left to the terminal foreground on purpose.
      expect(style.getStyle("property")).toBeUndefined();
      expect(style.getStyle("operator")).toBeUndefined();
    } finally {
      style.destroy();
    }
  });

  test("colours come from the ANSI palette, not fixed truecolour", () => {
    const style = markdownSyntaxStyle();
    try {
      const heading = style.getStyle("markup.heading");
      expect(heading?.bold).toBe(true);
      expect(heading?.fg?.intent).toBe("indexed");
      expect(heading?.fg?.slot).toBe(2);
      expect(style.getStyle("markup.raw")?.fg?.slot).toBe(3);
      expect(style.getStyle("markup.heading.1")?.bold).toBe(true);
      expect(style.getStyle("markup.heading.1")?.fg?.slot).toBe(2);
      expect(style.getStyle("markup.raw.block")?.fg?.slot).toBe(3);
      const link = style.getStyle("markup.link");
      expect(link?.fg?.slot).toBe(4);
      expect(link?.underline).toBe(true);
      expect(style.getStyle("markup.italic")?.italic).toBe(true);
      expect(style.getStyle("markup.list")?.fg?.slot).toBe(MUTED_COLOR.slot);
    } finally {
      style.destroy();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/tui/theme.test.ts`
Expected: the two new tests fail. "registers the code scopes" fails on
`expect(style.getStyle("keyword")).toBeDefined()`; "code scope colours" fails
on `expect(s?.fg?.intent).toBe("indexed")` receiving `undefined`.

- [ ] **Step 3: Add the colours and scopes to `theme.ts`**

Extend the `ANSI` table:

```ts
const ANSI = {
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  brightBlack: 8,
  brightWhite: 15,
} as const;
```

Replace the doc comment and body of `markdownSyntaxStyle` with:

```ts
/** Styles for MarkdownRenderable, from the same ANSI indices as `theme`, so
 * a reply looks like the rest of the history in any terminal palette. The
 * lookup falls back only to the first dot segment, so every multi-segment
 * scope that needs a style is registered exactly.
 *
 * Markup scopes are the captures the bundled tree-sitter markdown query
 * emits (0.5.10): headings per level, `markup.raw.block` for code the
 * markdown grammar highlights itself (indented code, blockquote content),
 * `markup.heading` for pipe-table header cells and `markup.raw` for inline
 * code.
 *
 * A fenced block is not markup: MarkdownRenderable turns it into its own
 * CodeRenderable whose filetype is the info string, so the JavaScript and
 * TypeScript grammars bundled with OpenTUI emit the code scopes below. A
 * block with no language, or one whose language has no bundled grammar, is
 * not highlighted at all and the frame `text.ts` adds sets it apart. Scopes
 * not listed (`property`, `variable`, `operator`, `punctuation.*`) stay on
 * the terminal foreground.
 *
 * A style it does not find falls back to `default`, set here to the terminal
 * foreground. The caller owns the returned handle and must `destroy()` it. */
export function markdownSyntaxStyle(): SyntaxStyle {
  const heading = { fg: RGBA.fromIndex(ANSI.green), bold: true };
  const raw = { fg: RGBA.fromIndex(ANSI.yellow) };
  const keyword = { fg: RGBA.fromIndex(ANSI.magenta) };
  const string = { fg: RGBA.fromIndex(ANSI.green) };
  const comment = { fg: MUTED_COLOR, italic: true };
  const fn = { fg: RGBA.fromIndex(ANSI.blue) };
  const literal = { fg: RGBA.fromIndex(ANSI.yellow) };
  const type = { fg: RGBA.fromIndex(ANSI.cyan) };
  return SyntaxStyle.fromStyles({
    default: { fg: DEFAULT_FG },
    "markup.heading": heading,
    "markup.heading.1": heading,
    "markup.heading.2": heading,
    "markup.heading.3": heading,
    "markup.heading.4": heading,
    "markup.heading.5": heading,
    "markup.heading.6": heading,
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.raw": raw,
    "markup.raw.block": raw,
    "markup.link": { fg: RGBA.fromIndex(ANSI.blue), underline: true },
    "markup.list": { fg: MUTED_COLOR },
    "markup.quote": { fg: MUTED_COLOR, italic: true },
    keyword,
    string,
    "string.special": string,
    comment,
    function: fn,
    "function.method": fn,
    "function.builtin": fn,
    constructor: fn,
    number: literal,
    constant: literal,
    "constant.builtin": literal,
    type,
    "variable.builtin": type,
  });
}
```

Note `constructor` as an object key: it is a plain string key here, and
`SyntaxStyle.fromStyles` iterates the object's own entries, so it is safe.
Biome may flag `function` or `constructor` as keys; if so, quote them
(`"function": fn`, `"constructor": fn`) — the test looks them up by string.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/tui/theme.test.ts`
Expected: all tests in the file pass.

- [ ] **Step 5: Full check and commit**

Run: `bun run check`
Expected: lint, build and all tests pass.

```bash
git add packages/cli/src/tui/theme.ts packages/cli/src/tui/theme.test.ts
git commit -m "feat: TUI theme colours the code scopes of bundled grammars in fenced blocks (Refs #127)"
```

Then `gh issue comment 127` (English): the code scopes landed; what's next is
the frame in `text.ts` (Task 2).

---

### Task 2: Frame a settled code block in `markdown()`

**Files:**
- Modify: `packages/cli/src/tui/text.ts` (imports at the top and the
  `markdown()` function, lines 40–62)
- Test: `packages/cli/src/tui/text.test.ts`

**Interfaces:**
- Consumes: `markdownSyntaxStyle()` from Task 1 (only in the test);
  `MUTED_COLOR`, `SELECTION_BG`, `SELECTION_FG` from `theme.ts`.
- Produces: `markdown(ctx, options): MarkdownRenderable` (unchanged
  signature). While `streaming` is true a code block is a bare
  `CodeRenderable`; once `streaming` is false it is a `BoxRenderable` with a
  left border in `MUTED_COLOR` and `paddingLeft: 1`, whose only child is the
  `CodeRenderable` carrying `selectionBg` / `selectionFg`.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/src/tui/text.test.ts`. Add the imports at the top of
the file next to the existing ones:

```ts
import { afterEach } from "bun:test";
import { BoxRenderable, CodeRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { markdown } from "./text.js";
import {
  MUTED_COLOR,
  SELECTION_BG,
  SELECTION_FG,
  markdownSyntaxStyle,
} from "./theme.js";
```

(Merge with the existing `import { expect, test } from "bun:test"` and
`import { adoptTerminalCursor } from "./text.js"` lines rather than
duplicating them.)

Then the test body:

```ts
let teardown: (() => void) | undefined;
afterEach(() => {
  teardown?.();
  teardown = undefined;
});

const FENCED = "before\n\n```javascript\nconst x = 1;\n```\n\nafter\n";

/** A Markdown body over one fenced block, as chat-view builds a reply. */
async function fencedBody(streaming: boolean) {
  const t = await createTestRenderer({ width: 40, height: 12 });
  const style = markdownSyntaxStyle();
  const body = markdown(t.renderer, {
    content: FENCED,
    syntaxStyle: style,
    conceal: true,
    streaming,
  });
  t.renderer.root.add(body);
  teardown = () => {
    body.destroy();
    style.destroy();
    t.renderer.destroy();
  };
  await t.renderOnce();
  return body;
}

/** The block MarkdownRenderable built for the fenced code: the child that
 * is either a CodeRenderable or a Box holding one. */
function codeBlockOf(body: { getChildren(): unknown[] }) {
  const blocks = body.getChildren();
  const hit = blocks.find(
    (b) =>
      b instanceof CodeRenderable ||
      (b instanceof BoxRenderable &&
        b.getChildren().some((c) => c instanceof CodeRenderable)),
  );
  if (!hit) throw new Error("no code block among the Markdown blocks");
  return hit;
}

test("a streaming code block stays a bare CodeRenderable with selection colours", async () => {
  const body = await fencedBody(true);
  const block = codeBlockOf(body);
  expect(block).toBeInstanceOf(CodeRenderable);
  expect((block as CodeRenderable).selectionBg).toBe(SELECTION_BG);
  expect((block as CodeRenderable).selectionFg).toBe(SELECTION_FG);
});

test("a settled code block is framed by a muted left border", async () => {
  const body = await fencedBody(true);
  body.streaming = false;
  const block = codeBlockOf(body);
  expect(block).toBeInstanceOf(BoxRenderable);
  const box = block as BoxRenderable;
  expect(box.border).toEqual(["left"]);
  expect(box.borderColor).toBe(MUTED_COLOR);
  expect(box.paddingLeft).toBe(1);
  const inner = box.getChildren();
  expect(inner).toHaveLength(1);
  expect(inner[0]).toBeInstanceOf(CodeRenderable);
  expect((inner[0] as CodeRenderable).selectionBg).toBe(SELECTION_BG);
  expect((inner[0] as CodeRenderable).selectionFg).toBe(SELECTION_FG);
});

test("a body built already settled frames its code block at once", async () => {
  const body = await fencedBody(false);
  expect(codeBlockOf(body)).toBeInstanceOf(BoxRenderable);
});
```

If `box.borderColor` comes back as a parsed `RGBA` that is not the same
object as `MUTED_COLOR`, compare fields instead:
`expect(box.borderColor.intent).toBe("indexed"); expect(box.borderColor.slot).toBe(8);`.
Likewise for `selectionBg` / `selectionFg`: compare `.slot` (4 and 15) if the
identity check fails. The existing mention-popup test shows the
`createTestRenderer` + `afterEach` teardown shape.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/src/tui/text.test.ts`
Expected: the first test passes (today's behaviour), the second and third
fail on `expect(block).toBeInstanceOf(BoxRenderable)`.

- [ ] **Step 3: Extend `markdown()` in `text.ts`**

Add `BoxRenderable` and `CodeRenderable` to the `@opentui/core` import, and
`MUTED_COLOR` to the `./theme.js` import. Replace the doc comment and body of
`markdown()` with:

```ts
/** MarkdownRenderable takes no selection colours; the blocks it builds do,
 * so they are set as each block is created. A table (0.5.10) takes them as
 * constructor options only and draws no selection at all without them, so
 * its private fields are set; the table selection test pins this.
 *
 * A fenced code block gets a muted left border so it stands apart from a
 * paragraph even when its language has no bundled grammar. OpenTUI does not
 * frame code itself, and a block `renderNode` replaces loses in-place
 * updates: it would be rebuilt on every streamed chunk and draw nothing
 * until its highlight resolves. So the frame is added only once the body has
 * left streaming mode; `streaming = false` rebuilds every block through this
 * hook again, which is when the frame appears. */
export function markdown(
  ctx: RenderContext,
  options: MarkdownOptions,
): MarkdownRenderable {
  let body: MarkdownRenderable | undefined;
  const renderable = new MarkdownRenderable(ctx, {
    fg: DEFAULT_FG,
    renderNode: (_token, context) => {
      const block = context.defaultRender();
      if (block instanceof TextTableRenderable) {
        Object.assign(block, {
          _selectionBg: SELECTION_BG,
          _selectionFg: SELECTION_FG,
        });
      } else if (block && "selectionBg" in block) {
        Object.assign(block, SELECTION);
      }
      if (block instanceof CodeRenderable && body && !body.streaming) {
        const frame = new BoxRenderable(ctx, {
          id: `${block.id}-frame`,
          width: "100%",
          border: ["left"],
          borderColor: MUTED_COLOR,
          paddingLeft: 1,
          flexShrink: 0,
        });
        frame.add(block);
        return frame;
      }
      return block;
    },
    ...options,
  });
  body = renderable;
  return renderable;
}
```

The constructor runs `updateBlocks()` before `body` is assigned, so a body
created with `streaming: false` would miss the frame on its first build.
Handle that in the same edit: after `body = renderable;`, add

```ts
  if (!renderable.streaming) renderable.content = renderable.content;
```

only if the third test ("built already settled") fails — check whether
setting `content` to the same value rebuilds. If it does not, use
`renderable.streaming = true; renderable.streaming = false;` instead, which
does (the setter rebuilds on any change). Keep whichever one makes the third
test pass and leave a one-line comment saying why the nudge exists.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/cli/src/tui/text.test.ts`
Expected: all tests in the file pass, including "TUI sources build text
through the text.ts factories" (the new `new BoxRenderable(` in `text.ts` is
not in that test's regex, which matches only Text/Textarea/Markdown/Input).

- [ ] **Step 5: Full check and commit**

Run: `bun run check`
Expected: lint, build and all tests pass.

```bash
git add packages/cli/src/tui/text.ts packages/cli/src/tui/text.test.ts
git commit -m "feat: TUI frames a settled fenced code block with a muted left border (Refs #127)"
```

Then `gh issue comment 127` (English): the frame landed; what's next is the
manual pass and the PR (Task 3).

---

### Task 3: Manual pass and pull request

**Files:**
- None modified unless the manual pass finds a defect.

- [ ] **Step 1: Manual pass in the TUI**

Run the CLI against the dummy provider used by the E2E tests, or the vendor
CLI if one is at hand, and ask for a reply containing three fenced blocks:
one ` ```javascript `, one with an unknown language such as ` ```lua `, one
with no language. Confirm, once the reply settles:

- every block has a muted left border with one column of padding;
- the JavaScript block shows `const` in magenta, the string in green, a
  comment in dim italic;
- the other two blocks are plain text inside the frame;
- while the reply streams, the blocks have no frame and no flicker.

If the user runs this pass rather than the agent, record the outcome in the
issue comment.

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --head issue-127 --label enhancement \
  --title "Fenced code blocks in the interactive TUI get a frame and syntax colours" \
  --body "$(cat <<'EOF'
Closes #127

A fenced code block in the TUI rendered like a paragraph. Two causes: the
theme defined no code scopes, so a block with a bundled grammar (JS/TS) fell
to one colour; and OpenTUI does not frame code blocks at all, so a block with
no grammar was indistinguishable from prose.

- `markdownSyntaxStyle()` gains the JS/TS scopes with ANSI colours.
- `markdown()`'s `renderNode` wraps a settled code block in a muted
  left-border Box. Not while streaming: a replaced block loses in-place
  updates and would flicker.
- The issue's first root cause (no `treeSitterClient` passed) was wrong;
  `CodeRenderable` falls back to the default client. The spec records this.

Spec: `docs/superpowers/specs/2026-09-24-tui-code-block-styling-design.md`
Plan: `docs/superpowers/plans/2026-09-24-tui-code-block-styling.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01N2sTvTiiLqaLj8W8KDd4Qf
EOF
)"
```

- [ ] **Step 3: Sync the issue**

`gh issue comment 127` with the PR link and "What's next: whole-branch
review, merge, release".
