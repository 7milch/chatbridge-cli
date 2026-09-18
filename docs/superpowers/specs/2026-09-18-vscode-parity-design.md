# VSCode extension parity (milestone 12) — Design

Issue #64. Follows the milestone 11 spec
(`2026-09-17-vscode-extension-design.md`); file and type names below refer
to that layout.

## Goal

Close four gaps between the VSCode sidebar and the interactive TUI, and add
slash commands to both:

1. **Message queue** in `SessionController`, with the TUI's semantics.
2. **Ctrl+R reopen** in the sidebar: replace the browser even mid-turn.
3. **Slash commands** `/login /logout /new /reopen /help`, defined once in
   core and handled by the TUI and the webview. `/login` in the TUI runs the
   headful login without leaving the TUI.
4. **Drop / paste attachments** in the webview: dropped files become
   attachment chips; pasted text that equals the active editor's selection
   becomes a `path:Lx-Ly` chip.

Out of scope: Markdown rendering, history persistence, `@` completion and
`!` shell mode in the webview (still "left for later" in the roadmap);
drop / paste in the TUI; changing the `auth login` CLI subcommand.

## Section 1: queue in `SessionController`

### Semantics (mirrors `ChatModel`)

- `send(text)` while the status is `busy`, `opening`, `reopening` or `dead`
  **queues** instead of refusing. The pending attachments go into the queue
  entry with the text (the composer is cleared, the chips disappear). A
  blank text with no attachments is still `EMPTY`.
- The queue drains one entry per turn end: after a reply, after a
  `RESPONSE_TIMEOUT` (status back to `idle`), and after a successful reopen.
  A fatal error (status `dead`) stops draining; the entries stay queued and
  drain again after New chat, Log in or reopen brings the controller back.
- `takeBack()` removes every queued entry and returns them in order; the
  webview puts the texts back into the composer (joined with a blank line,
  like the TUI) and the attachments back into the pending chips. Only called
  when the composer is empty.
- `removeQueued(index)` drops one entry (the × on a queue row).
- `newChat()` / `discard()` and `logout` keep the queue (the TUI keeps it
  across a reset too). Only `takeBack` / `removeQueued` empty it.

### Types

```ts
export interface QueueEntry {
  text: string;
  attachments: Attachment[];      // for the queue row and take-back
}
// controller-internal: QueueEntry plus the PendingAttachment contents
export interface State {
  status: Status;                  // gains "reopening"
  messages: Message[];
  pendingAttachments: Attachment[];
  queue: QueueEntry[];
  lastError?: string;
}
```

`SendResult` gains `{ ok: true; queued: true }` so the command layer can
skip the `BROWSER_UNAVAILABLE` retry prompt for a queued send (the error, if
any, surfaces when the entry is actually sent, through the history).

### Draining and stale turns

`runTurn` is split like the TUI's `sendPrompt`: the send half captures a
`generation` counter; a reopen bumps it, and a result from an older
generation is dropped (no history entry, no status change). Drain is
claimed synchronously at turn end, before `emit()`, so the webview never
renders an idle frame with entries waiting.

### Webview

- A `queue` list between the composer and the attachment chips, one row per
  entry: `text` (first line, ellipsised) plus `📎 N files` when the entry
  has attachments, and a × button (`removeQueued`). Hidden when empty.
- **Up** in an empty composer with a non-empty queue posts `takeBack`; the
  host answers with a `state` (queue empty) and the webview fills the
  composer from the entries it just displayed — the host adds the
  attachments back to `pendingAttachments` itself, so the next `state`
  carries them.
- The composer stays enabled while busy (it queues). The Send button label
  becomes `Queue` while the status is not `idle`/`closed`.
- Status row while busy with a queue: `Waiting... · 2 queued`.

## Section 2: reopen (Ctrl+R)

### Controller

```ts
/** Replaces the browser in every state: close-or-kill, reopen, mark the
 * history with a `reopened` separator, drain. Ignored while a reopen is
 * already running. */
reopen(): Promise<void>;
```

