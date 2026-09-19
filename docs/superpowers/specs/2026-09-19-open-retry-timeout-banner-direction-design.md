# Milestone 14 (v0.8.3): browser-open retry/timeout and banner gradient direction

Tracking issue: #42. Also closes #81.

## Goals

1. The "Opening browser..." phase gets its own timeout and a retry count,
   resolved in layers: built-in default → provider default → `config.json` →
   environment variable. (#42)
2. `BannerOptions.mode: "gradient"` gains a `direction` of `vertical`
   (default), `horizontal` or `diagonal`. (#81)

Non-goals: retrying `auth login`, backoff between attempts, a `createCli`-level
default separate from the provider, and any change to the per-turn `--timeout`.

## 1. Provider field and built-in defaults

`Provider` (`packages/provider/src/index.ts`) gains one optional field:

```ts
/** Optional. Defaults for the opening phase (launch → goto → isLoggedIn →
 * startNewChat). A slow service may raise the timeout; a flaky one may
 * ask for retries. Users override both via config.json and env vars. */
open?: { timeoutMs?: number; retries?: number };
```

Built-in defaults: `timeoutMs` 120 000 (the same value the opening steps use
today through `--timeout`), `retries` 0. `retries` counts re-runs after the
first attempt, so 0 keeps today's single attempt. Existing providers behave
exactly as before.

## 2. Layer resolution (`@chatbridge/cli`)

New module `packages/cli/src/open-options.ts`:

```ts
export interface OpenOptions { timeoutMs: number; retries: number }
export const DEFAULT_OPEN_OPTIONS: OpenOptions = { timeoutMs: 120_000, retries: 0 };
export function resolveOpenOptions(input: {
  provider: Pick<Provider, "open">;
  config: CliConfig;
  env: Record<string, string | undefined>;
}): OpenOptions;
```

Each layer overrides only the keys it sets: built-in → `provider.open` →
`config.open` → env.

- `config.json` gains `"open": { "timeoutSec"?: number, "retries"?: number }`.
  `loadConfig` validates it like `shell`: `open` must be an object,
  `timeoutSec` a positive number, `retries` a non-negative integer; anything
  else is `INVALID_CONFIG`. Seconds, matching `--timeout`.
- Environment: `CHATBRIDGE_OPEN_TIMEOUT` (seconds, positive number) and
  `CHATBRIDGE_OPEN_RETRIES` (non-negative integer). An unparsable value is
  `INVALID_ARGUMENT` before any browser launches, with the variable named in
  the message. Empty string counts as unset.
- Provider values are trusted as written (the vendor's own code); no
  validation beyond the type.
- One-shot mode starts reading `config.json` too (today only interactive
  does), via the same `loadConfig(location, { providerPinned })` call. A
  broken config now fails one-shot the same way; that is the documented
  "every mode fails the same way" rule.
- `createCli` gets no separate default of its own.

`create-cli.ts` resolves the options once per command and passes `open` to
`runOneShot` / `runInteractive`, which forward it to `ChatSession.open`.

## 3. Retry in core (`ChatSession.open`)

`ChatSessionOptions` gains an optional `open: { timeoutMs: number; retries: number }`,
defaulting to `{ timeoutMs, retries: 0 }` (the pre-0.8.3 behaviour). The cli
callers (one-shot and `runInteractive`) always supply it; the VSCode extension
and existing tests keep calling `ChatSession.open` unchanged.

`open()` keeps the `authStore.has()` pre-check outside the loop, then runs
`attempt()` up to `retries + 1` times. One attempt is today's body: launch
(through `launchRuntime`) → `page.setDefaultTimeout(open.timeoutMs)` →
`goto` → `assertLoggedIn` → `startNewChat`, every step under `runStep` with
`open.timeoutMs`. On failure the attempt closes the runtime it launched (if
launch succeeded) before returning control.

Retried: any error except the ones below. That covers launch failures,
`ResponseTimeoutError` from the opening steps, and Playwright page errors.

Not retried (thrown immediately): `AuthRequiredError` (raised before the
loop), `AuthExpiredError`, `BlockedError`, `BrowserUnavailableError`.

After the last attempt fails, its error is thrown unchanged. No backoff:
closing and relaunching a browser already takes seconds.

Progress: the first attempt reports `"Opening browser..."` as today; attempt
`k` of `n` (k ≥ 2) reports `"Opening browser... (attempt k/n)"` where
`n = retries + 1`. The TUI status row and Ctrl+R reopen pick this up through
the existing `onProgress` wiring; nothing else in the TUI changes.

`timeoutMs` (the per-turn `--timeout`) is no longer used by the opening
steps. It still governs `send`, `diagnoseTimeout` and `close`.

`auth login` (`session.ts`) is unchanged: it stays headful, one attempt,
30 s navigation timeout.

## 4. Banner gradient direction (#81)

`BannerOptions` (`banner-options.ts`) gains
`direction?: "vertical" | "horizontal" | "diagonal"`, default `"vertical"`.
It is only meaningful for `mode: "gradient"` and ignored otherwise.
`validateBanner` rejects any other string with
`banner.direction: expected "vertical" | "horizontal" | "diagonal", got ...`.

`BannerColorSpec` gains `direction` and `maxWidth` (the widest line in code
points). `bannerColorAt(row, col, spec)` computes the gradient position `t`:

- vertical: `row / (rows - 1)`
- horizontal: `col / (maxWidth - 1)`
- diagonal: `(row + col) / (rows + maxWidth - 2)`

A zero denominator yields `t = 0`. `t` is clamped to `[0, 1]` and then mapped
onto the stop list as today (`pos = t * (n - 1)`).

`colourLine` passes a centred column: `col + floor((maxWidth - lineWidth) / 2)`,
so lines of different widths line up on screen. `resolveBanner` computes
`maxWidth` once from `b.lines`. Widths are code-point counts, the same
approximation `per-char` already documents.

## 5. Tests

- core `chat-session.test.ts`: retries 0 → one attempt; launch fails once
  then succeeds → session opens and progress shows `(attempt 2/2)`; timeout
  on goto retried; `AuthExpiredError`/`BlockedError`/`BrowserUnavailableError`
  not retried; the runtime is closed between attempts; last error is rethrown.
- cli `open-options.test.ts`: each layer overrides the previous; partial
  overrides keep other keys; env parsing errors name the variable.
- cli `config.test.ts`: `open` shapes accepted and rejected.
- cli `create-cli.test.ts`: one-shot reads config; bad env exits 1 before launch.
- cli `banner.test.ts`: three directions, centring offset, degenerate sizes,
  `validateBanner` on a bad direction.

## 6. Documentation

README: `config.json` `open` section, the two environment variables, the
`Provider.open` field, and `direction` in the banner section. Provider
docs (`docs/` provider authoring guide, if present) get the `open` field.

## Files

`packages/provider/src/index.ts`, `packages/core/src/chat-session.ts`,
`packages/cli/src/config.ts`, `packages/cli/src/open-options.ts` (new),
`packages/cli/src/create-cli.ts`, `packages/core/src/session.ts` (`runOneShot` and `OneShotOptions` gain `open`), `packages/cli/src/tui/run-interactive.ts`,
`packages/cli/src/tui/banner-options.ts`, `packages/cli/src/tui/banner.ts`,
`README.md`.
