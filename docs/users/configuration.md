# Configuration

A chatbridge CLI reads one optional JSON file and a few environment variables. The VSCode extension uses VSCode settings instead; see [vscode.md](vscode.md). Examples below use `chatbridge`; substitute your vendor's binary name.

## The config file

```
~/.config/<configDir>/config.json
```

`<configDir>` is the CLI's name (`chatbridge` for the stock CLI) unless the vendor set a different directory with `createCli({ configDir })`. `chatbridge --help` prints the exact path.

A missing file is the same as an empty object `{}`. Keys you do not set keep their defaults. Unknown keys are ignored.

When the file is read:

| Command | Reads |
|---|---|
| Interactive mode (`chatbridge`) | The whole file, also when the vendor pinned the provider. |
| One-shot mode (`chatbridge -p`) | The whole file, also when the vendor pinned the provider. |
| `auth login`, `auth logout`, `auth status` | The file only when no provider is pinned and no `--provider` is given. Only `defaultProvider` is used, but the whole file is still checked, so a broken file fails the command. |
| `--help`, `--version` | Nothing. |

When the vendor pinned the provider, `defaultProvider` is ignored and not checked.

The file breaks the command, with exit 1, when it cannot be read, is not valid JSON, is not a JSON object at the top level, or a key has the wrong type or range. The message names the file and the problem:

```
chatbridge: Invalid config <path>: not valid JSON
chatbridge: Invalid config <path>: top level must be a JSON object
chatbridge: Invalid config <path>: "open.timeoutSec" must be a positive number
```

### Example

```json
{
  "defaultProvider": "./providers/my-provider",
  "shell": { "leadIn": "Here is the output.", "autoSend": false },
  "open": { "timeoutSec": 180, "retries": 1 },
  "idle": { "timeoutMin": 60 }
}
```

## Keys

| Key | Type | Default | Applies to |
|---|---|---|---|
| `defaultProvider` | string | unset | CLIs without a pinned provider, when `--provider` is not given. A value starting with `./` or `../` is resolved against the config file's directory; anything else is used as given (see [cli.md](cli.md)). |
| `shell.leadIn` | string | `Please check the execution result.` | Interactive `!` shell mode: the first line of the prompt sent after a command finishes. |
| `shell.autoSend` | boolean | `true` | Interactive `!` shell mode. `false` holds results and attaches them to your next message instead. |
| `open.timeoutSec` | number > 0 | `120` | The opening phase, in seconds. Interactive and one-shot mode. |
| `open.retries` | integer >= 0 | `0` | Extra attempts at the opening phase. Interactive and one-shot mode. |
| `idle.timeoutMin` | number >= 0 | `1440` (24 h) | Interactive mode only. Minutes without a turn before the browser is closed. `0` disables the idle close. |

