# Markdown rendering fixes — design

Milestone 20. Tracking issue #125, bundled with #124. Two externally reported
bugs in the Markdown path, both verified against the code before this spec.

## 1. KaTeX math is duplicated by `elementToMarkdown` (#125)

### Problem

KaTeX renders every expression twice: a `.katex-mathml` branch holding
`<math>` with the rendered tokens (`<mn>99.8</mn><mi>%</mi>`) *and* the LaTeX
source in `<annotation encoding="application/x-tex">99.8\%</annotation>`,
and a `.katex-html` branch marked `aria-hidden="true"`. The walker in
`packages/provider/src/element-to-markdown.ts` skips only `aria-hidden`
elements, so it drops the visual branch and reads the MathML one whole,
producing `99.8%99.8\%`.

### Decision

Skip `<annotation>` and `<annotation-xml>` everywhere. In MathML they are
alternative representations of their parent, never content to show, so the
rule is generic and does not name KaTeX. The output is the rendered text
(`99.8%`, `98∘`), which is what a sighted user sees and what the TUI and
clipboard need; the TUI does not render LaTeX, so emitting `$99.8\%$` was
rejected. Structured math (a fraction) flattens to its token text, exactly
as `textContent` already does. That is accepted.

Skipping `.katex-mathml` as the issue suggests would leave nothing, because
`.katex-html` is already dropped by `aria-hidden`.

### Change

- `packages/provider/src/element-to-markdown.ts`: add `ANNOTATION` and
  `ANNOTATION-XML` to the `SKIP` set. That set guards both the inline walker
  and the block walker, so no other branch changes. `<math>`, `<semantics>`,
  `<mrow>`, `<mn>`, `<mi>` remain unknown elements whose children pass through.
- `packages/runtime/src/element-to-markdown.e2e.test.ts`: a case with the real
  KaTeX structure (both branches, `<semantics>` + `<annotation>`, aria-hidden
  `.katex-html`) expecting `99.8%` inside a sentence, and a case for
  `<annotation-xml>`.

## 2. TUI headings and fenced code render as plain text (#124)

### Problem

`markdownSyntaxStyle()` in `packages/cli/src/tui/theme.ts` registers
`markup.heading` and `markup.raw`. The bundled tree-sitter query in
`@opentui/core` 0.5.10 (`assets/markdown/highlights.scm`) emits
`markup.heading.1` … `markup.heading.6` for headings and `markup.raw.block`
for fenced and indented code. Both `MarkdownRenderable.getStyle` and
`SyntaxStyle.getStyle` fall back only to the first dot segment (`markup`),
which is not a key, so the lookup misses. `markup.list`, `markup.quote` and
`markup.link` match exactly and work; inline `markup.raw` from the
`markdown_inline` grammar also matches, so only block code is broken.

`theme.test.ts` asserted the scopes the theme *defined*, not the scopes the
grammar *emits*, which is why it stayed green.

### Change

- `theme.ts`: add `markup.heading.1` … `markup.heading.6` with the heading
  style and `markup.raw.block` with the raw style. Keep `markup.heading`
  (pipe-table header cells) and `markup.raw` (inline code).
- `theme.test.ts`: the scope list becomes the names the bundled grammar emits,
  with a comment saying so and pointing at `highlights.scm`, so a future grammar
  bump that renames a capture fails here.

No fallback change is requested in `@opentui/core`; the theme must work with
the version pinned today.

## Out of scope

- Progressive dot-segment fallback upstream in OpenTUI.
- A provider-configurable skip list for `elementToMarkdown` (backlog #114).
- Rendering LaTeX in the TUI or VSCode view.

## Vendor impact

None. The `Provider` type, `createCli` / `createExtension` options, VSCode
manifest and templates are unchanged, so `upgrade-guide.md` gets no entry.
Vendors receive both fixes by bumping `@chatbridge/*`.

## Delivery

One PR, label `bug`, `Closes #125, closes #124`. Plan has two independent
tasks; both are mechanical enough for Sonnet, task reviews on Sonnet,
whole-branch review on Fable.
