# Milestone 19: VSCode Markdown and streaming, conversation handle

Tracking issue: #109. This spec covers #109 (Markdown and streaming display in
the VSCode chat view) and the in-process half of #73 (conversation resume through
a provider-exposed chat handle). One plan implements both.

## Problem

Milestone 17 gave the TUI streaming and Markdown rendering. The VSCode chat view
still shows a reply only once it is complete, as plain text: the host calls
`session.send(prompt)` without `onPartial`, the protocol `Message` carries no
format, and the webview renders everything through `textContent`. The webview
also rebuilds the whole history on every state frame, which would break
selection and scrolling as soon as partial text arrives several times a second.

Separately, a conversation lives only in the Playwright `Page`. When the idle
timeout closes the browser, or the user runs `/reopen`, the next open navigates
to `provider.chatUrl` and calls `startNewChat`, so the service-side conversation
is lost while the transcript on screen suggests it continues. The Provider
contract has no notion of conversation identity to reopen it with.

## Goals

1. The VSCode chat view renders assistant replies as Markdown when the provider
   returns Markdown, without any HTML injection path and with the CSP unchanged.
2. The VSCode chat view streams partial replies when the provider supports
   streaming, keeping selection and scroll position stable.
3. A provider can expose an opaque conversation handle and reopen a conversation
   from it; a URL-based helper makes the common case one line.
4. After an idle close or `/reopen`, the TUI and the VSCode view return to the
   same service-side conversation when the provider supports it, and say so.

## Non-goals

- Cross-process resume: saving the handle to disk, a `--continue` flag, chaining
  one-shot runs. A new backlog issue carries it; #73 closes with this milestone.
  The handle is an opaque string precisely so that it can be persisted later
  without another Provider change.
