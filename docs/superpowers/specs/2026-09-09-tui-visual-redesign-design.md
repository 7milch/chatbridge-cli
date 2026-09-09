# Interactive TUI visual redesign — design

Milestone 7, issue #28. Direction chosen by a mock competition on 2026-09-09
(`docs/superpowers/mocks/2026-09-09-tui-mocks.html`, mock 5; screenshot
`2026-09-09-tui-mock-5.png`). This spec settles the details the mock left open:
banner API, colour tokens, resize behaviour, and the popup placement.

## Goal

Give the interactive TUI a considered visual design without touching
conversation state or anything below `@chatbridge/cli`. Everything here lives
in `packages/cli`; `ChatModel`, `mentions/*`, core, runtime, and provider are
unchanged.

## Layout

The root is a column flex box with five children, top to bottom:

| Region | Renderable | Height | Content |
|---|---|---|---|
| header | `TextRenderable` | 1 row + 1 row margin | `badge(" name ")` then `muted("provider · headless\|headful · 120s budget")` |
| history **or** banner | `ScrollBoxRenderable` / `BoxRenderable` | `flexGrow: 1` | see below |
| input | `BoxRenderable` with `border: ["top", "bottom"]` | 1–5 rows + 2 border rows | `muted("> ")` beside a borderless `TextareaRenderable` |
| mention popup | `BoxRenderable`, inline, hidden by default | 0 or `rows + 1` | candidate list plus a hint row |
| status | `TextRenderable`, fixed 1 row, `flexShrink: 0` | 1 row | key hints or the activity indicator |

`ChatViewOptions` gains `headless: boolean` (for the mode text) and
`banner: string[]` (resolved by `createCli`, see below).

### History

Unchanged structure: one column box per message, appended incrementally,
`stickyScroll` at the bottom. Styling changes:

- Role labels are `user` / `assistant` / `error`, bold and coloured
  (`theme.user` / `theme.assistant` / `theme.error`). Body text is not
  indented.
- Error bodies use `theme.errorText`; other bodies are plain.
- Attachment lines (`📎 path (size)`) are `muted`.

### Banner

Shown while the history has no messages. It is a `BoxRenderable` with
`flexGrow: 1`, `justifyContent: "center"`, `alignItems: "center"`,
containing one `TextRenderable` per banner line. The banner and the history
are mutually exclusive children of the root: the view starts with the banner
attached; on the first message it removes the banner and adds the history in
the same slot. The banner is never shown again in that session.

Lines longer than the terminal width are truncated on the right (the banner
never wraps or scrolls horizontally). Centring is delegated to flex, so a
resize re-centres it with no handler in our code.

Line styling: for the default banner the first line is
`bold(name) + muted(" vX.Y.Z")`; every other line, and every line of a
vendor-supplied banner, is `muted`.

### Input

A box with only top and bottom borders (`theme.muted` colour, single style)
wraps a row: `muted("> ")` and a `TextareaRenderable` with no border,
placeholder `Type a message`, `flexGrow: 1`. Key bindings (Enter submit,
Shift+Enter / Ctrl+J newline) are unchanged.

Height follows the content: on every `onContentChange` the textarea height is
set to `clamp(virtualLineCount, 1, 5)`. Beyond five rows the textarea scrolls
internally. The history (or banner) shrinks through flex; nothing else moves.

### Mention popup

Moves from an absolutely positioned bordered box over the history to an
inline, borderless list between the input and the status row. When hidden it
has no height. When visible it holds up to `MAX_ROWS` candidate rows followed
by one hint row `muted("↕ select · Tab/Enter accept · Esc close")`. Each
candidate row is two spaces of indent, the directory part `muted`, the file
name plain; the selected row is `theme.selected` (inverse) across the label.
Rows are still created once and re-labelled. The `bottom` option of
`MentionPopup` is removed; the popup is constructed with the root as parent
and inserted before the status row. The status row stays visible while the
popup is open. Key handling in `ChatView` is unchanged.

### Status row

Idle: `muted(GUIDE)` where `GUIDE` keeps its current text. Busy: the existing
three-cell spinner, `Thinking…`, and `elapsed / budget`. `setStatus` pinning
(used for "Closing browser...") is unchanged.

### Resize