Status `reopening` while it runs (webview shows the spinner with
`Reopening browser...`). On success: `lastError` cleared, `reopened`
separator, status `idle`, drain. On failure: error entry, status `dead`,
`lastError` set, queue kept. The in-flight `send` of the previous
generation is abandoned; its promise still settles (with the stale result
dropped) so `commands.send` resolves.

Unlike `newChat`, `reopen` does **not** push a "New chat" separator and does
not clear `lastPrompt`; it is a recovery, not a conversation break.
`newChat` keeps refusing while busy, and now warns (`Wait for the current
reply to finish, or press Ctrl+R to reopen.`) — this closes item 9 of #59.

### Command and keybinding

New command `<id>.reopen` ("Reopen Browser"), added to `COMMAND_NAMES` (the
manifest check now requires eight commands; README and the dummy example
updated). The vendor manifest also declares

```json
"keybindings": [
  { "command": "<id>.reopen", "key": "ctrl+r", "mac": "cmd+r",
    "when": "focusedView == <id>.chat" }
]
```

Keybindings are not validated by `missingContributions` (like
`configuration`); the README lists the recommended entry. The webview also
listens for Ctrl+R / Cmd+R on its own document and posts
`{ type: "command", name: "reopen" }`, so the shortcut works when the
keybinding is missing from the manifest. The status row's `dead` state gains
a `Reopen` button next to `New chat`.

## Section 3: slash commands

### Shared table in core

`packages/core/src/slash-commands.ts`, no UI dependency:

```ts
export const SLASH_COMMANDS = [
  { name: "login",  description: "Log in in a browser window" },
  { name: "logout", description: "Delete the saved login and close the chat" },
  { name: "new",    description: "Start a new chat" },
  { name: "reopen", description: "Reopen the browser (also Ctrl+R)" },
  { name: "help",   description: "List these commands" },
] as const;
export type SlashCommand = (typeof SLASH_COMMANDS)[number]["name"];

/** `/name` on its own line (trailing whitespace allowed) → the command;
 * any other text → undefined. A leading `/` followed by an unknown word
 * → { unknown: "word" }. Text with more than one line is never a command. */
export function parseSlashCommand(text: string):
  | { command: SlashCommand } | { unknown: string } | undefined;
export function helpText(): string;   // one line per command, for the history
```

Only the bare form is a command. `/login now` or a second line makes the
text an ordinary message, so a prompt that happens to start with `/` is not
swallowed. An unknown `/word` is refused with an error entry
`Unknown command: /word. Type /help.` and the text stays in the composer.

### TUI

`ChatModel.submit` checks `parseSlashCommand` first (before mention
expansion and the queue): a command runs immediately in every status, it is
never queued.

| command  | ChatModel                                                            |
|----------|----------------------------------------------------------------------|
| `/new`   | `reset()` with the separator `new chat` instead of `reopened`        |
| `/reopen`| `reset()` (same as Ctrl+R)                                            |
| `/help`  | pushes a `help` entry (role `separator`-styled block with `helpText()`)|
| `/logout`| pushes a `Logged out` separator, `authStore.clear()`, then `reset()`; the new session fails with `AUTH_REQUIRED`, so the model ends `dead` with that error entry and `/login` recovers |
| `/login` | see below                                                             |

`/login` is a new status `logging-in`:

- `ChatModelOptions` gains `login: (opts: { signal, onProgress }) => Promise<void>`;
  `runInteractive` wires it to `runLogin({ provider, authStore, ... })`.
- Status row: `Log in in the browser window… (Ctrl+C cancel)`; progress
  messages replace the text. Input is queued meanwhile (same as `busy`).
- Ctrl+C aborts the signal instead of quitting (like a running shell
  command). `LoginAbortedError` → status back to what it was (`idle` or
  `dead`), `Login cancelled` separator.
- Success → `Logged in` separator, then `reset()` so the new browser
  context loads the saved state; the queue drains after that.
- Any other error → error entry, status back to the previous one.
- A second `/login` while one runs is ignored.

`waitForQuit` and the guide line learn the new status (`Ctrl+C cancel
login`). Startup is unchanged: an unauthenticated start still exits 2 with
the `auth login` hint, because the TUI cannot show a login before the
session exists.

