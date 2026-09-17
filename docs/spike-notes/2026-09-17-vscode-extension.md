# Spike: driving `ChatSession` from a VSCode extension host (issue #36)

Date: 2026-09-17. Workspace `dist/` at v0.6.0 (`@chatbridge/core`, `runtime`,
`provider`), `playwright` 1.63.0, VSCode 1.130.0 on macOS arm64. Throwaway
extension under `spikes/vscode-extension/` (deleted afterwards); this note
and the issues it names are the only things kept.

## Question

The backlog decided (2026-09-10) that the browser runs inside the
extension host, not in a CLI child process. Before designing the extension,
confirm three things on the real Electron Node:

1. `ChatSession` + Playwright (`chromium.launchServer` → `connect`) work
   from the extension host and complete a turn against the dummy chat.
2. Headful `runLogin()` opens a window from the extension host, detects
   completion, saves the auth state, and a later session reuses it.
3. What happens when Chromium is not installed, and how the extension
   should surface installation.

## Result in one line

All three work unchanged: the extension host is Node 24 with
`ELECTRON_RUN_AS_NODE=1`, login → save → headless turn → reuse all passed,
and the extension can install Chromium itself by spawning Playwright's CLI
with `process.execPath`.

## Method

A minimal extension (no webview) contributing commands `login`, `send`,
`close`, `env`, `install`, bundled with esbuild (`--platform=node
--format=cjs`, `vscode` and `playwright` external). It imported the
workspace `packages/core/dist/index.js` directly and inlined the dummy
provider from `examples/dummy-chat/provider.ts`. The dummy server uses
`Bun.serve`, so it ran separately under Bun on port 8735. The commands were
driven by `@vscode/test-electron` (`runTests` with the installed VSCode
binary) so each pass ran unattended; the extension appended a log file.

Four passes:

| Pass | Steps | Result |
|---|---|---|
| 1 | env, login, send, close | login window opened; state saved; reply `Echo: hello from vscode` in 857 ms |
| 2 | env, send, close (fresh host, saved state) | opened headless without login; reply in 861 ms |
| 3 | send with `PLAYWRIGHT_BROWSERS_PATH` empty | `Error: Executable doesn't exist at …/chromium_headless_shell-1243/…` plus Playwright's `npx playwright install` box |
| 4 | install, send, close (same empty path) | `playwright install chromium` spawned from the host finished in 15 s (557 MB); the following turn succeeded |

## Findings

### Runtime environment

- Extension host: `node 24.18.0`, `electron 42.6.0`, `process.execPath` is
  `Code Helper (Plugin)`, `ELECTRON_RUN_AS_NODE=1` is set. `@chatbridge/*`
  declare `engines.node >= 20`; nothing in core/runtime/provider needed
  changing. The `Bun`-only code in the repo is the dummy server and the
  CLI's TUI, neither of which the extension touches.
- `chromium.launchServer` + `chromium.connect` (the `kill()`-capable shape
  from milestone 8) works from the host; no sandbox or entitlement issue on
  macOS.
- The extension host inherits the user's shell `PATH` when VSCode is
  launched from a terminal; do not rely on that for finding browsers.
  Playwright resolves `~/Library/Caches/ms-playwright` on its own.

### Headful login

- `runLogin()` opened a headful Chromium window from the extension host,
  polled `isLoggedIn`, saved the storage state, and closed. The user clicks
  in the Playwright window, not in VSCode; nothing in the flow needs a
  VSCode UI. (In pass 1 nobody clicked within 60 s, so the spike's
  provider auto-clicked the dummy button; the window itself was open.)
- `runLogin` has no deadline by design (MFA). In an extension it must be
  cancellable from the UI: a `withProgress` notification with a cancel
  button that calls `rt.kill()`. Today `runLogin` exposes no cancel handle
  (the CLI relies on Ctrl-C). Gap → issue.
- Auth state landed in `~/.config/chatbridge-spike/dummy-chat.json` with the
  usual permissions. The extension should share the CLI's `configDir` so one
  `auth login` serves both; the derived CLI and the extension of one vendor
  must agree on it.

### Missing Chromium

- The failure is a plain `Error` thrown from `chromium.launchServer`
  (message starts with `Executable doesn't exist at`, followed by
  Playwright's boxed hint). Core does not classify it; the CLI would print
  it verbatim with exit 1. Neither `ChatSession.open` nor `runLogin`
  distinguishes it from any other launch failure. Gap → issue: a
  `BrowserUnavailableError` (or a field on a launch error) so both the CLI
  and the extension can offer the install step.
- Playwright's own detection is `chromium.executablePath()` + `existsSync`;
  the runtime can check this before launching and fail fast.
- The extension can install Chromium itself: spawn
  `process.execPath <playwright dir>/cli.js install chromium` with
  `ELECTRON_RUN_AS_NODE=1` in the env. Stdout carries a progress bar per
  download (ffmpeg, headless shell, full Chromium), usable for
  `withProgress`. `require.resolve("playwright/cli.js")` is blocked by the
  package's `exports` map; resolve `playwright/package.json` and join
  `cli.js`. Total download here: 557 MB, 15 s.
- Recommended surfacing: on `BrowserUnavailableError`, show a modal
  "Chromium is not installed" with an **Install** button that runs the
  spawn under `withProgress` and then retries the command; also a
  `chatbridge: Install browser` command for manual use. Never install
  silently on activation.

### Packaging notes for the design

- The extension must be CJS-bundled (VSCode loads `main` via `require`);
  `@chatbridge/*` are ESM and bundle fine with esbuild. `playwright` must
  stay external and ship inside the `.vsix` `node_modules` (it is pure JS
  plus the driver; `playwright-core` is a dependency of it). The vendor repo
  that packages the extension therefore depends on `playwright` (not just
  `playwright-core`) to get the `install` CLI.
- `@vscode/test-electron` works for CI-style E2E in a vendor repo: pass
  `--user-data-dir` with a short path (the default under the repo exceeds
  the macOS unix-socket path limit: `listen EINVAL … 1.13-main.sock`).
- A shared `createExtension({ provider, configDir, … })` factory in the
  style of `createCli` is feasible: the spike's `activate` is already
  provider-agnostic apart from the inlined dummy provider.

## Recommendation

Proceed to the architectural design of the extension on the "browser in the
extension host" decision; nothing found argues against it. Before or as part
of that milestone, close two runtime gaps in this repo:

1. Classify a missing browser executable (`BrowserUnavailableError`, #52) in
   core/runtime, with a pre-launch `existsSync(chromium.executablePath())`
   check, so the CLI can print an install hint and the extension can offer
   an install button.
2. Give `runLogin` a cancellation handle (#53; an `AbortSignal` option that
   kills the browser) so an extension can cancel a stuck login without
   Ctrl-C.

Everything else the extension needs (`ChatSession`, `AuthStore`, the
Provider contract) is already sufficient.
