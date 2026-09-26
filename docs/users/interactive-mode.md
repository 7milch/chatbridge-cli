# Interactive mode

The terminal chat you get from running `chatbridge` with no `-p`. See [cli.md](cli.md) for how modes and flags are chosen, and [configuration.md](configuration.md) for the config keys this page mentions.

## Starting and the screen

The screen opens at once; the browser behind it starts in the background, with `Opening browser...` on the status line. Anything you type while it opens is queued and sent once the chat is ready.

The header shows the provider's title, then a badge:

```
<provider> · headless|headful · <N>s budget
```

`<N>s budget` is the per-turn response timeout. If the saved login has expired, the first error appears in the chat history rather than the header, ending with `Type /login to log in.`

## Slash commands

Type `/` followed by a word. Built-in commands run immediately in any state, even while a reply is streaming or the browser is closed. A provider command (one the provider defines itself) queues like an ordinary message instead.

| Command | Does |
|---|---|
| `/login` | Opens a headful login window. Status line reads `Log in in the browser window… (Ctrl+C cancel)`. On success, a `Logged in` separator appears and the browser reopens automatically. |
| `/logout` | Separator `Logged out`, deletes the saved auth state, reopens the browser, and forgets the current conversation. |
| `/new` | Separator `new chat`, reopens the browser, and forgets the current conversation. |
| `/reopen` | Same as Ctrl+R. Separator `reopened`; restores the conversation when the provider supports it, noted as `reopened · conversation restored` or `reopened · conversation could not be restored`. |
| `/copy` | Copies the last complete reply as raw text. Shows `copied`, `copy failed`, or `nothing to copy yet` on the status line for 2 seconds. |
| `/help` | Lists built-ins, then the provider's own commands, one aligned line each. |

### The `/` popup

Typing `/` at the start of the input opens a popup of the built-ins and the provider's commands, each with its description, filtered as you type. **Up/Down** select, **Tab** completes the word to `/name ` so you can type arguments, and **Enter** completes too, unless what you typed is already the whole command, in which case it runs. **Esc** closes the popup. Accepting an entry never runs it. `/` has no special meaning in `!` shell mode.

### Parsing rules

A line matches a slash command when it fits `/<word>`, where `<word>` is letters only (`/usr/bin` is never a command). Giving a built-in arguments is an error: `/<word> takes no arguments.` A word nobody defines reports `Unknown command: /<word>. Type /help.`

## `@file` mentions

Type `@` at the start of the line or right after whitespace, followed by a path up to the next whitespace. A bare `@` opens a popup to pick a file. There is no line-range suffix.

The popup's file index is built once at startup from the current directory. It honours every `.gitignore` on the way down, always skips `.git` and `node_modules`, never follows symlinks, and stops at 20,000 files. Matching is a case-insensitive subsequence search: a character matched at the start of a path segment scores 3, one right after `.`, `-`, or `_` scores 2, everywhere else scores 1; ties go to the shorter path.

A hand-typed path is resolved when you send the message, even if the index skipped it as gitignored.

If any mention has a problem, nothing is sent: the text returns to the input box and every problem is listed at once.

| Problem | Message |
|---|---|
| Path escapes the working directory | `@<mention>: outside working directory` |
| Path does not exist | `@<mention>: not found` |
| Path is a directory | `@<mention>: is a directory` |
| File too large | `@<mention>: <kb> KB exceeds 200 KB` |
| File is binary | `@<mention>: binary file` |
| Message too large overall | `attachments total <size> exceeds 1 MB` |

Limits: 200 KB per file, 1 MB per message. The 1 MB message limit is shared with [URL hooks](../providers/extension-points/url-hooks.md).

Each attached file is appended after your typed text as:

````
### <path>
```<lang>
<file content>
```
````

The fence is three backticks, or one more than the longest run of backticks already in the file, so the fence can never close early. The language on the info string comes from the extension: `ts`, `js`, `tsx`, `jsx`, `json`, `md`, `py`, `sh`, `yaml`, `yml`, `toml`, `html`, `css`, `rs`, `go`; anything else gets no language tag.

History shows each attachment as `📎 <path> (<size>)`.

## URL hooks

A URL a provider recognises in your typed text is fetched by the provider and attached the same way, under a label the hook supplies. Only the text you typed is scanned, not attached files. See [URL hooks](../providers/extension-points/url-hooks.md).

## Keys

| Key | Does |
|---|---|
| Enter | Send, or queue while a turn is in flight. |
| Shift+Enter (needs a kitty-protocol-capable terminal) or Ctrl+J | Insert a newline. The input grows up to 5 rows. |
| Ctrl+R | Reopen the browser, in any state. The old browser is killed if it has not closed within 5 seconds. |
| PageUp / PageDown, mouse wheel | Scroll the history. |
| Up, on the first line, with a queue | Pull the queued entries back into the input box. |
| Up / Down, Tab / Enter, Esc | In either popup (`@file` or `/`): move the selection, accept it, or close the popup. Enter submits instead of accepting when the typed word already matches the selected command. |
| Ctrl+C | Cancel a `/login` in progress, stop a running shell command, or otherwise quit. |
| Esc / Backspace / Ctrl+U, on an empty `!` prompt | Leave shell mode. |

