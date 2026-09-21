---
name: creating-provider-repo
description: Use when standing up a new vendor-specific chatbridge Provider with its own CLI in a separate repository — a new web chat service, a spike against a public service, or a company-internal provider consuming the published @chatbridge/* packages.
---

# Creating a Provider Repo

One repo per vendor: one `Provider`, one CLI via `createCli`, on the
published `@chatbridge/*` packages. Selectors are observed in the real DOM,
never guessed. Nothing vendor-specific enters the framework.

This skill directory is self-contained: `templates/`, `probes/`,
`dom-discovery.md`, `vscode-extension.md`. For a newer framework version, use the
upgrading-provider-repo skill.

## Rules that do not bend

- Dependencies come from npm: `@chatbridge/cli`, `@chatbridge/core`,
  `@chatbridge/provider` at one exact version (the latest published), plus
  `playwright-core` at the version `@chatbridge/runtime` uses.
  `@chatbridge/runtime` is transitive; do not list it. Never `file:`, `link:`,
  or a checkout of the framework repository.
- After `bun install`, run `find node_modules -path '*@chatbridge/*/node_modules/@chatbridge*'`.
  Any hit is a nested older copy shadowing the runtime: fix the versions,
  `rm -rf node_modules bun.lock`, reinstall.
- The framework owns auth state (cookies, localStorage, IndexedDB, re-saved on
  every session close). The repo never stores, logs or reads credentials or
  tokens. No `.env`, no `.env.example`.
- Selectors come from probe output recorded in `docs/dom-notes.md`. A selector
  with no dom-notes entry is a bug.
- `bun run check` (lint + build + smoke tests) passes before every commit.
- Never run a formatter or any write over `.auth/`: a live browser profile.

## Layout

Copy `templates/` into the new repo root. Then:

- rename `gitignore` → `.gitignore`, `mcp.json` → `.mcp.json`, and in
  `vscode/`, `vscodeignore` → `.vscodeignore`;
- replace `<vendor>`, `<Vendor>`, `<VENDOR>` in **every** copied file,
  `*.test.ts` included (`src/provider.test.ts` asserts `provider.name` and an
  `https:` chat URL); `<publisher>` only in the VSCode manifest;
- resolve `<latest>` with `npm view @chatbridge/cli version`, and
  `<playwright-core>` with
  `npm view @chatbridge/runtime@<latest> dependencies.playwright` (same
  version numbers).

Names: package `chatbridge-<vendor>`, bin `<vendor>`; `private: true`.

```
package.json  tsconfig.json  biome.json  .gitignore  .mcp.json (two MCP servers)
src/selectors.ts   every URL and selector as a constant citing a dom-notes section
src/provider.ts    the whole contract; `// VARIANT` marks the branches
src/bin.ts         createCli({ name, version, provider, banner?, shell? }) — see its comments
src/selectors.test.ts  src/provider.test.ts   smoke
src/provider.e2e.test.ts  real service; needs <VENDOR>_E2E=1 and saved auth
docs/dom-notes.md  eight sections, filled by dom-discovery.md
README.md  CLAUDE.md  English; vscode/ optional
```

No CI: real-service tests need a human login.

### Runtime and shebang

Interactive mode (no `-p`) needs **Bun ≥ 1.3 or Node ≥ 26.4**; one-shot and
`auth` work on Node ≥ 20. `src/bin.ts`'s shebang picks the runtime of a
globally installed bin; `tsc` copies it into `dist/bin.js`:

| Users run the CLI on | Shebang |
|---|---|
| Bun (typical) | `#!/usr/bin/env bun` |
| Node ≥ 26.4 everywhere | `#!/usr/bin/env node` |
| Node < 26.4, no Bun | No interactive mode; `#!/usr/bin/env node`, `-p` only |

Wrong choice: see Traps.

## Procedure

1. **Scaffold** the layout above; install, `bun run check` (fill-in tests skip
   while every selector is empty), commit.
2. **Discover the DOM**: follow `dom-discovery.md` exactly. **REQUIRED.** Do
   not write a selector before its dom-notes section is filled.
3. **Fill `src/selectors.ts`**; `src/provider.ts` already implements the
   contract — change it only where a `// VARIANT` comment and the decision
   table say so. `--help` must print without `--provider`.
4. **Verify by hand**: `--version` → `auth login` → `-p "Reply with the
   single word: ping"` → gated E2E (two turns, second answer differs) →
   interactive mode (banner shows until the first message) → `auth logout` /
   `auth status`.