The defaults for `open.*` and `idle.timeoutMin` are the built-in ones; the provider may ship its own (see [Precedence](#precedence)).

`shell`, `open` and `idle` must each be an object. Every message a bad value produces:

| Problem | Message after `Invalid config <path>: ` |
|---|---|
| `defaultProvider` not a string | `"defaultProvider" must be a string` |
| `shell` not an object | `"shell" must be an object` |
| `shell.leadIn` not a string | `"shell.leadIn" must be a string` |
| `shell.autoSend` not a boolean | `"shell.autoSend" must be a boolean` |
| `open` not an object | `"open" must be an object` |
| `open.timeoutSec` not a finite number > 0 | `"open.timeoutSec" must be a positive number` |
| `open.retries` not an integer >= 0 | `"open.retries" must be a non-negative integer` |
| `idle` not an object | `"idle" must be an object` |
| `idle.timeoutMin` not a finite number >= 0 | `"idle.timeoutMin" must be a non-negative number` |
| File exists but cannot be read | `could not read the file` |

There is no config key for the per-turn timeout; use `--timeout` (see [cli.md](cli.md)).

## Environment variables

Values are trimmed first. An empty or blank value counts as unset.

| Variable | Overrides | Read by |
|---|---|---|
| `CHATBRIDGE_OPEN_TIMEOUT` | `open.timeoutSec`. Seconds, greater than 0. | Interactive and one-shot mode |
| `CHATBRIDGE_OPEN_RETRIES` | `open.retries`. Integer, 0 or more. | Interactive and one-shot mode |
| `CHATBRIDGE_IDLE_TIMEOUT` | `idle.timeoutMin`. Minutes, 0 or more; `0` disables. | Interactive mode |
| `CHATBRIDGE_DEBUG` | Nothing. When exactly `1`, a framework error also prints its cause as `Caused by: <stack or message>`. | Every command |
| `SHELL` | Nothing. The shell that runs `!` commands; `/bin/sh` when unset or empty. | Interactive `!` shell mode |

An invalid value exits 1 with one of these messages, where `<value>` is the trimmed value in quotes:

```
chatbridge: CHATBRIDGE_OPEN_TIMEOUT must be a positive number of seconds, got "<value>"
chatbridge: CHATBRIDGE_OPEN_RETRIES must be a non-negative integer, got "<value>"
chatbridge: CHATBRIDGE_IDLE_TIMEOUT must be a non-negative number of minutes (0 disables), got "<value>"
```

For the full list of exit codes, see [cli.md](cli.md#exit-codes).

## Precedence

Each knob is resolved from layers. A later layer wins, and only for the keys it sets.

### Provider selection

1. `defaultProvider` in `config.json`.
2. `--provider`.
3. A provider pinned by the vendor with `createCli({ provider })`. `--provider` is then rejected and `defaultProvider` is ignored.

With none of them, the CLI exits 5. See [cli.md](cli.md) for the message.

### Opening phase

The opening phase is launch, go to the chat page, check the login, then restore the conversation or start a new chat. It has its own timeout per step and a retry count. `--timeout` does not cover it.

In the CLI, for `timeoutSec` and `retries` separately:

1. Built-in: 120 s, 0 retries.
2. The provider's `open` defaults.
3. `open` in `config.json`.
4. `CHATBRIDGE_OPEN_TIMEOUT` and `CHATBRIDGE_OPEN_RETRIES`.

There is no flag.

A retry closes the browser and runs the whole phase again. Progress shows `Attempt <n> failed: <message>` and then `Opening browser... (attempt <n>/<total>)`. These failures are never retried, because opening again cannot fix them: no saved auth state, expired auth state, blocked by the service, and Chromium not installed. The last attempt's error is the one reported.

In VSCode, `config.json` and the environment variables are not read. The opening timeout is the provider's `open.timeoutMs` if it sets one, else the per-turn timeout below. Retries are the provider's `open.retries`, else 0.

### Per-turn timeout

| Where | Resolution |
|---|---|
| CLI | `--timeout <sec>`, else 120 s. |
| VSCode | The `<id>.timeoutSec` setting, else the vendor's `createExtension({ timeoutMs })`, else 120 s. An invalid setting shows a warning once and uses the fallback. |

No config key and no environment variable set it.

### Idle close

Interactive sessions close their browser after a stretch without a turn. The next message opens it again; see [interactive-mode.md](interactive-mode.md) and [../providers/extension-points/open-browser-idle.md](../providers/extension-points/open-browser-idle.md).

In the CLI:

1. Built-in: 24 hours.
2. The provider's `idle.timeoutMs`.
3. `idle.timeoutMin` in `config.json`.
4. `CHATBRIDGE_IDLE_TIMEOUT`.

`0` at any layer disables the idle close. One-shot mode never arms it.

In VSCode, the `<id>.idleTimeoutMinutes` setting replaces layers 3 and 4: unset means the provider's `idle.timeoutMs`, else 24 hours. An invalid setting shows a warning once and uses that fallback.

### `!` shell mode

1. Built-in: `leadIn` is `Please check the execution result.`, `autoSend` is `true`.
2. The vendor's `createCli({ shell })`.
3. `shell` in `config.json`.

`shell` in `config.json` applies even when the vendor pinned the provider.

### Browser reduced motion

The browser runs with reduced motion by default. Only the provider can change it (`browser.reducedMotion`); there is no user setting.

## Files on disk

| File | Holds | Written by | Removed by |
|---|---|---|---|
| `~/.config/<configDir>/config.json` | Your settings. | You. The CLI never writes it. | You. |
| `~/.config/<configDir>/auth/<provider name>.json` | The saved browser session: cookies, localStorage and IndexedDB. | A login (`auth login`, `/login`, the VSCode login). Also refreshed when a session closes while still logged in, so rotated cookies are kept. | `auth logout`, `/logout` in interactive mode, and the VSCode Log out command. |

The auth directory is created with mode `0700` and the state file with mode `0600`. Logging out deletes only that provider's state file; `config.json` and other providers' files stay.

The VSCode extension uses `<configDir>` too. It defaults to the extension's id, and a vendor that sets it to the CLI's `configDir` lets one `auth login` serve both.

The auth state file holds live session cookies. Treat it like a password:

- Keep it out of version control.
- Do not paste it into logs, issues or chat.
- Do not loosen its permissions.
