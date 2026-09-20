# @chatbridge/cli

The CLI for [chatbridge](https://github.com/7milch/chatbridge-cli): drive browser-only web chat AI services from the command line.

## Modes

- `chatbridge -p "<prompt>"` — one-shot, response on stdout. Node >= 20 or Bun.
- `chatbridge` — interactive chat in the terminal. Bun >= 1.3 or Node >= 26.4.
- `chatbridge auth login|logout|status` — manage the saved browser auth state.

## Interactive mode

`chatbridge` starts the TUI at once and opens the browser behind it, so the
status row shows `Opening browser...` while the first chat is loading;
anything typed meanwhile is queued and sent when it is ready. If you are not
logged in, the error appears in the chat instead of on a bare terminal:
type `/login`, log in in the browser window that opens (Ctrl+C cancels it),
and the chat reopens with the new login.

Keys: Enter sends, Ctrl+J (or Shift+Enter under a kitty-protocol terminal)
inserts a newline, `@` attaches a file, `!` runs a shell command, Up takes
queued messages back, Ctrl+R reopens the browser, PgUp/PgDn (and the mouse
wheel) scroll the history, Ctrl+C quits.

Commands, typed on a line of their own:

- `/login` — log in in a browser window
- `/logout` — delete the saved login and close the chat
- `/new` — start a new chat
- `/reopen` — reopen the browser (also Ctrl+R)
- `/copy` — copy the last reply to the clipboard
- `/help` — list these commands

## Copying text

Drag the mouse over history text and release to copy the selection — what is
on screen (the rendered text, with any Markdown markup concealed). `/copy`
instead copies the last complete reply's source text, exactly as the
provider returned it (the Markdown source, for a provider that declares
`responseFormat: "markdown"`). Either way the status line shows `copied` or
`copy failed` for a couple of seconds.

Locally the platform clipboard command is used first (`pbcopy`, `wl-copy` or
`xclip`, `clip.exe`), falling back to the terminal escape sequence OSC 52.
Over SSH only OSC 52 is used, since a platform command would write to the
remote machine's clipboard, not yours — and some terminals disable OSC 52
(tmux needs `set -g set-clipboard on`; macOS Terminal.app ignores it
outright), so a copy over SSH can silently fail to reach the system
clipboard in those setups.
