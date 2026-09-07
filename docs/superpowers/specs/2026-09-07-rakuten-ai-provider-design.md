# Rakuten AI Provider (private repo) — Design

Date: 2026-09-07
Status: Approved (brainstorming session)
Issue: https://github.com/7milch/chatbridge-cli/issues/11

## Goal

Build the first provider against a real web chat service, using the published
`@chatbridge/*` packages exactly as a downstream consumer would, and feed what
the real service teaches us back into the `Provider` contract in this repo.

Target service: **Rakuten AI**, the web app at `https://ai.rakuten.co.jp/`
(Rakuten ID login). Milestone 3b (streaming display) is deliberately ordered
after this milestone so it can be shaped by a real streaming DOM.

## Decisions (from brainstorming)

- **Separate repository, local only.** `chatbridge-rakuten-ai` lives at
  `~/Work/git/7milch/chatbridge-rakuten-ai`, has no remote, and holds exactly
  one provider. It replaces the roadmap's planned public
  `chatbridge-providers`; that idea is dropped, not postponed.
- **Deliverable is a derived CLI**, `rakuten-ai`, built with
  `createCli({ name: "rakuten-ai", provider })`. This rehearses milestone 5
  (company adoption) on a public service.
- **Dependencies come from npm**, never a local link. Contract changes are
  made here on `issue-11`, published as a new `@chatbridge/*` version, then
  picked up by bumping the version in the new repo.
- **Tests: smoke + gated real-service E2E.** No CI for the new repo. The E2E
  test runs only when explicitly enabled and a saved auth state exists.
- **Progress tracking stays on issue #11** in this repository, since the new
  repo has no GitHub presence. Commits in the new repo are summarised in the
  issue comments.

## 1. The `chatbridge-rakuten-ai` repository

```
package.json            name: chatbridge-rakuten-ai, private: true, type: module
                        bin: { "rakuten-ai": "./dist/bin.js" }
                        dependencies: @chatbridge/cli, @chatbridge/provider, playwright-core
                        devDependencies: typescript, @biomejs/biome
                        scripts: check (lint + build + test), build, test
tsconfig.json           mirrors packages/cli of this repo (ESM, strict, emit to dist/)
biome.json              copy of this repo's config
.gitignore              node_modules, dist, any local notes with personal data
src/provider.ts         defineProvider({ name: "rakuten-ai", chatUrl, ...five methods })
src/selectors.ts        every DOM selector as a named constant, in one file
src/bin.ts              process.exitCode = await createCli({ name: "rakuten-ai", provider }).run(process.argv)
src/provider.test.ts    smoke test (no browser, no login)
src/provider.e2e.test.ts real-service E2E, gated (see §4)
docs/dom-notes.md       findings from DOM discovery (§2), kept current
README.md               usage: auth login / logout / status, -p, interactive
CLAUDE.md               language policy (English), the three boundaries, auth-state rule
```

`playwright-core` is a peer dependency of `@chatbridge/provider`, so the new
repo declares it directly. The Chromium binary is installed once with
`playwright install chromium`.

Auth state lands in `~/.config/rakuten-ai/` through the existing runtime;
nothing in the new repo touches cookies or credentials. `rakuten-ai auth
logout` deletes it.

### Provider behaviour

| Method | Behaviour |
|---|---|
| `navigateToLogin` | `page.goto` to the Rakuten AI login entry; the user completes Rakuten ID login by hand in the headful window. |
| `isLoggedIn` | True when the chat composer (message input) is present on the chat page. Doubles as the startup auth-validity check. |
| `startNewChat` | Trigger the "new chat" control (or navigate to the new-chat URL), then wait for the composer to be visible and empty. |
| `sendMessage` | Fill the composer and activate send. |
| `waitForResponse` | Wait for the newest assistant message to appear, then for the generation-in-progress indicator to disappear, then return that message's text. Must return the latest turn only. |

The exact selectors, URLs, and indicator semantics are unknown until DOM
discovery (§2) and are recorded in `docs/dom-notes.md`, not in this spec.

## 2. DOM discovery comes first

Selectors cannot be designed on paper. The first implementation task opens
`https://ai.rakuten.co.jp/` with the Playwright MCP browser, logs in by hand,
and records in `docs/dom-notes.md`:

- login entry URL and what the page looks like when logged out vs. in
- chat page URL and the new-chat URL or control
- composer element, send control, and whether Enter submits
- assistant message container and how turns are distinguished
- the generation-in-progress indicator (element, attribute, or button state)
- any rate-limit or error banner and its text
- whether the response DOM is replaced or appended while streaming (input for milestone 3b)

Prefer stable attributes (`data-testid`, ARIA roles, `aria-label`) over
class names. Each selector in `src/selectors.ts` cites the note it came from.

## 3. Contract feedback loop (this repository)

Change the `Provider` contract only when the real service makes the current
one insufficient. Candidates noticed in advance, none pre-approved:

- a helper for "wait until the response text stops changing" if no reliable
  done indicator exists
- handling a post-login redirect that differs from `chatUrl`
- a way for a provider to surface a rate-limit or service error as a
  `ChatBridgeError` with a specific code

Each accepted change follows the normal cycle here: TDD, `bun run check`,
commit on `issue-11`, issue comment, then a `v0.2.x` tag to publish. The new
repo bumps its `@chatbridge/*` versions afterwards. If no change is needed,
this milestone still records that finding in the issue and the roadmap.

## 4. Testing

- **Smoke (`src/provider.test.ts`, runs in `bun run check`)**: the default
  export satisfies the `Provider` shape (name, `chatUrl` is an `https://`
  URL on `ai.rakuten.co.jp`, five functions); every selector constant is a
  non-empty string.
- **Real-service E2E (`src/provider.e2e.test.ts`)**: skipped unless
  `RAKUTEN_AI_E2E=1` and the auth state file exists. Steps: `-p "ping"`
  returns non-empty text; a two-turn `ChatSession` returns different text
  for the second turn, proving `waitForResponse` does not return the earlier
  turn. Run by hand after `rakuten-ai auth login`.
- Manual checklist in README: auth login → status → one-shot → interactive →
  logout → status shows logged out.

## 5. Roadmap changes (this repository)

- Repository split table: replace the `chatbridge-providers` row with
  `chatbridge-rakuten-ai` (local only, private, one provider).
- Milestone 4 heading becomes "Rakuten AI provider (private repo)".
- Milestone order is 4 → 3b; 3b's note already says it is shaped after 4.

## Out of scope

Streaming display (3b), Markdown rendering, history persistence, more than
one provider, pushing the new repo to any remote, and anything Rakuten
account-specific beyond the saved browser storage state.
