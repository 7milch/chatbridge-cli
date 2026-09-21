# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this repository is

One vendor, one `Provider`, one derived CLI (`<vendor>`), on the published
`@chatbridge/*` packages. Everything service-specific — URLs, selectors,
completion detection, DOM notes — lives here.

## Boundary (reversed from the framework's)

This repository is **private**: nothing here goes upstream. Internal URLs,
internal service names, DOM selectors and anything else vendor-specific must
never be copied into `chatbridge-cli`, an issue there, or a public place.
What does go upstream is a framework gap described in general terms: browser
launch, auth-state handling, session lifecycle. Fix it there, release, bump
the pin here.

## Rules that do not bend

- `@chatbridge/cli`, `@chatbridge/core` and `@chatbridge/provider` are pinned
  to one exact published version, plus `playwright-core` at the version
  `@chatbridge/runtime` uses. Never `file:`, `link:`, or a checkout of the
  framework. After `bun install`, run
  `find node_modules -path '*@chatbridge/*/node_modules/@chatbridge*'`; any hit
  is a nested older copy — fix the versions and reinstall from scratch.
- No credentials, tokens or `.env` files. The framework owns auth state.
- Never paste conversation text, auth state or internal URLs beyond the entry
  and chat URL into `docs/dom-notes.md`, a commit, or a screenshot.
- Selectors come from observing the real DOM, never from a guess. Prefer
  `data-*` and ARIA over generated class names. Record the observation in
  `docs/dom-notes.md` first, then write the selector.
- `bun run check` passes before every commit.
- Never run a formatter, a codemod or any other write over `.auth/` or
  `.playwright-mcp/`: `.auth/mcp-profile` is a live browser profile.
- Everything committed is English.

## Commands

```sh
bun run check                 # lint + build + tests
bun run build                 # dist/
<VENDOR>_E2E=1 bun test src/provider.e2e.test.ts   # real service, needs auth login
```

## Manual checklist after changing the provider

1. `<vendor> --version` prints the package version.
2. `<vendor> auth login` → log in by hand → the window closes on its own.
3. `<vendor> -p "Reply with the single word: ping"`.
4. The gated E2E (two turns, second answer differs; Markdown fidelity).
5. Interactive mode: the banner shows until the first message.
6. `<vendor> auth status`, then `<vendor> auth logout`.

## Following framework releases

After bumping `@chatbridge/*`, refresh the bundled skills, then follow the
`upgrading-provider-repo` skill:

```sh
rm -rf .claude/skills/creating-provider-repo .claude/skills/upgrading-provider-repo
cp -R node_modules/@chatbridge/provider/skills/. .claude/skills/
```
