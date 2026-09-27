# Milestone 26: Session resume and transcript persistence

Tracking issue: #119. This spec covers #119 (cross-process conversation resume)
and #74 (history persistence for the interactive transcript). One plan
implements both.

## Problem

An interactive session lives only in the process that runs it. The transcript
is an in-memory array, and the provider's conversation handle (milestone 19) is
an in-memory string: closing the TUI or the VSCode window loses both. A user who
wants to go back to yesterday's conversation has to find it in the service's own
web UI.

## Intent

Agreed with the maintainer during brainstorming:

- The goal is to return to an earlier **interactive** session from inside a
  running one, the way `/resume` works in Claude Code: type the command, pick a
  session from a list, get its transcript back and, when the provider supports
  it, the service-side conversation too.
- One-shot mode is not part of this. No startup flag is added.
- Saved sessions should need no housekeeping from the user: old ones disappear
  on their own.

## Goals

1. Every interactive session is saved to disk as it proceeds, in the TUI and in
   the VSCode chat view, unless the user turned saving off.
2. `/resume` lists the saved sessions of the current provider and reopens the
   chosen one: the transcript replaces the one on screen and the conversation
   handle, if any, is handed to `ChatSession.open`.
3. A session saved by the TUI can be resumed in VSCode and the reverse.
4. Saved sessions are pruned automatically and deleted on an explicit logout.
5. A failure to save, list or load never stops the chat.

## Non-goals

- A startup flag (`--continue`, `--resume`) and chaining one-shot `-p` runs.
  #119 named them; the maintainer dropped them. If they are wanted later they
  become a new backlog issue.
- Configuration keys for the retention period and the session cap.
- Type-to-filter in the TUI picker, deleting or renaming a single session.
- A `createCli` / `createExtension` option for a vendor to change the default
  of session saving.
- Encrypting saved sessions.
- Storing sessions in the OS temp directory. Considered and rejected: the path
  and the clean-up behaviour differ per OS, Windows in particular.
