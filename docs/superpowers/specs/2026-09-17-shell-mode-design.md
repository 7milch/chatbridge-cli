# `!` shell mode in the interactive TUI — design

Milestone 10, issue #47. Brainstormed 2026-09-17 (promoted from backlog
item #38, which records Claude Code's verified behaviour).

## Goal

Let the user run a shell command from the interactive TUI and have the
service react to its output in the same turn, the way Claude Code's `!`
mode does. Typing `!` on an empty input switches the input box into shell
mode; Enter runs the command in the directory `chatbridge` was started in;
the command line and its output stream into the history; the result is then
sent to the service under a configurable lead-in. A configuration switch
holds the result back instead and attaches it to the next message the user
composes.

Everything lives in `@chatbridge/cli`. Core, runtime, and provider are
unchanged. One-shot mode (`-p`) is out of scope.

## Decisions

- **Extras from Claude Code:** only paste-into-empty-input (a pasted text
  that starts with `!` enters the mode too). `Tab` history completion, `/`
  path completion and `Ctrl+B` backgrounding stay in the backlog.
- **Commands run only from `idle`.** While a command runs the model is
  `running`: the input is locked like `busy`, the status row shows the
  elapsed time, and Ctrl+C stops the command instead of quitting. Running a
  command while a turn is in flight is a backlog item.
