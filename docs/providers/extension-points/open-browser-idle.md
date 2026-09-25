# `open`, `browser`, `idle`

Three optional `Provider` members that set the built-in defaults for the
opening phase, the browser context, and the idle close of an interactive
session. The contract is `ProviderOpenDefaults`, `ProviderBrowserDefaults`
and `ProviderIdleDefaults` in `@chatbridge/provider`. The users of them are
`ChatSession.open` and the idle watch in `@chatbridge/core`
(`chat-session.ts`, `idle-watch.ts`), `resolveOpenOptions` and
`resolveIdleOptions` in the CLI (`open-options.ts`, `idle-options.ts`),
and `BrowserRuntime.launch` in `@chatbridge/runtime`
(`browser-runtime.ts`).

None of the three is required. Each has a built-in value that works
without a provider opinion.

## `open`

```ts
open?: {
  timeoutMs?: number; // built-in 120_000
  retries?: number;   // built-in 0
};
```

`timeoutMs` is the per-step timeout during the opening phase: launch,
`goto` the chat URL, `isLoggedIn`, then either restoring the conversation
or `startNewChat`. It is not the per-turn timeout; a session's turns run
under `--timeout` (CLI) or the resolved per-turn timeout (VSCode) once the
opening phase has handed the page over.

`retries` is how many extra times the whole opening phase is re-run after
a launch or navigation failure. A retry closes the browser first, then
starts over from launch; the last attempt's error is the one that
propagates. `AuthRequiredError`, `AuthExpiredError`, `BlockedError` and
`BrowserUnavailableError` are never retried, because opening again cannot
fix them (see [auth-and-browser.md](../auth-and-browser.md#errors)).

| Field | Built-in | Provider | User override |
|---|---|---|---|
| `timeoutMs` | 120 000 | `open.timeoutMs` | CLI: `open.timeoutSec` in config.json, then `CHATBRIDGE_OPEN_TIMEOUT`. VSCode: none. |
| `retries` | 0 | `open.retries` | CLI: `open.retries` in config.json, then `CHATBRIDGE_OPEN_RETRIES`. VSCode: none. |

In VSCode there is no `open` setting at all. The opening timeout is the
provider's `open.timeoutMs` if it sets one, else the resolved per-turn
timeout (the `<id>.timeoutSec` setting, or the vendor's
`createExtension({ timeoutMs })`, or 120 s). Retries are the provider's
`open.retries`, else 0. See
[../../users/configuration.md](../../users/configuration.md#opening-phase)
for the full precedence table and the CLI's env-var validation messages.

## `browser`

```ts
browser?: {
  reducedMotion?: "reduce" | "no-preference"; // built-in "reduce"
};
```

`reducedMotion` sets the emulated `prefers-reduced-motion` media feature
for every browser context the runtime opens for this provider, including
the headful login window. There is no user setting for it; only the
provider can change it.

| Field | Built-in | Provider | User override |
|---|---|---|---|
| `reducedMotion` | `"reduce"` | `browser.reducedMotion` | none |

The default exists because a page left animating in headless Chromium is
rasterised on the CPU for as long as the session stays open; see
[2026-09-20-idle-browser-cpu.md](../../spike-notes/2026-09-20-idle-browser-cpu.md)
for the measurement. Opt out only when the service misbehaves under
reduced motion, typically because `waitForResponse` keys on an animation
rather than on DOM state such as a busy attribute.

## `idle`

```ts
idle?: {
  timeoutMs?: number; // built-in 86_400_000 (24 h); 0 disables
};
```

Applies to interactive sessions only; one-shot mode never arms the idle
watch. The watch checks a wall-clock deadline on a repeating interval
(`tickMs`, default 30 s) rather than one long timer, so a sleeping laptop
does not push the deadline back: the first tick after wake expires an
already-overdue session. The watch pauses for the duration of a turn or a
command and resumes counting from the moment it ends.

On expiry the UI is told first, synchronously, so it drops the session
before anything else awaits. Progress reports:

```
Closing the browser after <duration> idle...
```

`<duration>` is formatted by `formatIdleDuration`: whole minutes or hours
print without a decimal (`24 h`), everything else with one (`1.5 min`).
The close then runs like any other close: auth state is saved if
`isLoggedIn` still returns `true`. It has a 5 second budget
(`IDLE_CLOSE_BUDGET_MS`) before the browser is killed instead. The next
prompt reopens the browser as usual.

| Field | Built-in | Provider | User override |
|---|---|---|---|
| `timeoutMs` | 86 400 000 (24 h) | `idle.timeoutMs` | CLI: `idle.timeoutMin` in config.json, then `CHATBRIDGE_IDLE_TIMEOUT`. VSCode: `<id>.idleTimeoutMinutes`. |

`0` at any layer disables the idle close entirely. In VSCode the
`<id>.idleTimeoutMinutes` setting replaces the config-file and env-var
layers outright: unset falls back to the provider's `idle.timeoutMs`,
then to 24 hours. See
[../../users/configuration.md](../../users/configuration.md#idle-close)
for the CLI's full layer order.

## Minimal template

```ts
open: {
  timeoutMs: 180_000,
  retries: 1,
},
browser: {
  reducedMotion: "no-preference",
},
idle: {
  timeoutMs: 60 * 60_000,
},
```

## Related

- [../../users/configuration.md](../../users/configuration.md) — the
  user-side precedence for `open`, `idle`, and every config key and env
  var.
- [../auth-and-browser.md](../auth-and-browser.md#headless-and-headful) —
  headless vs. headful, which `open` does not control.
- [../../spike-notes/2026-09-20-idle-browser-cpu.md](../../spike-notes/2026-09-20-idle-browser-cpu.md)
  — why reduced motion and the idle close both exist.