- Fixing the interactive `/logout` and the VSCode Log out command leaving the
  auth state on disk (#137). Both delete the saved sessions as this milestone
  intends; the auth-state deletion they already claim to do is a pre-existing
  defect, tracked separately.
- Stopping another running process from saving after a logout (#138).

## Design

### 1. Storage

```
<base>/<configDir>/sessions/<provider>/<id>.json
```

- `<base>` and `<configDir>` resolve exactly as for the auth state.
- Directories are created `0700`, files `0600`.
- `<provider>` has passed `validateProviderName`. `<id>` is a random UUID;
  `load` rejects an id that is not UUID-shaped, so an id can never name a path
  outside the directory.

```ts
interface SessionRecord {
  version: 1;
  id: string;
  provider: string;
  createdAt: string; // ISO 8601
  updatedAt: string;
  /** The provider's conversation handle as of the last successful turn. */
  conversation?: string;
  messages: StoredMessage[];
}

interface StoredMessage {
  role: "user" | "assistant" | "error" | "separator" | "shell";
  text: string;
  attachments?: { path: string; bytes: number }[];
  format?: "markdown";
  incomplete?: true;
  failed?: true;
  shell?: {
    command: string;
    output: string;
    exitCode: number | null;
    interrupted: boolean;
    droppedBytes: number;
    durationMs: number;
    signal?: string;
  };
}
```

`exitCode` is `null` on disk where the TUI holds `undefined`: a command that
was killed or stopped has none.

Not stored: the partial reply of a turn in flight, the queue, pending
attachments, `/help` output, the content of attached files (path and size only,
as in memory today), and the picker title (derived when listing).

#### Writing

`save` writes the whole record to a temporary file in the same directory,
fsyncs it, and renames it over the target. A crash or power loss leaves either
the previous content or the new content, never a truncated file. What can be
lost is the turn in flight.

#### Reading

A record is validated on read. A file that is not valid JSON, has a `version`
other than `1`, lacks a required field or has a field of the wrong type is an
**unreadable file**:

- `list` skips it silently.
- `load` returns `undefined`.
- It is never deleted on sight: an older build must not delete what a newer
  build wrote. It goes when its mtime is older than the retention period.
- It does not count towards the session cap.

#### Pruning

Runs when a session file is first created and when `list` is called.

1. Delete records whose `updatedAt` is more than 14 days old, unreadable files
   whose mtime is more than 14 days old, and temporary files whose mtime is more
   than 1 hour old.
2. If more than 50 records remain, delete the oldest by `updatedAt`.
3. Never delete the record of the current session.

14 days and 50 sessions are constants. The clock is injected for tests.

#### API (core)

```ts
class SessionStore {
  constructor(opts: { configDir: string; providerName: string; baseDir?: string });
  /** Newest first. Prunes. `current` is excluded from pruning. */
  list(opts?: { current?: string }): Promise<SessionSummary[]>;
  load(id: string): Promise<SessionRecord | undefined>;
  save(record: SessionRecord): Promise<void>;
  /** Deletes every session of this provider. For logout. */
  clear(): Promise<void>;
}

interface SessionSummary {
  id: string;
  updatedAt: string;
  /** First line of the first user message, truncated. */
  title: string;
  /** Number of user messages. */
  turns: number;
}
```

`SessionStore` lives in core: both UIs depend on core and the store has nothing
to do with the browser. It has no UI dependency. The stored message shape is
UI-neutral; the TUI and the VSCode host each convert between it and their own
`Message`.

### 2. When a session is saved

Both the TUI `ChatModel` and the VSCode `SessionController` follow this table.

| Event | Action |
|---|---|
| The first turn settles | Create the file. A session in which nothing was sent leaves no file. |
| A turn settles, success or failure | Rewrite |
| A `!` shell command ends (TUI) | Rewrite |
| `/reopen`, reopen after idle | Same session id; the separator is added and the file rewritten |
| `/new` | Switch to a new session id. The previous file stays. |
| Explicit logout | `SessionStore.clear()` |
| Quit | Nothing. Everything settled is already on disk. |

- Both UIs keep earlier history on screen after `/new`, so the screen can show
  several sessions. Each UI tracks where the current session starts in its
  message array and saves only from there.
- The stored handle follows the in-memory handle. When a failed restore drops
  the handle in memory, the next save drops it from the file.
- An expired login (`AUTH_EXPIRED`) deletes nothing. Only the three explicit
  logout entry points do: `auth logout`, the TUI `/logout`, the VSCode logout
  command.
- A failed save does not stop the chat. The UI shows
  `Could not save this session.` once per session, not per turn, and tries
  again on the next save.
- Nothing that settles while a logout is deleting the saved sessions is
  saved, and `/resume` is refused during that time, in both UIs.

### 3. Turning saving off

- CLI: `config.json` gains `sessions.enabled`, a boolean, default `true`. A
  value of another type is an `INVALID_CONFIG` error like the other keys.
- VSCode: the setting `<id>.saveSessions`, a boolean, default `true`. VSCode
  does not read `config.json`. It works undeclared; a manifest that declares it
  shows it in the settings UI.
- When off, nothing is saved or pruned, existing files are left alone, and
  `/resume` answers `Session saving is turned off.` An explicit logout still
  deletes them: it is the one way to remove what an earlier run saved.

### 4. `/resume`

`resume` joins `BUILTIN_COMMAND_NAMES` (provider) and `SLASH_COMMANDS` (core)
with the description `Go back to a saved session`. It takes no arguments. It
sits after `reopen` in the table: the popups complete the first match in table
order, and `/re` followed by Tab must keep completing to `/reopen`.

Flow:

1. The UI asks the store for the list, excluding the current session.
2. The user picks one or cancels. Cancelling changes nothing.
3. The record is loaded. The messages on screen are **replaced** by the
   record's messages; the current session id becomes the record's id and the
   in-memory handle becomes the record's handle.
4. The browser is reopened through the existing reset path, passing the handle.
5. A separator reports the outcome.
6. Later turns are saved into the same file, which moves it to the top of the
   list.

| Situation | Separator | Service side |
|---|---|---|
| The handle opened | `resumed · conversation restored` | The conversation continues |
| There was a handle and it did not open | `resumed · conversation could not be restored` | New chat; the handle is dropped from memory and file |
| No handle, or the provider has no `conversation` | `resumed · transcript only` | New chat |

The notes reuse `RESTORED_NOTE` and `NOT_RESTORED_NOTE` from
`conversation-note.ts`; `transcript only` is added there.

When `/resume` does nothing:

| Situation | Response |
|---|---|
| A turn, a shell command, a login, a reopen or the first open is in flight, or the queue is not empty | `Wait for the current step to finish before /resume.` |
| Saving is off | `Session saving is turned off.` |
| No saved session | `No saved sessions.` |
| The chosen file turned unreadable | `That session could not be loaded.` The current chat continues. |
| The browser fails to open after the transcript was swapped | The transcript stays, the error shows as for a failed `/reopen`, the handle is kept so that `/reopen` after a login tries the restore again |

`/new` abandons a turn in flight in the TUI; `/resume` refuses instead, because
a queued message would otherwise be sent into a different conversation. After
a fatal error nothing is in flight, so `/resume` works there and is, like
`/new`, a way out.

The sentences above are status-line notices in the TUI and notifications in
VSCode. They are not history entries, so they are never saved.

### 5. TUI picker

```
  09-26 14:32   Explain the retry logic in chat-session…   12 turns
> 09-25 09:10   Draft a release note for v0.12.0            3 turns
  09-21 22:05   Why does the idle close race with…          7 turns
```

- Built on the existing popup component above the input.
- Up / Down move, Enter selects, Esc cancels.
- More rows than the popup shows scroll; nothing is truncated silently.
- Times are local.
- The picker has its own hint, `↕ select · Enter resume · Esc cancel`; the
  mention and command popup keeps its `Tab/Enter accept` hint.
- When there are more sessions than the popup's eight rows, the hint ends with
  the position, ` · <selected>/<total>`, updated on every move.
- Widths are display cells, not code units: a Japanese character or an emoji
  takes two. Titles are padded to the widest by cells, and a title that would
  push the row past the terminal width is shortened by whole characters,
  ending with `…`, so the time and the turn count always show.
- The picker is modal: keys, including Ctrl+R and PgUp / PgDn, and pastes do
  not reach the input or the history. Ctrl+C still quits.

### 6. VSCode

- Entry points: `/resume` in the composer, and the command `<id>.resume`.
- `resume` joins `OPTIONAL_COMMAND_NAMES`: a manifest that does not declare it
  still gets a working `/resume`; it only misses the palette entry and the
  title-bar overflow entry. No existing vendor extension breaks.
- The picker is `vscode.window.showQuickPick` in the host: label is the title,
  description the turn count, detail the local time. Filtering by typing comes
  with it. The webview gets no picker UI.
- Protocol: `WebviewCommand` gains `"resume"`. No new frame. The swapped history
  travels in the ordinary state frame.
- The webview renders history incrementally. A history that was replaced rather
  than appended to must cause a full redraw; the pure function that decides this
  gets a test for it.
- VSCode has no `shell` role. A stored `shell` message is shown as one plain
  text entry, `$ <command>` followed by the output. The host keeps the stored
  messages as the source of truth and derives the displayed history from them,
  so resuming and saving in VSCode does not lose the `shell` data.
- `discard` already refuses while a turn is in flight; `/resume` follows the
  same rule.
- A logout claims the controller for its whole duration: no turn starts and
  nothing is saved from the moment it begins until the `Logged out` separator
  is pushed. A send that arrives meanwhile queues instead of running. New chat
  claims the controller the same way while it closes the browser.

### 7. Security and privacy

- A saved session holds what the user and the assistant wrote, and the handle.
  It gets the same file permissions as the auth state.
- The handle and message text never appear in a log line or an error message,
  `CHATBRIDGE_DEBUG=1` included. A file path may.
- A record read from disk is untrusted input: validated before use. The handle
  is only ever passed to the provider's `conversation.open`, whose failure
  already falls back to a new chat.
- The provider contract already says a handle must never embed credentials; the
  provider documentation repeats it now that handles reach the disk.
- Several processes: a logout deletes what is on disk at that moment. Another
  process of the same provider that is still running keeps its recorder and
  writes its conversation again at its next turn (#138). The user documentation
  says to quit the other sessions before logging out. Two processes that resume
  the same saved session each rewrite the whole file; the last save wins.

### 8. What a vendor sees

| | Change |
|---|---|
| Required | A provider that defines its own `/resume` command must rename it: `defineProvider` now rejects the name. |
| Required | A banner, footer or document that says conversations are not stored is no longer true and must be reworded. The templates said so until now. |
| Optional | Declare the `<id>.resume` command and the `<id>.saveSessions` setting in the extension manifest. |
| Unchanged | The `Provider` type, `createCli` options, `createExtension` options. |

The upgrade guide gets this entry and the vendor templates get the command and
the setting.

## Testing

| Subject | Covers | Kind |
|---|---|---|
| `SessionStore` | Round trip, `0700` / `0600`, replace by rename, unreadable files and unknown `version` skipped, malformed id rejected, `clear` | Unit, temp dir |
| Pruning | Age, cap, current session kept, unreadable files not counted, stale temp files removed; injected clock | Unit |
| Summary | Title truncation, turn count, a record with no user message | Unit |
| TUI `ChatModel` | Every row of the save table, id change on `/new`, every row of the "does nothing" table, the three separators, the save-failure notice shown once | Unit, fake store and session |
| TUI picker | Rows, movement, scrolling past the visible rows, Enter, Esc | Unit |
| VSCode `SessionController` | The same as the TUI model, plus the `shell` round trip | Unit |
| Webview history diff | A replaced history redraws in full | Unit |
| Manifest | `resume` is optional | Unit |
| Settings | `sessions.enabled` and invalid values; `saveSessions` | Unit |
| Resume E2E | Against the dummy chat: two turns, a fresh model over the same base dir, `/resume`, then `turns?` answers with the next turn number | E2E, real Chromium |
| Failed restore E2E | An unknown handle falls back to a new chat and the separator says so | E2E |
| Logout | Each of the three entry points deletes the sessions | Unit and E2E |

## Documentation

| File | Change |
|---|---|
| `docs/users/interactive-mode.md` | `/resume` in the command table, the resume flow and separators, the "handle lives only in memory" sentence |
| `docs/users/configuration.md` | `sessions.enabled`, `sessions/` in the files-on-disk table, retention and cap |
| `docs/users/vscode.md` | `/resume`, the command, the `saveSessions` setting |
| `docs/users/cli.md` | `auth logout` also deletes saved sessions |
| `docs/providers/extension-points/conversation.md` | Handles are now saved to disk; remove the "#119 not implemented" note |
| `docs/providers/` manifest page | The optional command and setting |
| `packages/provider/skills/upgrading-provider-repo/upgrade-guide.md` | The entry of section 8 |
| Vendor templates | Command and setting in `templates/vscode/package.json` |
| `README.md` | One line in the feature list |

## Implementation order

1. core: `SessionStore`, validation, pruning.
2. provider and core: `resume` as a built-in name, the `transcript only` note.
3. cli: `sessions.enabled`, saving from the TUI model, `/new` and logout.
4. cli: the TUI picker and `/resume`.
5. vscode: saving, `/resume`, QuickPick, the setting, the manifest.
6. E2E, documentation, upgrade guide, templates.
