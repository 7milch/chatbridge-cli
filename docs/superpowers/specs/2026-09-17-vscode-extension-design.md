# VSCode extension (milestone 11) — Design

Date: 2026-09-17
Status: Approved (brainstorming session)
Issue: https://github.com/7milch/chatbridge-cli/issues/57
Spike: `docs/spike-notes/2026-09-17-vscode-extension.md` (#36)

## Goal

Ship a VSCode extension factory, `createExtension`, in the style of
`createCli`: this repository provides the provider-agnostic extension
(sidebar chat view, commands, error handling, Chromium installation), and a
vendor repository supplies the Provider and packages the `.vsix`.

Decisions taken during brainstorming:

- **Own webview**, not the Chat Participant API. The intended users are
  corporate environments where Copilot Chat (which the built-in Chat view
  depends on) may be disabled.
- **Vanilla TypeScript** in the webview, no UI framework. The UI is small;
  CSP and bundling stay simple.
- **First release scope:** chat send/receive, new chat, login/logout,
  Chromium install flow, and editor integration (send selection / send
  file). No `@` completion, no `!` shell mode.
- **Attachments use the CLI's format.** The formatting helpers move from
  `@chatbridge/cli` to `@chatbridge/core` so the extension does not depend
  on the CLI package.
- **Unit tests plus one `@vscode/test-electron` E2E** in this repository.
- **Prerequisites #52 and #53** (runtime gaps found by the spike) are the
  first tasks of this milestone.

Out of scope for the first release: Markdown rendering, history
persistence, `@` mention completion, `!` shell mode, Chat Participant API,
switching between several Providers at runtime.

## Section 1: package layout and dependencies

New package `packages/vscode` (npm `@chatbridge/vscode`, `type: module`,
`engines.node >= 20`). Dependency direction stays one-way:
`vscode → core → runtime → provider`. The extension never imports
`@chatbridge/cli`.

```
packages/vscode/
  src/
    index.ts              exports createExtension and public types
    create-extension.ts   the factory: activate / deactivate
    session-controller.ts session state machine (no vscode import; unit-tested)
    commands.ts           command registration
    chat-view-provider.ts WebviewViewProvider; bridges protocol ⇄ controller
    protocol.ts           host ⇄ webview message types (imported by both sides)
    install-browser.ts    spawns playwright/cli.js install chromium
    vscode-api.ts         minimal interface over the vscode API (fakes in tests)
    webview/
      main.ts             webview script (DOM only)
      style.css
  dist/                   tsc output (host side) + esbuild IIFE bundle (webview)
examples/vscode-dummy-chat/
  package.json            reference `contributes` manifest (id = "chatbridge-dummy")
  src/extension.ts        createExtension({ provider: dummyProvider, ... })
  esbuild.mjs             CJS bundle; `vscode` and `playwright` external
  test/e2e.test.ts        @vscode/test-electron run against the dummy chat
```

Dependencies:

- `@chatbridge/vscode`: `dependencies` = `@chatbridge/core`.
  `devDependencies` = `@types/vscode` (the host provides the module),
  `esbuild` (webview bundle, run as part of `bun run build`).
- `examples/vscode-dummy-chat`: `dependencies` = `@chatbridge/vscode`,
  `@chatbridge/example-dummy-chat`, `playwright` (not `playwright-core`:
  the `install` CLI is needed, per the spike). `devDependencies` =
  `@vscode/test-electron`, `esbuild`.
- A vendor repository copies the example as its template. The
  `creating-provider-repo` skill gains a VSCode section.

Why the vendor writes the manifest: `contributes` (view container, view,
commands, menus, configuration) is static JSON that VSCode reads before
any code runs, so the factory cannot generate it. IDs follow a naming rule
derived from `id` (below). On `activate`, the factory checks the host
extension's `packageJSON.contributes` for the expected view and command
IDs and throws a clear error listing the missing ones, so a mistyped
manifest fails loudly instead of silently doing nothing. A manifest
generator was considered and rejected as premature.

Factory options, symmetric with `CreateCliOptions`:

```ts
export interface CreateExtensionOptions {
  /** Prefix for every contributed ID, e.g. "company-ai". */
  id: string;
  /** Shown as the view title and in notifications. */
  displayName: string;
  /** Always pinned; no dynamic provider loading. */
  provider: Provider;
  /** Directory name under ~/.config; defaults to `id`. Use the same value
   * as the vendor CLI's `configDir` so one `auth login` serves both. */
  configDir?: string;
  /** Defaults; the user's settings (Section 2) override them. */
  timeoutMs?: number; // 120_000
  headless?: boolean; // true
  /** Test-only: overrides the config/auth-store base directory. */
  baseDir?: string;
}

export function createExtension(opts: CreateExtensionOptions): {
  activate(context: vscode.ExtensionContext): Promise<void>;
  deactivate(): Promise<void>;
};
```

The vendor's `extension.ts` is:

```ts
import { createExtension } from "@chatbridge/vscode";
import { provider } from "./provider.js";
export const { activate, deactivate } = createExtension({
  id: "company-ai", displayName: "Company AI", provider, configDir: "company-ai",
});
```

Contributed IDs (all under `<id>.`): view container `<id>` in the activity
bar; view `<id>.chat`; commands `<id>.login`, `<id>.logout`,
`<id>.newChat`, `<id>.installBrowser`, `<id>.sendSelection`,
`<id>.sendFile`, `<id>.focus`; configuration keys `<id>.headless`,
`<id>.timeoutSec`.

## Section 2: extension host side

### SessionController

A thin state machine without any `vscode` import, the analogue of the
TUI's `ChatModel`. It owns the history and the `ChatSession`.

- States: `closed` (no browser) → `opening` → `idle` ⇄ `busy`; `dead` from
  any state on a fatal error.
- **Lazy launch.** `activate` never starts a browser; the first `send`
  calls `ChatSession.open`. This avoids a Chromium process on every VSCode
  start.
- `send(text, attachments)`: opens the session when `closed`; rejected
  when `busy` (the webview disables input, so this is a guard, not a
  queue). The prompt sent is `text`, then `"\n\n"`, then one
  `formatAttachment(...)` per attachment in order (Section 4). An empty
  `text` with attachments is allowed, as with the TUI's `@file`-only send.
- `newChat()`: the TUI's `Ctrl+R`. Closes the current session via
  `closeOrKill` (5 s, then `kill`), pushes a `separator` message, returns
  to `closed`; the next send reopens.
- `close()`: called from `deactivate`; `closeOrKill` as above.
- Fatal (→ `dead`): `AuthRequiredError`, `AuthExpiredError`,
  `BlockedError`, `BrowserUnavailableError`, any other open failure.
  `ResponseTimeoutError` is not fatal: the session stays open, an `error`
  message is pushed, the state returns to `idle` (as in the TUI).
- History (`Message[]`) lives here, so a webview that VSCode disposes and
  recreates is restored from it. Nothing is persisted to disk.
- `pendingAttachments: Attachment[]` (Section 4) also live here.
- Observers subscribe to `onChange` and receive the full `State`
  (`status`, `messages`, `pendingAttachments`) plus the latest progress
  line.

```ts
export type Role = "user" | "assistant" | "error" | "separator";
export interface Message { role: Role; text: string; attachments?: Attachment[] }
export type Status = "closed" | "opening" | "idle" | "busy" | "dead";
```

`closeOrKill` moves from `packages/cli/src/tui/close-session.ts` to
`@chatbridge/core` (it depends only on `ChatSessionLike`) and the CLI
imports it from there.

### Commands

| Command | Behaviour |
|---|---|
| `login` | `runLogin` under `withProgress` (notification, cancellable). Cancel aborts the `AbortSignal` from #53. On success, a `separator`-style "Logged in" line is pushed; a `dead` controller returns to `closed`. |
| `logout` | `closeOrKill` the session, `authStore.clear()`, state `closed`. |
| `newChat` | `controller.newChat()`. Also a view title button. |
| `installBrowser` | Runs `install-browser.ts` under `withProgress`; the progress text is Playwright's per-download stdout line. Never runs on activation. |
| `sendSelection` / `sendFile` | Section 4. |
| `focus` | Reveals and focuses the chat view. |

`install-browser.ts` spawns `process.execPath <playwright dir>/cli.js
install chromium` with `ELECTRON_RUN_AS_NODE=1`, resolving the directory
from `playwright/package.json` (the `exports` map blocks
`require.resolve("playwright/cli.js")`). The spawn function is injected so
the unit test checks the arguments and the progress parsing without
downloading anything.

### Error surfacing

One map from `ChatBridgeError.code` to presentation, the analogue of the
CLI's `EXIT_CODES`:

| Code | Presentation |
|---|---|
| `AUTH_REQUIRED`, `AUTH_EXPIRED` | `error` message in the history plus a **Log in** button in the webview that runs `<id>.login`. |
| `BROWSER_UNAVAILABLE` (#52) | Modal `showErrorMessage` with an **Install** button. After a successful install the failed send is retried once automatically. |
| `BLOCKED` | `error` message plus the hint to set `<id>.headless` to `false` and retry. |
| `RESPONSE_TIMEOUT` | `error` message only; session kept. |
| anything else | `error` message; state `dead`; **New chat** recovers. |

Error messages never include auth content; `onProgress` and error text
already exclude it by design in core.

### Settings and progress

- `contributes.configuration`: `<id>.headless` (boolean, default `true`),
  `<id>.timeoutSec` (number, default `120`). Read when a session is
  opened; a change applies to the next open. `configDir` is a factory
  argument, not a setting, so the CLI and the extension of one vendor
  always share the auth state.
- `ChatSession`'s `onProgress` strings go to a status-bar item
  (`$(sync~spin) <text>`) while `busy`, to the webview's progress line,
  and to an `OutputChannel` named `displayName`.

## Section 3: webview and protocol

### View

One activity-bar container (`<id>`, icon plus `displayName`) with one
`WebviewView` (`<id>.chat`). The provider builds the HTML from
`dist/webview/main.js` and `style.css` with a fixed CSP:
`default-src 'none'; script-src 'nonce-<n>'; style-src <cspSource>`. No
external resources.

Elements (vanilla TS, direct DOM):

- History: `user`, `assistant`, `error`, `separator`. Assistant text is
  rendered as plain text (`textContent`, `white-space: pre-wrap`).
  Markdown rendering is deferred together with the TUI's.
- Input: a `textarea`; Enter sends, Shift+Enter inserts a newline;
  disabled while `busy`/`opening`.
- Attachment chips above the input, one per pending attachment
  (`path (size)`, × removes). Sent user messages list their attachments
  as one line each, as the TUI does.
- Status line: spinner plus progress text while `busy`; a **New chat**
  button when `dead`; a **Log in** button after an auth error.
- Colours come only from `--vscode-*` CSS variables.

### Protocol (`protocol.ts`, discriminated unions shared by both sides)

```ts
// webview → host
export type ToHost =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "removeAttachment"; index: number }
  | { type: "command"; name: "login" | "newChat" | "installBrowser" };

// host → webview
export type ToWebview =
  | { type: "state"; status: Status; messages: Message[];
      pendingAttachments: Attachment[]; lastError?: string }
  | { type: "progress"; text: string };
```

`state` is always a full replacement, sent on `ready` and on every
controller change. The history is one window's worth, so full replacement
is cheap and avoids diff-sync bugs. `lastError` carries the code of the
most recent fatal error so the webview can choose the recovery button.

### Recreation

VSCode disposes the webview when the sidebar is hidden (the design does not
rely on `retainContextWhenHidden`). `resolveWebviewView` returns fresh
HTML each time; the webview posts `ready`, the host replies with the
current `state`. The controller is the single source of truth.

### Test boundary

`chat-view-provider.ts` receives only "something with `postMessage` and
`onDidReceiveMessage`" and translates `ToHost` into controller calls. Unit
tests use a fake webview and never load `vscode`. `webview/main.ts` is a
DOM-only layer exercised once by the E2E.

## Section 4: editor integration and the `attachment` move

### Move to core

`packages/cli/src/fence.ts` (`fenceFor`) and, from
`packages/cli/src/mentions/expand-mentions.ts`, `section()`,
`languageOf()`, `LANGUAGES`, `formatSize`, the `Attachment` type and the
size constants move to `packages/core/src/attachment.ts`, exported from
`@chatbridge/core`:

```ts
export interface Attachment { path: string; bytes: number }
export const MAX_FILE_BYTES = 200 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024;
export function fenceFor(content: string): string;
export function formatAttachment(path: string, content: string): string;
export function formatSize(bytes: number): string;
```

`formatAttachment` produces `### <path>\n<fence><lang>\n<body><fence>`,
byte-for-byte what `section()` produces today. The CLI (`expand-mentions`,
`shell/format-result`) switches its imports; behaviour is unchanged and
covered by the existing tests, which move with the code. Mention parsing,
the file index and the `@` UI stay in the CLI.

### Commands

Both use the VSCode API only and never read the disk themselves.

| Command | Source | Attachment path | Menus |
|---|---|---|---|
| `sendSelection` | active editor's selection; whole document when empty | workspace-relative path, plus `:L1-L2` for a selection | editor context menu, palette |
| `sendFile` | the file right-clicked in the explorer, else the active editor | workspace-relative path | explorer context menu, palette |

Both **queue an attachment**; neither sends. The controller appends to
`pendingAttachments`, the `state` update shows the chip, and the user
types a message and sends. Files outside any workspace folder use their
absolute path. Size limits are the shared core constants; an oversize
attachment is rejected with `showWarningMessage`. No binary detection: the
content comes from an editor document.

## Section 5: prerequisites #52 and #53

`ChatBridgeError` lives in core and runtime cannot depend on core, so
detection lives in runtime and classification in core.

### #52 `BrowserUnavailableError`

- `@chatbridge/runtime` exports `missingBrowserExecutable(): string |
  undefined` (returns `chromium.executablePath()` when `existsSync` is
  false) and `isMissingExecutableError(err: unknown): boolean` (matches
  Playwright's `Executable doesn't exist at` message as a fallback).
- `@chatbridge/core` adds `BrowserUnavailableError` (`code:
  "BROWSER_UNAVAILABLE"`, message includes the expected path).
  The pre-check applies to headed launches (`runLogin`, headful sessions):
  they call `missingBrowserExecutable()` before launching and throw, since
  it checks the headed `chromium-<rev>` binary. Headless launches skip it
  (a `--only-shell` install has only `chromium_headless_shell-<rev>`) and
  rely on the fallback: a launch error that satisfies
  `isMissingExecutableError` is wrapped into the same class.
- CLI: `EXIT_CODES.BROWSER_UNAVAILABLE = 7`; the printed message ends with
  `Run: npx playwright install chromium`. `--help` and the README exit-code
  lists gain the entry.

### #53 cancellable `runLogin`

- `LoginOptions.signal?: AbortSignal`. On abort: stop polling, `rt.kill()`,
  reject with the new `LoginAbortedError` (`code: "LOGIN_ABORTED"`). An
  already-aborted signal rejects before any launch.
- The 1 s poll delay becomes an abortable timer (`setTimeout` plus a signal
  listener) instead of `page.waitForTimeout`.
- CLI `auth login` connects `SIGINT` to the signal and exits 130 on
  `LOGIN_ABORTED`; everything else is unchanged.

## Section 6: testing, CI, build

- **Unit (bun test):** `SessionController` with a fake `ChatSessionLike`
  (transitions, every error code, `newChat` close-or-kill);
  `chat-view-provider` with a fake webview (`ToHost` → controller calls,
  `state` emission); `install-browser` with an injected spawn (arguments,
  progress parsing); core `attachment` (tests moved from the CLI). The
  `vscode` module is never loaded in unit tests: everything goes through
  `vscode-api.ts`.
- **E2E (one test):** `examples/vscode-dummy-chat/test/e2e.test.ts` runs
  VSCode via `@vscode/test-electron` against the dummy chat server (Bun):
  `login` → `send` (commands invoked directly, the controller exposed for
  the test) → the reply is in the history → `newChat` → deactivate. A
  short `--user-data-dir` (spike finding). The webview DOM is not
  asserted.
- **CI:** the extension's unit tests are part of `bun run check`. The E2E
  is a separate job `vscode-e2e` (ubuntu, `xvfb-run`, VSCode download)
  that runs only when `packages/vscode/**` or
  `examples/vscode-dummy-chat/**` changed, using the same diff detection
  as the docs-only skip. Locally: `bun run e2e:vscode`.
- **Build:** the package joins `tsc --build`; the webview bundle (esbuild
  IIFE) runs from the package's `build` script after tsc.
  `scripts/pack-all.sh` gains `@chatbridge/vscode`. The example's `.vsix`
  is built with `@vscode/vsce` in the E2E job as a packaging smoke test.

## Task order

1. #52 `BrowserUnavailableError` (runtime + core + CLI).
2. #53 cancellable `runLogin` (core + CLI).
3. Move `attachment` helpers and `closeOrKill` to core; CLI re-imports.
4. `packages/vscode`: protocol, `SessionController`, `install-browser`.
5. `chat-view-provider`, `commands`, `create-extension`, webview.
6. `examples/vscode-dummy-chat`: manifest, bundle, E2E; CI job.
7. Docs: README section, ROADMAP entry moves to done,
   `creating-provider-repo` skill gains the VSCode section.
