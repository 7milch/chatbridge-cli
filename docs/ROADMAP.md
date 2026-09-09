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

## Milestones

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

### 5. Company adoption

Company repository builds `company-ai-cli` via `createCli({ name, provider, configDir })`
on top of the published packages. Nothing company-specific lands in this repo.

## Backlog

Not scheduled. Each item becomes a milestone when picked up.

- **Streaming display.** Both observed services grow one assistant element
  in place, so streaming can be a generic poll in the core over two
  provider knobs (`streaming.responseText(page)` and
  `streaming.isComplete(page)`), with `ChatSession.send(prompt, { onDelta })`
  emitting deltas and still taking the final text from `waitForResponse`;
  one-shot stays batch. Full sketch in the 3b spec's backlog note.
- **Markdown rendering in the TUI history.** Wanted; needs an OpenTUI
  rendering approach for code blocks and lists.
- **Cross-process conversation resume (chat handle).** Provider would expose
  the service's conversation id; the CLI would reopen it.
- **History persistence.** Save the interactive transcript to disk.
- **`@file` mentions in one-shot mode.** Behind an explicit flag; `-p`
  stays verbatim by default.
- **Live re-scan of the mention index.** New files appear without a
  restart.

## Standing design rules

- The UI is not the core; core and providers never depend on the TUI.
- Playwright lifecycle (browser / context / page / auth state) is shared; DOM work is the provider's.
- Auth *state* is stored (storage state, 600/700 permissions, never logged); credentials never are.
- Dependency direction is one-way: `cli → core → runtime → provider`.
- Every document pushed to the remote is in English; GitHub issue/PR comments too.
