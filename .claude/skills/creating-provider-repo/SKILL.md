---
name: creating-provider-repo
description: Use when standing up a new vendor-specific chatbridge Provider with its own CLI in a separate repository — a new web chat service, a spike against a public service, or a company-internal provider consuming the published @chatbridge/* packages.
---

# Creating a Provider Repo

One repo per vendor: one `Provider`, one derived CLI via `createCli`, on the
published `@chatbridge/*` packages. Selectors come from observing the real
DOM, never from guessing. Nothing vendor-specific ever enters `chatbridge-cli`.

## Rules that do not bend

- Dependencies come from npm: `@chatbridge/cli`, `@chatbridge/core`,
  `@chatbridge/provider` pinned to one exact version (the latest published:
  `npm view @chatbridge/cli version`), plus `playwright-core` pinned to the
  version `@chatbridge/runtime` uses. `@chatbridge/runtime` is transitive;
  do not list it. Never `file:`, `link:`, or a checkout of `chatbridge-cli`.
- After `bun install`, run `find node_modules -path '*@chatbridge/*/node_modules/@chatbridge*'`.
  Any hit means a nested older copy is shadowing the runtime: fix the
  versions, `rm -rf node_modules bun.lock`, reinstall.
- The framework owns auth state (cookies, localStorage, IndexedDB, re-saved
  on every session close). The repo never stores, logs, or reads credentials
  or tokens. No `.env`, no `.env.example`.
- `bun run check` (lint + build + smoke tests) passes before every commit.

## Layout

Names: repo and package `chatbridge-<vendor>`, bin `<vendor>` (for example
`chatbridge-rakuten-ai` / `rakuten-ai`); `private: true`.

```
package.json          bin: { "<vendor>": "./dist/bin.js" }; deps as in Rules
.gitignore            node_modules/, dist/, *.tsbuildinfo, *.log, storage-state*.json, .auth/, .superpowers/
src/selectors.ts      every URL and selector as a named constant; each cites a docs/dom-notes.md section
src/provider.ts       defineProvider({ name, chatUrl, five methods }); default export
src/bin.ts            process.exitCode = await createCli({ name, version, provider, banner? }).run(process.argv) — see Derived CLI identity
src/selectors.test.ts smoke: every export is a non-empty string
src/provider.test.ts  smoke: shape (name, https chatUrl on the vendor host, five functions)
src/provider.e2e.test.ts  real service; skipped unless <NAME>_E2E=1 and the auth store has a file
docs/dom-notes.md     findings, with observation date (sections: Login, Chat page, New chat, Composer, Messages, Generation indicator, Errors and rate limits, Streaming behaviour)
README.md, CLAUDE.md  English; usage, gated E2E, manual checklist
```

Copy `tsconfig.json` from `chatbridge-cli/packages/cli` (drop `composite`
and `references`) and `biome.json` from the `chatbridge-cli` root.
No CI workflow: real-service tests need a human login.

## Derived CLI identity (`@chatbridge/cli` ≥ 0.4.0)

```ts
#!/usr/bin/env bun
// src/bin.ts — the shebang picks the runtime that runs the CLI, see
// "Runtime and shebang" below.
import { createRequire } from "node:module";
import { createCli } from "@chatbridge/cli";
import provider from "./provider.js";

// Read the vendor package's own version; "../package.json" resolves from
// both src/ (bun) and dist/ (node), which sit one level under it.
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

process.exitCode = await createCli({
  name: "<vendor>",
  version, // `<vendor> --version` / `-V` prints "<vendor> vX.Y.Z"; also the default banner
  provider,
  // Optional `string[]`. Interactive-mode startup banner, one string per
  // row, any row count, shown centred until the first message, all rows
  // dim; rows wider than the terminal are cut on the right. Used verbatim:
  // no placeholders, no colours. Omit for the default (name, version, hint).
  banner: ["<Vendor> internal assistant", "Conversations are not stored by this CLI."],
}).run(process.argv);
```

`version` and `banner` are the only vendor-facing TUI knobs; colours and
layout are fixed by the framework.

### Runtime and shebang

Interactive mode (no `-p`) needs **Bun ≥ 1.3 or Node ≥ 26.4**; one-shot and
`auth` work on Node ≥ 20. The shebang decides which runtime a globally
installed bin (`bun link`, `npm link`, `npm i -g`) uses, and `tsc` copies it
into `dist/bin.js` unchanged:

| Users run the CLI on | Shebang |
|---|---|
| Bun (typical for a private vendor repo) | `#!/usr/bin/env bun` |
| Node ≥ 26.4 everywhere | `#!/usr/bin/env node` |
| Node < 26.4, no Bun | Interactive mode is unavailable; `#!/usr/bin/env node` and document `-p` only |

Symptom of the wrong choice: `<vendor>: interactive mode needs Bun >= 1.3 or
Node >= 26.4; use -p <prompt> on this runtime` even though Bun is installed.
Verify with `<vendor> --version` after linking, then open interactive mode.

