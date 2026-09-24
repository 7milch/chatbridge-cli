# TUI code block styling — design

Milestone 21, issue #127. A fenced code block in the interactive TUI renders
like a paragraph: no frame, and one flat colour even for a language with a
bundled grammar. Verified against `@opentui/core` 0.5.10 before this spec.

## What is actually wrong

The issue names two root causes. One holds, one does not, and the real one
is a third:

- **Wrong:** "`markdown()` never passes a `treeSitterClient`, so no highlight
  runs." `CodeRenderable`'s constructor falls back with
  `options.treeSitterClient ?? getTreeSitterClient()`. The reporter's flat
  spans came from `createTestRenderer`, whose `MockTreeSitterClient` returns
  `{ highlights: [] }` by default.
- **Holds:** `MarkdownRenderable.createCodeRenderable` returns a bare
  `CodeRenderable`. `createBlockquoteRenderable` wraps its content in a
  `BoxRenderable` with a left border; code blocks get nothing.
- **The real cause of the flat colour:** a fenced block becomes its own
  `CodeRenderable` whose `filetype` comes from the info string (`javascript`,
  …). Its highlights are code scopes (`keyword`, `string`, `comment`, …), none
  of which `markdownSyntaxStyle()` defines, so every token falls to `default`.
  The `markup.raw.block` scope added in v0.11.1 (#124) is emitted by the
  markdown grammar and never reaches a fenced block, so the code-block half of
  #124 is still open. A block with no language has `filetype` undefined and no
  highlight runs at all.

## Change 1: a frame, once the reply has settled

`markdown()` in `packages/cli/src/tui/text.ts` already passes a `renderNode`
hook. It gains one more case: when `context.defaultRender()` returns a
`CodeRenderable` **and** the MarkdownRenderable is not streaming, wrap it in

```ts
new BoxRenderable(ctx, {
  width: "100%",
  border: ["left"],
  borderColor: MUTED_COLOR,
  paddingLeft: 1,
  flexShrink: 0,
})
```

Same shape as OpenTUI's blockquote, muted colour so the two differ.

**Why not while streaming.** A `renderNode` result that is not the default
renderable is marked `canUpdateInPlace: false`, so the block is recreated on
every content update, and a freshly built streaming `CodeRenderable` draws no
text until its highlight resolves. Wrapping only after settling keeps the
in-place update path during the reply.

**How the frame appears on settle.** `chat-view.ts`'s `setBody(settled)` sets
`streaming = false`. In 0.5.10 that alone reuses every block whose source did
not change and never calls `renderNode`, so `markdown()` returns a small
subclass whose `streaming` setter, once when streaming ends, assigns a fresh
`renderNode`: the setter for that option clears the block state and rebuilds
every block through the hook, which is when the frame appears. The hook reads
`streaming` from the live instance, falling back to the initial option only
while the constructor runs. A framed block is outside OpenTUI's in-place
updates afterwards; no caller changes a settled body's style or streaming
state today. Two facts the hook depends on: a paragraph is also a
`CodeRenderable` (filetype `markdown`), so the frame requires
`token.type === "code"`; and `defaultRender()` leaves the inter-block
`marginBottom` on the code block, so the frame takes it over and the border
stops at the code.

Selection colours are applied to the inner `CodeRenderable` before wrapping,
as the existing `"selectionBg" in block` branch does today.

## Change 2: code scopes in the theme

`markdownSyntaxStyle()` in `packages/cli/src/tui/theme.ts` adds the scopes the
bundled JavaScript and TypeScript grammars emit, ANSI-indexed like everything
else so the terminal palette applies:

| Scope | Style |
|---|---|
| `keyword` | magenta (5) |
| `string`, `string.special` | green (2) |
| `comment` | bright black (8), italic |
| `function`, `function.method`, `function.builtin`, `constructor` | blue (4) |
| `number`, `constant`, `constant.builtin` | yellow (3) |
| `type`, `variable.builtin` | cyan (6) |
| `property`, `variable`, `operator`, `punctuation.*`, `embedded` | not registered; falls to `default` |

`SyntaxStyle.getStyle` falls back only to the first dot segment, so
`string.special`, `function.method` and the like are registered individually.

The doc comment on `markdownSyntaxStyle()` is corrected: `markup.raw.block`
covers code the markdown grammar highlights directly (indented code, blockquote
content), not fenced blocks. A fenced block is highlighted by its own language
grammar; with no language it is not highlighted and the frame alone sets it
apart.

## Testing

- `theme.test.ts`: list the `@scope` captures of
  `@opentui/core/assets/{javascript,typescript}/highlights.scm` that the table
  styles and assert `getStyle` finds each, plus the ANSI slot per colour. Fix
  the existing comment that says fenced code goes through `markup.raw.block`.
- `text.test.ts`: with `createTestRenderer`, build `markdown()` over a fenced
  block with `streaming: true` and assert the block is a bare
  `CodeRenderable`; set `streaming = false` and assert it is now a
  `BoxRenderable` with a left border whose child is a `CodeRenderable`
  carrying the selection colours.
- `bun run check`.
- Manual pass in the TUI, three blocks: ` ```javascript `, an unknown
  language, no language.

## Out of scope

- A language label on the frame.
- A frame during streaming.
- Changes in `@opentui/core`.
- The VSCode chat view, whose HTML already frames code.
- The upgrade guide: nothing a vendor sees changes.
