# Milestone 17 (v0.10.0): TUI clipboard and focus

Tracking issue: #71. This spec covers #99 (keep focus on the chat input), #98
(copy a mouse selection) and #100 (`/copy`). Reply rendering (#96, #72, #71) and
#103 are in `2026-09-20-reply-rendering-design.md`; one plan implements both,
and this spec's work comes after it because it depends on the `selectable`
flags and the `incomplete` marker defined there.

## Problem

OpenTUI captures the mouse, so the terminal's own select-to-copy no longer
works in the interactive TUI, and the TUI does nothing with its own selection.
There is no keyboard way to get a reply onto the clipboard either. Clicking
anywhere outside the input moves focus away from it, and typing stops working
until the input is clicked again.

## Goals

1. Dragging over history text copies it on mouse up.
2. `/copy` copies the last assistant reply, in the TUI and in VSCode.
3. Keystrokes always reach the chat input.

Non-goals: `/copy` arguments (`N`, `all`, `code`), a paste handler, copying
from the VSCode transcript by any means other than `/copy` (the webview already
has native selection), and clipboard *reads*.

## 1. Clipboard transport (`packages/cli/src/tui/clipboard.ts`)

```ts
copyToClipboard(text: string, deps: ClipboardDeps): Promise<boolean>;
```

`ClipboardDeps` carries `env`, `platform`, `process` (the child-process seam) and
`osc52: (text: string) => boolean` (bound to `renderer.copyToClipboardOSC52`),
so the module itself does not import OpenTUI.

- Over SSH (`SSH_TTY` or `SSH_CONNECTION` set): OSC 52 only. A platform command
  would write to the remote machine's clipboard.
- Local: the platform command first — `pbcopy` (darwin), `wl-copy` when
  `WAYLAND_DISPLAY` is set, else `xclip -selection clipboard` (linux),
  `clip.exe` (win32) — with the text on stdin and a 2 s budget. If the command
  is missing or exits non-zero, fall back to OSC 52. The command comes first
  locally because OSC 52 cannot report success and macOS Terminal.app ignores it.
- Returns `true` when the command exited 0 or OSC 52 was written.
- The copied text is never logged and never passed as a command argument.

The status line shows `copied` or `copy failed` for about 2 s, then returns to
whatever it would show otherwise.

## 2. Select to copy (#98)

`ChatView` subscribes to the renderer's selection event. When a selection ends
with non-empty text, that text is copied through `copyToClipboard`. The
selection highlight is left as OpenTUI draws it and clears on the next click.

Renderables that are not message text are `selectable: false`: role labels,
separators, attachment lines, the `(incomplete)` line, the pending indicator
row, the banner, the queue list and the status line. A selection therefore
yields message text only.

The copied text is what is on screen: for a Markdown reply that is the rendered
text with markup concealed. The Markdown source is what `/copy` is for.

Mouse handling stays whatever `createCliRenderer` enables by default; the plan
verifies that it is on and sets `useMouse: true` explicitly if it is not.

## 3. Focus stays on the input (#99)

Either the renderer is created with `autoFocus: false`, so a click never moves
focus, or `ChatView` hands focus back when the input reports a blur. The plan's
first task verifies which one works with selection and wheel scrolling intact,
and the implementation uses exactly one. Other renderables stay clickable (the
history still starts a selection and scrolls by wheel).

History scrolling by key must keep working with the input focused. The plan
checks whether PgUp/PgDn currently depend on the scroll box having focus; if
they do, the global `handleKey` gains PgUp/PgDn that scroll the history by a
page. The mention and command popups are driven from the input and are
unaffected.

## 4. `/copy` (#100)

- `BUILTIN_COMMAND_NAMES` (`packages/provider`) and `SLASH_COMMANDS`
  (`packages/core/src/slash-commands.ts`) gain `copy` — "Copy the last reply to
  the clipboard". It takes no arguments, like every built-in, and appears in
  `/help` and in both completion popups through the existing lists.
- A provider that defines its own `copy` command is now rejected by
  `defineProvider()` (existing built-in precedence rule). Called out in the
  release notes.
- It copies the `text` of the newest assistant message that is not
  `incomplete`, i.e. the text as the provider returned it (Markdown source for
  a Markdown provider). It never opens a session, never sends anything to the
  service, never adds a turn, and works while the session is closed, dead or
  idle-closed. While a turn is pending it copies the last settled reply.
- Feedback: `copied`, `copy failed`, or `nothing to copy yet`.
- TUI: `ChatModel` handles it through an injected `copy: (text) => Promise<boolean>`
  that `runInteractive` binds to `copyToClipboard`; feedback goes to the status
  line, not the history.
- VSCode: `SessionController` exposes `lastReply()`; the `copy` handler lives in
  `commands.ts` with the other command handlers and takes an injected
  `writeClipboard: (text: string) => Thenable<void>`, which `create-extension.ts`
  binds to `vscode.env.clipboard.writeText`. Feedback is an information message
  (a warning when the write fails). `copy` joins `WebviewCommand`; it is a view
  command only, not a palette command, so the manifest is unchanged.

## 5. Documentation

READMEs of the CLI and the VSCode extension list `/copy`; the CLI README gains a
short "Copying text" section (drag to copy, `/copy`, the SSH/OSC 52 note and
that some terminals disable OSC 52).

## 6. Testing

- `clipboard.ts`: command chosen per platform/env, stdin carries the text, SSH
  forces OSC 52, fallback on missing command and on non-zero exit, timeout.
- `ChatModel`: `/copy` picks the newest complete reply, skips incomplete ones,
  reports `nothing to copy yet`, adds no message and opens no session.
- VSCode: `SessionController.lastReply()`, and the `copy` handler in
  `commands.ts` through an injected `writeClipboard` (copied, nothing to copy,
  write failed, no `writeClipboard` wired).
- `defineProvider`: a provider command named `copy` is rejected.
- `ChatView` (test renderer): selection end triggers a copy with the selected
  text; non-message renderables are not selectable; a click elsewhere leaves
  typing in the input;
  PgUp/PgDn scroll the history with the input focused.
