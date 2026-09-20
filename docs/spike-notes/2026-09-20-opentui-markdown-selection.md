# OpenTUI 0.5.10: markdown, selection and focus

Spike for milestone 17 (issue #71). Every answer below was produced by a
throwaway script run from `packages/cli/` with `bun` (Bun 1.4.0, macOS
arm64) against the installed `@opentui/core` 0.5.10, or read from that
package's `.d.ts` / bundled source. The scripts were deleted after the run;
the commands needed to reproduce them are described with each answer.

## 1. Markdown in the test renderer

**Yes, it renders concealed — but only after the asynchronous tree-sitter
highlight lands, which needs real elapsed time and not just more
`renderOnce()` calls.** With `createTestRenderer({ width: 60, height: 20 })`
and

```ts
new MarkdownRenderable(renderer, {
  content: "# Title\n\n- **bold** item\n\n```ts\nconst a = 1;\n```",
  syntaxStyle: SyntaxStyle.create(),
  conceal: true,
})
```

added to `renderer.root`, the frame settles on the **3rd** `renderOnce()`
when each pass is followed by `await sleep(50)`:

```
0|Title
1|
2|- bold item
3|
4|const a = 1;
```

`#`, `**` and the ``` fence are gone. The list bullet `- ` is *not*
concealed — it is kept as the rendered list marker, so a check for
"no markdown syntax left" must not assert on `-`.

Two negative results matter more than the positive one:

- A tight loop of 10 `await t.renderOnce()` calls with no delay between
  them **never** produced the text. The frame showed only `const a = 1;`
  and four blank rows above it.
- Replacing `renderOnce()` with `t.flush()` in that same tight loop did not
  help either — same frame after 10 passes.

Structure dump after the tight loop (the blank rows are laid out, just not
painted yet):

```
MarkdownRenderable w=60 h=5
  CodeRenderable block-0 y=0 w=60 h=3  txt="# Title\n\n- **bold** item"
  CodeRenderable block-1 y=4 w=60 h=1  txt="const a = 1;"
```

Every top-level block — the coalesced prose block included — is a
`CodeRenderable`, and concealment of the prose block is driven by the
tree-sitter `markdown` parse. Until that resolves, the prose block paints
nothing at all.

## 2. Streaming mode

**Yes. Each frame shows the text so far, an unterminated code fence renders
as code, and the final frame is byte-identical to a fresh non-streaming
render of the same content.** With `streaming = true` and `content`
assigned three times:

```
Q2 streaming frame for "Par":
  >Par
Q2 streaming frame for "Partial reply\n\n```ts\nconst a":
  >Partial reply
  >const a
Q2 streaming frame for "Partial reply\n\n```ts\nconst a = 1;\nconst b":
  >Partial reply
  >const a = 1;
  >const b
```

Then `content = "Partial reply\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nDone."`
plus `streaming = false`:

```
Q2 final streamed frame:        Q2 fresh (non-streaming) frame:
  >Partial reply                  >Partial reply
  >const a = 1;                   >const a = 1;
  >const b = 2;                   >const b = 2;
  >Done.                          >Done.
Q2 frames identical: true
```

The comparison was a strict `===` on the two `captureCharFrame()` strings.
Same caveat as question 1: each assignment needed a few `renderOnce()`
calls spaced 50 ms apart before the frame caught up.

## 3. Tree-sitter under both runtimes

**Tree-sitter itself works under both Bun 1.4.0 and Node 24.7.0. What fails
under Node 24 is OpenTUI's native render library, not tree-sitter.**
Node >= 26.4 was not available on this machine (`node --version` →
`v24.7.0`), so the *rendering* half of this question could not be run under
a supported Node; it would need a Node >= 26.4 install to confirm.

Calling the shared client directly (`getTreeSitterClient()`) succeeded
identically under both runtimes — under `bun` and under
`node --experimental-strip-types`:

```
initialize: "ok"
isInitialized: true
highlightOnce(typescript): {"n":7,"sample":[[0,5,"keyword"],[6,7,"variable"],[6,7,"type"],[6,7,"constant"]]}
highlightOnce(markdown): {"n":1,"sample":[[0,12,"spell",{"isInjection":true,"injectionLang":"markdown_inline"}]]}
```

Running the question-1 render script under Node 24 fails before any
markdown work, in `createTestRenderer`:

```
Error: Failed to initialize OpenTUI render library: OpenTUI native FFI is not available for this runtime yet
    at resolveRenderLib (.../@opentui/core/chunk-node-f647ts9q.js:17657:13)
    at new CliRenderer (.../chunk-node-6bg8r2m7.js:7313:17)
    at setupTestRenderer (.../testing.js:716:10)
```

That is the reason for the documented "Bun >= 1.3 or Node >= 26.4" floor,
and it is unrelated to tree-sitter.

**Highlight colours.** `SyntaxStyle.create()` registers no styles, so the
code block renders in a single colour — `captureSpans()` over the question-1
frame reported `distinct non-blank fg colours: 1` (`rgb(1,1,1)`, i.e. white;
the RGBA components are 0–1 floats). With a populated style the highlights
do come through:

```ts
SyntaxStyle.fromStyles({
  default: { fg: "#c0c0c0" }, keyword: { fg: "#ff00ff", bold: true },
  variable: { fg: "#00ffff" }, number: { fg: "#ffff00" },
})
```

```
"const"->rgb(1,0,1)  "a"->rgb(0,1,1)  " = "->rgb(0.753,0.753,0.753)
"1"->rgb(1,1,0)      ";"->rgb(0.753,0.753,0.753)
```

So syntax colouring requires an explicit `SyntaxStyle` built from styles or
a theme; `SyntaxStyle.create()` alone gives monochrome code.

**`treeSitterClient` omitted.** The option is optional
(`treeSitterClient?: TreeSitterClient` in `renderables/Markdown.d.ts`); when
it is left out the renderable uses the shared `getTreeSitterClient()`
singleton. That is what every run above did, and it worked.

**When highlighting fails.** Simulated with
`new MockTreeSitterClient({ autoResolveTimeout: 1 })` and
`setMockResult({ error: "simulated worker load failure" })`:

```
frame with a failing tree-sitter client:
  ># Title
  >- **bold** item
  >const a = 1;
process-level errors: none
```

Nothing throws, nothing is logged to the frame, and no `uncaughtException`
or `unhandledRejection` fires — but **concealment is lost**: the raw `#` and
`**` markers are shown. Degradation is to plain markdown source, not to a
crash.

## 4. Mouse and selection

**`useMouse` defaults to `true`, and `"selection"` fires once, on mouse up.**

`useMouse?: boolean` and `autoFocus?: boolean` are optional in
`CliRendererConfig` (`renderer.d.ts:46-47`), and the bundled constructor
defaults both to true:

```js
this._useMouse = config.useMouse ?? true;   // chunk-bun-bb3k0yt8.js:7431
this.autoFocus = config.autoFocus ?? true;  // chunk-bun-bb3k0yt8.js:7432
```

`createCliRenderer({ exitOnCtrlC: false })` therefore has the mouse on.
The test renderer confirmed it at runtime: `Q4 useMouse default: true`.

Only `finishSelection()` emits the event, and it is called from exactly one
place — the `type === "up" && button === LEFT && currentSelection.isDragging`
branch of `processSingleMouseEvent` (`chunk-bun-bb3k0yt8.js:9257` →
`:10212 emit("selection", this.currentSelection)`). Drag moves call
`updateSelection()`, which does not emit. Measured with the mock mouse over
three `TextRenderable`s (`alpha line`, `bravo line` with
`selectable: false`, `charlie line`):

```
Q4 after mousedown, events: 0
Q4 after drag move, events: 0
Q4 after 2nd drag move, events: 0
Q4 after mouseup, events: 1
   selection ctor=Selection text="alpha line\ncharlie line"
Q4 getSelection(): Selection text="alpha line\ncharlie line"
Q4 selectedRenderables ids: ["a","c"]
```

**Payload:** a `Selection` instance (`lib/selection.d.ts`) with
`getSelectedText(): string`, `bounds`, `selectedRenderables` and
`isDragging`. The same object is also reachable as
`renderer.getSelection()`.

**`selectable: false` excludes the text.** `bravo line` sat between the two
selected rows and appears neither in `getSelectedText()` nor in
`selectedRenderables`.

## 5. Focus

**It is `autoFocus` that steals focus, and `autoFocus: false` keeps it on
the input while the wheel still scrolls the history.** The one use of the
flag is the left-mousedown handler, which walks up from the hit target to
the first `focusable` ancestor and focuses it
(`chunk-bun-bb3k0yt8.js:9174`):

```js
if (this.autoFocus && event.type === "down" && event.button === 0 && !event.defaultPrevented) {
  let current = target;
  while (current) { if (current.focusable) { current.focus(); break; } current = current.parent; }
}
```

A `ScrollBoxRenderable` reports `focusable: true`, so today a click on the
history takes focus off the textarea. Measured with a 40-row ScrollBox plus
a focused `TextareaRenderable`:

```
Q5 renderer.autoFocus option = true
  input.focused before click: true   history.focusable: true
  input.focused after click on history: false   blurred events: 1
  history.scrollTop: start=29 afterWheelUp=28 afterWheelDown=29
  PgUp/PgDn with textarea focused: start=29 afterPgUp=29 afterPgDn=29; textarea text=""

Q5 renderer.autoFocus option = false
  input.focused before click: true   history.focusable: true
  input.focused after click on history: true   blurred events: 0
  history.scrollTop: start=29 afterWheelUp=28 afterWheelDown=29
  PgUp/PgDn with textarea focused: start=29 afterPgUp=29 afterPgDn=29; textarea text=""
```

- **`autoFocus: false` keeps focus on the input** across a click on the
  history, and **wheel scrolling is unaffected** — `scrollTop` moved 29 → 28
  on wheel up and back to 29 on wheel down under both settings. Wheel
  scrolling does not go through the focus path.
- **`Renderable` does emit `"blurred"`.** `RenderableEvents.BLURRED =
  "blurred"` (`Renderable.d.ts:17`), emitted at the end of `blur()`
  (`chunk-bun-bb3k0yt8.js:384`). The counter above recorded exactly one
  `blurred` on the `autoFocus: true` click and none on the
  `autoFocus: false` click, so a re-focus-on-blur handler is a viable
  fallback.
- **PgUp/PgDn do nothing today.** With the textarea focused, neither key
  changed `history.scrollTop` and neither inserted anything into the
  textarea. Page scrolling has to be wired up explicitly.

## Consequences for the plan

- **Task 9 (markdown reply rendering)** must not pass a bare
  `SyntaxStyle.create()` if code blocks are meant to be coloured: it gives
  monochrome code. Build the style from the repo's existing theme with
  `SyntaxStyle.fromStyles(...)` / `SyntaxStyle.fromTheme(...)` instead
  (question 3).
- **Task 9** must also accept that concealment is asynchronous and can fail
  open: when tree-sitter cannot highlight, the reply shows raw `#` and `**`
  rather than an error. That is an acceptable degradation, but any
  assertion that "no markdown markers are visible" is not safe as a
  correctness check (questions 1 and 3). The failing-highlighter case above
  was simulated with `MockTreeSitterClient`, not observed from a real
  worker-load failure; a real tree-sitter worker crash under load was not
  reproduced here.
- **Tests written in tasks 8 and 9** cannot use a tight `renderOnce()` loop.
  They need real elapsed time between passes — `await t.renderOnce()`
  followed by `await sleep(50)`, repeated until the expected text appears
  (a `waitForFrame`-style helper). A bare `renderOnce()` or `flush()` loop
  never settles. Also, assertions must not treat the list bullet `- ` as
  leftover markdown syntax (question 1).
- **Task 8 (pending row / streaming reply text)** can keep `streaming = true`
  while chunks arrive and flip it to `false` at the end: the final frame is
  identical to a fresh render, so no re-creation of the renderable is needed
  (question 2).
- **Task 12 (select-to-copy)** should subscribe to
  `CliRenderEvents.SELECTION` and copy `selection.getSelectedText()` on that
  one event — it fires once per gesture, on mouse up, so no debouncing is
  needed. Chrome that must not be copied (labels, status row, guide) should
  carry `selectable: false`, which reliably drops it from
  `getSelectedText()` (question 4).
- **Task 13 (sticky input focus)** should use
  `createCliRenderer({ exitOnCtrlC: false, autoFocus: false })`. That is
  sufficient on its own, and it does not cost wheel scrolling of the
  history. The `blurred` re-focus handler is a working fallback but is not
  needed if `autoFocus: false` is taken (question 5).
- **Task 13** must additionally wire PgUp/PgDn to the history scroll box if
  page scrolling is in scope: neither key does anything today while the
  textarea has focus (question 5).
- **CI note for any task adding these tests:** they only run under Bun. Node
  24 cannot construct a renderer at all (`OpenTUI native FFI is not
  available for this runtime yet`), and a Node >= 26.4 run of the rendering
  path was not verified here (question 3).

**Follow-up (2026-09-21):** select-to-copy was later verified on a *started*
renderer too — selection starts before `autoFocus` is consulted in OpenTUI's
mouse path, so the two do not race. Tests exercising it must still read the
selected row from a settled frame (question 1's caveat), not from the frame
immediately after the mouse-up event.
