# CLI reference

## Synopsis

```
chatbridge [--provider <name|path>] [--headful] [--timeout <sec>]
chatbridge -p <prompt> [--provider <name|path>] [--headful] [--timeout <sec>]
chatbridge auth login [--provider <name|path>]
chatbridge auth logout [--provider <name|path>]
chatbridge auth status [--provider <name|path>]
chatbridge --version | -V
```

A vendor CLI that pins its provider drops `--provider` from every line above; passing it anyway is an error. Examples below use `chatbridge`; substitute your vendor's binary name.

## Flags

| Flag | Default | Notes |
|---|---|---|
| `-p, --prompt <text>` | unset | Runs one-shot mode. The reply is printed to stdout followed by a newline; nothing else goes to stdout. |
| `--provider <npm-package or ./path>` | unset | Which provider to load. Rejected when the CLI has a fixed provider, with exit 1: `<name> has a fixed provider; --provider is not accepted`. See "Where the provider comes from" below. |
| `--headful` | false | Shows the browser window instead of running headless. |
| `--timeout <sec>` | 120 | Per-turn timeout, and per URL-hook resolve in interactive mode (see `configuration.md`). Does not cover the browser's opening phase. Must be a finite number greater than 0, or: `--timeout must be a positive number of seconds`. |
| `-h, --help` | | Prints usage to stdout, exit 0. |
| `-V, --version` | | Prints `<name> v<version>` to stdout, exit 0. |

Extra positional arguments are otherwise unused; only `auth login`, `auth logout` and `auth status` are recognized subcommands.

If the arguments themselves cannot be parsed, the CLI prints `<name>: <message>`, a blank line and the help text to stderr, then exits 1.

## Modes

Dispatch order: `--help`, then `--version`, then `auth login` / `auth logout` / `auth status`, then interactive mode (no subcommand and no `-p`), then one-shot mode (`-p`). Anything else prints help to stdout and exits 1.

### One-shot mode

```
chatbridge -p "your prompt"
```

Sends one prompt, prints the reply to stdout, and exits 0. The whole reply is printed at once, as plain text: for a provider with `responseFormat: "markdown"` that is the Markdown source. Slash commands, URL hooks and `@file` mentions are interactive-only; the prompt is sent verbatim. Requires Node >= 20 or Bun (no interactive-mode runtime floor applies). Progress lines are written to stderr, and only when stderr is a TTY.

### Interactive mode

```
chatbridge
```

Opens a terminal chat. See `interactive-mode.md` for slash commands, `@file` mentions, `!` shell mode and keys.

Interactive mode requires both stdin and stdout to be a TTY:

```
interactive mode needs a terminal; use -p <prompt> for one-shot
```

It also requires Bun >= 1.3 or Node >= 26.4:

```
interactive mode needs Bun >= 1.3 or Node >= 26.4; use -p <prompt> on this runtime
```

Progress lines go to stderr, and only when stderr is a TTY, same as one-shot mode.

### Auth subcommands

```
chatbridge auth login
chatbridge auth logout
chatbridge auth status
```

`auth login` opens a headful browser for you to sign in manually. Progress is written to stderr. Pressing Ctrl-C cancels the login and exits 130.

`auth logout` deletes the saved auth state. When stderr is a TTY it prints:

```
✓ Auth state deleted
```

`auth status` prints one of these to stdout and always exits 0:

```
Auth state present for "<provider>" (<path>)
No auth state for "<provider>"
```

## Where the provider comes from

Resolution order: a provider pinned by the vendor CLI, then `--provider`, then `defaultProvider` in `config.json` (see `configuration.md`).

A `--provider` value starting with `./`, `../` or `/` is resolved as a path against the current directory. Anything else is treated as an npm package name; a globally installed CLI can only resolve a package name when that package is also installed globally.

The resolved module's default export must be a provider object with `name`, `chatUrl` and the five provider methods. If it is not, the CLI exits 5:

```
Module "<spec>" does not default-export a Provider (name, chatUrl, and the five methods are required).
```

If no provider is pinned, no `--provider` is given and `config.json` has no `defaultProvider`, the CLI exits 5:

```
No provider specified. Pass --provider <npm-package|./path> or set "defaultProvider" in <path>.
```

The provider's `name` must match `/^[a-z0-9][a-z0-9._-]{0,63}$/` (lowercase letters, digits, `.`, `_` or `-`, 1-64 characters, starting with a letter or digit) because it is used as a file name for the auth store. A name that does not match this exits 5.

## Exit codes

| Exit | When |
|---|---|
| 0 | Success. |
| 1 | Bad flag, bad `--timeout`, no TTY for interactive mode, an old runtime, a broken `config.json`, a missing provider spec, or any other unmapped error. |
| 2 | No saved auth state: `No saved auth state for provider "<name>". Run \`auth login\` first.` |
| 3 | Saved auth state is no longer valid: `Auth state for "<name>" is no longer valid. Run \`auth login\` again.` |
| 4 | A turn or step timed out: `Timed out during <step> after <ms> ms.` A timeout that coincides with a lost login is reported as 3 or 6 instead. |
| 5 | The provider could not be loaded, or its module or name is invalid. |
| 6 | Blocked by the service: `Blocked by "<name>": <description>. Try --headful.` |
| 7 | Chromium is not installed: the error message plus `Run: npx playwright install chromium`. |
| 130 | Login cancelled with Ctrl-C during `auth login`. |

## Debugging

Set `CHATBRIDGE_DEBUG=1` to append the underlying cause to a framework error:

```
Caused by: <stack or message>
```

If interactive mode cannot close the browser within 5 seconds while shutting down, it exits 1 with:

```
browser did not close within 5 s; exiting
```
