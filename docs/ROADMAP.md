# Roadmap

Decisions from the initial design session (2026-09-05). Each milestone gets its own
spec → plan → implementation cycle; this file records the big picture so it survives
across sessions.

## Repository split

| Repository | Holds | Visibility |
|---|---|---|
| `chatbridge-cli` (this repo) | Service-independent skeleton only: Provider API, Playwright runtime, auth-state management, core session flows, CLI + (later) TUI, bundled dummy chat for E2E | Public OSS |
| `chatbridge-providers` (planned) | Providers for public web chat services (ChatGPT, Claude.ai, Gemini, …). Breaks when those UIs change without affecting the skeleton's quality signal | Public OSS |
| Company repository | Company-internal provider (URLs, selectors, login detection, config). Never enters either OSS repo | Private |

All three layers consume the same `Provider` contract from `@chatbridge/provider`.

## Milestones

### 1. One-shot vertical slice — done (PR #2, 2026-09-06)

`chatbridge -p "..."`: restore auth state → new chat → send → response to stdout.
Headful `auth login`, `auth logout|status`, `createCli` factory for derived CLIs,
dummy chat + reference provider, CI E2E on real Chromium. Bun + Playwright verified.

### 2. Hardening + publishability (small) — in progress (issue #3)

Follow-ups deferred from milestone 1:

- `playwright-core` becomes a peerDependency of `@chatbridge/provider` (required before publishing)
- Config-file `defaultProvider` fallback (`~/.config/chatbridge/config.json`)
- Tests for exit codes 3 / 4 / 5 (auth expired, response timeout, provider load)
- Provider `name` sanitized before use as a file name
- Pinned provider rejects an explicit `--provider`; unknown flags print usage
- Widen Playwright `TimeoutError` mapping beyond `waitForResponse`; carry `cause`
- Confirm or rename the `@chatbridge` npm scope; first publish

### 3. Interactive TUI (OpenTUI)

Claude Code–style chat UI: history, multi-line input, send, streaming/loading state,
error and status display. Designs conversation continuation (chat handle / resume) and
streaming response capture in the Provider contract — deliberately left out of
milestone 1 so they are shaped by real usage, not guessed. OpenTUI is provisional
until this milestone proves it under Bun.

### 4. Public providers repository

Create `chatbridge-providers` with the first real-service provider, using the
`Provider` contract as published. Feedback from a real service (streaming DOM
replacement, lazy login redirects, rate limits) flows back into the contract here.

### 5. Company adoption

Company repository builds `company-ai-cli` via `createCli({ name, provider, configDir })`
on top of the published packages. Nothing company-specific lands in this repo.

## Standing design rules

- The UI is not the core; core and providers never depend on the TUI.
- Playwright lifecycle (browser / context / page / auth state) is shared; DOM work is the provider's.
- Auth *state* is stored (storage state, 600/700 permissions, never logged); credentials never are.
- Dependency direction is one-way: `cli → core → runtime → provider`.
- Every document pushed to the remote is in English; GitHub issue/PR comments too.
