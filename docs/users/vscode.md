# VSCode extension

A chatbridge VSCode extension puts `<Vendor>` in the activity bar as a chat
view. Every contributed command shows in the command palette as
`<Vendor>: <title>`.

## Install and first run

The extension needs Chromium once. Either:

- Run the command `<Vendor>: Install Browser` from the palette. It runs
  `playwright install chromium` from the Playwright bundled with the
  extension and reports progress with notifications: `Installing Chromium`,
  then `Chromium installed.` on success or `Chromium install failed: <msg>`
  on failure.
- Or install it yourself: `npx playwright install chromium`.

If a send fails because Chromium is missing, the error offers an `Install`
button that runs the same install and retries the turn.

## Commands

| Command | Does |
|---|---|
| Log in | Shows a cancellable notification `Log in to <Vendor>`. Refused while a turn is in flight: `Wait for the current reply to finish, then log in.` On success, a `Logged in` separator is added to the history. |
| Log out | Deletes the saved auth state, closes the browser, adds a `Logged out` separator, and forgets the current conversation. |
| New Chat | Closes the browser and adds a `New chat` separator; the browser reopens lazily on the next send. Refused mid-turn: `Wait for the current reply to finish, or press Ctrl+R to reopen.` |
| Reopen Browser (Ctrl+R / Cmd+R while the view is focused) | Replaces the browser regardless of its current state and adds a `reopened` separator, including a restore note about the conversation. |
| Send Selection to \<Vendor\> (editor context menu) | Attaches the current selection as `<path>:L<start>-L<end>` (1-based, inclusive lines), or the whole buffer when nothing is selected. |
| Send File to \<Vendor\> (explorer context menu) | Attaches the chosen file, or the active editor's buffer when invoked with no file argument. |
| Focus Chat | Focuses the chat view. |
| Help (optional; only if the vendor's manifest declares it) | Focuses the view and prints the `/help` listing into the history. |

## Settings

Settings are re-read at the start of every session, so a change takes effect
the next time the browser opens.

| Setting | Default | Notes |
|---|---|---|
| `<id>.headless` | `true` | Set to `false` to show the browser; this is the remedy suggested when a turn fails with `BLOCKED`. |
| `<id>.timeoutSec` | The vendor's `timeoutMs`, or 120 seconds | Applies to each turn and to the opening phase. An invalid value shows one warning per session and falls back to the default. |
| `<id>.idleTimeoutMinutes` | The provider's own idle timeout, or 1440 minutes (24 hours); `0` disables it | An invalid value shows one warning per session and falls back to the default. |

See [configuration.md](configuration.md) for how these settings relate to
the CLI's own configuration.

## Composer and attachments

The composer is a textarea with the placeholder `Message…`.

- **Enter** sends the message, or queues it if a turn is already running.
  **Shift+Enter** inserts a newline instead.
- **Up** on an empty composer takes the last queued message back for
  editing. Its attachments come back as chips; if any no longer fit, you see
  `N attachment(s) left out: total size limit.`
- **`+`** opens a native file picker (`Attach`) to add attachments.
- **`/`** opens the slash-command menu.
- An attachment-only message (no text) is allowed.

Attachments render as chips: `📎 <path> (<size>)` with a `×` to remove them.
A chip can come from:

- The `+` picker.
- Dragging a file onto the composer while holding Shift (a plain drop opens
  the file in the editor instead).
- The Send Selection / Send File commands.
- Pasting text that exactly matches the active editor selection; it becomes
  a `path:Lx-Ly` chip instead of inline text.

A dashed ghost chip `+ <basename>` offers the active editor's file; clicking
it attaches the file's current contents, including unsaved edits.

Size limits apply per file and in total: `<path>: <kb> KB exceeds 200 KB`
and `attachments total <size> exceeds 1 MB`.

A sent message uses the same `### <path>` fenced attachment layout as the
terminal UI; see [interactive-mode.md](interactive-mode.md) for the exact
format. A provider's URL hooks attach content the same way; see
[URL hooks](../providers/extension-points/url-hooks.md).

## Slash commands

The composer uses the same parser and built-in commands as the terminal UI
(`/login`, `/logout`, `/new`, `/reopen`, `/copy`, `/help`, plus whatever the
provider adds); see [interactive-mode.md](interactive-mode.md) for the full
list. `/new` runs New Chat. `/copy` copies the last complete reply to the
clipboard and reports `Nothing to copy yet.`, `Copied the last reply.`, or
`Could not copy the last reply.` if the clipboard write fails. An unknown
command is shown inline above the composer rather than sent.

Typing `/` opens a completion menu: **Up/Down** move the selection, **Tab**
completes the word, **Enter** completes or, if the text is already a
complete command, sends it, and **Esc** closes the menu (it reopens if you
keep typing and the text still matches).

## Replies

Replies render as Markdown: headings, lists including task lists, tables,
blockquotes, and fenced code blocks with a language label and a Copy button
that reads `Copied` for 1.5 seconds after a click. Links are limited to
`http`/`https`; images are shown as plain links rather than rendered; raw
HTML is shown as text. There is no syntax colouring inside code blocks.

A reply streams into view as it is written. If the browser stops or errors
mid-reply, what streamed so far is kept and marked `(incomplete)`.

Separators (login, logout, new chat, reopen, idle close) render as
`— text —` in the history.

## Status, errors and recovery

While a turn is running, a spinner shows the latest progress line, plus
` · N queued` when messages are waiting. The same line appears in the status
bar and in an Output channel named `<Vendor>`.

When there is nothing to send to, a dead card appears in place of the
composer, with `Not logged in.` or `The chat stopped.` and buttons for
Log in, Reopen, and New chat. Two remedies are shown depending on the
failure:

- `Set the "<id>.headless" setting to false and try again.` when the site
  blocked the headless browser.
- `Run "<Vendor>: Install Browser" and send again.` when Chromium is not
  installed; sending also offers this as a modal Install button.

## Idle close

When a chat has been idle longer than `<id>.idleTimeoutMinutes`, the browser
closes and a `closed after idle` separator is added. The next message
reopens the browser lazily, restoring the conversation when possible and
adding a restore note otherwise.
