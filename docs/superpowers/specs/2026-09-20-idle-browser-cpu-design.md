# Milestone 16 (v0.9.x): idle browser CPU

Tracking issue: #95. The milestone also carries #97 (VSCode chat view layout,
its own spec) and the v0.9.0 follow-ups #87–#94 (bounded fixes that go straight
into the plan).

## Problem

A long-lived interactive session keeps a headless Chromium alive. On macOS
headless Chromium rasterises in software, and Playwright disables background
throttling, so a chat page that keeps animating burns CPU for as long as the
session stays open: a session left open for 2.5 days held one core at ~97%.
`close()` ends it cleanly; the cost is paid while the session is legitimately
open and idle. See #95 for the measurement.

## Goals

1. Ask every page for reduced motion by default, so pages that honour the media
   query stop animating. A provider can opt out.
2. End the browser of a session that has been idle too long (default 24 h), and
   let the UI reopen it on the next prompt through its existing reopen path.
3. Document that an idle session is not free, and the two knobs.

Non-goals: freezing or throttling the page between turns (the service may drop
the connection), sweeping orphaned browsers after the host process was
SIGKILLed (needs pid files), restoring the conversation after a reopen (#73),
any change to one-shot mode, and anything that changes how the browser presents
itself to the service beyond the standard `prefers-reduced-motion` preference.

## 1. Provider fields

`Provider` (`packages/provider/src/index.ts`) gains two optional fields. Both
are additive; existing providers compile and behave as described below without
changes.

```ts
/** Optional. Browser context preferences. `reducedMotion` defaults to
 * "reduce": an idle headless page that keeps animating is rasterised on the
 * CPU forever. Set "no-preference" only when the service misbehaves under
 * reduced motion. */
browser?: { reducedMotion?: "reduce" | "no-preference" };

/** Optional. Default idle timeout of an interactive session, in ms. After
 * this long without a turn the browser is closed and the UI reopens it on the
 * next prompt. 0 disables. Users override it via config.json, an env var, or
 * the VSCode setting. */
idle?: { timeoutMs?: number };
```

Built-in defaults: `reducedMotion` `"reduce"`, `idle.timeoutMs` 86 400 000
(24 h).

## 2. Runtime

`BrowserRuntime.launch()` already receives the provider. It passes
`reducedMotion: provider.browser?.reducedMotion ?? "reduce"` to
`browser.newContext()` next to `storageState`. This is the only
`newContext()` call in the repo, so the value applies to every launch, headless
or headful, including the `auth login` window: a page looks the same in all of
them when debugging.

## 3. Core

### `IdleWatch` (`packages/core/src/idle-watch.ts`, new)

A small, UI-free unit:

```ts
export interface IdleWatchOptions {
  timeoutMs: number;          // > 0; the caller does not construct one for 0
  onExpire: () => void;
  now?: () => number;         // default Date.now
  tickMs?: number;            // default 30_000
}
export class IdleWatch {
  touch(): void;   // activity: restart the idle period
  pause(): void;   // a turn is in flight: never expire
  resume(): void;  // turn ended: touch() and watch again
  stop(): void;    // clear the interval; idempotent
}
```

- A coarse `setInterval(tickMs)`, `unref()`ed so it never keeps a process
  alive, compares `now() - lastActivityAt` with `timeoutMs`. It compares wall
  clock time on purpose: timers run on a monotonic clock that does not advance
  during system sleep, so one long `setTimeout` would be late by the length of
  the sleep. With the wall-clock check the first tick after wake expires an
  overdue session.
- `onExpire` fires at most once; the watch stops itself before calling it.

### `ChatSession`

- `ChatSessionOptions` gains `idle?: { timeoutMs: number }` (resolved value;
  when absent: `provider.idle?.timeoutMs ?? 86_400_000`), `onIdleExpired?: () =>
  void`, and the test seams `now?` and `idleTickMs?`.
- When the resolved timeout is `> 0`, `open()` creates an `IdleWatch` after the
  opening phase succeeded. `send` and `runCommand` call `pause()` when they set
  `pending` and `resume()` in their `finally`. `close()` and `kill()` call
  `stop()`.
- On expiry, in this order:
  1. `onIdleExpired()` is called synchronously, so the UI drops its reference
     before anything awaits. From here `send`/`runCommand` reject with the
     usual `InvalidStateError("ChatSession is closed.")`.
  2. `onProgress("Closing the browser after <duration> idle...")`.
  3. `closeOrKill(this, IDLE_CLOSE_BUDGET_MS)` from `close-session.ts` (budget
     5 000 ms): a normal `close()` first, so the rotated auth state is saved,
     then `kill()` if the page is wedged.
- `close()` stays idempotent but now returns the in-flight close promise when
  one exists, instead of resolving immediately. A UI that tears down while the
  idle close is still saving auth state therefore waits for it rather than
  exiting underneath it.
- One-shot mode (`session.ts`) is untouched.

`IdleWatch` and the `idle` option type are exported from
`@chatbridge/core`.

## 4. CLI and TUI

### Resolution

A new `idle-options.ts`, modelled on `open-options.ts`, resolves the timeout in
layers: built-in 24 h → `provider.idle.timeoutMs` → `config.json`
`idle.timeoutMin` → env `CHATBRIDGE_IDLE_TIMEOUT` (minutes). Values are
non-negative finite numbers; `0` disables; anything else is rejected the same
way `open.timeoutSec` / `CHATBRIDGE_OPEN_TIMEOUT` are (config: error naming the
file and key; env: error naming the variable). `config.ts` learns the `idle`
key. The resolved value is passed to `ChatSession.open` from `run-interactive`
only.

### TUI model

`ChatModel` passes `onIdleExpired` when it opens a session. On expiry, if the
session that expired is still the current one:

- it drops `current` and records `idleClosed = true`; status stays `idle`;
- the view's idle guide is replaced by
  `Browser closed after being idle · your next prompt reopens it`;
- the next submitted prompt is queued and `reset("reopened after idle")` runs;
  the existing queue drain sends the prompt once the reopen settles. The
  separator tells the user the service-side conversation is a new chat;
- `/new`, `/reopen` (Ctrl+R) and `/login` behave as they do today and clear
  `idleClosed`. Provider `/commands` typed while `idleClosed` reopen first, the
  same way a prompt does.

A reopen that fails leaves the model `dead` with the reopen error, as any
failed `reset` does today.

## 5. VSCode

`SessionController` passes `onIdleExpired` through its `openSession` wiring.
On expiry of the current session it forgets the session without closing it
again (core is closing it), pushes the separator `closed after idle`, and sets
status `closed`. The existing lazy open on the next send does the rest and
pushes nothing further.

The extension gains one setting, `idleTimeoutMinutes` under the provider's
configuration section (next to the existing timeout setting, same parsing
rules with `0` allowed), declared through `manifest.ts`. Unset means the
provider default, then 24 h.

## 6. Documentation

- `README.md`: a short "Long-running sessions" section: an open session keeps a
  browser alive, why it costs CPU, the 24 h idle close and how to change or
  disable it (config, env, VSCode setting).
- `README.md` "Provider extension points", `packages/provider/README.md` and
  the `creating-provider-repo` skill: `browser.reducedMotion` (why it defaults to
  `"reduce"`, when to opt out, and that completion detection should key on DOM
  state rather than on a running animation) and `idle.timeoutMs`.
- `packages/vscode/README.md`: the new setting.
- Release notes (PR title/body): the behaviour change — an interactive session
  now closes its browser after 24 h idle and reopens on the next prompt.

## 7. Testing

- `idle-watch.test.ts` (fake `now`, short `tickMs`): expires after the timeout;
  `touch()` extends; never expires while paused; `resume()` restarts the
  period; a wall-clock jump (sleep/wake) expires on the next tick; fires once;
  `stop()` is idempotent.
- `chat-session.test.ts` (fake runtime): order of `onIdleExpired` →
  progress → close; auth state saved on a healthy page; falls back to `kill()`
  when `close()` hangs; no expiry during a pending `send`/`runCommand`;
  `timeoutMs: 0` creates no watch; `close()` during the idle close joins it;
  `send` after expiry rejects with `InvalidStateError`.
- `packages/runtime` E2E (real Chromium): `matchMedia("(prefers-reduced-motion:
  reduce)").matches` is `true` by default and `false` with the provider opt-out.
- `idle-options.test.ts` and `config.test.ts`: layer precedence, `0`, invalid
  values.
- `chat-model.test.ts`: after expiry the next prompt reopens with the
  separator and is sent; `/new` and Ctrl+R clear the flag; a stale session's
  expiry is ignored.
- `session-controller.test.ts`: expiry → `closed` + separator; next send
  opens lazily; a stale session's expiry is ignored.
- CPU acceptance is **not** a CI test (CPU readings are flaky on shared
  runners). `scripts/measure-idle-cpu.ts` reproduces the measurement from #95
  against an animated fixture page through `BrowserRuntime.launch()`; the
  before/after numbers are recorded in
  `docs/spike-notes/2026-09-20-idle-browser-cpu.md`. Target: under a few
  percent of one core while idle with the default context.