- **Messages queue while a command runs; commands do not.** `submit` while
  `running` queues the message (milestone 9's queue); it drains after the
  command's turn ends, or after a held command returns to idle, and carries
  the held sections. `runShell` while not idle is rejected, not queued.
  Take-back (`Up`) and the queue guide are disabled in shell mode.
- **No timeout.** Long builds and test runs must not be cut off. Ctrl+C
  stops the command (SIGTERM to the process group, SIGKILL after 2 s).
- **Output cap: 200 KiB, tail kept.** When the cap is hit the command is
  killed and the head of the output is dropped; both the history and the
  prompt carry a `truncated` note. Truncation never blocks the send.
- **stdout and stderr are merged in arrival order**, as a terminal shows
  them. The exit code is appended only when non-zero; a stopped command
  is marked `interrupted` instead.
- **Prompt shape** reuses the milestone 6 fenced-section form, labelled
  with the command line.
- **Lead-in and auto-send are configurable** in three layers: built-in
  default → vendor default via `createCli({ shell })` → the user's
  `config.json`. `autoSend: false` is the analogue of Claude Code's
  `respondToBashCommands: false`: results are held and attached to the next
  message the user sends. There is no per-turn lead-in override; holding
  the result back already lets the user write their own words.
- **Live output.** The history entry for the command is created when the
  command starts and its output is rewritten as chunks arrive (throttled to
  100 ms). This is independent of the streaming-display backlog item.
- **Each command starts in the start directory.** `cd` does not carry over
  to the next command; the `@file` index stays as built at startup.
- **Shell:** `$SHELL` when set, otherwise `/bin/sh`, invoked with `-c`.
  Non-interactive, so shell aliases do not apply. stdin is closed.
- **No sandbox.** The command runs with the user's own privileges and
  environment, as in Claude Code.

## 1. Modules

```
packages/cli/src/shell/                  no OpenTUI import
  run-command.ts     runCommand(cmd, opts) → RunningCommand
  format-result.ts   formatShellSection(result) / formatShellPrompt(leadIn, result)
  shell-config.ts    ShellConfig, DEFAULT_SHELL_CONFIG, resolveShellConfig(...layers)
packages/cli/src/config.ts               CliConfig gains shell?: Partial<ShellConfig>
packages/cli/src/create-cli.ts           CreateCliOptions gains shell?: Partial<ShellConfig>
packages/cli/src/tui/
  chat-model.ts      status "running", role "shell", runShell() / stopShell(), held results
  chat-view.ts       shell mode switch and display, live output, status row
  run-interactive.ts InteractiveOptions gains shell?: ShellConfig
```

### `run-command.ts`

```typescript
export interface RunOptions {
  cwd: string;
  /** Output cap. Past it the command is killed and only the tail is kept.
   * Default 200 KiB. */
  maxBytes?: number;
  /** Called with the whole output so far whenever it changes, throttled
   * to 100 ms. */
  onOutput?: (text: string) => void;
  /** Test-only: the shell binary. Default $SHELL or /bin/sh. */
  shell?: string;
}
export interface ShellResult {
  command: string;
  /** stdout and stderr interleaved in arrival order, decoded as UTF-8
   * (invalid bytes become U+FFFD). */
  output: string;
  /** Bytes dropped from the head by the cap; 0 when nothing was dropped. */
  droppedBytes: number;
  /** Exit code on normal exit; undefined when killed or stopped. */
  exitCode: number | undefined;
  /** True when stop() ran or the cap killed the command. */
  interrupted: boolean;
  /** The signal that ended the command when something other than stop()
   * killed it; absent on a normal exit and on an interrupted result. */
  signal?: NodeJS.Signals;
  durationMs: number;
}
export interface RunningCommand {
  readonly done: Promise<ShellResult>;
  /** SIGTERM to the process group, SIGKILL after 2 s. `done` always
   * settles. Idempotent: later calls, and calls after exit, do nothing. */
  stop(): void;
}
export const MAX_OUTPUT_BYTES = 200 * 1024;
export function runCommand(command: string, opts: RunOptions): RunningCommand;
```

- As shipped, the child is
  `spawn("/bin/sh", ["-c", 'exec "$@" 2>&1', "sh", shell, "-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] })`:
  a POSIX wrapper merges stderr into stdout on one fd before the user's
  shell runs, so arrival order is preserved and a non-POSIX `$SHELL`
  (fish, csh) never has to perform the redirection itself. A path-like
  `shell` is preflighted with `fs.access(X_OK)`, so a missing or
  non-executable shell rejects `done` instead of surfacing as exit 127.
  `detached` puts the command in its own process group so `stop()` can
  signal the whole tree (`process.kill(-pid, signal)`); the runner still
  `await`s the child, so nothing runs on after the TUI exits. After the
  SIGKILL escalation the output pipes are destroyed 500 ms later, so `done`
  settles even when a process left the group (`setsid`) and still holds a
  pipe open.
- The environment is inherited unchanged.
- Chunks from both pipes go into one byte buffer in arrival order. Once
  the buffer exceeds `maxBytes` the head is dropped to keep the last
  `maxBytes`, `droppedBytes` accumulates, and `stop()` is called.
- `done` rejects only when the shell itself cannot be started (`ENOENT`
  etc.); the caller turns that into an error entry.

### `format-result.ts`

```typescript
export function formatShellSection(result: ShellResult): string;
export function formatShellPrompt(leadIn: string, result: ShellResult): string;
```

`formatShellSection` output, all parts on their own lines:

````
### $ npm test
… (truncated: first 312 KB dropped)      ← only when droppedBytes > 0
```
<output, trailing newline added when missing>
```
exit code: 1                             ← only when exitCode is non-zero
killed by SIGKILL                        ← only when a signal we did not send ended it
interrupted                              ← only when interrupted
````

The fence is three backticks, lengthened past the longest backtick run at
a line start in the output; `fenceFor` moves from `expand-mentions.ts`
into a shared helper so both features use one implementation. No language
tag. `formatShellPrompt` is `leadIn`, a blank line, then the section.

### `shell-config.ts`

```typescript
export interface ShellConfig {
  /** First line of the prompt sent after a command finishes. */
  leadIn: string;
  /** false: hold results and attach them to the next message instead. */
  autoSend: boolean;
}
export const DEFAULT_SHELL_CONFIG: ShellConfig = {
  leadIn: "Please check the execution result.",
  autoSend: true,
};
/** Later layers override earlier ones; undefined keys are ignored. */
export function resolveShellConfig(
  ...layers: (Partial<ShellConfig> | undefined)[]
): ShellConfig;
```

## 2. `ChatModel`

### States

```
idle ──runShell()──▶ running ──done, autoSend──▶ busy ──reply──▶ idle
                        │
                        ├──done, hold────────▶ idle (held +1)
                        ├──stopShell()───────▶ same branches, interrupted
                        └──reset()───────────▶ resetting (killed, output dropped)
```

- `Status` gains `"running"`. `submit()` and `runShell()` return `false`
  in every state but `idle`.
- `Role` gains `"shell"`. `Message` gains `result?: ShellResult` (the
  live result while running, the final one after), `held?: boolean` and
  `failed?: boolean` (the shell could not be spawned).

### API

```typescript
export interface ChatModelOptions {
  // ...existing
  /** Default: DEFAULT_SHELL_CONFIG, so existing callers need no change. */
  shell?: ShellConfig;
  /** Test-only: replaces runCommand. */
  runCommand?: (cmd: string, opts: RunOptions) => RunningCommand;
  /** Directory commands start in. Default: process.cwd(). */
  cwd?: string;
}
export class ChatModel {
  /** Results waiting for the next submit (autoSend: false). */
  readonly heldResults: ShellResult[];
  /** Runs one command. false when ignored: blank command, not idle. */
  runShell(command: string): Promise<boolean>;
  /** Stops the running command; no-op otherwise. */
  stopShell(): void;
}
```

### `runShell(command)`

1. Trim; return `false` when blank or not `idle`. Set `status` to
   `running`, push `{ role: "shell", text: command, result }` with an
   empty in-progress result, `onChange`.
2. Start `runCommand(command, { cwd: process.cwd(), onOutput })`. Every
   `onOutput` replaces `result.output` on that entry and calls `onChange`.
3. Await `done`. If the generation changed (a reset ran) do nothing more.
4. Replace the entry's `result` with the final one and `onChange`.
5. `autoSend`: build `formatShellPrompt(leadIn, result)` and send it
   through the same internal `sendPrompt(prompt)` that `submit` uses after
   expansion (status `busy`, reply / timeout / fatal handled identically).
   No `user` entry is pushed; the `shell` entry stands for the turn.
6. `autoSend: false`: push the result to `heldResults`, mark the entry
   `held`, set `status` to `idle`, `onChange`.
7. A rejected `done` (the shell could not start) marks the entry `failed`
   and notifies the view. Unless a reset made the run stale, it also pushes
   an error entry `could not start shell: <message>` and returns to `idle`;
   not fatal.

### `submit(text)`

After expansion, when `heldResults` is non-empty, append
`formatShellSection` for each held result to the expanded prompt, blank-line
separated. `heldResults` and the `held` flags are cleared only when the reply
arrives (before the queue drains), so a `MentionError`, a timeout, a fatal
send error and a reset during the send all leave the results held for the
next message. While the send is in flight the entry still shows the held
footer.

### `reset()`

While `running`, call `stopShell()` first; the generation bump drops the
completion. Held results survive a reset.

### Teardown

`runInteractive`'s `finally` calls `stopShell()` before the existing
close-or-kill so no child process outlives the TUI. Held results are
discarded silently.

## 3. `ChatView`

### Shell mode

A view-level `shellMode` flag; the model does not know about it.

- **Enter:** in `onContentChange`, when the previous content was empty and
  the new content starts with `!`, strip the `!`, set `shellMode`, change
  the prompt to `! ` in `theme.shell` (new, yellow), and set the
  placeholder to `Run a shell command`. Typing and pasting reach the same
  hook.
- **Exit:** in `handleKey`, when `shellMode` and `plainText` is empty,
  `escape` / `backspace` / `ctrl+u` are consumed (`preventDefault`), the
  flag is cleared and the prompt restored. With text present they reach
  the textarea as today. Deleting the last character does not exit; the
  next press does.
- **`@` popup:** `refreshPopup` hides the popup while in shell mode; no
  mention expansion for commands.
- **Newlines:** Shift+Enter / Ctrl+J still insert a newline; a multi-line
  command is passed to `-c` as is.

### Submit

`onSubmit` branches on `shellMode`: blank text or a non-`idle` model is
ignored; otherwise the textarea is cleared, shell mode is kept so the next
command can be typed at once, and `model.runShell(text)` is called. The
normal branch is unchanged.

### Live output

`messageBox` for `role === "shell"` renders the label `shell`, a first
line `$ <command>`, and an output `TextRenderable`. The view remembers the
output renderable of the last drawn shell entry; `update()` rewrites its
content from `result.output` while that entry is the last message. When
the result is final, one muted footer line is added as applicable:
`exit code: N`, `killed by SIGKILL`, `interrupted`, `… (truncated: first N
KB dropped)`, `did not start` for a shell that could not be spawned, and
`📎 held, sent with your next message` for a held result (cleared when it
is sent).

### Status row

The row is one fixed line and clips, so every text must fit 80 columns.
That is why the idle guide drops the Shift+Enter mention (Ctrl+J works on
every terminal; README documents both) and why the held variant is shorter.

| State | Text |
|---|---|
| idle, normal | `Enter send · Ctrl+J newline · @ file · ! shell · Ctrl+R reopen · Ctrl+C quit` |
| idle, shell mode | `Enter run · Esc exit shell · Ctrl+R reopen · Ctrl+C quit` |
| idle, N held results | `📎 N held · Enter send · @ file · ! shell · Ctrl+R reopen · Ctrl+C quit` (or `📎 N held · ` + the shell-mode text) |
| running | `●○○ Running…  12s · Ctrl+C stop` (spinner frames as today), plus ` · N queued` while messages wait |
| busy / resetting / dead | unchanged |

### Ctrl+C

`waitForQuit` does not resolve while the model is `running`; it calls
`model.stopShell()` instead. A second Ctrl+C during the 2 s grace is also
routed to `stopShell()` (a no-op) rather than quitting.

### Banner

`BANNER_HINT` becomes `Type a message, @ to attach a file, ! to run a
command.` and moves to its own line under `Connected to <provider>.`: banner
lines do not wrap and the provider name has no length budget, so the hint (55
cells) must not share a line with it.

## 4. Configuration

### `config.ts`

```typescript
export interface CliConfig {
  defaultProvider?: string;
  shell?: { leadIn?: string; autoSend?: boolean };
}
```

`loadConfig` validates the new section: `shell` must be an object when
present; `leadIn` a string; `autoSend` a boolean. Violations throw the
existing `INVALID_CONFIG` (exit 1) with messages such as
`"shell.leadIn" must be a string`. Unknown keys are ignored as today.

### `create-cli.ts`

```typescript
export interface CreateCliOptions {
  // ...existing
  /** Vendor defaults for `!` shell mode; the user's config.json overrides. */
  shell?: { leadIn?: string; autoSend?: boolean };
}
```

The interactive path resolves
`resolveShellConfig(DEFAULT_SHELL_CONFIG, opts.shell, config.shell)` and
passes it as `runInteractive({ shell })`. Today `getProvider` skips
`loadConfig` when the provider is pinned; the interactive path now always
loads the config (a missing file yields `{}`), so a vendor CLI's users can
override the lead-in. The comment on `getProvider` is updated. One-shot and
`auth` do not read the shell section.

`help()` gains the line
`Interactive mode: @ attaches a file, ! runs a shell command and sends its output.`
and the config note mentions `"shell": { "leadIn", "autoSend" }`.

### Documentation

`README.md`'s TUI section describes `!` mode, the hold-back switch, and the
`createCli({ shell })` / `config.json` examples.

## 5. Error handling summary

| Situation | Handling |
|---|---|
| Shell cannot start | entry footer `did not start`; error entry `could not start shell: <message>`; back to `idle`; not fatal |
| Non-zero exit | not an error; `exit code: N` appended; sent or held as usual |
| Output over the cap | command killed; `interrupted`, `droppedBytes > 0`; sent or held with the note |
| Ctrl+C while running | `interrupted`; output so far is sent or held |
| Killed by a signal stop() did not send (`kill -9` from elsewhere, a crash of the shell) | not `interrupted`; `killed by <SIGNAL>` appended; sent or held as usual |
| No exit 2 s after SIGTERM | SIGKILL to the process group |
| Ctrl+R while running | command killed, browser reopened, output dropped; the entry shows `interrupted` |
| Non-UTF-8 output | decoded with replacement characters; never throws |
| Send fails (timeout, fatal) | exactly as `submit`: timeout → `idle`, otherwise `dead`; held results that rode along stay held |
| Quit with held results | discarded silently |
| Logging | command lines and output appear only in the history, never in `onProgress` or on stderr (output may contain secrets) |
| ANSI escapes in output | passed through unchanged; stripping is a backlog item |

## 6. Testing

Same two layers as milestones 6–8; no new E2E.

- `shell/run-command.test.ts` — real `sh -c`: stdout/stderr order
  (`echo a; echo b >&2; echo c`), non-zero exit code, several `onOutput`
  calls, cap kills the command and keeps the tail, `stop()` on `sleep 10`
  yields `interrupted` and settles `done`, a grandchild
  (`sh -c 'sleep 10 & wait'`) does not survive `stop()`, a missing shell
  rejects.
- `shell/format-result.test.ts` — exact output for success, `exit code`,
  `interrupted`, `truncated` note, fence lengthening, trailing newline.
- `shell/shell-config.test.ts` — layer precedence; `undefined` keys do not
  erase earlier layers.
- `config.test.ts` — type checks for each `shell` key; omitted → `{}`.
- `create-cli.test.ts` — a pinned-provider CLI still passes `config.json`'s
  `shell` to `runInteractive` (mocked).
- `tui/chat-model.test.ts` — fake `runCommand`: `running` transition,
  `onChange` per `onOutput`, the exact prompt reaching `send` under
  `autoSend`, holding and attaching on the next `submit`, held results kept
  across a `MentionError`, `submit` / `runShell` rejected while `running`,
  completion ignored after `reset`, `stopShell` no-op when idle.
- `tui/chat-view.test.ts` — `!` on empty input switches the prompt and
  strips the `!`; a mid-text `!` does not; `Escape` / `Backspace` on empty
  exit; `@` shows no popup in shell mode; Enter calls `runShell` and keeps
  the mode; live rewrite of the shell entry; each status row text; Ctrl+C
  while `running` does not quit.
- `cli.e2e.test.ts` — unchanged.

### Spike (first plan task)

Verify against `@opentui/core` 0.5.10: the textarea's default handling of
`Ctrl+U` and `Backspace`, and whether a paste reaches `onContentChange` as
one change with the full text. The enter-mode detection is written so that
either outcome works (if a paste arrives character by character, the text
after `!` must be preserved).

## Out of scope / backlog

- `Tab` completion from previous commands, `/` path completion, `Ctrl+B`
  backgrounding.
- Running a command while a turn is in flight (queuing `!` commands; #46
  shipped the message queue).
- `cd` carrying over between commands.
- Stripping ANSI escapes from the output.
- A per-turn lead-in override.
- One-shot mode.