### Webview

`submit()` in `main.ts` runs `parseSlashCommand`: a command posts
`{ type: "command", name }` (`new` → `newChat`, `login`, `logout`,
`reopen`) or, for `help`, renders the help block locally from
`SLASH_COMMANDS` (the table is imported into the bundle; core's entry point
is not, so `slash-commands.ts` is imported by path via a `@chatbridge/core/slash-commands`
export — add `"./slash-commands"` to core's `package.json` `exports`; the
webview bundle already inlines its imports via esbuild). Unknown → inline error
row under the composer, text kept. The commands then behave exactly like
the palette commands (`logout` warns while busy, etc.).

## Section 4: drop and paste in the webview

### Protocol additions

```ts
// webview → host
| { type: "attachUris"; uris: string[] }            // drop
| { type: "pasted"; id: number; text: string }      // paste
| { type: "takeBack" }
| { type: "removeQueued"; index: number }
| { type: "command"; name: "login" | "logout" | "newChat" | "installBrowser" | "reopen" }
// host → webview
| { type: "pasteResult"; id: number; attached: boolean }
```

### Drop

The webview's `drop` handler reads `text/uri-list` (one URI per line,
`#` comments skipped) and posts `attachUris`; `dragover` calls
`preventDefault` so the view is a drop target. VSCode fills `text/uri-list`
for explorer items and editor tabs. The host resolves each URI:

- `file:` / `vscode-remote:` schemes → `ui.openDocument(uri)` → `attach`
  (path relative to the workspace, whole content), same size limits and
  warnings as `sendFile`.
- A directory (`openDocument` throws) or any other scheme → one warning
  listing what was skipped; the rest still attach.

### Paste

On `paste` in the composer the webview takes the clipboard text, calls
`preventDefault`, posts `pasted { id, text }` and waits for `pasteResult`
with that id (a 500 ms timeout falls back to inserting the text). The host
compares the text with `ui.activeEditor()?.selection?.text`:

- Equal (after normalising `\r\n` to `\n`) → `attachEditor(editor, true)`
  (the existing `path:L4-L12` chip) and `attached: true`; the webview
  inserts nothing.
- Otherwise → `attached: false`; the webview inserts the text at the caret
  (`document.execCommand("insertText")` keeps undo working).

A single-line paste skips the round trip and is inserted directly: a
one-line selection is not worth a chip, and this keeps ordinary pastes
snappy.

### Display

Chips and history rows keep the existing `📎 path (size)` format; a
selection chip already reads `check-versions.sh:L4-L12 (312 B)`. No new
rendering.

## Section 5: testing

- `session-controller.test.ts`: queue (send while busy, drain order, stop
  on dead, take back with attachments, removeQueued), reopen (mid-turn
  stale result dropped, failure → dead keeps queue, ignored while running),
  `queued: true` result.
- `slash-commands.test.ts` (core): parse table, bare form only, unknown.
- `chat-model.test.ts`: each slash command, `/login` cancel / success /
  failure, queue drains after login, second `/login` ignored.
- `commands.test.ts`: `attachUris` mixed good/bad, paste equal / not equal,
  newChat-while-busy warning, reopen command.
- `chat-view-bridge.test.ts`: new message types routed.
- `examples/vscode-dummy-chat` E2E: one test each for "send while busy
  queues and drains", "Ctrl+R mid-turn recovers", "/help renders",
  "drop a file attaches" (dispatch a synthetic `drop` with `text/uri-list`
  on the webview — the E2E confirms the MIME type VSCode actually sends
  for an editor tab, recorded in the test), "paste selection attaches".
- Manifest test: eight commands required.

## Task order

1. Core: `slash-commands.ts` + export path.
2. Controller: queue + generation + reopen (unit tests).
3. Protocol + bridge + webview: queue list, take back, Reopen button,
   Ctrl+R, slash handling.
4. Commands + manifest + keybinding + README + dummy example.
5. Drop / paste (host side, then webview).
6. TUI: slash commands, `/login` status, run-interactive wiring.
7. E2E, ROADMAP entry, #59 item 9.
