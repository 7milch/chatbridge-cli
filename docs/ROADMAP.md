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

### 4.5. Second public service spike: ChatGPT

A time-boxed spike (about a day, nothing kept) driving chatgpt.com through
the published packages, to expose what one sample could not: bot / headless
detection, a `contenteditable` composer, lazy login redirects, rate-limit and
error banners, and whether the streaming DOM is appended or replaced. Output
is a findings note plus issues for any runtime gaps; no provider is kept.
Runs before 3b so the streaming design rests on two observed services.

### 3b. Streaming display

Streaming response capture in the Provider contract and incremental display
in the TUI. Also deferred here: Markdown rendering, cross-process conversation
resume (chat handle), history persistence, and detecting auth expiry
mid-conversation. Shaped by the DOM observations from milestones 4 and 4.5, so it
follows them in execution order.

### 5. Company adoption

Company repository builds `company-ai-cli` via `createCli({ name, provider, configDir })`
on top of the published packages. Nothing company-specific lands in this repo.

## Standing design rules

- The UI is not the core; core and providers never depend on the TUI.
- Playwright lifecycle (browser / context / page / auth state) is shared; DOM work is the provider's.
- Auth *state* is stored (storage state, 600/700 permissions, never logged); credentials never are.
- Dependency direction is one-way: `cli → core → runtime → provider`.
- Every document pushed to the remote is in English; GitHub issue/PR comments too.
