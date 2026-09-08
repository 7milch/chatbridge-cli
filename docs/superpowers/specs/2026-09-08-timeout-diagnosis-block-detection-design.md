# Timeout diagnosis, block detection, activity indicator (milestone 3b) — Design

Date: 2026-09-08
Status: Approved (brainstorming session)
Issue: https://github.com/7milch/chatbridge-cli/issues/25

## Goal

Close the two gaps that milestones 4 and 4.5 exposed, and make a long wait
in the TUI legible, without changing how responses are captured:

1. A response timeout in a conversation may really be an expired login.
   Diagnose it instead of reporting a bare timeout.
2. A bot challenge or an IdP refusing the automated browser is reported as
   an expired auth state (#23). Let a provider say "blocked, not logged
   out" and suggest `--headful`.
3. While a turn is pending the TUI shows a plain spinner. Replace it with an
   activity indicator that shows elapsed time against the timeout budget.

## Decisions (from brainstorming)

- **Streaming display is dropped from this milestone and moved to the
  backlog.** Both observed services (Rakuten AI, ChatGPT) already work with
  the completion-based contract: `waitForResponse` waits for the done signal
  and returns the whole text. What streaming services actually make hard is
  completion detection, and that already belongs to the provider's
  `waitForResponse` plus the trap table in the `creating-provider-repo`
  skill. Incremental display is a UX feature, not a provider need. The
  design sketched for it is recorded in `docs/ROADMAP.md` under Backlog so
  it can be resumed.
- **One-shot mode stays batch.** `-p` prints the finished response only.
- **The `isLoggedIn` boolean does not change.** Block detection is an
  optional method that only providers who recognise a block add; every
  existing provider keeps working unchanged.
- **No active monitoring of the login during a conversation.** Expiry shows
  up as a timeout; the timeout is the trigger to check.
- **Markdown rendering, cross-process resume (chat handle), and history
  persistence leave the milestone list** and become backlog items.

## 1. Provider contract

One optional method is added to `Provider` in `@chatbridge/provider`:

```typescript
/** Optional. When the page shows a block that logging in again would not
 * clear (a bot challenge interstitial, an IdP refusing the automated
 * browser), return a short description of it; otherwise undefined. The
 * core calls this only after `isLoggedIn` returned false. Must not throw
 * on an ordinary logged-out page. */
detectBlock?(page: Page): Promise<string | undefined>;
```

The five existing methods are unchanged. `defineProvider` accepts the new
member with no runtime change.

The dummy chat gains a way to serve a block page so the path is covered by
E2E: an in-process hook `setBlocked(boolean)` (next to the existing
`invalidateSessions` / `setReplyDelayMs` hooks); while set, `/chat`
responds with a page titled `Just a moment...` that has no
`#message-input`, regardless of session. The dummy provider's
`detectBlock` returns `"challenge page"` when `document.title` is that
string.

## 2. Core

### Errors

New `ChatBridgeError` subclass in `packages/core/src/errors.ts`:

```typescript
/** The service blocked the automated browser; logging in again would not
 * help. Suggests --headful. */
export class BlockedError extends ChatBridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super("BLOCKED", message, options);
  }
}
```

Message format, built in the core so every CLI says the same thing:

```
Blocked by "<provider.name>": <description>. Try --headful.
```

The hint is "Try", not "Use": headful passes Cloudflare but some IdPs
refuse the automated browser even headful (spike note, milestone 4.5).

### `assertLoggedIn`

A private helper on `ChatSession`, used in two places:

```
isLoggedIn(page)
  true  → return
  false → detectBlock?(page)
            string    → throw BlockedError
            undefined → throw AuthExpiredError (today's message)
```

Both calls are wrapped in `runStep` with the session's `timeoutMs`, so a
hanging `isLoggedIn` still maps to `ResponseTimeoutError` naming the step.

- `ChatSession.open` replaces its inline `isLoggedIn` check with
  `assertLoggedIn`. Behaviour for a logged-out page is identical to today;
  a block page now raises `BlockedError` instead of `AuthExpiredError`.
- `ChatSession.send` wraps the existing `sendMessage` / `waitForResponse`
  steps: when either raises `ResponseTimeoutError`, `send` runs
  `assertLoggedIn` before rethrowing.
  - Still logged in → rethrow the original `ResponseTimeoutError`. The
    session stays usable, as today.
  - Not logged in → `AuthExpiredError` (or `BlockedError`) propagates
    instead. The session is not usable; the caller closes it.
  - If the diagnosis itself throws anything else (for example the page is
    gone), the original `ResponseTimeoutError` wins and is rethrown
    unchanged. The diagnosis must never hide the primary failure.
- `pending` is cleared in the existing `finally`, so a diagnosed expiry
  does not leave the session in a stuck state for `close`.
- `close` is unchanged: `isLoggedIn` false there only skips the auth-state
  save, which is the right outcome for both expiry and block.

### `runOneShot` and `runLogin`

No code change. One-shot now exits 6 on a block page and the login flow is
untouched: a challenge page during headful login is something the user
sees and solves in the window.

## 3. CLI

### Exit codes

| Code | Error | Situation |
|---|---|---|
| 6 | `BLOCKED` | Block page at open, or diagnosed after a timeout |

Existing codes 1–5 are unchanged. `reportError` maps the new code; `--help`
lists it with the others.

### TUI

- `ChatModel`: no change. `AuthExpiredError` and `BlockedError` are not
  `ResponseTimeoutError`, so the existing rule already stores them in
  `fatal`, shows them in history, and ends the app.
- `ChatViewOptions` gains `timeoutMs: number`; `runInteractive` passes
  `opts.timeoutMs` through.
- `ChatView.startSpinner` becomes the activity indicator. Frames cycle
  every 120 ms through `●○○`, `○●○`, `○○●`, `○●○`; the line reads

  ```
  ○●○ Thinking…  12s / 120s
  ```

  Elapsed seconds count from the moment the status turned busy
  (`Date.now()` captured in `startSpinner`); the budget is `timeoutMs`
  rounded to whole seconds. The frame width is fixed at three cells so
  legacy terminals do not misalign the line. `stopSpinner` and the pinned
  status (`setStatus`) behave as today.

## 4. Errors and exit (additions to the 3a table)

| Situation | Behaviour | Exit |
|---|---|---|
| Block page during `open` (one-shot or interactive) | stderr message with `Try --headful`, no TUI | 6 |
| `send` timed out, page still logged in | timeout shown in history, input resumes (unchanged) | — |
| `send` timed out, page logged out | `AuthExpiredError` shown in history, TUI closes | 3 |
| `send` timed out, block page | `BlockedError` shown in history, TUI closes | 6 |

## 5. Testing

- **Provider unit (`index.test.ts`)**: `defineProvider` accepts a provider
  with and without `detectBlock`.
- **Core unit (`chat-session.test.ts`)**, with the existing stubbed runtime:
  - `open` on a page where `isLoggedIn` is false and `detectBlock` returns
    a string throws `BlockedError` with the documented message and closes
    the browser.
  - `open` with `detectBlock` undefined or returning undefined still throws
    `AuthExpiredError`.
  - `send` timeout with `isLoggedIn` true rethrows `ResponseTimeoutError`
    and a following `send` succeeds.
  - `send` timeout with `isLoggedIn` false throws `AuthExpiredError`;
    with `detectBlock` returning a string throws `BlockedError`.
  - `send` timeout where the diagnosis throws rethrows the original
    `ResponseTimeoutError` (the cause is not replaced).
- **Core E2E (`session.e2e.test.ts`)**: with the dummy chat blocked, `open`
  rejects with `BlockedError`; unblocked, the existing two-turn test passes.
- **CLI (`create-cli.test.ts` / `cli.e2e.test.ts`)**: exit code 6 and the
  `Try --headful` text on stderr for the blocked dummy chat.
- **View (`chat-view.test.ts`)**: while busy the status line contains
  `Thinking…` and `s / 2s` (fake session with a 2 s timeout option); after
  the reply the guide returns. Frame rotation is asserted by capturing two
  frames at least 120 ms apart and seeing different dot patterns.

## 6. Documentation and roadmap

- `README.md`: exit code 6 in the exit-code table; `detectBlock` in the
  provider section with the Cloudflare example; the interactive-mode
  section describes the indicator.
- `.claude/skills/creating-provider-repo/SKILL.md`: one row in the trap
  table pointing the headless-challenge trap at `detectBlock`, with a
  `document.title === "Just a moment..."` example.
- `docs/ROADMAP.md`:
  - 3b heading becomes `3b. Timeout diagnosis, block detection, activity
    indicator — in progress (issue #25)`, body replaced by this scope.
  - New `## Backlog` section after milestone 5, holding: streaming display
    (with the knob design summarised below), Markdown rendering in the
    history (wanted), cross-process conversation resume (chat handle),
    history persistence.

### Backlog note: streaming display design sketch

Recorded so the work can be resumed without re-deriving it. Both observed
services grow one assistant element in place, so streaming can be a
generic poll in the core over two provider knobs:

```typescript
streaming?: {
  /** Text of the in-progress assistant response; undefined while only a
   * placeholder exists. */
  responseText(page: Page): Promise<string | undefined>;
  /** Done signal (stop control gone, send control back, ...). */
  isComplete(page: Page): Promise<boolean>;
  pollIntervalMs?: number; // default 250
};
```

`ChatSession.send(prompt, { onDelta })` would poll `responseText`, emit
deltas (or the whole text when the prefix no longer matches, which covers
placeholder swaps), stop on `isComplete`, and still take the final text
from `waitForResponse`. One-shot stays batch. The TUI renders the newest
assistant message from the full text on each delta.

## Out of scope

- Streaming / incremental display (backlog, sketch above)
- Markdown rendering, chat handle, history persistence (backlog)
- Any bot-protection evasion (project rule; `detectBlock` only reports)
- Active login monitoring between turns
