# Roadmap

Decisions from the initial design session (2026-09-05). Each milestone gets its own
spec → plan → implementation cycle; this file records the big picture so it survives
across sessions.

## Repository split

| Repository | Holds | Visibility |
|---|---|---|
| `chatbridge-cli` (this repo) | Service-independent skeleton only: Provider API, Playwright runtime, auth-state management, core session flows, CLI + (later) TUI, bundled dummy chat for E2E | Public OSS |
| `chatbridge-rakuten-ai` (local only) | One provider for Rakuten AI plus a derived `rakuten-ai` CLI via `createCli`. Consumes the published packages; rehearses milestone 5 | Private, no remote |
| Company repository | Company-internal provider (URLs, selectors, login detection, config). Never enters either OSS repo | Private |

All three layers consume the same `Provider` contract from `@chatbridge/provider`.

## How work is tracked

Status does not live in this file. It lives on GitHub, so it is the same on
every branch and needs no commit to change.

| What | Where |
|---|---|
| The milestone in flight and what it bundles | [Open milestones](https://github.com/7milch/chatbridge-cli/milestones) |
| Unscheduled ideas | Issues labelled [`backlog`](https://github.com/7milch/chatbridge-cli/issues?q=is%3Aissue+is%3Aopen+label%3Abacklog) |
| Priority and progress | [Project board](https://github.com/users/7milch/projects/1) (private, so the link 404s for anyone else) |
| Long-term memory across sessions | The issue thread, via `gh issue comment` |
| What shipped in each version | [Releases](https://github.com/7milch/chatbridge-cli/releases), generated at publish time from the merged pull requests |

This file keeps the shipped history below, plus the standing design rules at the
end. When a milestone ships, add a heading for it here and close its milestone.
A backlog item becomes a milestone when it is picked up: give it a milestone and
drop the `backlog` label.

## Milestones

Shipped, newest last.

### 1. One-shot vertical slice — done (PR #2, 2026-09-06)

`chatbridge -p "..."`: restore auth state → new chat → send → response to stdout.
Headful `auth login`, `auth logout|status`, `createCli` factory for derived CLIs,
dummy chat + reference provider, CI E2E on real Chromium. Bun + Playwright verified.

### 2. Hardening + publishability (small) — done (PR #4, 2026-09-07)

Follow-ups deferred from milestone 1:

- `playwright-core` becomes a peerDependency of `@chatbridge/provider` (required before publishing)
- Config-file `defaultProvider` fallback (`~/.config/chatbridge/config.json`)
- Tests for exit codes 3 / 4 / 5 (auth expired, response timeout, provider load)
- Provider `name` sanitized before use as a file name
- Pinned provider rejects an explicit `--provider`; unknown flags print usage
- Widen Playwright `TimeoutError` mapping beyond `waitForResponse`; carry `cause`
- Confirm or rename the `@chatbridge` npm scope; first publish

### 3a. Interactive TUI (OpenTUI), non-streaming — done (PR #8, 2026-09-07)

Claude Code–style chat UI: history, multi-line input, send, loading state,
error and status display. Core gains `ChatSession` (browser stays open across
turns); the Provider contract documents multi-turn semantics without new
methods. OpenTUI proven under Bun 1.4 (spike in the spec).

### 4. Rakuten AI provider (private repo) — done (issue #11, PR #12, v0.2.0, 2026-09-08)

A local-only repo `chatbridge-rakuten-ai` builds a `rakuten-ai` CLI on the
published packages. Findings from the real service flow back into the shared
runtime here: the saved auth state now includes IndexedDB (the service keeps
its session there), and the `Provider` contract itself needed no change.
Taken up before 3b, which is shaped by what this milestone exposed (streaming
appends to one element; completion is signalled by the send button returning).
Follow-ups shipped in 0.2.1–0.2.2: the auth state is re-saved when a session
closes (services rotate tokens), and release checks catch a stale `bun.lock`.

### 4.4. Skill: scaffold a vendor provider repo — done (issue #20, 2026-09-08)

A repo skill (`creating-provider-repo`) that captures the milestone 4
procedure for standing up a separate vendor repo with one Provider and a
derived CLI on the published packages: layout, DOM discovery notes, login
signal pitfalls (guest mode, off-origin login page), gated real-service E2E,
dependency hygiene. Written while the experience is fresh; 4.5 dogfoods it.

### 4.5. Second public service spike: ChatGPT — done (issue #22, 2026-09-08)

A time-boxed spike (about a day, nothing kept) driving chatgpt.com through
the published packages with the 4.4 skill, to expose what one sample could not: bot / headless
detection, a `contenteditable` composer, lazy login redirects, rate-limit and
error banners, and whether the streaming DOM is appended or replaced. Output
is a findings note plus issues for any runtime gaps; no provider is kept.
Runs before 3b so the streaming design rests on two observed services.
Outcome: `docs/spike-notes/2026-09-08-chatgpt.md`. Headless is blocked by
Cloudflare and evasion was ruled out of scope; headful one-shot worked
unchanged; both observed services append the streaming DOM in place.

### 3b. Timeout diagnosis, block detection, activity indicator — done (issue #25, 2026-09-08)

Closes the gaps milestones 4 and 4.5 exposed without changing response
capture: a response timeout mid-conversation is diagnosed (`isLoggedIn`
after the timeout → `AuthExpiredError`), a provider can report a bot
challenge or IdP refusal as "blocked, not logged out" through an optional
`detectBlock` (#23; `BlockedError`, exit 6, suggests `--headful`), and the
TUI shows elapsed time against the timeout budget while a turn is pending.
Streaming display was rescoped to the backlog: both observed services
already work with the completion-based contract, and incremental display
is a UX feature rather than a provider need.
Spec: `docs/superpowers/specs/2026-09-08-timeout-diagnosis-block-detection-design.md`.

### 6. @file mentions in the interactive TUI — done (issue #27, 2026-09-09)

Typing `@` in the TUI opens a fuzzy popup over a `.gitignore`-aware index
of the working directory; on send the mentioned files are appended to the
prompt as fenced sections and the history shows one attachment line per
file. Everything lives in `@chatbridge/cli`; core, runtime, and provider
are unchanged. One-shot expansion stays in the backlog behind a flag.
Spec: `docs/superpowers/specs/2026-09-09-file-mentions-design.md`.

### 7. Interactive TUI visual redesign — done (issue #28, 2026-09-09)

Give the interactive TUI a considered visual design. Direction chosen by a
mock competition (five HTML mocks, 2026-09-09); the pick is mock 5:

- Header: inverse badge with the CLI name, then provider · mode · timeout budget in dim text
- Role labels: bold, coloured `user` / `assistant` / `error`; body text unindented
- Startup banner centred in the empty history until the first message; vendor-configurable via `createCli({ banner })`
- Input: bare `>` between two hairlines, one row when empty, growing to five rows, then scrolling internally
- `@` file popup: plain indented list below the input (from milestone 6)
- Status row: key hints when idle; spinner + elapsed / budget while waiting

Mocks: `docs/superpowers/mocks/2026-09-09-tui-mocks.html`.
Shipped with `createCli({ version, banner })` and `--version`; spec: `docs/superpowers/specs/2026-09-09-tui-visual-redesign-design.md`.

### 8. Ctrl+R: reopen the browser from the TUI — done (issue #34, PR #35, 2026-09-10)

Ctrl+R closes the browser (5 s cap, then SIGKILL via the new
`BrowserRuntime.kill()` / `ChatSession.kill()`), opens a fresh one with the
saved auth state, and marks the kept history with `── reopened ──`. It works
mid-turn — the main use is a hung page. Fatal errors no longer quit the TUI:
the model enters `dead`, the status row offers `Ctrl+R reopen · Ctrl+C quit`,
and quitting reports the error. Core stays UI-free; the state machine and
the close cap live in `@chatbridge/cli`.
Spec: `docs/superpowers/specs/2026-09-10-browser-reopen-design.md`.

### 9. Message queue while a turn is in flight — done (issue #46, PR #48, 2026-09-17)

Claude Code-style: `Enter` while a turn is in flight queues the message
instead of dropping it; the queue is listed above the input box and drained
one entry per turn. `Up` from the first line of the input takes the queue
back into the box for editing. `@` mentions expand at send time; the queue
survives `dead` and a Ctrl+R reopen. `Esc` is untouched.
Spec: `docs/superpowers/specs/2026-09-17-message-queue-design.md`.

### 10a. Customizable busy spinner — done (issue #49, 2026-09-17)

`createCli({ spinner: { frames, intervalMs, label, frameColor, labelColor } })`
replaces the three-dot spinner and the `Thinking…` label of the busy status
row and colours them (`"#rrggbb"` or an ANSI index); `label` may be a list,
one entry picked at random per turn. Built-in default →
`createCli` only: the provider carries no presentation data and there is no
`config.json` layer. Frames are not validated; they must share a display
width. Spec: `docs/superpowers/specs/2026-09-17-custom-spinner-design.md`.

### 10b. `!` shell mode in the TUI — done (issue #47, PR #50, 2026-09-17)

Claude Code-style: `!` on an empty input switches the input box into shell
mode; Enter runs the command in the start directory (own privileges, no
sandbox) and streams its output into the history; the result is sent as a
`### $ <command>` fenced section under a configurable lead-in, or held and
attached to the next message with `autoSend: false`. Lead-in and switch are
resolved built-in → `createCli({ shell })` → `config.json`. Output is
capped at 200 KiB (tail kept), stdout/stderr merged, `exit code` /
`interrupted` labelled; Ctrl+C stops a running command; Ctrl+R kills it.
Everything lives in `@chatbridge/cli`. A message typed while a command runs
is queued (milestone 9) and drains when the command's turn ends; a command
itself is never queued. Enter leaves shell mode after running the command
(issue #55). Left for later: `Tab` command history, `/` path completion,
`Ctrl+B` backgrounding, `cd` carry-over, ANSI stripping, running commands
while a turn is in flight.
Spec: `docs/superpowers/specs/2026-09-17-shell-mode-design.md`.

### 11. VSCode extension — done (issue #57, 2026-09-17)

`@chatbridge/vscode`: `createExtension({ id, displayName, provider,
configDir })` returns `activate` / `deactivate`; a vendor manifest declares
the `<id>.*` view, commands and settings (validated on activation). Sidebar
webview in vanilla TS (plain-text replies, attachment chips, Log in / New
chat recovery), lazy browser launch in the extension host, login with a
cancellable progress notification, Chromium install via Playwright's CLI
spawned with the host binary, send-selection / send-file in the CLI's
attachment format (helpers moved to core with `closeOrKill`). Runtime gaps
#52 (`BrowserUnavailableError`, exit 7) and #53 (cancellable `runLogin`,
exit 130) closed first. One `@vscode/test-electron` E2E in
`examples/vscode-dummy-chat`, separate CI job. Left for later: Markdown
rendering, history persistence, `@` completion, `!` shell mode, Chat
Participant API.
Spec: `docs/superpowers/specs/2026-09-17-vscode-extension-design.md`.

### 12. VSCode parity: queue, Ctrl+R, slash commands, drop/paste — done (issue #64)

`SessionController` gained the TUI's message queue (take back with Up) and
`reopen()`; `<id>.reopen` command with a recommended Ctrl+R keybinding.
Slash commands `/login /logout /new /reopen /help` defined once in core
(`@chatbridge/core/slash-commands`) and handled by both UIs; the TUI now
starts before the browser opens and `/login` runs the headful login from
inside it. Dropped files and pasted editor selections become attachment
chips in the webview. Ships as a 0.8.x patch.
Spec: `docs/superpowers/specs/2026-09-18-vscode-parity-design.md`.

### 13. v0.8.2 follow-ups and small features — done (issue #69, PR #70, 2026-09-19)

Bundles the deferred review follow-ups (#67, #59), the auto-resizing VSCode
composer (#68) and TUI banner gradients (#65). Ships as a 0.8.x patch.

### 14. Browser-open retry/timeout and banner gradient direction — done (issue #42, PR #82, 2026-09-19)

The "Opening browser..." phase gets a per-step timeout and a retry count,
resolved built-in → provider → config.json → env (#42); one-shot mode now
reads config.json. Banner gradients gain a direction (#81). Ships as v0.8.3.

### 15. Provider extension points: slash commands and URL hooks — done (issue #83, PR #85, 2026-09-20)

A Provider can ship `/commands` (`show` prints on the page's behalf, `send`
expands into a turn) and URL hooks (a matching URL is resolved by the
provider and attached like an `@file` mention), both for the TUI and
VSCode only (#83, #84). The framework never fetches and never sees a
credential. Ships as v0.9.0.

### 16. Idle browser CPU, VSCode chat view layout and `/` completion — done (issue #95, PR #101, 2026-09-20)

Every browser context asks for `prefers-reduced-motion: reduce`, and an
interactive session closes its browser after 24 h idle and reopens on the
next prompt (#95). The VSCode chat view gets native title-bar actions, a
one-box composer with a file picker and a `/` command menu (#97), and typing
`/` completes commands in both UIs (#86). Also the eight v0.9.0 follow-ups
(#87–#94). Ships on the 0.9.x line.

### 17. Streaming, Markdown and TUI polish — done (issue #71, PR #112, 2026-09-21)

Interactive replies stream and render as Markdown in the TUI: providers opt in
with `responseFormat`, `streaming.responseText` and the `elementToMarkdown`
helper, and the wait indicator is the last history row the reply grows from
(#71, #72, #96). Text can be copied by dragging or with the new `/copy`
built-in, focus stays on the input and PgUp/PgDn page the history (#98, #99,
#100), and teardown waits for an idle close that is still saving auth state
(#103). Ships as v0.10.0.

## Backlog

Moved to GitHub. See the issues labelled
[`backlog`](https://github.com/7milch/chatbridge-cli/issues?q=is%3Aissue+is%3Aopen+label%3Abacklog);
each one becomes a milestone when it is picked up.

## Company adoption

Company repository builds `company-ai-cli` via `createCli({ name, provider, configDir })`
on top of the published packages. Nothing company-specific lands in this repo.

Tracked in the company repository, not here; no milestone is opened in this repo
for it.

## Standing design rules

- The UI is not the core; core and providers never depend on the TUI.
- Playwright lifecycle (browser / context / page / auth state) is shared; DOM work is the provider's.
- Auth *state* is stored (storage state, 600/700 permissions, never logged); credentials never are.
- Dependency direction is one-way: `cli → core → runtime → provider`.
- Every document pushed to the remote is in English; GitHub issue/PR comments too.

### 18. Provider skills kit — done (issue #113, PR #116, 2026-09-21)

The provider-author skills ship inside `@chatbridge/provider` and are written
for a smaller model working alone: a nine-step DOM discovery procedure through
Playwright MCP driven by one probe script (`window.__cbProbe`), vendor repo
templates with a contract-complete provider, and `upgrading-provider-repo` with
a fixed-shape upgrade guide for existing vendor repos. Verified by running a
Sonnet model against a realistic `/hard` skin of the dummy chat (#113);
follow-ups #114, #115. Ships as v0.10.1.

### 19. VSCode Markdown and streaming, conversation handle — done (issue #109, PR #123, 2026-09-22)

The VSCode chat view renders Markdown replies (a `marked` lexer feeds a plain
node tree that is built into the DOM without any HTML injection, CSP unchanged)
and streams them while they are written, with incremental history rendering and
a copy button on code blocks. `Provider` gains an optional
`conversation: { handle, open }` and a `urlConversation({ match })` helper, so
the TUI and the VSCode view return to the same service-side conversation after
a reopen or an idle close; nothing is persisted, and resuming across processes
stays a follow-up (#119). Follow-ups #120, #121, #122. Ships as v0.11.0.

### 20. Markdown rendering fixes — done (issue #125, PR #126, 2026-09-24)

Two externally reported bugs. `elementToMarkdown` skips MathML `<annotation>`
/ `<annotation-xml>`, so KaTeX math no longer comes out doubled (#125). The TUI
theme registers `markup.heading.1`–`6` and `markup.raw.block`, the capture
names the bundled grammar actually emits, so headings and fenced code are
styled again, and the theme test asserts those names (#124). Ships as v0.11.1.

### 21. TUI code block styling — done (issue #127, PR #128, 2026-09-24)

A fenced code block in the interactive TUI rendered like a paragraph. The theme
now styles the code scopes the bundled JavaScript / TypeScript grammars emit,
and `markdown()` moves a settled fenced block into a muted left-border frame in
place, so a reply is never rebuilt on settle. The issue's "no `treeSitterClient`"
root cause was wrong; the spec records what actually happens. Ships as v0.11.2.

### 22. TUI syntax colours for more languages — done (issue #129, PR #130, 2026-09-24)

`@chatbridge/cli` ships tree-sitter grammars for Python, Ruby, JSON, Bash and
Go under `assets/<lang>/` and registers them at TUI start-up, so those fenced
blocks get per-token colours. Queries are pinned to the tag each wasm was built
from; YAML stays out because the only prebuilt wasm crashes in OpenTUI's
web-tree-sitter. Ships as v0.11.3.

### 23. VSCode current-file attach tip — done (issue #131, PR #132, 2026-09-25)

The VSCode chat composer shows the active editor's file as a dashed `+ <name>`
chip in the attachment row; one click attaches it through the same path as a
drop or the `+` picker. New optional `VscodeUi.onDidChangeActiveEditor` and an
`activeFile` host → webview message kept out of `State`, so an editor switch
never re-renders the history. Ships as v0.12.0.

### 24. Reference guide — done (issue #133, PR #134, 2026-09-26)

A reader-split reference guide under `docs/` (`users/`, `providers/`,
`contributing/`), an index `README.md` in every directory, one page per
extension point and four copy-ready recipes. The root README is a front page,
package READMEs point at the guide, and `CLAUDE.md` requires a PR that changes
what a user or vendor sees to update the matching guide page. Docs only, no
release.

### 25. VSCode template fixes — done (issue #135, PR #136, 2026-09-26)

`createExtension` reads its three settings through `inspect()` and honours only
values the user set, so a manifest `default` no longer shadows the vendor's
options. The vendor template's `package` script produces a `.vsix` that ships
Playwright, with the old flag-only command kept as `package:smoke`.
