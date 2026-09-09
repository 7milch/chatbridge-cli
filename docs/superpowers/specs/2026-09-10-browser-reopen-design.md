# Ctrl+R: reopen the browser from the interactive TUI — design

Milestone 8, issue #34. Brainstormed 2026-09-10 (replaces the earlier
backlog note).

## Goal

The main use is a hung page: a response that will never arrive, or a page
that stopped reacting. Today the user can only wait for the timeout or quit
with Ctrl+C and lose the transcript. Ctrl+R closes the browser (killing it if
it will not close), opens a fresh one with the saved auth state, starts a new
chat, and keeps the on-screen history so the user can re-send.

A second benefit falls out of the same mechanism: fatal errors no longer exit
the TUI. The model enters a `dead` state from which Ctrl+R recovers and
Ctrl+C quits with the original error.

## Decisions

- Ctrl+R works in every state: while a turn is pending (the main case), when
  idle, and when dead. No confirmation prompt.
- The history is kept. A dim separator line `── reopened ──` marks the
  reopen; the interrupted turn gets no extra entry (the user's prompt is
  already in the history). The banner is not shown again.
- Every fatal error, including `AuthExpiredError`, `BlockedError`, and
  `AuthRequiredError`, puts the model in `dead` instead of exiting. A reopen
  that fails (for example the auth state really is gone) shows the error in
  the history and returns to `dead`; the user reads the message and presses
  Ctrl+C. Startup errors before the UI exists still propagate as today.
- Closing the old browser is capped at 5 s. When the cap is hit the Chromium
  process is killed before the new browser is launched, so a wedged browser
  never lingers.
- Core stays free of TUI policy: it gains a `kill()` primitive; the 5 s cap
  and the state machine live in `@chatbridge/cli`.

## Layer changes

### runtime

`BrowserRuntime.kill(): Promise<void>` sends `SIGKILL` to the browser process
(`browser.process()?.kill("SIGKILL")`) and drops the Playwright connection.
No-op when the process is already gone. `close()` is unchanged.

### core

- `RuntimeLike` gains `kill(): Promise<void>`.
- `ChatSession.kill(): Promise<void>`: marks the session closed and calls
  `rt.kill()`. It does not save the auth state (the page is presumed hung, so
  `isLoggedIn` cannot be trusted). Idempotent; a `send` after it throws
  `InvalidStateError` as after `close()`.
- `send`, `open`, `close`, and the one-shot `session.ts` are unchanged. A send
  that fails because its session was closed or killed underneath it is the
  caller's to discard.

### cli — `ChatModel`

```ts
type Status = "idle" | "busy" | "resetting" | "dead";
type Role = "user" | "assistant" | "error" | "separator";

interface ChatModelOptions {
  openSession: () => Promise<ChatSessionLike>;
  expand?: (text: string) => Promise<Expansion>;
}
interface ChatSessionLike {
  send(prompt: string): Promise<string>;
  close(): Promise<void>;
  kill(): Promise<void>;
}
```

- The model is constructed with the first session (opened before the UI
  exists, as today) and an `openSession` factory for later reopens.
- `session` is exposed read-only so teardown can close whichever session is
  current.
- `fatal` keeps the last fatal error; it is the reason for `dead`, no longer
  a signal to exit. A successful reset clears it.
- `submit()`: unchanged except that a fatal error sets `status = "dead"`
  instead of leaving it `idle`. Input is ignored while `busy`, `resetting`,
  or `dead`.
- `reset()`:
  1. Ignore when already `resetting`. Otherwise `status = "resetting"`,
     `onChange()`.
  2. Bump a generation counter, then `closeOrKill(oldSession, 5_000)`:
     `close()`, and if it has not resolved within 5 s, `kill()`. Errors from
     either are swallowed.
  3. `openSession()`. On success: replace the session, push
     `{ role: "separator", text: "reopened" }`, clear `fatal`,
     `status = "idle"`. On failure: push an `error` entry with the message,
     set `fatal`, `status = "dead"`.
  4. `onChange()` after each observable step.
- A `send` still in flight when reset starts belongs to an older generation.
  When it settles, its result or error is dropped and it must not touch
  `status`, `fatal`, or the history.

### cli — `ChatView`

- Global keypress listener handles `ctrl + r` → `model.reset()`,
  `preventDefault()`. Works whether or not the mention popup is open.
- Status line by state:
  - `idle`: `Enter send · Shift+Enter (or Ctrl+J) newline · @ file · Ctrl+R reopen · Ctrl+C quit`
  - `busy`: spinner and elapsed / budget, as today (no Ctrl+R hint, to keep
    the line short)
  - `resetting`: `Reopening browser...`
  - `dead`: `Ctrl+R reopen · Ctrl+C quit` in the error colour
- `separator` messages render as one dim line `── reopened ──` with no role
  label and no bottom-margin difference from other entries.

### cli — `runInteractive` / `waitForQuit`

- `waitForQuit` resolves only on Ctrl+C or renderer destroy; it no longer
  resolves on `fatal`. The resolved value is `model.fatal` at that moment, so
  a quit from `dead` reports the last fatal error and the exit-code mapping
  in `createCli` stays as it is.
- `runInteractive` passes `openSession: () => ChatSession.open(opts)` to the
  model. The `finally` block closes `model.session` (the current one) with the
  existing `closeWithTimeout`. If teardown runs during a reset, it closes the
  session that is current at that moment and does not wait for the reset.

## Error handling summary

| Event | Before | After |
|---|---|---|
| `ResponseTimeoutError` during a turn | error entry, stay idle | unchanged |
| Other error during a turn | error entry, exit | error entry, `dead` |
| Ctrl+R while busy | n/a | close-or-kill, reopen, separator, idle |
| Ctrl+R while dead | n/a | same; on failure error entry, `dead` again |
| Ctrl+C while dead | n/a | exit with the last fatal error |
| Old browser will not close in 5 s | exit hard at teardown | killed, reopen proceeds |

## Testing

- **runtime E2E**: launch real Chromium, `kill()`, assert the process is gone
  and a second `kill()` is harmless.
- **core unit**: `ChatSession.kill()` with a fake runtime — `saveAuthState`
  not called, `kill` called once, idempotent, `send` afterwards throws
  `InvalidStateError`.
- **cli `chat-model`**: fake session and fake `openSession`; reset while busy
  drops the stale send's result and error; reset from `dead` clears `fatal`;
  reset failure returns to `dead` with an error entry; reset during
  `resetting` is ignored; `kill` is called when `close` exceeds the cap
  (fake timers); separator entry appended on success.
- **cli `chat-view`**: Ctrl+R reaches `model.reset()` with the popup open and
  closed; status text per state; separator rendering.
- **cli `run-interactive`**: `waitForQuit` no longer resolves on `fatal`;
  Ctrl+C resolves with `model.fatal`; teardown closes the current session
  after a reset.
- `bun run check` green before every commit.

## Documentation

- `docs/ROADMAP.md`: replace the milestone 8 bullets with the decisions above
  and mark done on merge.
- README key guide: add `Ctrl+R reopen`.

## Out of scope

- Re-sending the interrupted prompt automatically.
- Cross-process conversation resume (still in the backlog).
- Any change to one-shot mode.
