# Interactive TUI (milestone 3a) — Design

Date: 2026-09-07
Status: Approved (brainstorming session)
Issue: https://github.com/7milch/chatbridge-cli/issues/7

## Goal

Give the CLI an interactive chat mode on OpenTUI, and add the one Core
concept it needs: a conversation that keeps the browser open across
several turns. Streaming display is deliberately deferred to milestone 3b
so that the TUI skeleton and the Provider contract are settled first.

Roadmap milestone 3 is split:

- **3a (this spec):** conversation continuation in Core, non-streaming TUI,
  OpenTUI proven under Bun.
- **3b (later):** streaming response capture in the Provider contract and
  incremental display.

## Spike result (OpenTUI under Bun)

A throwaway spike against `@opentui/core` 0.5.10 on Bun 1.4 confirmed:

- A bottom-anchored multi-line `TextareaRenderable` with custom key
  bindings (Enter submits, Shift+Enter inserts a newline).
- A `ScrollBoxRenderable` history with `stickyScroll` + `stickyStart:
  "bottom"` keeps the latest message visible as the log grows.
- A spinner driven by `setInterval` updating a `TextRenderable` renders
  while an async call is pending.
- `@opentui/core/testing` provides a mock terminal (fixed size, key input,
  frame capture) usable in `bun test`.
- The real renderer starts, accepts input, and exits on Ctrl+C inside a
  pseudo-terminal.

Constraints carried into the design:

1. **Shift+Enter is indistinguishable from Enter on legacy terminals.** Only
   terminals speaking the kitty keyboard protocol (iTerm2, kitty, WezTerm,
   Ghostty, …) deliver the modifier. **Ctrl+J** is bound to newline as well
   and works everywhere: legacy terminals send it as a linefeed byte, kitty
   terminals report it as `ctrl+j`, so both are bound. The on-screen guide
   names both.
2. The test renderer's `waitForFrame` does not advance real time. Tests
   with async work poll with `sleep → renderOnce → captureCharFrame`.
3. `@opentui/core` needs **Bun ≥ 1.3 or Node ≥ 26.4**. See "Runtime
   requirements".

## Decisions (from brainstorming)

- **TUI lives in `@chatbridge/cli`** (`packages/cli/src/tui/`). `createCli`
  gains the interactive branch, so derived CLIs (`company-ai-cli`) get it for
  free. Core, runtime, and provider never import OpenTUI.
- **The Provider contract does not change in code.** Conversation
  continuation is "call `sendMessage` / `waitForResponse` again on the same
  `Page`". This is documented, not plumbed. A chat handle / cross-process
  resume is deferred until milestone 4 has a real service to shape it.
- **A response timeout does not end the session.** The error is shown in
  the history and input resumes; the browser stays open. Failures before
  the TUI appears (no auth, expired auth, provider load) exit with the
  one-shot exit codes.
- **Two test layers, no full E2E.** `ChatSession` is verified on real
  Chromium against the dummy chat; the TUI is verified on the OpenTUI test
  renderer against a fake session.

## 1. Core: `ChatSession`

New file `packages/core/src/chat-session.ts`, exported from `@chatbridge/core`.

```typescript
export interface ChatSessionOptions {
  provider: Provider;
  authStore: AuthStore;
  headless: boolean;
  timeoutMs: number;
  /** Progress messages (stderr in the CLI). Never receives auth content. */
  onProgress?: (message: string) => void;
}

export class ChatSession {
  /** authStore.has() → launch → goto chatUrl → isLoggedIn → startNewChat. */
  static open(opts: ChatSessionOptions): Promise<ChatSession>;
  /** sendMessage → waitForResponse. Rejects with InvalidStateError while a
   * previous send is still pending or after close(). */
  send(prompt: string): Promise<string>;
  /** Closes the browser. Idempotent. */
  close(): Promise<void>;
}
```

- `open` moves the first half of today's `runOneShot` verbatim: the
  `AuthRequiredError` / `AuthExpiredError` checks, `setDefaultTimeout`, and
  every step wrapped in `runStep` so Playwright `TimeoutError` still maps to
  `ResponseTimeoutError` naming the step. If any step in `open` fails, the
  browser is closed before the error propagates.
