# Milestone 15a: Provider-defined slash commands

Issue: #83 (tracking issue of milestone 15). Ships as v0.9.0 together with
the URL hooks spec (`2026-09-20-provider-url-hooks-design.md`, #84).

## Goal

A Provider can ship its own `/commands` for the interactive UIs (TUI and
VSCode). One-shot mode (`-p`) does not see them. Two kinds:

- **show** — read something off the page and print it in the history
  (`/model`, `/usage`, `/status`).
- **send** — expand the typed line into a prompt and send it as an ordinary
  turn (`/summarize`, `/translate <text>`). The history keeps what the user
  typed; only the service sees the expansion.

Out of scope, deliberately: commands that change page state (model switch,
web-search toggle) — they interact with `/new` and `/reopen` and need their
own design; a `/` completion popup — `/help` lists commands, completion is
a backlog item; one-shot mode.

## Boundaries kept

- **UI is not core.** A command returns plain data (`show` text or a
  `send` prompt). The UI decides how to render or route it. A Provider
  never sees a TUI or a webview.
- **Runtime vs. DOM.** `run(page, args)` receives the same `Page` as
  `sendMessage`; core wraps the call in `runStep` with the session timeout,
  exactly like the other provider methods.
- **Auth state, not credentials.** `login`/`logout`/`new`/`reopen`/`help`
  stay built in and cannot be overridden or shadowed by a provider.

## Section 1: Provider API (`packages/provider`)

```ts
export type ProviderCommandResult =
  | { kind: "show"; text: string }
  | { kind: "send"; prompt: string };

export interface ProviderCommand {
  /** `/name`. Lower-case letters only; must not collide with a built-in. */
  name: string;
  /** One line for `/help`. */
  description: string;
  /** `args` is the rest of the line after the command word, trimmed;
   * `""` when there is none. May span lines. */
  run(page: Page, args: string): Promise<ProviderCommandResult>;
}

export interface Provider {
  // ...existing members...
  /** Optional. Commands listed by `/help` after the built-ins. */
  commands?: ProviderCommand[];
}
```

`defineProvider` validates `commands` and throws a plain `Error` (this is
a programming error at provider-definition time, not a runtime failure) when:

- a name does not match `/^[a-z]+$/`;
- a name is one of the built-ins, which the provider package exports as
  `BUILTIN_COMMAND_NAMES = ["login", "logout", "new", "reopen", "help"]`
  so core's table and this check cannot drift (core imports it);
- two commands share a name.

The check is the "future validation hook" the existing comment on
`defineProvider` promised.

## Section 2: core

### `slash-commands.ts`

```ts
export type ParsedSlash =
  | { command: SlashCommand }              // built-in, no args
  | { custom: string; args: string }        // provider command
  | { unknown: string }
  | { error: string };                      // e.g. built-in given args

export function parseSlashCommand(
  text: string,
  custom: ReadonlySet<string> = EMPTY,
): ParsedSlash | undefined;
```

Pattern becomes `^\/([a-z]+)(?:\s+([\s\S]*))?$` on the trimmed text. Rules:

- `/word` with `word` a built-in and no args → `{ command }` (unchanged).
- A built-in with args (`/login now`) → `{ error: "/login takes no arguments." }`.
  Today this is sent as an ordinary message, which was never useful.
- `word` in `custom` → `{ custom: word, args }`, `args` trimmed, `""` if
  absent.
- Any other `word` → `{ unknown }` (unchanged).
- Not starting with `/word` → `undefined`: paths like `/usr/bin` and
  everything else stay ordinary messages.

`helpText(custom: readonly { name; description }[] = [])` lists built-ins
first, then the provider's commands in the provider's order, all aligned to
the longest name.

### `ChatSession.runCommand`

```ts
async runCommand(name: string, args: string): Promise<ProviderCommandResult>
```

- Throws `InvalidStateError` when closed or when a send is pending (same
  guards as `send`), and when `name` is not in `provider.commands` (a UI
  bug: the parser only produces names from that list).
- Runs `command.run(page, args)` under `runStep("command:<name>", timeoutMs)`.
  A timeout throws `ResponseTimeoutError` like a slow `waitForResponse` and
  triggers the same `diagnoseTimeout`.
- Returns the result untouched. Core never sends the `send` prompt itself:
  the UI owns the turn and its history, so it calls `session.send(prompt)`.

`commandNamesOf(provider): ReadonlySet<string>` in `slash-commands.ts` gives
the UIs the set to pass to the parser (empty when `commands` is absent).

## Section 3: TUI (`packages/cli/src/tui/chat-model.ts`)

- `submit`: parse with the provider's command set. Built-ins keep running
  immediately in any state. A `custom` entry queues like an ordinary message
  when the model is not idle, because it needs the page: the queue entry
  stores the raw typed line and is re-parsed on drain. `error` and
  `unknown` push an error entry and resolve `false` (input refilled).
- New `runCustom(name, args, typed)`:
  1. push `{ role: "user", text: typed }` (the `/…` line as typed);
  2. status `busy`; `session.runCommand(name, args)`;
  3. `show` → push `{ role: "help", text }` (reuses the help styling: plain,
     no assistant framing); settle idle;
  4. `send` → call the existing turn tail (`sendPrompt(prompt)`) so the reply
     lands as an assistant entry and timeouts/errors behave as for a typed
     message. Held shell results ride along as they do for a message. No
     mention expansion on the prompt: the provider produced it, not the user;
  5. errors → error entry via `describe(err)`, settle as `sendPrompt` does
     (idle on timeout, dead on fatal).
- `/help` passes `provider.commands` to `helpText`.

## Section 4: VSCode

- `protocol.ts`: `ToHost` `command` becomes
  `{ type: "command"; name: WebviewCommand; args?: string }` and gains
  `{ type: "customCommand"; name: string; args: string }`. `ToWebview`
  `config` gains `commands: { name; description }[]` so the webview can
  parse and, later, complete.
- `webview/main.ts`: parse with the names from `config`; `custom` posts
  `customCommand`; `error` shows the inline error like `unknown`.
- `SessionController.runCommand(name, args, typed)`: mirrors the TUI —
  push the user entry, queue when not ready (queue entries gain an optional
  `command` field so drain re-dispatches), `show` → `pushHelp`-style history
  entry, `send` → `startTurn` with the expanded prompt and no attachments
  and the user entry already pushed.
- `commands.ts` `help` passes `provider.commands`.

## Section 5: tests

- provider: `defineProvider` accepts a valid list; rejects bad names,
  built-in collisions, duplicates.
- core: parser table (built-in / built-in with args / custom with and
  without args / multi-line args / unknown / path); `helpText` ordering;
  `runCommand` with a dummy provider: show, send, timeout, pending guard,
  unknown name, closed session.
- TUI `chat-model.test.ts`: show entry, send goes through `sendPrompt`,
  queued while busy, error shown, `/help` lists custom commands.
- VSCode: bridge routes `customCommand`; controller show/send/queue; webview
  parse posts the right message.
- Fixtures: the dummy provider in `packages/cli/src/__fixtures__` gains a
  `show` and a `send` command.

## Section 6: docs

README provider section: a `commands` example (`/model` as show,
`/summarize` as send). `creating-provider-repo` skill: one line pointing at
`commands` and `urlHooks`. CHANGELOG/release notes via the PR title.
