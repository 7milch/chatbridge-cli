# Rakuten AI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local-only repo `chatbridge-rakuten-ai` that ships a `rakuten-ai` CLI driving https://ai.rakuten.co.jp/ through the published `@chatbridge/*` packages, plus any `Provider` contract fixes the real service forces back into this repo.

**Architecture:** One package, one provider. `src/selectors.ts` holds every DOM selector as a constant, `src/provider.ts` implements the five `Provider` methods against them, `src/bin.ts` pins the provider into `createCli`. Selectors come from a hands-on DOM discovery task recorded in `docs/dom-notes.md`. Real-service E2E is gated behind an env var and a saved auth state.

**Tech Stack:** TypeScript 5, Bun (test runner, scripts), Biome, `@chatbridge/cli` + `@chatbridge/provider` 0.1.0 from npm, `playwright-core` 1.63.0 with Chromium.

**Spec:** `docs/superpowers/specs/2026-09-07-rakuten-ai-provider-design.md`

## Global Constraints

- New repo path: `~/Work/git/7milch/chatbridge-rakuten-ai`. **No git remote is ever added.** Progress is reported on issue #11 of `7milch/chatbridge-cli` with `gh issue comment 11 --repo 7milch/chatbridge-cli`.
- Every file in the new repo is in English (README, CLAUDE.md, comments, commit messages). Issue comments in English.
- `@chatbridge/*` come from npm, never `file:` or `bun link`.
- Never store, log, or commit credentials or auth state. Auth state is handled by the runtime under `~/.config/rakuten-ai/auth/`.
- `docs/dom-notes.md` must not contain personal data (no account names, no chat content beyond test prompts like "ping").
- `bun run check` in the new repo must pass before every commit there. Contract changes in this repo follow this repo's `bun run check`.
- Commit message trailer in both repos: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Commits in this repo reference `(Refs #11)`.
- Tasks 2 and 4 need a real Rakuten ID login in a headful browser, so they run in the main session with the user, not in a subagent.

---

### Task 1: Scaffold the repository

**Files:**
- Create: `~/Work/git/7milch/chatbridge-rakuten-ai/package.json`
- Create: `~/Work/git/7milch/chatbridge-rakuten-ai/tsconfig.json`
- Create: `~/Work/git/7milch/chatbridge-rakuten-ai/biome.json`
- Create: `~/Work/git/7milch/chatbridge-rakuten-ai/.gitignore`
- Create: `~/Work/git/7milch/chatbridge-rakuten-ai/CLAUDE.md`
- Create: `~/Work/git/7milch/chatbridge-rakuten-ai/src/selectors.ts`
- Test: `~/Work/git/7milch/chatbridge-rakuten-ai/src/selectors.test.ts`

**Interfaces:**
- Produces: `bun run check` (lint + build + test) working in the new repo; `src/selectors.ts` exporting the constants named in Step 6 as `string` values (empty until Task 3).

- [ ] **Step 1: Create the directory and init git**

```bash
mkdir -p ~/Work/git/7milch/chatbridge-rakuten-ai/src ~/Work/git/7milch/chatbridge-rakuten-ai/docs
cd ~/Work/git/7milch/chatbridge-rakuten-ai && git init -b main
```

- [ ] **Step 2: Write package.json**

```json
{
  "name": "chatbridge-rakuten-ai",
  "version": "0.1.0",
  "private": true,
  "description": "rakuten-ai CLI: drives the Rakuten AI web app through chatbridge",
  "type": "module",
  "engines": { "node": ">=20", "bun": ">=1.3" },
  "bin": { "rakuten-ai": "./dist/bin.js" },
  "scripts": {
    "lint": "biome check .",
    "build": "tsc --build",
    "test": "bun run build && bun test",
    "check": "bun run lint && bun run test"
  },
  "dependencies": {
    "@chatbridge/cli": "0.1.0",
    "@chatbridge/provider": "0.1.0",
    "playwright-core": "1.63.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "@types/bun": "^1.4.1",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 3: Write tsconfig.json, biome.json, .gitignore**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["**/*.test.ts"]
}
```

`biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "files": { "ignore": ["node_modules", "dist", "*.tsbuildinfo", ".claude"] },
  "formatter": { "enabled": true, "indentStyle": "space" },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "organizeImports": { "enabled": true }
}
```

`.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
*.log
.DS_Store
# Never commit browser state or personal notes
storage-state*.json
.auth/
notes-local/
```

- [ ] **Step 4: Write CLAUDE.md**

```markdown
# CLAUDE.md

Local-only, private repository. One provider: Rakuten AI (https://ai.rakuten.co.jp/).
Progress is tracked on https://github.com/7milch/chatbridge-cli/issues/11.

## Rules

- Everything here is in English: docs, comments, commit messages.
- This repo has no git remote and must never get one.
- `@chatbridge/*` packages come from npm. Contract changes go to the
  `chatbridge-cli` repo first, get published, then are bumped here.
- Auth *state* only: the runtime stores browser storage state under
  `~/.config/rakuten-ai/auth/`. Never store, log, or commit credentials.
- `docs/dom-notes.md` records DOM findings; it must not contain personal data.

## Commands

- `bun install` — install deps
- `bunx playwright install chromium` — one-time browser install
- `bun run check` — lint (Biome) + build (tsc) + tests (bun test); required before every commit
- `RAKUTEN_AI_E2E=1 bun test` — real-service E2E; needs `rakuten-ai auth login` first
- `bun run dist/bin.js -p "ping"` — one-shot after building

## Layout

- `src/selectors.ts` — every DOM selector / URL as a named constant, each citing `docs/dom-notes.md`
- `src/provider.ts` — the `Provider` implementation
- `src/bin.ts` — `createCli({ name: "rakuten-ai", provider })`
```

- [ ] **Step 5: Write the failing selector smoke test**

`src/selectors.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import * as selectors from "./selectors.js";

describe("selectors", () => {
  test("every exported constant is a non-empty string", () => {
    const entries = Object.entries(selectors);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, value] of entries) {
      expect(typeof value, name).toBe("string");
      expect((value as string).length, name).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 6: Write selectors.ts with placeholder-free shape**

Values are filled in Task 3 from `docs/dom-notes.md`. Until then the test in
Step 5 fails, which is intended: the scaffold is verified by lint + build.

```ts
/** Every DOM selector and URL for Rakuten AI lives here. Each constant
 * cites the section of docs/dom-notes.md it was taken from. Values are
 * set in Task 3 after DOM discovery. */

/** dom-notes.md §Login */
export const LOGIN_URL = "";
/** dom-notes.md §Chat page */
export const CHAT_URL = "";
/** dom-notes.md §New chat */
export const NEW_CHAT_URL = "";
/** dom-notes.md §Composer */
export const COMPOSER = "";
/** dom-notes.md §Composer */
export const SEND_BUTTON = "";
/** dom-notes.md §Messages */
export const ASSISTANT_MESSAGE = "";
/** dom-notes.md §Generation indicator */
export const GENERATING_INDICATOR = "";
```

- [ ] **Step 7: Install and verify lint + build pass, test fails as expected**

```bash
cd ~/Work/git/7milch/chatbridge-rakuten-ai
bun install
bunx playwright install chromium
bun run lint && bun run build
bun test
```

Expected: lint and build succeed; `bun test` fails on the empty-string assertion for `LOGIN_URL`.

- [ ] **Step 8: Commit and sync**

```bash
git add -A && git commit -m "chore: scaffold rakuten-ai CLI repo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 11 --repo 7milch/chatbridge-cli --body "chatbridge-rakuten-ai: scaffolded (package.json, tsconfig, biome, CLAUDE.md, selectors skeleton with smoke test). Next: DOM discovery on ai.rakuten.co.jp (Task 2)."
```

---

### Task 2: DOM discovery (main session, with the user)

**Files:**
- Create: `~/Work/git/7milch/chatbridge-rakuten-ai/docs/dom-notes.md`

**Interfaces:**
- Produces: concrete values for every constant in `src/selectors.ts`, plus answers to the streaming question that milestone 3b needs.

- [ ] **Step 1: Open the site with the Playwright MCP browser**

Use `mcp__plugin_playwright_playwright__browser_navigate` to `https://ai.rakuten.co.jp/`, then `browser_snapshot`. Record the logged-out state: URL after redirects, the login entry control, and whether the chat composer exists without login.