- `send` wraps `sendMessage` and `waitForResponse` in `runStep` exactly as
  today. A timeout leaves the session usable: the caller may `send` again.
- `InvalidStateError` is a new `ChatBridgeError` subclass with code
  `INVALID_STATE` (exit code 1). It signals a programming error in the
  caller, not a user-facing condition.
- `runOneShot` becomes `open → send → close` in a `try/finally`. Its
  signature, progress messages, errors, and exit codes are unchanged, and
  its existing tests must pass without edits.

### Provider contract wording

Doc comments on `Provider.sendMessage` and `Provider.waitForResponse` (and
the provider section of the README) gain:

> Both methods are called repeatedly on the same `Page` for a multi-turn
> conversation. `waitForResponse` must return the response to the most
> recent `sendMessage` only, never an earlier one.

The dummy-chat provider already satisfies this (`.last()` plus the
busy → idle transition); no change is needed there.

## 2. CLI wiring and TUI structure

### Launch rules

- `chatbridge` with no `-p` and no `auth` subcommand starts interactive
  mode. `--provider`, `--headful`, and `--timeout` apply as in one-shot.
- If stdin or stdout is not a TTY, print
  `interactive mode needs a terminal; use -p <prompt> for one-shot` to
  stderr and exit 1 (`INVALID_ARGUMENT`).
- `--help` gains one usage line for the bare invocation and a sentence
  describing interactive mode.

### Files (`packages/cli/src/tui/`)

Three units, each testable alone:

- **`chat-model.ts`** — pure state, no OpenTUI import.
  ```typescript
  export interface ChatSessionLike { send(prompt: string): Promise<string>; close(): Promise<void>; }
  export type Role = "user" | "assistant" | "error";
  export interface Message { role: Role; text: string; }
  export type Status = "idle" | "busy";
  export class ChatModel {
    readonly messages: Message[];
    status: Status;
    constructor(session: ChatSessionLike);
    /** Settable; called after every state change. */
    onChange: () => void;
    /** Ignores empty/whitespace input and input while busy. */
    submit(text: string): Promise<void>;
    /** Set when submit hit an unrecoverable error; the app must exit. */
    fatal?: unknown;
  }
  ```
  `submit` pushes the user message, sets `busy`, awaits `send`, pushes the
  assistant message (or an `error` message for `ResponseTimeoutError`),
  and returns to `idle`. Any other exception is stored in `fatal` and
  also pushed as an `error` message; the runner exits.
- **`chat-view.ts`** — builds the OpenTUI tree from a `ChatModel` and
  re-renders on `onChange`. Layout top to bottom: header line
  (`<cli name> · <provider name>`), scrolling history (`You` /
  `Assistant` / `Error` labels, blank line between messages), bordered
  4-line textarea with placeholder, status line. Status line shows the
  spinner + `Waiting for response...` while busy, otherwise the guide
  `Enter send · Shift+Enter (or Ctrl+J) newline · Ctrl+C quit`.
  Key bindings: `return` / `kpenter` → submit; `return`+shift and
  `linefeed` → newline. Textarea is cleared on submit and keeps focus.
- **`run-interactive.ts`** — `runInteractive(opts): Promise<{ fatal?: unknown }>`.
  Opens the `ChatSession` with progress to stderr (same messages as
  one-shot), then creates the renderer (`exitOnCtrlC: false`, Ctrl+C is
  handled explicitly so cleanup runs), builds the view, and resolves when
  the user quits or `fatal` is set. If renderer creation fails, the
  already-open session is closed before the error propagates.
  The exported `waitForQuit(renderer, model)` resolves on three events:
  Ctrl+C, `model.fatal` being set, and the renderer's `"destroy"` event —
  OpenTUI installs its own SIGINT/SIGTERM/SIGHUP handlers that destroy the
  renderer without exiting the process, so without the third the promise
  would stay pending and the browser would keep the process alive.
  Teardown order in `finally`: pin `Closing browser...` on the status line
  → `closeWithTimeout(session, 5000)` (close errors swallowed) →
  `view.destroy()` → `renderer.destroy()`. If the close timed out, the
  Playwright connection would keep the event loop alive, so the runner
  writes `browser did not close within 5 s; exiting` to stderr and calls
  `process.exit(1)`; the terminal is already restored, and interactive
  mode has no pending stdout to drop.

