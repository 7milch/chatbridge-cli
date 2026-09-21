---
name: upgrading-provider-repo
description: Use when bumping @chatbridge/* in an existing vendor provider repository, or when asked to adopt a framework feature the provider does not use yet — Markdown replies, streaming, slash commands, URL hooks, idle timeout, VSCode view changes.
---

# Upgrading a Provider Repo

`upgrade-guide.md` next to this file says what each released version asks of a
vendor repository. Release notes do not; never adopt a feature from them.
`../creating-provider-repo/` holds the templates, the probes and
`dom-discovery.md` that the guide's entries refer to.

## Procedure

1. **Bump.** Read the current pin from `package.json` and keep the number: it
   decides which guide entries apply. Target = `npm view @chatbridge/cli version`.
   Set every `@chatbridge/*` dependency to that one exact version, and
   `playwright-core` to `npm view @chatbridge/runtime@<target> dependencies.playwright`
   (the two share version numbers).
   `@chatbridge/runtime` is transitive; do not list it. Then:

   ```sh
   rm -rf node_modules bun.lock && bun install
   find node_modules -path '*@chatbridge/*/node_modules/@chatbridge*'
   ```

   Any `find` hit is a nested older copy shadowing the runtime: fix the
   versions and reinstall until it prints nothing.

2. **Refresh the skills**, then stop and re-open this file from the refreshed
   copy before continuing — the copy you are reading now shipped with the old
   pin and may be missing the very entries you need:

   ```sh
   rm -rf .claude/skills/creating-provider-repo .claude/skills/upgrading-provider-repo
   cp -R node_modules/@chatbridge/provider/skills/. .claude/skills/
   ```

3. **Work the guide.** Open `upgrade-guide.md`, take every entry above the old
   pin up to the target, oldest first. Do each entry's **Required** steps
   without asking. List its **Optional** steps to the user, one line each, and
   do the ones they pick. Apply **VSCode manifest** only when a `vscode/`
   directory exists.

4. **Verify.** Run the entry's own `Verify:` line, then `bun run check`, then
   the gated E2E (`<VENDOR>_E2E=1 bun test src/provider.e2e.test.ts`, which
   needs a saved auth state from `auth login`).

5. **Commit one entry at a time**, naming the version in the message.

## Red flags

Stop and go back to the guide when you catch yourself:

- adopting a feature you read about in a release note, with no guide entry;
- skipping an entry's `Verify:` line because `bun run check` passed;
- bumping some `@chatbridge/*` packages and leaving others behind;
- writing a selector that has no entry in `docs/dom-notes.md`;
- editing a file under `.claude/skills/` by hand — the next refresh overwrites
  it, and the fix belongs in the framework;
- guessing a selector instead of running `../creating-provider-repo/dom-discovery.md`.

A gap the provider cannot solve — browser launch, auth state, session
lifecycle, Markdown conversion — is a `chatbridge-cli` issue: report it there,
then bump once it is released.