- [ ] **Step 2: Ask the user to log in by hand in that browser window**

Do not type credentials. Wait for the user to say login is complete, then `browser_snapshot` again.

- [ ] **Step 3: Capture the chat page**

For each item, note the element's role, `data-testid` / `aria-label` / `id` if any, and a Playwright locator that matches exactly one element (`page.getByRole(...)` or `page.getByTestId(...)` preferred; CSS only as a fallback). Use `browser_evaluate` to confirm uniqueness, for example:

```js
() => document.querySelectorAll('[data-testid="composer"]').length
```

Items:
1. chat page URL; new-chat URL or control
2. composer element; whether Enter submits or inserts a newline
3. send control
4. assistant message container; how to pick the latest turn (e.g. `.last()` on a role/testid locator)
5. generation-in-progress indicator: element, attribute, or send-button state toggling while streaming
6. rate-limit / error banner if reachable
7. whether the streaming response DOM is replaced or appended (observe with two `browser_snapshot` calls during one long answer to "Write 300 words about tea")

- [ ] **Step 4: Write docs/dom-notes.md**

Use exactly these section headings so `selectors.ts` comments resolve:

```markdown
# Rakuten AI DOM notes

Date observed: 2026-09-07. Re-check when anything below stops matching.

## Login
- Logged-out redirect target: <url>
- Login entry URL used by `navigateToLogin`: <url>
- Logged-in signal used by `isLoggedIn`: <locator> present on the chat page

## Chat page
- URL: <url>

## New chat
- URL or control: <url or locator>
- Ready signal: composer visible and empty

## Composer
- Locator: <locator>
- Enter behaviour: <submits | newline>
- Send control: <locator>

## Messages
- Assistant message locator: <locator>
- Latest turn: <how>

## Generation indicator
- Locator / state: <locator or attribute>
- Done when: <condition>

## Errors and rate limits
- <what was seen, or "not reachable during discovery">

## Streaming behaviour (input for milestone 3b)
- DOM is <replaced | appended> while streaming; <notes>
```

- [ ] **Step 5: Commit and sync**

```bash
cd ~/Work/git/7milch/chatbridge-rakuten-ai
git add docs/dom-notes.md && git commit -m "docs: record Rakuten AI DOM findings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 11 --repo 7milch/chatbridge-cli --body "chatbridge-rakuten-ai: DOM discovery done, recorded in docs/dom-notes.md (login signal, composer, send, assistant message, generation indicator, streaming behaviour). Next: implement provider + bin (Task 3)."
```

---

### Task 3: Provider, selectors, and the CLI entry point

**Files:**
- Modify: `~/Work/git/7milch/chatbridge-rakuten-ai/src/selectors.ts`
- Create: `~/Work/git/7milch/chatbridge-rakuten-ai/src/provider.ts`
- Create: `~/Work/git/7milch/chatbridge-rakuten-ai/src/bin.ts`
- Test: `~/Work/git/7milch/chatbridge-rakuten-ai/src/provider.test.ts`

**Interfaces:**
- Consumes: constants from `src/selectors.ts`; `defineProvider`, `Provider` from `@chatbridge/provider`; `createCli` from `@chatbridge/cli`.
- Produces: `src/provider.ts` default export `Provider` named `"rakuten-ai"`; `dist/bin.js` runnable as `rakuten-ai`.

- [ ] **Step 1: Fill selectors.ts from dom-notes.md**

Replace each `""` with the value recorded under the cited section. Keep the comments. Selector constants hold the string form usable in `page.locator(...)`; where the notes chose `getByRole`/`getByTestId`, express it as a CSS/ARIA string (`[data-testid="x"]`, `role=button[name="Send"]` is not valid CSS, so use `button[aria-label="Send"]` or the exact attribute). If `NEW_CHAT_URL` turned out to be a control instead of a URL, set `NEW_CHAT_URL` to the chat URL and add:

