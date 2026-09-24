# Markdown Rendering Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two Markdown bugs: `elementToMarkdown` duplicating KaTeX math (#125) and the TUI rendering headings and fenced code as plain text (#124).

**Architecture:** Two independent one-file fixes with their tests. Task 1 adds
MathML `<annotation>` / `<annotation-xml>` to the walker's skip set in
`@chatbridge/provider`, covered by the headless-Chromium table test in
`@chatbridge/runtime`. Task 2 adds the capture names the bundled tree-sitter
markdown grammar actually emits to the TUI theme, and makes the theme test
assert those names.

**Tech Stack:** TypeScript, Bun test runner, Playwright (Chromium) for the
provider e2e table, `@opentui/core` 0.5.10 `SyntaxStyle`.

**Spec:** `docs/superpowers/specs/2026-09-24-markdown-rendering-fixes-design.md`

## Global Constraints

- Branch `issue-125`. Tracking issue #125; #124 is bundled. Commit messages
  in English, ending with the attribution lines the session provides.
- `bun run check` must pass before every commit (lint + build + all tests).
  Tests import cross-package code from `dist/`, so `bun run build` is part of
  it; do not run `bun test` alone after editing another package.
- Dependency direction `cli → core → runtime → provider`; nothing here
  changes it.
- No `@opentui/core` change or bump; the theme must work with 0.5.10.
- No `upgrade-guide.md` entry: nothing vendor-facing changes.
- After each task's commit, post a comment on #125 (English) with what was
  committed and "What's next".

---

### Task 1: Skip MathML annotations in `elementToMarkdown` (#125)

**Files:**
- Modify: `packages/provider/src/element-to-markdown.ts:15`
- Test: `packages/runtime/src/element-to-markdown.e2e.test.ts` (the `CASES` table)

**Interfaces:**
- Consumes: `elementToMarkdown(locator: Locator): Promise<string>` (existing).
- Produces: nothing new; the function's signature is unchanged.

Background: `walk` runs inside the page via `locator.evaluate`, so it must
stay a single self-contained function. `SKIP` is checked by both the inline
walker (line 66) and the block walker (line 185), so one entry covers both.

- [ ] **Step 1: Add the failing cases to the e2e table**

In `packages/runtime/src/element-to-markdown.e2e.test.ts`, append to `CASES`
right before the closing `];`:

```ts
  [
    // KaTeX renders a MathML branch (visually clipped, holding the rendered
    // tokens plus the LaTeX source in <annotation>) and an aria-hidden HTML
    // branch. The annotation is an alternative representation, not text.
    "KaTeX math emits the rendered text once",
    '<p>contains <span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mn>99.8</mn><mi mathvariant="normal">%</mi></mrow><annotation encoding="application/x-tex">99.8\\%</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span class="mord">99.8</span><span class="mord">%</span></span></span></span> of the mass</p>',
    "contains 99.8% of the mass",
  ],
  [
    "annotation-xml inside math is skipped too",
    '<p><math><semantics><mn>2</mn><annotation-xml encoding="MathML-Content"><cn>2</cn></annotation-xml></semantics></math></p>',
    "2",
  ],
```

- [ ] **Step 2: Build and run the table to see the two new cases fail**

Run: `bun run build && bun test packages/runtime/src/element-to-markdown.e2e.test.ts`
Expected: the two new tests FAIL; the first receives `"contains 99.8%99.8\\% of the mass"`,
the second `"22"`. All older cases pass.

- [ ] **Step 3: Add the two tags to `SKIP`**

In `packages/provider/src/element-to-markdown.ts`, replace line 15:

```ts
  const SKIP = new Set(["BUTTON", "SVG", "SCRIPT", "STYLE", "NOSCRIPT"]);
```

with:

```ts
  // MathML annotations are alternative representations of their parent (the
  // LaTeX source under KaTeX), not text to show: reading them next to the
  // rendered tokens doubles every expression.
  const SKIP = new Set([
    "BUTTON",
    "SVG",
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "ANNOTATION",
    "ANNOTATION-XML",
  ]);
```

- [ ] **Step 4: Run the full check**

Run: `bun run check`
Expected: lint clean, build ok, all tests pass including the two new cases.

- [ ] **Step 5: Commit and sync**

