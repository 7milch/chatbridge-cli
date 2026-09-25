# Reference guide under `docs/` — design

Milestone 24, tracking issue #133.

## Problem

Everything a user or a provider author needs lives in one 426-line
`README.md`. The provider skills are written for a model and read badly as
documentation; the `core` and `runtime` package READMEs are three lines;
`docs/` holds only the roadmap, the publishing procedure, spike notes and
the superpowers specs and plans, with no index. Answering "how do I write a
URL hook" on 2026-09-25 meant reading `expand-url-hooks.ts`.

## Goals

- A reference guide a reader can navigate by who they are: end user,
  provider author, contributor. Both users and provider authors carry the
  same weight.
- Fine-grained directories with a `README.md` index at every level.
- One worked recipe per Provider extension point, against a dummy or public
  service only.
- The root `README.md` becomes a front page; nothing is documented twice.
- A review rule that keeps the guide in step with the code, at zero
  implementation cost.

## Non-goals

- Generating reference pages from types (TypeDoc or similar).
- A rendered docs site.
- Rewriting the provider skills. They stay independent of the guide and
  keep their own copy of what they need; both are updated under the review
  rule.
- A Japanese edition. Everything pushed is English (language policy).
- A CI check that pages name real flags and methods. The task review does
  that by hand this time; a mechanical check is a backlog idea.

## Layout

```
docs/
  README.md                  index of docs/
  ROADMAP.md                 unchanged
  users/
    README.md
    cli.md                   commands, flags, exit codes
    configuration.md         config.json keys, environment variables, precedence
    interactive-mode.md      built-in commands, @file mentions, key bindings, shell mode
    vscode.md                install, view, commands, settings, keybindings
  providers/
    README.md
    contract.md              the required Provider methods, one section each
    define-provider.md       defineProvider validation and the createCli / createExtension wiring
    auth-and-browser.md      auth state, headful login, what the runtime owns, bot protection stance
    extension-points/
      README.md
      commands.md
      url-hooks.md
      streaming.md
      conversation.md
      detect-block.md
      open-browser-idle.md   the `open`, `browser` and `idle` defaults
    recipes/
      README.md
      url-hooks/jira-datacenter.md
      commands/…             one recipe each, see "Recipes"
      streaming/…
      conversation/…
  contributing/
    README.md
    packages.md              the four packages, dependency direction, dist and tests
    testing.md               bun run check, E2E, the VSCode suite outside check
    PUBLISHING.md            moved from docs/, content unchanged
  spike-notes/               unchanged
  superpowers/               unchanged
```

Every directory's `README.md` lists its pages with one line each and says
who the directory is for. `docs/README.md` lists the top level.

## Page shapes

**`users/cli.md` and `users/configuration.md`** are tables first, prose
second: one row per command, flag, key or variable, with the default and
what overrides what. `configuration.md` states the precedence order once:
provider default, `config.json`, environment variable, command line (and
the VSCode setting where one exists).

**`providers/contract.md`** gives each required method one section with
three parts: when the framework calls it, the properties it must hold
(`waitForResponse` never returns an earlier turn; `sendMessage` is called
once per turn on the same `Page`), and the failure seen when it does not.

**Each `extension-points/*.md`** follows the shape of the URL hooks page
drafted on 2026-09-25: what the framework does with it, the constraints,
a minimal template, links to its recipes. Facts about limits and
validation come from the code, not from the README as it stands today.

**Each recipe** is copy-ready vendor code with an `example.com` host, a
"register it" section, a "use it" section, variations, and a "verify"
section. Never an internal host, selector or credential.

## Recipes in this milestone

| Extension point | Recipe | Target |
|---|---|---|
| URL hooks | Jira Data Center issue with comments | `jira.example.com`, REST API v2, PAT |
| Commands | `/title` (show) and `/shout` (send), the two result kinds | the bundled dummy chat |
| Streaming | `responseText` that returns `undefined` until the new turn's bubble exists | the bundled dummy chat |
| Conversation | `urlConversation` keyed on the `/chat/c/<id>` path | the bundled dummy chat |

The dummy provider in `examples/dummy-chat/provider.ts` already implements
all four, so the three dummy recipes are that code lifted out, explained
section by section, and kept identical to it; a recipe that drifts from
the example is a review finding.

`detectBlock` and `open` / `browser` / `idle` get a template on their
extension-point page, not a recipe: there is nothing service-specific to
show.

## Root README and package READMEs

The root `README.md` keeps: title and status line, Concept, Quick start,
Install, a "Documentation" section linking `docs/README.md` and the three
reader indexes, License. Every other section moves: Interactive mode to
`users/interactive-mode.md`, VSCode extension to `users/vscode.md`,
Long-running sessions to `users/configuration.md` and
`providers/extension-points/open-browser-idle.md`, Authentication and Scope
to `providers/auth-and-browser.md`, Provider extension points to
`providers/extension-points/`, Upgrading to 0.10 to `providers/define-provider.md`.
Moved text is rewritten into the page's shape, not pasted.

Each package `README.md` becomes: what the package is, an install line,
and absolute GitHub links to the pages that document it. The 237-line
`packages/vscode/README.md` is split between `users/vscode.md` (using it)
and `providers/define-provider.md` (packaging it). Package READMEs are what
npm shows, so the links must be absolute.

## Keeping the guide current

`CLAUDE.md`, "Pull requests", gains one bullet: a PR that changes what a
user sees (a CLI command or flag, a config key, an environment variable, a
built-in interactive command, a VSCode command or setting) updates
`docs/users/` in the same PR; a PR that changes what a vendor sees updates
`docs/providers/` in the same PR in addition to the upgrade guide. The
whole-branch review checks both. No tooling.

## Execution

One task per page in the implementation plan. Sonnet writes pages whose
facts come from one package; Opus writes `contract.md`,
`configuration.md`, `define-provider.md` and `auth-and-browser.md`, which
cross packages. Every task review greps for each flag, key, method and
limit the page names and confirms it exists in the code with the stated
default. The PR carries the `documentation` label. `bun run check` must
keep passing; Biome does not lint Markdown, so the check guards only the
example and README code that moves.

## Out of scope, recorded as backlog if wanted later

- Mechanical freshness check in CI.
- Generated API reference.
- Pointing the provider skills at the guide.