```ts
/** dom-notes.md §New chat */
export const NEW_CHAT_BUTTON = "<locator>";
```

- [ ] **Step 2: Run the selector smoke test**

```bash
cd ~/Work/git/7milch/chatbridge-rakuten-ai && bun test src/selectors.test.ts
```

Expected: PASS.

- [ ] **Step 3: Write the failing provider smoke test**

`src/provider.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import provider from "./provider.js";

describe("rakuten-ai provider", () => {
  test("has the Provider shape", () => {
    expect(provider.name).toBe("rakuten-ai");
    for (const m of [
      "navigateToLogin",
      "isLoggedIn",
      "startNewChat",
      "sendMessage",
      "waitForResponse",
    ] as const) {
      expect(typeof provider[m], m).toBe("function");
    }
  });

  test("chatUrl is https on ai.rakuten.co.jp", () => {
    const url = new URL(provider.chatUrl);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("ai.rakuten.co.jp");
  });
});
```

- [ ] **Step 4: Run it to confirm it fails**

```bash
bun test src/provider.test.ts
```

Expected: FAIL, "Cannot find module './provider.js'".

- [ ] **Step 5: Write provider.ts**

Adjust only the parts marked by comments to what `dom-notes.md` says (Enter vs. click, URL vs. button for new chat, indicator semantics).

```ts
import { type Page, defineProvider } from "@chatbridge/provider";
import {
  ASSISTANT_MESSAGE,
  CHAT_URL,
  COMPOSER,
  GENERATING_INDICATOR,
  LOGIN_URL,
  NEW_CHAT_URL,
  SEND_BUTTON,
} from "./selectors.js";

/** Rakuten AI (https://ai.rakuten.co.jp/). Selectors: docs/dom-notes.md. */
export default defineProvider({
  name: "rakuten-ai",
  chatUrl: CHAT_URL,

  async navigateToLogin(page: Page) {
    await page.goto(LOGIN_URL);
  },

  async isLoggedIn(page: Page) {
    // The composer only renders for a logged-in user (dom-notes §Login).
    return (await page.locator(COMPOSER).count()) > 0;
  },

  async startNewChat(page: Page) {
    // dom-notes §New chat: navigate (or click NEW_CHAT_BUTTON instead).
    if (page.url() !== NEW_CHAT_URL) await page.goto(NEW_CHAT_URL);
    const composer = page.locator(COMPOSER);
    await composer.waitFor({ state: "visible" });
    await composer.fill("");
  },

  async sendMessage(page: Page, prompt: string) {
    await page.locator(COMPOSER).fill(prompt);
    // dom-notes §Composer: click send (or press Enter if Enter submits).
    await page.locator(SEND_BUTTON).click();
  },

  async waitForResponse(page: Page) {
    const messages = page.locator(ASSISTANT_MESSAGE);
    // Only the turn created by the most recent sendMessage counts, so wait
    // for the count to grow past what existed before the send.
    const before = await messages.count();
    await page.waitForFunction(
      ({ sel, n }) => document.querySelectorAll(sel).length > n,
      { sel: ASSISTANT_MESSAGE, n: before - 1 },
    );
    // dom-notes §Generation indicator: done when the indicator is gone.
    await page.locator(GENERATING_INDICATOR).waitFor({ state: "hidden" });
    const text = await messages.last().innerText();
    return text.trim();
  },
});
```

Note on `before - 1`: `sendMessage` may have already inserted the new
assistant placeholder before `waitForResponse` runs, so the count may or may
not have grown yet. If the notes show the placeholder appears synchronously
on send, replace the `waitForFunction` with `await messages.last().waitFor({ state: "visible" })`.

- [ ] **Step 6: Write bin.ts**

```ts
#!/usr/bin/env node
import { createCli } from "@chatbridge/cli";
import provider from "./provider.js";

// exitCode instead of process.exit(): pending stdout writes on a pipe
// would otherwise be dropped.
process.exitCode = await createCli({ name: "rakuten-ai", provider }).run(
  process.argv,
);
```