5. **Feed gaps back**: anything the provider cannot solve (browser launch,
   auth state, session lifecycle) is a framework issue — fixed and released
   there, then bumped here.

## Provider method contract

`templates/src/provider.ts` implements this; read it when debugging a VARIANT.

| Method | Must |
|---|---|
| `navigateToLogin` | `goto` the entry URL; the user completes login by hand. |
| `isLoggedIn` | Polled every second during `auth login`, once at startup. (1) origin differs from `chatUrl`'s → `false`, DOM untouched (the IdP page; a no-op when login is same-origin); (2) in one `try`, wait ≤10 s for the sign-in or account control to be **visible**; (3) account present AND sign-in absent; (4) `catch` → `false`. Visible-only locators: a hidden twin times every poll out. |
| `startNewChat` | Navigate or click, then wait for the composer to be visible and empty. |
| `sendMessage` | Record the assistant-message count (module-level `WeakMap<Page, number>`), fill (works on `contenteditable` too), submit, then wait briefly for the generating state (ignore timeout). |
| `waitForResponse` | Done signal, then the count exceeding the recorded one, then the newest message read until two reads 500 ms apart agree. Never an earlier turn. Done signal first: a placeholder turn may come and go before the real one. |
| `detectBlock` | Called only after `isLoggedIn` returned false. A short description when the page is a bot challenge or an IdP refusal, else `undefined`. Must not throw. |
| `commands` (≥ 0.9.0) | `/name` commands (TUI and VSCode): `{ name, description, run(page, args) }` → `{ kind: "show", text }` or `{ kind: "send", prompt }`. Lower-case names, never a built-in, no one-shot mode. |
| `urlHooks` (≥ 0.9.0) | `{ match, resolve(url) => { label, content } }`. Fetching is the provider's; the framework appends the content as an attachment, under the session timeout and the `MAX_*_BYTES` caps, after trimming trailing prose punctuation. |
| `responseFormat` (≥ 0.10.0) | `"markdown" \| "text"` (default `"text"`). Use the exported `elementToMarkdown(locator)`, never your own converter. |
| `streaming` (≥ 0.10.0) | `{ responseText(page), pollIntervalMs? }` (default 250 ms), polled while `waitForResponse` is pending. Never an earlier turn's text: `undefined` until the new reply can be told apart from the previous one. |

Two optional fields:

- `browser: { reducedMotion }` — leave at `"reduce"`: an animating idle page
  burns CPU. Write `waitForResponse` against DOM state, not an
  animation.
- `idle: { timeoutMs }` — default idle lifetime of an interactive session (24 h;
  `0` disables), overridden by the user's `idle` config key,
  `CHATBRIDGE_IDLE_TIMEOUT` and the VSCode `idleTimeoutMinutes` setting.
  Declare `idleTimeoutMinutes` and `timeoutSec` in a VSCode manifest with **no**
  `default`: a declared default overrides the provider's value; the fallback
  goes in the `description`.

## VSCode extension

Optional; follow `vscode-extension.md`, templates in `templates/vscode/`.

## Traps seen in the wild

| Symptom | Cause | Fix |
|---|---|---|
| Composer exists without login; one-shot returns a sign-in promo | Guest chat | Login signal = account present AND sign-in absent; decision table |
| `auth login` saved a state that restores as logged out | Session in IndexedDB, or state captured on the IdP origin | Framework ≥ 0.2.0 saves IndexedDB; `isLoggedIn` false off-origin |
| Saved state dies an hour after login | Token rotation, no re-save | Framework ≥ 0.2.2 re-saves on close |
| CLI ignores a framework fix | Nested older `@chatbridge/*` copy | Flat install (Rules) |
| Partial answer returned | Done signal fired before the new turn existed | Count-before + stability read (contract) |
| No "generating" element | Send button swapped for a stop button | Decision table |
| `waitForResponse` returns "…" or an ellipsis | A placeholder assistant turn appears, is removed, then the real one is inserted | Decision table |
| Page title "Just a moment...", `isLoggedIn` false | Cloudflare challenge in headless Chromium | `detectBlock` → the CLI exits 6, `Try --headful`; evasion is out of scope |
| An IdP refuses the automated browser even headful | It fingerprints it | Log in with a password or emailed code; note it in §Login |
| `interactive mode needs Bun >= 1.3…` although Bun is installed | `dist/bin.js` shebang is `node`, system Node older | Shebang `#!/usr/bin/env bun`; rebuild |