Layout is left to flex. Small terminals are not special-cased: the history or
banner simply gets zero rows once the header, input, popup, and status rows
consume the height. No `resize` handler is added.

## Colour tokens

`packages/cli/src/tui/theme.ts` is the only place styles are defined. It
wraps OpenTUI styled-text helpers and is not configurable by vendors.

| Token | Used for | Style |
|---|---|---|
| `badge` | CLI name in the header | bold + inverse |
| `muted` | header detail, borders, `>`, guide, attachments, banner, popup directory part, popup hint | dim |
| `user` | user label | bold + ANSI blue |
| `assistant` | assistant label | bold + ANSI green |
| `error` | error label | bold + ANSI red |
| `errorText` | error body | ANSI red |
| `selected` | popup selection | inverse |

Colours are the 16 ANSI named colours so the terminal palette applies and
both light and dark themes stay readable. The first implementation task
verifies with a unit test that OpenTUI's `blue()` / `green()` / `red()`
produce indexed ANSI colours rather than fixed truecolour values; if they do
not, `theme.ts` builds them with `fg()` and an indexed `RGBA` instead. The
public token names do not change either way.

## Public API changes (`@chatbridge/cli`)

```ts
export interface CreateCliOptions {
  name: string;
  /** Shown in the startup banner and by --version. */
  version?: string;
  /** Startup banner, one element per row; replaces the default banner. */
  banner?: string[];
  // existing options unchanged
}
```

- `--version` / `-V` prints `name vX.Y.Z` (or just `name` when `version` is
  unset) to stdout and exits 0. `help()` lists it.
- Default banner (`banner` unset):
  1. `name vX.Y.Z` (or `name`)
  2. `Connected to <provider>. Type a message, or @ to attach a file.`
- A vendor banner is used verbatim, line by line; no placeholder
  substitution, no colour control. It is a plain `string[]` on purpose;
  per-line colour and width-aware functions were considered and deferred
  (YAGNI).
- `resolveBanner({ name, version, providerName, banner })` in
  `tui/banner.ts` is a pure function returning the styled lines, so the
  rule above is unit-testable without a renderer.
- `bin.ts` passes the package's own version to `createCli`.
- `InteractiveOptions` gains `banner: string[]` and already carries
  `headless`; both are forwarded to `ChatViewOptions`.

## Files

New: `tui/theme.ts`, `tui/theme.test.ts`, `tui/banner.ts`,
`tui/banner.test.ts`.

Updated: `tui/chat-view.ts`, `tui/mention-popup.ts`,
`tui/run-interactive.ts`, `create-cli.ts`, `bin.ts`, `index.ts` (type
export), their tests, `README.md` (`version`, `banner`, `--version`),
`docs/ROADMAP.md` (milestone 7 marked done at PR time).

Unchanged: `tui/chat-model.ts`, `mentions/*`, every other package.
OpenTUI stays at 0.5.10.

## Testing

Frame-based tests through `createTestRenderer`, as today. Frames carry no
colour or attributes, so layout and wording are asserted on frames while
styling is asserted on `theme.ts` directly.

- `theme.test.ts`: each token's chunk has the expected attributes and an
  indexed ANSI foreground where a colour is specified.
- `banner.test.ts`: default banner with and without `version`; vendor banner
  passed through verbatim.
- `chat-view.test.ts`: header format (`name provider · headless · 2s budget`);
  banner centred at start and gone after the first message; vendor banner
  lines drawn, over-wide lines truncated; input is one row when empty, grows
  to five with newlines, stops growing at six and scrolls, history shrinks
  accordingly; popup appears between input and status with the hint row and
  the status row still visible; existing key, spinner, attachment, and error
  tests updated for the new labels and kept.
- `mention-popup.test.ts`: rewritten for inline placement (no `bottom`).
- `run-interactive.test.ts`: `banner` and `headless` reach the view.
- `create-cli.test.ts`: `--version` / `-V` output with and without
  `version`; help mentions it; existing behaviour unchanged.
- Manual: run `chatbridge` in a real terminal in a light and a dark theme,
  attach screenshots to issue #28. Not automated.

## Out of scope

Streaming display, Markdown rendering, history persistence, vendor-configurable
colours, a minimum-size warning, and `@file` mentions in one-shot mode remain
in the roadmap backlog.
