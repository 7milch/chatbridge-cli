# Milestone 17 (v0.10.0): reply rendering — wait indicator, Markdown, streaming

Tracking issue: #71. This spec covers #96 (wait indicator in the history), #72
(Markdown rendering in the TUI) and #71 (streaming display), plus #103 (teardown
must wait for an idle close that is still saving auth state), which touches the
same core seam. The milestone also carries #99, #98 and #100, which have their
own spec (`2026-09-20-tui-clipboard-focus-design.md`). One plan implements both.

## Problem

The interactive TUI shows an assistant reply only once it is complete, as raw
text, and paints the wait indicator on the status line below the input, away
from where the reply lands. Web chat services render Markdown to HTML, and
providers read `textContent`, so lists, code fences and tables are flattened
before the text ever reaches the UI. Long replies therefore mean a long blank
wait followed by a wall of unformatted text.

Separately, when the idle timeout fires, both UIs drop their session reference
before core has finished saving the rotated auth state, so a process exit in
that window (up to 5 s) loses the save (#103).

## Goals

1. Providers can return Markdown, with a shared DOM-to-Markdown helper so each
   provider does not write its own converter.
2. Providers can expose the in-progress reply text; core polls it and hands
   partial text to the UI while the existing completion contract stays in charge.
3. The TUI shows the wait indicator as the last row of the history, grows the
   streaming reply from that row, and renders Markdown replies.
4. A UI teardown waits for an idle close that is still in flight.

Non-goals: Markdown or streaming display in the VSCode chat view (its webview
has no HTML injection path today; a sanitiser and CSP review is a separate
backlog item), streaming in one-shot mode (stays batch), token-level deltas
(the UI always receives the whole text so far), conversation persistence
(#73, #74), and any change to how completion or timeouts are detected.

## 1. Provider fields and helper

`Provider` (`packages/provider/src/index.ts`) gains two optional fields. Both
are additive; existing providers compile and behave exactly as before.

```ts
/** Optional. What `waitForResponse` (and `streaming.responseText`) return.
 * "text" (default) is shown verbatim. "markdown" is rendered as Markdown by
 * UIs that support it; use `elementToMarkdown` to produce it from the DOM. */
responseFormat?: "markdown" | "text";

/** Optional. Lets interactive UIs show the reply while it is being written.
 * Core polls `responseText` while `waitForResponse` is pending; completion,
 * the final text and timeouts still come from `waitForResponse`. */
streaming?: {
  /** Text so far of the reply to the most recent `sendMessage`, in
   * `responseFormat`. `undefined` while only a placeholder exists. Must never
   * return an earlier turn's text. */
  responseText(page: Page): Promise<string | undefined>;
  /** Poll interval in ms. Default 250. */
  pollIntervalMs?: number;
};
```

`defineProvider()` rejects a `responseFormat` other than the two literals, a
`streaming` without a `responseText` function, and a `pollIntervalMs` that is
not a finite number greater than 0.

### `elementToMarkdown(locator: Locator): Promise<string>`

Exported from `@chatbridge/provider` (new file `element-to-markdown.ts`). It
runs one dependency-free DOM walker inside the page via `locator.evaluate` and
returns Markdown for the element's subtree:

| DOM | Markdown |
|---|---|
| `h1`–`h6` | `#`–`######` |
| `p`, block `div` | paragraph, blank line between blocks |
| `strong`/`b`, `em`/`i`, `del`/`s` | `**`, `*`, `~~` |
| inline `code` | backticks (fence length grows past any backtick run inside) |
| `pre` (with or without inner `code`) | fenced block; language from a `language-xxx` / `lang-xxx` class on `code` or `pre`; content is `textContent` verbatim |
| `ul` / `ol` (nested) | `- ` / `1. `, 2-space (ul) or 3-space (ol) indent per level, `start` honoured |
| `blockquote` | `> ` prefix on every line |
| `a[href]` | `[text](href)`; bare text when `href` is empty or `javascript:` |
| `table` | GFM pipe table; first row is the header; `\|` escaped in cells |
| `hr`, `br` | `---`, line break |
| `img` | `![alt](src)` |
| `button`, `svg`, `script`, `style`, `[aria-hidden="true"]` | skipped (copy buttons, icons) |
| anything else | its children, inline |

Text nodes are emitted as-is outside `pre`, with runs of whitespace collapsed;
Markdown-significant characters in plain text are not escaped (a reply that
shows a literal `*` keeps it; the rare mis-render is accepted over escaping
noise in `/copy` output). The result is trimmed and has no more than one blank
line in a row.

The walker is a single self-contained function (it is serialised into the
page), so it may not reference module scope.

## 2. Core

### `ChatSession.send(prompt, opts?)`

```ts
send(prompt: string, opts?: { onPartial?: (textSoFar: string) => void }): Promise<string>;
```

- The return value, guards, `runStep` wrapping, `diagnoseTimeout`, and the idle
  watch pause/resume are unchanged.
- When `opts.onPartial` is given **and** the provider has `streaming`, core
  polls after `sendMessage` has resolved and `waitForResponse` has started:
  1. wait `pollIntervalMs` (default 250);
  2. if `waitForResponse` has settled, stop;
  3. `await responseText(page)`; a rejection is swallowed;
  4. if `waitForResponse` has settled meanwhile, stop without emitting;
  5. if the value is a string and differs from the last emitted one, call
     `onPartial(value)`; go to 1.
  Polls never overlap, and no `onPartial` call happens after `send` settles.
  An `onPartial` that throws is swallowed; it must not fail the turn.
- The final text is always the `waitForResponse` result, never the last partial.
- Without `onPartial`, or without `provider.streaming`, no polling happens.
  `runOneShot` and the VSCode `SessionController` do not pass it.
- The poll timer goes through the existing injectable clock seam style
  (`pollSleep?: (ms: number) => Promise<void>` on `ChatSessionOptions`, test only).

`ChatSession` exposes `readonly responseFormat: "markdown" | "text"` (the
provider's value, default `"text"`), and both `ChatSessionLike` shapes gain it as
an optional member so fakes keep compiling.

### Idle expiry hands over the in-flight close (#103)

`ChatSessionOptions.onIdleExpired` becomes
`(closing: Promise<void>) => void`. `expireIdle` creates a deferred, calls
`onIdleExpired(deferred.promise)` first and synchronously (the ordering comment
stays true), then reports progress, runs `closeOrKill(this, IDLE_CLOSE_BUDGET_MS)`
and resolves the deferred in a `finally`. The promise never rejects.

- TUI: `ChatModel.idleExpired` stores it as `idleClosing`; the `finally` of
  `runInteractive` awaits it under the same `CLOSE_TIMEOUT_MS` budget it already
  uses for `closeWithTimeout(model.session, …)`, before destroying the renderer.
  A timeout takes the existing `teardownExitMessage` / `process.exit(1)` path.
- VSCode: `SessionController.idleExpired` stores it; `close()` (deactivate)
  awaits it under `closeTimeoutMs` before resolving.
- Each UI clears the stored promise once it settles.

This is the one VSCode change in this spec; it is a correctness fix, not a
rendering feature.

## 3. TUI

### The turn in flight lives outside the transcript

`ChatModel` gains `partial: string | undefined`: the reply text so far of the
turn in flight, updated by `onPartial` and cleared when the turn settles or a
reset makes it stale. It is never part of `messages`, so it cannot reach `/copy`
or any future transcript persistence. The elapsed timer and the spinner label
stay in `ChatView`, where they already live.

While the model is `busy`, `ChatView` paints a pending row as the last child of
the history scroll box, with `selectable: false`:

- no partial yet: one row, `<frame> <label>  <elapsed>s` (the #96 indicator);
- partial present: the assistant label, the body (Markdown or text, see below),
  and a trailing muted row `<frame> <elapsed>s`;
- on success: the body renderable is kept and becomes the settled message
  (content set to the final text, streaming switched off, trailing row removed,
  `selectable` restored). It is not removed and re-created, so nothing flickers
  or jumps.

Only the busy (waiting-for-reply) state moves. Shell `Running…` stays on the
status line (the shell entry already has a live footer in the history), as do
opening, logging-in, resetting, dead and the idle guide. During a turn the
status line drops the frame and label and shows
`<elapsed>s / <budget>s[ · N queued]` plus the usual key guide.

The scroll box keeps `stickyScroll` / `stickyStart: "bottom"`; a user who has
scrolled up is not pulled back down by partial updates.

If a turn fails while `partial` is set, the partial is appended to
`messages` as an assistant message with `incomplete: true`, rendered with a
muted `(incomplete)` line under it, followed by the error entry. This keeps the
text when only completion detection timed out. `/copy` skips incomplete
messages.

### Markdown

`Message` gains `format?: "markdown"` (set from `session.responseFormat` when
the assistant message is created) and `incomplete?: true`.

- Assistant messages with `format: "markdown"` render through OpenTUI's
  `MarkdownRenderable` with `conceal: true`; `streaming: true` while pending,
  `false` once settled. Tables use the OpenTUI default.
- Everything else (user, error, help, shell, separators, and assistant messages
  of `"text"` providers) renders exactly as today.
- `theme.ts` gains `markdownSyntaxStyle()`, built from the same ANSI indexed
  colours as the rest of the theme, so the terminal palette applies.
- Code-block highlighting uses OpenTUI's tree-sitter client when it loads under
  the running runtime (Bun and Node are both supported hosts); when it does not,
  code blocks render unhighlighted. The first plan task verifies which it is on
  both runtimes and records the result on the tracking issue; no fallback
  highlighter is added.
- `@opentui/core` stays lazily loaded and confined to `packages/cli/src/tui/`.

## 4. Dummy chat

`examples/dummy-chat/server.ts` gains an incremental mode that is the default:
the assistant element is created empty, grows in chunks on a timer while
`#chat-log[data-state="busy"]`, and flips to `idle` after the last chunk. The
reply is Markdown rendered to HTML by a tiny server-side renderer limited to
what the fixtures use (heading, paragraph, bold, list, fenced code, table), so
`elementToMarkdown` is exercised end to end. Chunk delay is configurable by a
query parameter so tests can run fast or observe several partials.

`examples/dummy-chat/provider.ts` sets `responseFormat: "markdown"`, returns
`elementToMarkdown(lastAssistant)` from `waitForResponse`, and implements
`streaming.responseText` over the same locator (`undefined` while the element
is empty).

## 5. Documentation

- Root README and `packages/cli` README: streaming and Markdown in interactive
  mode; one-shot and VSCode unchanged.
- Provider authoring guide and the `creating-provider-repo` skill:
  `responseFormat`, `elementToMarkdown`, `streaming.responseText`, with the rule
  that `responseText` must never return an earlier turn.
- Release notes (hand-edited into the generated notes): the `onIdleExpired`
  signature change for embedders of `@chatbridge/core`.

## 6. Testing

- `elementToMarkdown`: real-Chromium tests in `packages/runtime` (where the
  browser E2E harness lives), one HTML fixture per table row above plus a
  nested-list and a copy-button case.
- `defineProvider`: the three new rejections.
- Core polling, with a fake provider and the injected `pollSleep`: emits only on
  change, skips `undefined`, swallows `responseText` and `onPartial` throws,
  never emits after settle, never overlaps, and does not poll without
  `onPartial` or without `streaming`. Timeout diagnosis still runs with polling on.
- #103: core passes a promise that resolves only after the close finished and
  never rejects (including the kill fallback); `runInteractive` teardown and
  `SessionController.close()` each wait for it, and each give up at their budget.
- `ChatModel`: pending lifecycle, partial updates, incomplete-on-failure,
  `format` stamping.
- `ChatView` (existing test renderer): indicator row placement, in-place
  promotion to the settled message, `selectable` flags, status-line content
  during a turn, Markdown vs text renderable selection.
- CLI E2E against the incremental dummy: several partials are observed, the
  final text equals the Markdown source, one-shot output is unchanged in shape.