## DOM notes

Before discovery, each `dom-notes.md` section holds one line:
`Not yet observed.` A section is done when it names a locator that matched
exactly one element on the observation date.

## Procedure

1. **Scaffold** the layout with empty selector strings and the smoke tests
   asserting only `typeof === "string"`. Install, `bun run check`, commit.
2. **Discover the DOM** in a real browser (Playwright MCP or headful
   Playwright) with the user logging in by hand. Record every item in
   `docs/dom-notes.md` before writing a selector. Prefer `data-*`, ARIA
   roles and labels; class names from CSS-in-JS are not stable. Note whether
   labels are localized. Discover in the **logged-in** app: a guest page can
   be a different DOM (ChatGPT serves a separate shell to guests). Playwright
   MCP is headless and cannot take a human login; when the service blocks
   headless, discover through the derived CLI's `auth login` window instead.
3. **Fill selectors and the provider**, add the non-empty assertion, `--help`
   must print without `--provider`.
4. **Verify by hand**: `--version` prints the package version → `auth login`
   → `-p "Reply with the single word: ping"` → gated E2E (two turns, second
   answer differs) → interactive mode (banner shows until the first message)
   → `auth logout` / `auth status`.
5. **Feed gaps back**: anything the provider cannot solve (browser launch,
   auth-state contents, session lifecycle) is a `chatbridge-cli` issue, fixed
   there, released, then the version is bumped here.

## Provider method contract

| Method | Must |
|---|---|
| `navigateToLogin` | `goto` the vendor's entry URL; the user completes login by hand. |
| `isLoggedIn` | Called every second during `auth login` and once at startup. In order: (1) `page.url()` origin differs from `chatUrl`'s → return `false` without touching the DOM (the IdP page); (2) inside one `try`: wait, bounded to 10 s, for either the sign-in control or the account control to be visible; (3) return account control present AND sign-in control absent; (4) `catch` → `false`. Every locator in the `.or()` must match only visible elements: `.first()` picks DOM order, and a hidden match (ChatGPT keeps a hidden `<textarea>`) makes the wait time out on every poll. |
| `startNewChat` | Navigate or click, then wait for the composer visible and empty. |
| `sendMessage` | Record the assistant-message count (module-level `WeakMap<Page, number>`), fill (`fill()` works on `contenteditable` composers too), submit, then wait briefly for the "generating" state to begin (ignore timeout). |
| `waitForResponse` | Wait for the done signal, then for the count to exceed the recorded one, then read the newest message with `innerText` until two reads 500 ms apart agree. Never return an earlier turn. Done signal first: some services insert a placeholder turn that is removed before the real one. |
| `detectBlock` (optional) | Called only after `isLoggedIn` returned false. Return a short description when the page is a bot challenge or an IdP refusal (title, a known interstitial element); return `undefined` for a normal logged-out page. Must not throw. |

## Traps seen in the wild

| Symptom | Cause | Fix |
|---|---|---|
| Composer exists without login; one-shot returns a sign-in promo | Service offers guest chat | Login signal = account menu present AND sign-in control absent |
| `auth login` saved a state that restores as logged out | Session lives in IndexedDB, or state captured on the IdP origin | Framework ≥ 0.2.0 saves IndexedDB; `isLoggedIn` returns false off-origin |
| Saved state dies about an hour after login | Token rotation, state never re-saved | Framework ≥ 0.2.2 re-saves on close; keep versions current |
| CLI ignores a framework fix | Nested older `@chatbridge/*` copy under `node_modules` | Flat install (see Rules) |
| Partial answer returned | Done signal fired before the new turn existed | Count-before + stability read (see contract) |
| No "generating" element | Send button swapped for a stop button | Done = stop button gone. Do not wait for the send button to return: ChatGPT renders it only while the composer is non-empty |
| `waitForResponse` returns "…" or an ellipsis | A placeholder assistant element (ChatGPT: `data-message-id="request-…"`) appears, is removed ~2 s later, then the real one is inserted | Wait for the done signal before the count check; stability read |
| Page title "Just a moment..." and `isLoggedIn` false; CLI says auth expired | Cloudflare challenge in headless Chromium (both headless modes) | Implement `detectBlock` (framework ≥ 0.3.0): return `"challenge page"` when `document.title === "Just a moment..."`, so the CLI exits 6 and says `Try --headful`. Bot-protection evasion is out of scope (`CLAUDE.md`); record it and move on |
| Google (or another IdP) refuses the automated browser even headful | IdP fingerprints the browser | Log in with email + password / emailed code; note it in `dom-notes.md` §Login |
| `interactive mode needs Bun >= 1.3 or Node >= 26.4` although Bun is installed | `dist/bin.js` shebang is `node` and the system Node is older | Shebang `#!/usr/bin/env bun` (see Runtime and shebang), rebuild |