### `createCli` changes

One new branch before the help fallback: if `cmd === undefined` and no
`-p`, resolve provider and auth store exactly as one-shot does, then call
`runInteractive` and map its result through `reportError` (exit 0 when
`fatal` is undefined). Errors thrown before the renderer exists go through
the same `reportError`; errors after it are already on screen, so the
runner prints only a one-line summary to stderr (plus `Caused by:` when
`CHATBRIDGE_DEBUG=1`) after the terminal is restored.

## 3. Errors and exit

| Situation | Behaviour | Exit |
|---|---|---|
| No auth state / auth expired / provider load fails during `open` | stderr message, no TUI | 2 / 3 / 5 (unchanged) |
| Non-TTY without `-p` | stderr message | 1 |
| `ResponseTimeoutError` during `send` | shown in history, input resumes | — |
| Any other error during `send` | shown in history, TUI closes | 1 |
| Ctrl+C (idle or busy), or SIGTERM/SIGHUP destroying the renderer | close session, restore terminal | 0 |
| Browser did not close within 5 s | stderr note after the terminal is restored, hard `process.exit` | 1 |

Not handled in 3a: auth expiring mid-conversation. The contract has no
way to detect it, so it surfaces as a timeout. Documented as a known gap.

### Runtime requirements

`@opentui/core` requires Bun ≥ 1.3 or Node ≥ 26.4, while one-shot mode
still runs on Node 20. To keep one-shot users unaffected:

- `run-interactive.ts` is loaded with a dynamic `import()` only when
  interactive mode is chosen, so `@opentui/core` is never evaluated for
  `-p` or `auth`.
- Before that import, `createCli` checks `process.versions.bun` or a Node
  major/minor of at least 26.4; otherwise it prints
  `interactive mode needs Bun >= 1.3 or Node >= 26.4; use -p <prompt> on
  this runtime` and exits 1.
- `packages/cli/package.json`: `engines` becomes
  `{ "node": ">=20", "bun": ">=1.3" }`; `@opentui/core` is a regular
  dependency (its native binaries arrive via its own optional
  dependencies). The `bin` shebang stays `#!/usr/bin/env node`.
- README states the requirement in the interactive-mode section.

## 4. Testing

- **Core unit (`chat-session.test.ts`)**: `send` while pending rejects
  with `InvalidStateError`; `send` after `close` rejects; `close` twice is
  a no-op; a failing step in `open` closes the browser. Uses a stubbed
  `BrowserRuntime` as the existing session tests do.
- **Core E2E (`session.e2e.test.ts`)**: two turns on the dummy chat return
  `Echo: first` then `Echo: second`; after a forced timeout (`setReplyDelayMs`
  above `timeoutMs`) a subsequent `send` with a normal delay succeeds.
- **CLI unit (`chat-model.test.ts`)**: with a fake session — idle→busy→idle
  transition, empty input ignored, input while busy ignored, timeout yields
  an `error` message and idle, other error sets `fatal`.
- **CLI view (`chat-view.test.ts`)**: OpenTUI test renderer, fake session
  with a short delay — typed text appears; Enter submits and clears the
  box; spinner text appears while busy; reply appears in history; twelve
  turns scroll the history and keep the latest visible; Shift+Enter (kitty
  mode) and Ctrl+J (legacy and kitty modes) insert a newline.
- **CLI (`create-cli.test.ts`)**: bare invocation with non-TTY stdio exits
  1 with the documented message.
- **CI**: the first implementation task adds `@opentui/core` and runs a
  trivial test-renderer test on CI to confirm the Linux native binary
  loads. No new browser install.

## 5. Documentation

- README: "Interactive mode" section (how to start, keys, runtime
  requirement, what happens on timeout / Ctrl+C).
- `docs/ROADMAP.md`: milestone 3 becomes 3a (this spec) and 3b (streaming);
  3b keeps the deferred bullets below.
- Provider doc comments per section 1.

## Out of scope (deferred to 3b or later)

- Streaming / incremental response display and the Provider contract for it
- Markdown rendering in the history
- Cross-process conversation resume (chat handle)
- Persisting conversation history to disk
- Detecting auth expiry mid-conversation