- Syntax highlighting of code blocks in the webview.
- History persistence (#74).
- A DOM test harness for the webview (#102). The DOM layer stays thin instead.
- Any change to `createExtension` options or to the required manifest
  `contributes`.

## Design

### 1. Conversation handle — provider

```ts
export interface ProviderConversation {
  /** Opaque handle for the conversation on the page; undefined when there is none yet. */
  handle(page: Page): Promise<string | undefined>;
  /** Bring the page to the conversation the handle names. */
  open(page: Page, handle: string): Promise<void>;
}

// Provider gains:
conversation?: ProviderConversation;

export function urlConversation(options: {
  match: RegExp | ((url: string) => boolean);
}): ProviderConversation;
```

- `urlConversation().handle` returns `page.url()` when it satisfies `match`,
  otherwise `undefined`. `open` rejects a handle that does not satisfy `match`,
  calls `page.goto(handle)`, and throws when the page did not end on a URL that
  satisfies `match` — a service answers an unknown id by redirecting to the
  plain chat page, and that must read as a failed restore.
- `defineProvider` validates that `conversation.handle` and `conversation.open`
  are functions. `urlConversation` rejects a `match` RegExp carrying the `g` or
  `y` flag, as URL hooks do, and throws at construction time.
- The handle's content is the provider's business. A service that does not put
  the conversation id in the URL implements `open` by other means (for example a
  sidebar click).

### 2. Conversation handle — core

- `ChatSession.open` options gain `conversation?: string`.
- The opening phase becomes: launch → `goto(chatUrl)` → `assertLoggedIn` → if a
  handle was given and `provider.conversation` exists, `conversation.open(page,
  handle)`; otherwise `startNewChat(page)`.
- Restoring never fails the open. If `conversation.open` throws or times out, or
  if the page's origin afterwards differs from the origin of `chatUrl`, core
  navigates back to `chatUrl` and calls `startNewChat`. The session exposes
  `restored: boolean | undefined`: `true` when the handle was opened, `false`
  when the fallback ran, `undefined` when no handle was given or the provider has
  no `conversation`.
- After every successful `send`, core calls `provider.conversation?.handle(page)`
  and keeps the result in `session.conversation` (a getter). A throw is swallowed
  and the previous value kept. An `undefined` result also keeps the previous
  value. The handle is never logged or put in an error message.
- `runOneShot` is unchanged.

### 3. Conversation handle — callers

Both the TUI `ChatModel` and the VSCode `SessionController`:

- remember the last `session.conversation` in memory, surviving the session
  object being dropped;
- pass it as `conversation` on the next open after an idle close or a reopen;
- forget it on new chat and on logout;
- word the separator by outcome: `reopened · conversation restored` when
  `restored === true`, `reopened · conversation could not be restored` when
  `false`, and the existing wording when `undefined`. The idle-close separator
  keeps its wording when it is pushed; the outcome line is pushed when the lazy
  reopen completes.

### 4. VSCode protocol and host

- `Message` gains `format?: "markdown" | "text"` and `incomplete?: true`. The host
  copies `session.responseFormat` onto assistant messages only; user, error,
  separator and help messages render verbatim as today.
- `ToWebview` gains `{ type: "partial"; text: string; format: "markdown" | "text" }`,
  carrying the full in-progress text of the assistant reply being streamed and
  how to render it. It is deliberately not a
  field of `State`: a state frame carries the whole history, and sending it at
  polling frequency would be wasteful and would drive full re-renders.
- `ChatSessionLike` widens to `send(prompt, options?: { onPartial? })` and exposes
  `responseFormat`, `conversation` and `restored`.
- `runTurn` passes `onPartial`. A partial is posted only when the turn's
  `generation` is still current, reusing the existing stale-turn guard.
- When a turn fails after partial text arrived, the host pushes that text as an
  assistant message with `incomplete: true`, then the error message, matching the
  TUI.
- A provider without `streaming` never triggers `onPartial`; behaviour is then
  exactly today's.
- A settled turn still ends with a `state` frame; the webview replaces the
  streaming node with the settled message.

### 5. Webview rendering

New pure modules under `src/webview/`, no DOM access, tested with `bun test`:

- `markdown-tree.ts` — `toTree(markdown: string): TreeNode[]`. Runs
  `marked.lexer()` (tokens only; marked never produces HTML here) and maps tokens
  to plain nodes `{ tag, className?, text?, href?, lang?, children? }`. Covered:
  headings, paragraphs, ordered/unordered/nested/task lists, blockquotes, GFM
  tables (alignment as a class), `hr`, fenced and indented code, strong, em, del,
  inline code, links, line breaks. Safety rules:
  - `html` tokens become literal text;
  - a link gets an `href` only for `http:` and `https:`; anything else renders as
    text;
  - images are never loaded: they become a link showing the alt text, so
    `img-src` in the CSP stays as it is;
  - an unknown token type renders its `raw` as text;
  - `toTree` never throws on truncated input (an unclosed fence is a code block).
- `stream-state.ts` — decides, from the settled messages and the current partial,
  which rendered messages are kept, replaced, appended or removed, and whether
  the streaming node exists. Same role as `view-state.ts`.

`marked` is added as a devDependency of `@chatbridge/vscode`; esbuild inlines it
into `dist/webview/main.js`. Vendors copy `dist/webview` as before.

DOM layer in `main.ts`:

- `renderTree(nodes)` builds a `DocumentFragment` with `createElement`,
  `textContent`, `className` and `setAttribute("href", …)` only. `innerHTML` stays
  unused.
- `render(s)` stops replacing the whole history. It applies the `stream-state`
  decision, so settled message nodes are reused and a text selection inside them
  survives.
- A `partial` frame updates only the streaming node, coalesced to one update per
  animation frame. The Markdown tree is rebuilt from the full partial each time.
  The existing at-bottom scroll guard decides whether to follow.
- A code block gets a header with the language label, when present, and a copy
  button. Copy always goes through the host, with a new
  `{ type: "copyText"; text }` message (the existing `copy` command means "copy
  the last reply") handled with
  `vscode.env.clipboard`.
- An incomplete message gets a class and a short trailing marker.
- Styles are classes in `style.css` using VSCode theme variables. No inline
  styles, no injected `<style>`.

### 6. Vendor-facing changes

- `packages/provider/skills/upgrading-provider-repo/upgrade-guide.md` gains a
  section for the release with:
  - `### Conversation handle` — Optional, `Needs DOM observation: yes` (the
    conversation URL shape must be observed). Change: add `conversation:
    urlConversation({ match })`. Verify: two turns interactively, `/reopen`, then a
    follow-up that depends on the earlier turns is answered in context and the
    separator says the conversation was restored.
  - `### Markdown and streaming in the VSCode view` — Optional, `Needs DOM
    observation: no`. Change: bump `@chatbridge/vscode` and re-copy
    `dist/webview`; rendering follows `responseFormat` and `streaming` already on
    the provider. `**VSCode manifest:** none.`
- The provider template in `creating-provider-repo` gains a commented
  `urlConversation` line.
- The dummy-chat fixture gains per-conversation URLs so E2E can cover restore.

## Error handling

| Situation | Behaviour |
|---|---|
| `conversation.open` throws or times out | Fall back to `chatUrl` + `startNewChat`; `restored = false`; open succeeds |
| Page ends on another origin after `conversation.open` | Same fallback |
| `conversation.handle` throws or returns `undefined` | Keep the previous handle; the turn still succeeds |
| Turn fails after partials | Partial kept as an `incomplete` assistant message, then the error |
| Partial arrives for a stale generation | Dropped by the host |
| Malformed or truncated Markdown | Rendered best-effort; `toTree` never throws |

## Testing

- `provider`: `urlConversation` (match by RegExp and by function, flag
  rejection, `handle` undefined off-conversation), `defineProvider` validation.
- `core`: the opening phase with and without a handle, fallback on throw, fallback
  on origin change, `restored` values, handle refresh after `send`, swallowed
  `handle` errors, the handle never appearing in logs or errors.
- `runtime`/`cli` E2E with dummy-chat: two turns, reopen, the same conversation is
  back; an invalid handle falls back to a new chat.
- `cli` TUI `ChatModel`: remember, pass, forget; separator wording.
- `vscode` host: `onPartial` → `partial` frames, stale partial dropped,
  `incomplete` on failure, `format` copied onto assistant messages, handle
  remember/pass/forget, separator wording, `copyText` message.
- `vscode` webview: `markdown-tree.test.ts` (each construct, every safety rule,
  truncated input, samples of `elementToMarkdown` output) and
  `stream-state.test.ts` (settled nodes kept, partial replaced by the settled
  message, streaming node lifecycle).
- `webview-html.test.ts` keeps pinning the CSP unchanged.

## Release

Additive `Provider` surface plus a VSCode feature: a minor bump (0.11.0), to be
confirmed with the maintainer at ship time. The unreleased light-terminal fix
(#118) rides along.