- [ ] **Step 7: Run check and the help command**

```bash
bun run check
bun run dist/bin.js --help
```

Expected: check passes (both smoke tests); help prints usage without a `--provider` flag (provider is pinned).

- [ ] **Step 8: Commit and sync**

```bash
git add -A && git commit -m "feat: rakuten-ai provider and CLI entry point

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 11 --repo 7milch/chatbridge-cli --body "chatbridge-rakuten-ai: provider, selectors, and bin implemented; smoke tests pass; --help works with the pinned provider. Next: gated real-service E2E + README, run by hand (Task 4)."
```

---

### Task 4: Gated real-service E2E and README (main session, with the user)

**Files:**
- Create: `~/Work/git/7milch/chatbridge-rakuten-ai/src/provider.e2e.test.ts`
- Create: `~/Work/git/7milch/chatbridge-rakuten-ai/README.md`

**Interfaces:**
- Consumes: `ChatSession`, `createAuthStore` from `@chatbridge/core` (a transitive dependency of `@chatbridge/cli`; add `"@chatbridge/core": "0.1.0"` to `dependencies` so the import is explicit).

- [ ] **Step 1: Add the core dependency**

```bash
cd ~/Work/git/7milch/chatbridge-rakuten-ai && bun add @chatbridge/core@0.1.0
```

- [ ] **Step 2: Write the gated E2E test**

`src/provider.e2e.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ChatSession, createAuthStore } from "@chatbridge/core";
import provider from "./provider.js";

const authStore = createAuthStore({
  configDir: "rakuten-ai",
  providerName: provider.name,
});
const enabled = process.env.RAKUTEN_AI_E2E === "1" && authStore.has();

describe.skipIf(!enabled)("rakuten-ai real service", () => {
  test(
    "two turns return non-empty, distinct responses",
    async () => {
      const session = await ChatSession.open({
        provider,
        authStore,
        headless: true,
        timeoutMs: 120_000,
      });
      try {
        const first = await session.send("Reply with the single word: ping");
        expect(first.length).toBeGreaterThan(0);
        const second = await session.send("Reply with the single word: pong");
        expect(second.length).toBeGreaterThan(0);
        expect(second).not.toBe(first);
      } finally {
        await session.close();
      }
    },
    300_000,
  );
});
```

- [ ] **Step 3: Confirm the test skips without the gate**

```bash
bun test src/provider.e2e.test.ts
```

Expected: 1 skipped, 0 fail.

- [ ] **Step 4: Log in and run the E2E for real**

```bash
bun run build && bun run dist/bin.js auth login
```

The user completes Rakuten ID login in the headful window. Then:

```bash
bun run dist/bin.js auth status
RAKUTEN_AI_E2E=1 bun test src/provider.e2e.test.ts
bun run dist/bin.js -p "Reply with the single word: ping"
```

Expected: status reports logged in; E2E passes; one-shot prints a response. If any step fails, fix `selectors.ts` / `provider.ts` against `dom-notes.md` (update the notes if the DOM differs) and re-run. If the failure cannot be fixed inside the provider, that is a contract gap: record it in the issue and handle it in Task 5.

- [ ] **Step 5: Try interactive mode and logout**

```bash
bun run dist/bin.js
```

Send two messages, confirm the second answer is not the first, quit. Then:

```bash
bun run dist/bin.js auth logout && bun run dist/bin.js auth status
```

Expected: status reports no saved auth state.

- [ ] **Step 6: Write README.md**

