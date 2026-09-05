# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language policy

- **Every document pushed to the remote must be written in English.** This includes `README.md`, `CLAUDE.md`, `docs/`, specs, ADRs, code comments, and commit messages.
- **All GitHub issue and PR comments must be written in English.**
- Conversation with the user in this session is in Japanese; that does not change the rules above.
- `INIT.md` is the original Japanese requirements document. It is gitignored and stays local — do not commit it, and do not push Japanese prose in its place. When its content needs to be shared, translate it into English first.

## Current state

Greenfield. No implementation code yet — the repository holds only project scaffolding. Build, test, and lint commands do not exist yet; replace this section with the real commands once a toolchain is chosen and set up.

Read `INIT.md` (local, Japanese) before starting implementation. Its §14 states an explicit policy: set up the development environment and AI development rules *before* building features.

## Purpose

A reusable OSS framework that lets users drive browser-only web chat AI services from a CLI. Not a single-service tool: service-specific behaviour is swapped in as a Provider / Adapter.

## Architecture

```
CLI ─┬─ Interactive Mode (OpenTUI)
     └─ One-shot Mode (-p / --prompt → stdout)
              │
            Core (session, conversation state, provider lifecycle, common errors)
              │
         Provider API
              │
        Playwright Layer (browser / context / page / auth state)
              │
          Web Chat AI
```

Three boundaries must hold:

1. **The UI is not the core.** Core and Provider must not depend on OpenTUI. Interactive and one-shot modes share the same Core and Provider, so a Provider must never assume a TUI exists.
2. **Playwright lifecycle is separate from service-specific DOM work.** Browser startup/shutdown, contexts, pages, and auth-state persistence belong to the shared runtime. DOM selectors, message submission, response-completion detection, login-page navigation, and login-completion detection are delegated to the Provider.
3. **Handle auth *state*, not credentials.** The framework never stores usernames or passwords. The user logs in manually in a headful browser and the resulting browser context storage state is saved and restored. SSO / MFA / corporate IdP specifics are out of scope for the shared runtime.

## OSS scope boundary (strict)

This repository is public. Never bring company-specific material into it:

- Company chat AI implementations, internal URLs, internal service names
- Internal DOM selectors, corporate SSO / IdP logic
- Credentials, private APIs, internal configuration values

Those live in a separate company repository that consumes this project as a dependency. Sample providers must target public services or dummies only.

## Auth state handling

- Saved state contains session cookies. Keep it out of git, restrict file permissions, and never write it to logs.
- `logout` must delete it.
- Intended API surface: `login()` / `saveAuth()` / `loadAuth()` / `isAuthenticated()` / `logout()`
- `auth login` launches Playwright in headful mode.

## Technology candidates (not final)

TypeScript / Bun / OpenTUI / Playwright. These are candidates, to be confirmed after the spec is written. Update this section when the stack is decided or changed.