Dragging the mouse over history text and releasing copies the selected text.

The status line's guide text changes with state:

```
Enter send · @ file · ! shell · / commands · Ctrl+R reopen · Ctrl+C quit
```

In shell mode:

```
Enter run · Esc exit shell · Ctrl+R reopen · Ctrl+C quit
```

While a shell result is held, the guide is prefixed with `📎 N held · `. After a fatal error (the chat is "dead"):

```
Ctrl+R reopen · /login · Ctrl+C quit
```

After the browser closes from being idle:

```
Browser closed after being idle · your next prompt reopens it
```

### Queued messages

A message sent while a reply is pending, while the browser opens, or while a `!` command runs is queued instead of dropped. Queued messages are listed above the input box and go out one per turn, oldest first, once the current turn ends (also after a Ctrl+R reopen). **Up** on the first line of the input takes the whole queue back into the box, one message per line, ahead of anything you have typed; Enter then queues the box again as one message, and clearing it drops them. A `!` command is never queued: it needs an idle session, so Enter leaves it in the box. In shell mode **Up** does not take the queue back; leave shell mode with **Esc** first.

## `!` shell mode

Typing `!` into an empty input switches to shell mode: the prompt turns into a yellow `! `, the placeholder reads `Run a shell command`, and the `@file` popup is disabled. Enter runs the command and returns to message mode.

The command runs as `$SHELL -c <command>` (falling back to `/bin/sh`), in the directory chatbridge was started in, in its own process group, with stdin closed and stderr merged into stdout. There is no sandbox, and `cd` inside the command does not persist to the next one.

Output is capped at 200 KB: past the cap the head of the output is dropped and the command is killed. Ctrl+C sends SIGTERM, then SIGKILL after 2 seconds if the process is still alive.

The history entry shows a `shell` label, `$ <command>`, the captured output, and a footer built from whichever of these apply:

- `… (truncated: first N KB dropped)`
- `exit code: N`
- `killed by <SIGNAL>`
- `interrupted`
- `did not start`
- `📎 held, sent with your next message`

When the result is sent, it goes out as `<leadIn>`, a blank line, then a fenced `### $ <command>` section with the captured output.

A result is held instead of sent automatically when `shell.autoSend` is `false`, while `/login` is in progress, or after an idle close. A held result travels with your next message and survives even if that message's own turn times out.

The lead-in text and whether results auto-send are configured with `shell.leadIn` and `shell.autoSend`; see [configuration.md](configuration.md).

## Replies and streaming

History labels are coloured: `user` blue, `assistant` green, `error` red, `shell` yellow. Separators appear as `── text ──`.

Assistant replies render as Markdown only when the provider declares `responseFormat: "markdown"`. Fenced code blocks get a left border once they finish streaming. Syntax colouring is available for JavaScript, TypeScript, Markdown, and Zig (from OpenTUI), plus Python, Ruby, JSON, Bash, and Go (bundled with the CLI). YAML and any other unrecognised language get a plain frame with no colouring.

While a reply streams, a spinner row shows `<frame> <label>  <s>s` and grows into the reply text as it arrives. If the reply fails partway through, the text that arrived is kept, marked `(incomplete)`.

The spinner defaults to the frames `●○○`, `○●○`, `○○●`, `○●○` at 120 ms per frame, with the label `Thinking…`; a vendor CLI may customise this.

A response timeout leaves the session usable for the next turn. Any other error makes the chat dead (see the guide text above); Ctrl+R or `/login` can bring it back. Quitting while the chat is dead exits with that error's code, for example 3 for an expired login or 6 for a block (see [cli.md](cli.md#exit-codes)).

## Idle close and reopen

After 24 hours without a turn (configurable; see [configuration.md](configuration.md)) the browser closes and the auth state is saved. The status guide changes to the idle message shown above. Your next prompt reopens the browser, with a `reopened after idle` separator plus the same restore note `/reopen` uses.

The conversation handle used to restore a chat lives only in memory: `/new` and `/logout` forget it, same as `/reopen`'s reset does when asked to forget.

While the browser is closed from being idle, `/copy` and `!` shell commands still work; a shell result is held and goes out with the next message.

## Copying

A mouse-drag selection copies what is on screen: for a Markdown reply, the rendered text with its markup concealed. `/copy` copies the last complete reply's source text, exactly as the provider returned it (the Markdown source, for a Markdown provider). Both use the same clipboard path. The CLI tries a platform tool first: `pbcopy` on macOS, `clip.exe` on Windows, and on Linux `wl-copy` when `WAYLAND_DISPLAY` is set, otherwise `xclip -selection clipboard`. Each gets a 2-second timeout before falling back to an OSC 52 escape sequence written straight to the terminal.

Over SSH (`SSH_TTY` or `SSH_CONNECTION` set), only OSC 52 is used, since a platform tool would fill the clipboard on the remote machine instead of yours. Some terminals disable OSC 52: tmux needs `set -g set-clipboard on`, and macOS Terminal.app ignores it outright, so in those setups a copy over SSH can silently fail to reach your clipboard.