```markdown
# chatbridge-rakuten-ai

`rakuten-ai`: a CLI for the Rakuten AI web app (https://ai.rakuten.co.jp/),
built on [chatbridge](https://github.com/7milch/chatbridge-cli). Private,
local-only repository.

## Setup

    bun install
    bunx playwright install chromium
    bun run build

## Usage

    bun run dist/bin.js auth login      # headful; log in with your Rakuten ID by hand
    bun run dist/bin.js auth status
    bun run dist/bin.js -p "Hello"      # one-shot, response to stdout
    bun run dist/bin.js                 # interactive chat (Bun >= 1.3)
    bun run dist/bin.js auth logout     # deletes the saved browser state

Only browser storage state is saved (under `~/.config/rakuten-ai/auth/`);
credentials are never stored.

## Tests

    bun run check                        # lint + build + smoke tests
    RAKUTEN_AI_E2E=1 bun test            # real-service E2E; needs `auth login` first

## Manual checklist (after a DOM change)

1. `auth login` → `auth status` says logged in
2. `-p "ping"` prints a response
3. interactive: two turns, second answer differs from the first
4. `auth logout` → `auth status` says logged out

DOM findings live in `docs/dom-notes.md`.
```

- [ ] **Step 7: Check, commit, sync**

```bash
bun run check
git add -A && git commit -m "test: gated real-service E2E; add README

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 11 --repo 7milch/chatbridge-cli --body "chatbridge-rakuten-ai: real-service E2E passes (two-turn), one-shot and interactive verified by hand, logout verified; README added. Contract gaps found: <list or 'none'>. Next: contract feedback + roadmap update in chatbridge-cli (Task 5)."
```

---

### Task 5: Contract feedback and roadmap update (this repository, branch `issue-11`)

**Files:**
- Modify: `docs/ROADMAP.md` (repository split table, milestone 4 heading, milestone 3b note)
- Modify (only if Task 4 found a gap): `packages/provider/src/index.ts`, `packages/core/src/chat-session.ts`, and their tests

**Interfaces:**
- Consumes: the "Contract gaps found" list from the Task 4 issue comment.

- [ ] **Step 1: Update the roadmap**

In `docs/ROADMAP.md`:

Replace the `chatbridge-providers` table row with:

```markdown
| `chatbridge-rakuten-ai` (local only) | One provider for Rakuten AI plus a derived `rakuten-ai` CLI via `createCli`. Consumes the published packages; rehearses milestone 5 | Private, no remote |
```

Replace the milestone 4 heading block with:

```markdown
### 4. Rakuten AI provider (private repo) — in progress (issue #11)

A local-only repo `chatbridge-rakuten-ai` builds a `rakuten-ai` CLI on the
published packages. Findings from the real service (streaming DOM, login
redirects, completion detection) flow back into the `Provider` contract here.
Taken up before 3b, which is shaped by what this milestone exposes.
```

Keep the rest. Run `bun run check`, commit:

```bash
git add docs/ROADMAP.md && git commit -m "docs: roadmap reflects the private Rakuten AI provider repo (Refs #11)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 11 --body "Roadmap updated: repository split table and milestone 4 wording now describe chatbridge-rakuten-ai. Next: contract fixes if any, then whole-branch review."
```

- [ ] **Step 2: If no contract gap was found, record that and stop here**

```bash
gh issue comment 11 --body "Provider contract v0.1.0 was sufficient for Rakuten AI; no contract change in this milestone. Streaming observations for 3b are in chatbridge-rakuten-ai/docs/dom-notes.md §Streaming behaviour. Next: finish the branch."
```

- [ ] **Step 3: If a gap was found, design it as a bounded change**

For each gap: write a failing test in the owning package (`packages/provider/src/index.test.ts` or `packages/core/src/chat-session.test.ts`), implement the smallest change, keep the dummy provider and E2E green, `bun run check`, commit with `(Refs #11)`, issue comment. Then bump versions to `0.2.0` in all four `packages/*/package.json`, commit `chore: release v0.2.0 (Refs #11)`, and after the PR merges tag `v0.2.0` on main to publish. In the new repo, `bun add @chatbridge/cli@0.2.0 @chatbridge/provider@0.2.0 @chatbridge/core@0.2.0`, re-run Task 4 Step 4, commit, issue comment.

- [ ] **Step 4: Finish the branch**

Use `superpowers:finishing-a-development-branch`: whole-branch review, then open a PR from `issue-11` to `main` with the roadmap (and any contract) changes. The user merges.