```bash
git add packages/provider/src/element-to-markdown.ts packages/runtime/src/element-to-markdown.e2e.test.ts
git commit -m "fix: elementToMarkdown skips MathML annotations so KaTeX math is not doubled (Refs #125)"
gh issue comment 125 --body "Committed: elementToMarkdown now skips <annotation> and <annotation-xml>, with two e2e cases (KaTeX structure, annotation-xml). What's next: Task 2, TUI theme scopes for headings and fenced code (#124)."
```

---

### Task 2: Register the capture names the markdown grammar emits (#124)

**Files:**
- Modify: `packages/cli/src/tui/theme.ts:72-88`
- Test: `packages/cli/src/tui/theme.test.ts:81-104`

**Interfaces:**
- Consumes: `SyntaxStyle.fromStyles` / `getStyle` from `@opentui/core` (existing).
- Produces: nothing new; `markdownSyntaxStyle(): SyntaxStyle` is unchanged.

Background: `@opentui/core/assets/markdown/highlights.scm` (0.5.10) captures
headings as `markup.heading.1` … `markup.heading.6` and fenced / indented
code as `markup.raw.block`. The style lookup falls back only to the first
dot segment (`markup`), so the two-segment keys never match those. The
existing test asserted the theme's own keys, which is why it stayed green.

- [ ] **Step 1: Make the theme test assert the grammar's capture names**

In `packages/cli/src/tui/theme.test.ts`, replace the first test in
`describe("markdownSyntaxStyle", ...)` (lines 82-100) with:

```ts
  // These are the capture names @opentui/core's bundled tree-sitter query
  // (assets/markdown/highlights.scm, plus markdown_inline) emits, not the
  // names the theme happens to define. The style lookup only falls back to
  // the first dot segment, so a missing exact key renders as plain text.
  test("registers every markup scope the bundled grammar emits", () => {
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
```

Then, in the second test ("colours come from the ANSI palette, not fixed
truecolour"), add after the `markup.raw` slot assertion:

```ts
      expect(style.getStyle("markup.heading.1")?.bold).toBe(true);
      expect(style.getStyle("markup.heading.1")?.fg?.slot).toBe(2);
      expect(style.getStyle("markup.raw.block")?.fg?.slot).toBe(3);
```

- [ ] **Step 2: Run the theme test to see it fail**

Run: `bun test packages/cli/src/tui/theme.test.ts`
Expected: FAIL — `markup.heading.1` (and the other new scopes) are `undefined`.

- [ ] **Step 3: Add the scopes to the theme**

In `packages/cli/src/tui/theme.ts`, replace the doc comment and function
(lines 72-88) with:

```ts
/** Styles for MarkdownRenderable, from the same ANSI indices as `theme`, so
 * a reply looks like the rest of the history in any terminal palette. The
 * scope names are the captures the bundled tree-sitter markdown query emits
 * (0.5.10): headings come per level, fenced and indented code as
 * `markup.raw.block`, and the lookup falls back only to the first dot
 * segment, so each must be registered exactly. `markup.heading` stays for
 * pipe-table header cells and `markup.raw` for inline code. A style it does
 * not find falls back to `default`, set here to the terminal foreground.
 * The caller owns the returned handle and must `destroy()` it. */
export function markdownSyntaxStyle(): SyntaxStyle {
  const heading = { fg: RGBA.fromIndex(ANSI.green), bold: true };
  const raw = { fg: RGBA.fromIndex(ANSI.yellow) };
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
  });
}
```

- [ ] **Step 4: Run the theme test, then the full check**

Run: `bun test packages/cli/src/tui/theme.test.ts`
Expected: PASS.

Run: `bun run check`
Expected: all green. `chat-view.test.ts` "a markdown reply is rendered with
markup concealed" still passes; it checks concealment, not colour.

- [ ] **Step 5: Commit and sync**

```bash
git add packages/cli/src/tui/theme.ts packages/cli/src/tui/theme.test.ts
git commit -m "fix: TUI styles headings and fenced code, matching the grammar's capture names (Refs #124)"
gh issue comment 125 --body "Committed: theme registers markup.heading.1-6 and markup.raw.block; theme test now asserts the scopes the bundled grammar emits. What's next: whole-branch review, then PR (Closes #125, closes #124, label bug)."
```
