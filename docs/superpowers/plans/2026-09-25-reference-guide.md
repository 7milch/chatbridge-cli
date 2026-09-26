# Reference Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reader-split reference guide under `docs/` (users, providers, contributing) with an index in every directory, one recipe per extension point, the root README reduced to a front page and package READMEs reduced to pointers.

**Architecture:** Every page is written from the code, not from the current README: each task lists the facts the page must carry with their source locations, and the task review greps the code for every name and default the page states. Directory indexes are created up front in Task 1 with every planned page listed, so later tasks only fill files in.

**Tech Stack:** Markdown only. No new tooling. `bun run check` must keep passing (Biome ignores Markdown; the check guards code that moves).

**Spec:** `docs/superpowers/specs/2026-09-25-reference-guide-design.md`

## Global Constraints

- Every file pushed is English (language policy in `CLAUDE.md`).
- Never write an internal host, selector or credential. Example hosts are `*.example.com`; the only real service named is the bundled dummy chat.
- Every directory under `docs/` that this plan creates has a `README.md` index: one line per page, and a first line saying who the directory is for.
- Page prose style: short sentences, tables for enumerations (flags, keys, commands, methods), fenced blocks for code and exact messages. No em-dashes.
- A page names a source file only when the reader has to go there. Facts are stated, not cited, in the page; the citations below are for the implementer and the reviewer.
- Every code sample compiles against `@chatbridge/*` 0.12.0 as exported today (see the "Exports" facts in Task 15). The three dummy recipes must be byte-identical to the corresponding parts of `examples/dummy-chat/provider.ts`.
- Commit after every task with `Refs #133` in the message and the attribution lines from the session. One commit per task.
- Model policy: tasks marked **Opus** cross packages; the rest are **Sonnet**. Task review model matches.

## Facts that contradict the current README (fix by writing from the code)

The pages must state these correctly; do not copy the README.

1. The TUI `@file` mention has no `:L1-L2` suffix. The suffix exists only on VSCode selection chips.
2. Ctrl+R / `/reopen` restores the conversation when the provider declares `conversation`; the README's "starts a new chat" and "not restored" lines are stale.
3. The VSCode view renders Markdown and streams; the README line saying "the whole reply arrives at once, as plain text" is stale.
4. The VSCode command list includes `reopen` and the optional `help`; the settings include `idleTimeoutMinutes`.
5. The README "Status" and "Planned features" sections are stale (they predate v0.1.0); the front page drops them.
6. There is no `--continue` flag.

---

### Task 1: Skeleton and indexes (Sonnet)

**Files:**
- Create: `docs/README.md`, `docs/users/README.md`, `docs/providers/README.md`, `docs/providers/extension-points/README.md`, `docs/providers/recipes/README.md`, `docs/contributing/README.md`
- Move: `docs/PUBLISHING.md` → `docs/contributing/PUBLISHING.md` (`git mv`, content unchanged)
- Modify: `CLAUDE.md` (the `docs/PUBLISHING.md` mention under "Pull requests"), `docs/ROADMAP.md` if it mentions `docs/PUBLISHING.md` (grep first)
- Delete: the uncommitted drafts `docs/recipes/` and the uncommitted README.md hunk from 2026-09-25 (`git checkout README.md`; keep a copy of `docs/recipes/url-hooks/jira-datacenter.md` and `docs/recipes/url-hooks/README.md` in the scratchpad for Task 10, then `rm -r docs/recipes`)

**Interfaces:**
- Produces: the directory layout and index lines every later task fills in. Later tasks do not edit indexes except to correct their own line.

- [ ] **Step 1: Save the drafts and clean the tree**

```bash
mkdir -p /private/tmp/claude-501/-Users-7milch-Work-git-7milch-chatbridge-cli/34192742-39f0-4504-bb33-d744d6f4afa7/scratchpad/drafts
cp docs/recipes/url-hooks/*.md /private/tmp/claude-501/-Users-7milch-Work-git-7milch-chatbridge-cli/34192742-39f0-4504-bb33-d744d6f4afa7/scratchpad/drafts/
rm -r docs/recipes docs/README.md
git checkout README.md
git status --short   # expect: clean
```

- [ ] **Step 2: Move PUBLISHING.md and fix references**

```bash
mkdir -p docs/contributing && git mv docs/PUBLISHING.md docs/contributing/PUBLISHING.md
grep -rn 'docs/PUBLISHING.md' CLAUDE.md docs/ROADMAP.md README.md packages/*/README.md .github
```
Replace every hit with `docs/contributing/PUBLISHING.md`.

- [ ] **Step 3: Write `docs/README.md`**

```markdown
# Documentation

Pick the index for who you are.

- [users/](users/README.md) — running the CLI, the interactive terminal chat and the VSCode extension.
- [providers/](providers/README.md) — writing a Provider for a web chat service and packaging it as a CLI or extension.
- [contributing/](contributing/README.md) — working on this repository: packages, tests, releases.
- [ROADMAP.md](ROADMAP.md) — shipped milestones and the standing design rules.
- [spike-notes/](spike-notes/) — dated findings from spikes against public services and the runtime.
- [superpowers/](superpowers/) — dated design specs and implementation plans, one pair per milestone.
```

- [ ] **Step 4: Write `docs/users/README.md`**

```markdown
# Using chatbridge

For people who run a chatbridge-based CLI or VSCode extension. A vendor's CLI is `chatbridge` with a fixed provider; everything here applies to it unless the vendor says otherwise.

- [cli.md](cli.md) — commands, flags, provider resolution, exit codes.
- [configuration.md](configuration.md) — `config.json` keys, environment variables, what overrides what.
- [interactive-mode.md](interactive-mode.md) — the terminal chat: slash commands, `@file` mentions, `!` shell mode, keys, streaming, idle close.
- [vscode.md](vscode.md) — the VSCode chat view: commands, settings, composer, attachments.
```

- [ ] **Step 5: Write `docs/providers/README.md`**

```markdown
# Writing a Provider

For people who implement `Provider` from `@chatbridge/provider` for one web chat service and ship it as a CLI, a VSCode extension, or both. The framework owns the browser and the auth state; the provider owns URLs, selectors and completion detection.

- [contract.md](contract.md) — the seven required members, when each is called, what each must guarantee.
- [define-provider.md](define-provider.md) — `defineProvider` validation, `createCli` and `createExtension` wiring, the VSCode manifest a vendor must carry.
- [auth-and-browser.md](auth-and-browser.md) — auth state on disk, the headful login flow, headless and headful sessions, the bot-protection stance.
- [extension-points/](extension-points/README.md) — the optional members: commands, URL hooks, streaming, conversation, detectBlock, open / browser / idle.
- [recipes/](recipes/README.md) — copy-ready examples, one per extension point.

The `@chatbridge/provider` package also ships two skills for coding agents, `creating-provider-repo` and `upgrading-provider-repo`; they are procedures, this guide is the reference.
```

- [ ] **Step 6: Write `docs/providers/extension-points/README.md`**

```markdown
# Extension points

Optional members of `Provider`. Each page says what the framework does with the member, the constraints it must respect, a minimal template, and where its recipe is.

- [commands.md](commands.md) — `commands`: `/name` commands in the interactive UIs.
- [url-hooks.md](url-hooks.md) — `urlHooks`: a URL typed in a message becomes an attachment.
- [streaming.md](streaming.md) — `streaming`: show the reply while it is being written.
- [conversation.md](conversation.md) — `conversation`: return to the same chat after the browser was closed.
- [detect-block.md](detect-block.md) — `detectBlock`: tell a bot challenge from an expired login.
- [open-browser-idle.md](open-browser-idle.md) — `open`, `browser`, `idle`: defaults for the opening phase, reduced motion, and the idle close.
```

- [ ] **Step 7: Write `docs/providers/recipes/README.md`**

```markdown
# Recipes

Copy-ready code for the extension points. Each recipe targets the bundled dummy chat or an `example.com` host; copy it into your provider repository and change the host, never the other way round. The three dummy-chat recipes are the code of `examples/dummy-chat/provider.ts`, explained.

- [commands/dummy-title-shout.md](commands/dummy-title-shout.md) — one `show` command and one `send` command.
- [url-hooks/jira-datacenter.md](url-hooks/jira-datacenter.md) — a Jira Data Center issue with its comments, over REST API v2 with a personal access token.
- [streaming/dummy-response-text.md](streaming/dummy-response-text.md) — `responseText` that stays `undefined` until the new turn's bubble exists.
- [conversation/dummy-url-conversation.md](conversation/dummy-url-conversation.md) — `urlConversation` keyed on the `/chat/c/<id>` path.
```

- [ ] **Step 8: Write `docs/contributing/README.md`**

```markdown
# Contributing

For people who change this repository.

- [packages.md](packages.md) — the five packages, the one-way dependency direction, what each exports, the examples.
- [testing.md](testing.md) — `bun run check`, the E2E suites, the VSCode suite that runs outside the check.
- [PUBLISHING.md](PUBLISHING.md) — cutting a release and publishing to npm.

Process rules (branches, milestones, tracking) are in `CLAUDE.md` at the repository root.
```

- [ ] **Step 9: Verify and commit**

```bash
bun run check 2>&1 | tail -3
git add -A docs CLAUDE.md
git commit -m "docs: guide skeleton with per-directory indexes, PUBLISHING moves under contributing (Refs #133)"
```

---

### Task 2: `docs/users/cli.md` (Sonnet)

**Files:**
- Create: `docs/users/cli.md`
- Sources: `packages/cli/src/create-cli.ts` (parseArgs :162-173, help text :78-104, dispatch :160-316), `packages/cli/src/exit-codes.ts`, `packages/cli/src/resolve-provider.ts`, `packages/cli/src/tui/runtime-check.ts`, `packages/core/src/create-auth-store.ts:10-19`

**Facts the page carries** (verify each against the source before writing):

Flags (`parseArgs`, positionals allowed):

| Flag | Default | Notes |
|---|---|---|
| `-p, --prompt <text>` | unset | one-shot mode; reply on stdout followed by a newline, nothing else on stdout |
| `--provider <npm-package or ./path>` | unset | rejected with exit 1 when the CLI pins a provider: `<name> has a fixed provider; --provider is not accepted` |
| `--headful` | false | show the browser window |
| `--timeout <sec>` | 120 | per turn, and per URL-hook resolve in the TUI; not the opening phase (see configuration.md). Must be a finite number > 0: `--timeout must be a positive number of seconds` |
| `-h, --help` | | help on stdout, exit 0 |
| `-V, --version` | | `<name> v<version>`, exit 0 |

Dispatch order: help, version, then positionals `auth login` / `auth logout` / `auth status`, then interactive (no positional, no `-p`), then one-shot (`-p`), then anything else prints help and exits 1. A parseArgs error prints `<name>: <msg>`, a blank line and help to stderr, exit 1.

`auth login`: headful browser, Ctrl-C cancels (exit 130), progress on stderr. `auth logout`: deletes the state, prints `✓ Auth state deleted` to stderr when stderr is a TTY. `auth status`: stdout `Auth state present for "<provider>" (<path>)` or `No auth state for "<provider>"`, exit 0 either way.

Interactive mode needs a TTY on stdin and stdout (`interactive mode needs a terminal; use -p <prompt> for one-shot`) and Bun >= 1.3 or Node >= 26.4 (`interactive mode needs Bun >= 1.3 or Node >= 26.4; use -p <prompt> on this runtime`). One-shot runs on Node >= 20 or Bun. Progress lines go to stderr only when stderr is a TTY.

Provider resolution: pinned provider > `--provider` > `defaultProvider` in config.json. A spec starting with `./`, `../` or `/` is a path against the current directory; anything else is an npm package name, which a globally installed CLI resolves only when the package is installed globally too. The module's default export needs `name`, `chatUrl` and the five methods, else exit 5 with `Module "<spec>" does not default-export a Provider (name, chatUrl, and the five methods are required).` No provider at all: `No provider specified. Pass --provider <npm-package|./path> or set "defaultProvider" in <path>.` The provider name must match `/^[a-z0-9][a-z0-9._-]{0,63}$/` (exit 5).

Exit codes:

| Exit | Codes | When |
|---|---|---|
| 1 | INVALID_ARGUMENT, INVALID_CONFIG, INVALID_STATE, and any unmapped error | bad flag or env var, no TTY, old runtime, broken config.json, unexpected error |
| 2 | AUTH_REQUIRED | no saved auth state: `No saved auth state for provider "<name>". Run \`auth login\` first.` |
| 3 | AUTH_EXPIRED | `Auth state for "<name>" is no longer valid. Run \`auth login\` again.` |
| 4 | RESPONSE_TIMEOUT | `Timed out during <step> after <ms> ms.`; a timeout that coincides with a lost login is reported as 3 or 6 instead |
| 5 | PROVIDER_LOAD, INVALID_PROVIDER | |
| 6 | BLOCKED | `Blocked by "<name>": <description>.` plus ` Try --headful.` |
| 7 | BROWSER_UNAVAILABLE | plus `Run: npx playwright install chromium` |
| 130 | LOGIN_ABORTED | Ctrl-C during `auth login` |

`CHATBRIDGE_DEBUG=1` appends `Caused by: <stack or message>` to framework errors. A TUI teardown that cannot close the browser within 5 s exits 1 with `browser did not close within 5 s; exiting`.

**Page outline:** Synopsis (the four invocations) · Flags table · Modes (one-shot, interactive, auth subcommands) · Where the provider comes from · Exit codes table · Debugging.

- [ ] **Step 1: Read the sources listed above; note any fact that differs from the table and use the code.**
- [ ] **Step 2: Write the page.**
- [ ] **Step 3: Verify every flag, message and exit code named in the page:**

```bash
for s in '--headful' '--timeout' 'auth status' 'LOGIN_ABORTED' 'Try --headful' 'npx playwright install chromium' 'has a fixed provider'; do grep -rn --include=*.ts -F "$s" packages/cli/src packages/core/src | grep -v test | head -1 || echo "MISSING: $s"; done
```
Every line must print a hit.

- [ ] **Step 4: Commit**

```bash
git add docs/users/cli.md
git commit -m "docs(users): CLI reference — commands, flags, provider resolution, exit codes (Refs #133)"
```

---

### Task 3: `docs/users/configuration.md` (Opus)

**Files:**
- Create: `docs/users/configuration.md`
- Sources: `packages/cli/src/config.ts` (:7-20 keys, :35-38 path, :74-150 validation), `packages/cli/src/open-options.ts`, `packages/cli/src/idle-options.ts`, `packages/cli/src/shell/shell-config.ts`, `packages/core/src/idle-watch.ts:4`, `packages/core/src/chat-session.ts:258-263`, `packages/vscode/src/create-extension.ts:147-178`, `packages/runtime/src/auth-store.ts:23-43`

**Facts the page carries:**

File: `~/.config/<configDir>/config.json`; `configDir` is the CLI name unless the vendor set `createCli({ configDir })`. Missing file = `{}`. Not valid JSON, not an object, or a wrong type → exit 1 (`INVALID_CONFIG`). Unknown keys are ignored. Read by interactive and one-shot mode even when the provider is pinned; `auth *` reads it only for `defaultProvider` and only when no provider is pinned or passed.

| Key | Type | Default | Applies to |
|---|---|---|---|
| `defaultProvider` | string; `./` or `../` resolves against the config file's directory | none | CLIs without a pinned provider |
| `shell.leadIn` | string | `Please check the execution result.` | TUI `!` mode |
| `shell.autoSend` | boolean | `true` | TUI `!` mode |
| `open.timeoutSec` | number > 0 | 120 | opening phase, CLI only |
| `open.retries` | integer >= 0 | 0 | opening phase, CLI only |
| `idle.timeoutMin` | number >= 0, 0 disables | 1440 | interactive only |

Validation messages: `"open.timeoutSec" must be a positive number`, `"open.retries" must be a non-negative integer`, `"idle.timeoutMin" must be a non-negative number`.

Environment variables (trimmed; blank = unset):

| Variable | Overrides | Error when invalid (exit 1) |
|---|---|---|
| `CHATBRIDGE_OPEN_TIMEOUT` | `open.timeoutSec` (seconds, > 0) | `CHATBRIDGE_OPEN_TIMEOUT must be a positive number of seconds, got "…"` |
| `CHATBRIDGE_OPEN_RETRIES` | `open.retries` (integer >= 0) | `CHATBRIDGE_OPEN_RETRIES must be a non-negative integer, got "…"` |
| `CHATBRIDGE_IDLE_TIMEOUT` | `idle.timeoutMin` (minutes, 0 disables) | `CHATBRIDGE_IDLE_TIMEOUT must be a non-negative number of minutes (0 disables), got "…"` |
| `CHATBRIDGE_DEBUG` | `1` prints `Caused by:` under framework errors | |
| `SHELL` | shell for `!` mode, falls back to `/bin/sh` | |

Precedence, later wins, key by key:

- Provider selection: pinned `createCli({ provider })` > `--provider` > `defaultProvider`.
- Opening phase (`timeoutMs`, `retries`): built-in 120 s / 0 → provider `open` → config `open` → env `CHATBRIDGE_OPEN_*`. No flag. Retries re-run launch → goto → isLoggedIn → startNewChat after a launch or navigation failure, closing the browser between attempts; auth-required, auth-expired, blocked and browser-unavailable errors are never retried. In VSCode there is no `open` override: the opening timeout is the `<id>.timeoutSec` setting (or the provider's `open.timeoutMs`), retries are the provider's or 0.
- Per-turn timeout: `--timeout` or 120 s in the CLI; `<id>.timeoutSec`, else `createExtension({ timeoutMs })`, else 120 s in VSCode. No config key, no env var.
- Idle close: built-in 24 h → provider `idle.timeoutMs` → config `idle.timeoutMin` → env `CHATBRIDGE_IDLE_TIMEOUT`; in VSCode `<id>.idleTimeoutMinutes` replaces the config and env layers. One-shot forces 0.
- Shell: built-in → vendor `createCli({ shell })` → config `shell`.
- `browser.reducedMotion`: provider only, no user override.

Auth state file: `~/.config/<configDir>/auth/<provider name>.json`, directory 0700, file 0600, holds cookies, localStorage and IndexedDB. `auth logout` (and `/logout`, and the VSCode Log out command) deletes only that file. Keep it out of version control and logs.

**Page outline:** The config file (path, when it is read, what breaks it) · Keys table · Environment variables table · Precedence, one subsection per knob · Files on disk (config.json, auth state).

- [ ] **Step 1: Read the sources; reconcile with the tables above.**
- [ ] **Step 2: Write the page.**
- [ ] **Step 3: Verify:**

```bash
for s in 'timeoutSec' 'timeoutMin' 'CHATBRIDGE_OPEN_TIMEOUT' 'CHATBRIDGE_OPEN_RETRIES' 'CHATBRIDGE_IDLE_TIMEOUT' 'CHATBRIDGE_DEBUG' 'Please check the execution result.' '0o600' '86_400_000' '120_000'; do grep -rn --include=*.ts -F "$s" packages/*/src | grep -v test | head -1 || echo "MISSING: $s"; done
```

- [ ] **Step 4: Commit**

```bash
git add docs/users/configuration.md
git commit -m "docs(users): configuration reference — config.json, environment, precedence, files on disk (Refs #133)"
```

---

### Task 4: `docs/users/interactive-mode.md` (Sonnet)

**Files:**
- Create: `docs/users/interactive-mode.md`
- Sources: `packages/core/src/slash-commands.ts`, `packages/cli/src/tui/chat-view.ts` (guides :44-80, keys :378-386 and :866-933, shell entry :941-961), `packages/cli/src/tui/chat-model.ts` (runSlash :717-804, runShell :519-613, reset :957-1019), `packages/cli/src/tui/run-interactive.ts:91-114`, `packages/cli/src/mentions/parse-mentions.ts`, `packages/cli/src/mentions/file-index.ts`, `packages/cli/src/mentions/expand-mentions.ts`, `packages/core/src/attachment.ts`, `packages/cli/src/shell/run-command.ts`, `packages/cli/src/shell/format-result.ts`, `packages/cli/src/tui/grammars.ts`, `packages/cli/src/tui/clipboard.ts`, `packages/cli/src/tui/spinner.ts:35-39`

**Facts the page carries:**

Startup: the TUI opens at once and the browser behind it (`Opening browser...`); text typed meanwhile is queued. Header: `<title>` badge, `<provider> · headless|headful · <N>s budget`. Not logged in → the error appears in the chat with `Type /login to log in.`

Slash commands (built-ins run at once in any state; provider commands queue like a message):

| Command | Does |
|---|---|
| `/login` | headful login window; status `Log in in the browser window… (Ctrl+C cancel)`; on success separator `Logged in` and an automatic reopen |
| `/logout` | separator `Logged out`, deletes the auth state, reopens, forgets the conversation |
| `/new` | separator `new chat`, reopens, forgets the conversation |
| `/reopen` | same as Ctrl+R; separator `reopened`, restores the conversation when the provider supports it (`reopened · conversation restored` / `reopened · conversation could not be restored`) |
| `/copy` | copies the last complete reply as raw text; notice `copied` / `copy failed` / `nothing to copy yet` for 2 s |
| `/help` | built-ins then provider commands, one aligned line each |

Parsing: `^/([a-z]+)(?:\s+([\s\S]*))?$`; a built-in with arguments → `/<word> takes no arguments.`; unknown → `Unknown command: /<word>. Type /help.`; `/usr/bin` is not a command.

Clipboard: `pbcopy` on macOS, `clip.exe` on Windows, `wl-copy` (with `WAYLAND_DISPLAY`) or `xclip -selection clipboard` on Linux, 2 s timeout, then OSC 52; over SSH (`SSH_TTY` or `SSH_CONNECTION`) OSC 52 only. Mouse drag over history text copies on release.

`@file` mentions: `@` at the start or after whitespace, path to the next whitespace; a bare `@` opens the popup. No line-range suffix. Popup index: built once at startup from the current directory, honours every `.gitignore`, always skips `.git` and `node_modules`, never follows symlinks, capped at 20 000 files, case-insensitive subsequence match scored 3 at a segment start, 2 after `.` `-` `_`, 1 elsewhere, ties to the shorter path. A hand-typed path resolves at send time even if gitignored. Problems are collected and nothing is sent, the text returns to the box: `@<m>: outside working directory`, `not found`, `is a directory`, `<kb> KB exceeds 200 KB`, `binary file`, `attachments total <size> exceeds 1 MB`. Limits 200 KB per file, 1 MB per message (shared with URL hooks). Prompt layout: typed text, then per file `### <path>` and a fenced block whose fence is 3 backticks or one more than the longest backtick run in the content, info string from the extension (ts js tsx jsx json md py sh yaml yml toml html css rs go). History shows `📎 <path> (<size>)`.

Provider URL hooks: a URL the provider recognises is fetched by the provider and attached the same way under the hook's label; scanned in the typed text only. Link to `../providers/extension-points/url-hooks.md`.

Keys:

| Key | Does |
|---|---|
| Enter | send (or queue while busy) |
| Shift+Enter (kitty protocol) / Ctrl+J | newline; input grows to 5 rows |
| Ctrl+R | reopen the browser, any state |
| PageUp / PageDown, mouse wheel | scroll history |
| Up on the first line with a queue | take the queue back into the box |
| Up / Down, Tab / Enter, Esc | popup select, accept, close; Enter submits when the word already equals the selected command |
| Ctrl+C | cancel login, stop a shell command, otherwise quit |
| Esc / Backspace / Ctrl+U on an empty `!` prompt | leave shell mode |

Status guides verbatim: `Enter send · @ file · ! shell · / commands · Ctrl+R reopen · Ctrl+C quit`; shell `Enter run · Esc exit shell · Ctrl+R reopen · Ctrl+C quit`; held prefix `📎 N held · `; dead (red) `Ctrl+R reopen · /login · Ctrl+C quit`; idle `Browser closed after being idle · your next prompt reopens it`.

`!` shell mode: `!` in an empty input enters it (prompt turns to a yellow `! `, placeholder `Run a shell command`, popup off). Enter runs and returns to message mode. Runs `$SHELL -c <cmd>` (or `/bin/sh`) in the startup directory, own process group, stdin closed, stderr merged into stdout; no sandbox, `cd` does not persist. Output capped at 200 KB (head dropped, command killed); Ctrl+C sends SIGTERM then SIGKILL after 2 s. History: `shell` label, `$ <cmd>`, output, footer parts `… (truncated: first N KB dropped)`, `exit code: N`, `killed by <SIGNAL>`, `interrupted`, `did not start`, `📎 held, sent with your next message`. Sent as `<leadIn>` + blank line + `### $ <cmd>` fenced section; held instead when `shell.autoSend` is false, during `/login`, or after an idle close; held results go with the next message and survive a timeout. Config: `shell.leadIn`, `shell.autoSend` (link to configuration.md).

Rendering: labels `user` blue, `assistant` green, `error` red, `shell` yellow; separators `── text ──`. Assistant replies render as Markdown only when the provider declares `responseFormat: "markdown"`; fenced blocks get a left border once settled; syntax colours for javascript, typescript, markdown, zig (OpenTUI) and python, ruby, json, bash, go (bundled); YAML and unknown languages are framed only. Streaming: spinner row `<frame> <label>  <s>s` becomes the growing reply; a reply that failed part-way keeps its text with `(incomplete)`. A response timeout keeps the session usable; any other error makes the chat dead. Spinner default frames `●○○ ○●○ ○○● ○●○`, 120 ms, `Thinking…`.

Idle close: after 24 h without a turn (configurable, see configuration.md) the browser closes, auth state saved; the guide line changes; the next prompt reopens with separator `reopened after idle` plus the restore note. The conversation handle is in memory only; `/new` and `/logout` forget it. `/copy` and `!` still work while closed; a shell result is held.

**Page outline:** Starting and the screen · Slash commands · `@file` mentions · URL hooks (pointer) · Keys · `!` shell mode · Replies and streaming · Idle close and reopen · Copying.

- [ ] **Step 1: Read the sources; reconcile.**
- [ ] **Step 2: Write the page.**
- [ ] **Step 3: Verify:**

```bash
for s in 'Enter send · @ file · ! shell' 'Browser closed after being idle' 'takes no arguments' 'reopened after idle' 'Run a shell command' 'MAX_OUTPUT_BYTES' 'outside working directory' 'nothing to copy yet'; do grep -rn --include=*.ts -F "$s" packages/cli/src packages/core/src | grep -v test | head -1 || echo "MISSING: $s"; done
```

- [ ] **Step 4: Commit**

```bash
git add docs/users/interactive-mode.md
git commit -m "docs(users): interactive mode reference — commands, mentions, shell mode, keys, streaming, idle (Refs #133)"
```

---

### Task 5: `docs/users/vscode.md` (Sonnet)

**Files:**
- Create: `docs/users/vscode.md`
- Sources: `packages/vscode/src/commands.ts`, `packages/vscode/src/create-extension.ts:147-236`, `packages/vscode/src/manifest.ts`, `packages/vscode/src/timeout-setting.ts`, `packages/vscode/src/webview/main.ts`, `packages/vscode/src/webview/command-menu.ts`, `packages/vscode/src/view-state.ts`, `packages/vscode/src/session-controller.ts` (limits :218-232, lastReply :195-202, idle :434-463), `packages/vscode/src/install-browser.ts`, `packages/vscode/README.md` (the "Usage", "Composer", "Replies" sections; the page replaces them)

**Facts the page carries:**

The view is `<Vendor>` in the activity bar; every command is `<Vendor>: <title>` in the palette. Install Chromium once with `<Vendor>: Install Browser` (runs `playwright install chromium` from the bundled Playwright; notifications `Installing Chromium`, `Chromium installed.`, `Chromium install failed: <msg>`) or `npx playwright install chromium`.

Commands:

| Command | Does |
|---|---|
| Log in | cancellable notification `Log in to <Vendor>`; refused while busy: `Wait for the current reply to finish, then log in.`; success separator `Logged in` |
| Log out | deletes the auth state, closes the browser, separator `Logged out`, forgets the conversation |
| New Chat | closes the browser, separator `New chat`, reopens lazily on the next send; refused mid-turn: `Wait for the current reply to finish, or press Ctrl+R to reopen.` |
| Reopen Browser (Ctrl+R / Cmd+R in the view) | replaces the browser in any state, separator `reopened` with the restore note |
| Send Selection to <Vendor> (editor context menu) | attaches the selection as `<path>:L<start>-L<end>` (1-based, inclusive), or the whole buffer when nothing is selected |
| Send File to <Vendor> (explorer context menu) | attaches that file, or the active editor's buffer |
| Focus Chat | focuses the view |
| Help (optional in the vendor manifest) | focuses the view and prints the `/help` listing |

Settings (re-read at every session open):

| Setting | Default | Notes |
|---|---|---|
| `<id>.headless` | true | false shows the browser; the remedy for `BLOCKED` |
| `<id>.timeoutSec` | vendor's `timeoutMs` or 120 | per turn and the opening phase; invalid → one warning and the fallback |
| `<id>.idleTimeoutMinutes` | provider's or 1440; 0 disables | invalid → one warning and the fallback |

Composer: textarea `Message…`; `+` attaches via a native picker (`Attach`); `/` opens the command menu; Enter sends or queues, Shift+Enter newline; Up on an empty composer takes the queue back (attachments return as chips; `N attachment(s) left out: total size limit.` when they no longer fit). Attachments: chips `📎 <path> (<size>)` with ×; sources are the picker, Shift+drop (a plain drop opens the file in VSCode), Send Selection / Send File, and a multi-line paste that equals the active selection (becomes a `path:Lx-Ly` chip). Ghost chip `+ <basename>` offers the active `file:` document; clicking attaches its current contents, unsaved edits included. Limits `<path>: <kb> KB exceeds 200 KB` and `attachments total <size> exceeds 1 MB`. An attachment-only message is allowed. Sent layout is the same `### <path>` fenced format as the TUI. Provider URL hooks attach the same way (pointer to `../providers/extension-points/url-hooks.md`).

Slash commands: the same parser and built-ins as the TUI (link to interactive-mode.md); `/new` is New Chat; `/copy` reports `Nothing to copy yet.`, `Copied the last reply.` or `Could not copy the last reply.`; unknown commands show inline above the composer. Command menu: Up/Down, Tab completes, Enter completes or sends, Esc closes until the text changes.

Replies: Markdown (headings, lists and task lists, tables, blockquotes, fenced code with a language label and a Copy button that reads `Copied` for 1.5 s); links http/https only, images as links, raw HTML as text; no syntax colours. Streaming shows the reply as it is written; a reply that stopped early is marked `(incomplete)`. Separators render as `— text —`.

Status: a spinner with the latest progress line, ` · N queued`; the same line in the status bar and an Output channel named `<Vendor>`. Dead card `Not logged in.` or `The chat stopped.` with Log in / Reopen / New chat buttons; remedies `Set the "<id>.headless" setting to false and try again.` (blocked) and `Run "<Vendor>: Install Browser" and send again.` (Chromium missing, also offered as a modal Install button on send).

Idle: separator `closed after idle`, the next send reopens lazily with the restore note.

Auth state and config directory are shared with the vendor's CLI when the vendor set the same `configDir` (pointer to configuration.md).

**Page outline:** Install and first run · Commands · Settings · Composer and attachments · Slash commands · Replies · Status, errors and recovery · Idle close.

- [ ] **Step 1: Read the sources; reconcile.**
- [ ] **Step 2: Write the page.**
- [ ] **Step 3: Verify:**

```bash
for s in 'idleTimeoutMinutes' 'Wait for the current reply to finish, then log in.' 'Nothing to copy yet.' 'closed after idle' 'left out: total size limit' 'Installing Chromium' 'Set the "'; do grep -rn --include=*.ts -F "$s" packages/vscode/src | grep -v test | head -1 || echo "MISSING: $s"; done
```

- [ ] **Step 4: Commit**

```bash
git add docs/users/vscode.md
git commit -m "docs(users): VSCode extension reference — commands, settings, composer, replies (Refs #133)"
```

---

### Task 6: `docs/providers/contract.md` (Opus)

**Files:**
- Create: `docs/providers/contract.md`
- Sources: `packages/provider/src/index.ts:99-151`, `packages/core/src/chat-session.ts` (open :251-313, attempt :315-371, assertLoggedIn :225-246, send :425-454, diagnoseTimeout :557-571, close :579-610), `packages/core/src/session.ts` (runOneShot :29-39, runLogin :81-122), `packages/core/src/run-step.ts`, `packages/cli/src/resolve-provider.ts:4-20`, `examples/dummy-chat/provider.ts`

**Facts the page carries:**

Required members: `name`, `chatUrl`, `navigateToLogin(page)`, `isLoggedIn(page)`, `startNewChat(page)`, `sendMessage(page, prompt)`, `waitForResponse(page)`. Doc comments verbatim from index.ts. `name` also names the auth-state file and must match `/^[a-z0-9][a-z0-9._-]{0,63}$/`.

Lifecycle, in order:

1. Session open (every attempt): launch Chromium with the saved storage state → `page.setDefaultTimeout(open.timeoutMs)` → `page.goto(chatUrl)` → `isLoggedIn` → if false and `detectBlock` exists, `detectBlock` → if a conversation handle was given and the provider has `conversation`, `conversation.open` → otherwise `startNewChat`. Then the page's default timeout becomes the per-turn timeout and the idle watch starts. Missing auth file fails before any browser work with `AuthRequiredError`.
2. Turn: `sendMessage` → `waitForResponse` (with `streaming.responseText` polled meanwhile) → `conversation.handle` (5 s budget, errors swallowed). On a timeout, `isLoggedIn` (and `detectBlock`) run again to tell a lost login from a slow reply.
3. Provider command: `run(page, args)` under the per-turn timeout, same diagnosis.
4. Close: idle watch stops → `isLoggedIn` → true saves the storage state (`false` logs `Session is no longer logged in; auth state not saved.`) → browser closes. `kill` saves nothing.
5. `auth login`: headful launch → `page.setDefaultTimeout(30_000)` → `navigateToLogin` → `isLoggedIn` polled every 1 s with no deadline until true → state saved → close. Ctrl-C kills the browser.
6. One-shot: open with idle disabled → one turn → close.

Per-method section, each with "Called", "Must", "When it does not":

- `navigateToLogin`: headful only, 30 s timeout. Must land on a page from which the user can log in. If it throws or times out, `auth login` fails.
- `isLoggedIn`: at open, after any timeout, at close, and once a second during login. Must be cheap, side-effect free, and return false rather than throw mid-login. A false at open becomes `AuthExpiredError` (exit 3) or, via `detectBlock`, `BlockedError` (exit 6); a false at close skips the auth save; a throw at close is logged as `Could not save auth state: <msg>`.
- `startNewChat`: after the login check on every open that did not restore a conversation. Must leave the page ready for `sendMessage`. Not called when a conversation was restored.
- `sendMessage`: once per turn on the same `Page`; never concurrently. Must submit and return; completion is `waitForResponse`'s job. A Playwright timeout becomes `ResponseTimeoutError` (`Timed out during sendMessage after <ms> ms.`).
- `waitForResponse`: right after `sendMessage`. Must return only the reply to that `sendMessage`, in `responseFormat` (`"text"` default, `"markdown"` via `elementToMarkdown`). Returning an earlier turn's text is the classic bug; key completion on DOM state (a busy/idle attribute, a stop button disappearing), not on an animation.
- `name` / `chatUrl`: `chatUrl` is where every open navigates; its origin is what a restored conversation is checked against.

Timeouts: every provider call runs under `page.setDefaultTimeout`: the opening timeout during open, the per-turn timeout during turns and commands, 30 s during login. Playwright `TimeoutError` is mapped to `ResponseTimeoutError`; other errors pass through with their message.

Reference implementation: `examples/dummy-chat/provider.ts`; quote its `isLoggedIn`, `startNewChat`, `sendMessage`, `waitForResponse` verbatim as the worked example.

**Page outline:** The contract in one table · Lifecycle (the six flows above) · Each member (Called / Must / When it does not) · Timeouts and errors · Worked example.

- [ ] **Step 1: Read the sources; reconcile.**
- [ ] **Step 2: Write the page.**
- [ ] **Step 3: Verify:**

```bash
for s in 'setDefaultTimeout(30_000)' 'LOGIN_POLL_INTERVAL_MS' 'HANDLE_BUDGET_MS' 'Session is no longer logged in' 'Could not save auth state' 'Timed out during'; do grep -rn --include=*.ts -F "$s" packages/core/src | grep -v test | head -1 || echo "MISSING: $s"; done
diff <(sed -n '/async isLoggedIn/,/^    },/p' examples/dummy-chat/provider.ts) <(awk '/^```ts/{f=1;next}/^```/{f=0}f' docs/providers/contract.md | sed -n '/async isLoggedIn/,/^    },/p') && echo "dummy isLoggedIn identical"
```

- [ ] **Step 4: Commit**

```bash
git add docs/providers/contract.md
git commit -m "docs(providers): the Provider contract — lifecycle and per-method guarantees (Refs #133)"
```

---

### Task 7: `docs/providers/define-provider.md` (Opus)

**Files:**
- Create: `docs/providers/define-provider.md`
- Sources: `packages/provider/src/index.ts:156-228`, `packages/cli/src/create-cli.ts:20-47` and `packages/cli/src/tui/banner-options.ts`, `packages/cli/src/tui/spinner.ts:3-39`, `packages/vscode/src/create-extension.ts:31-60`, `packages/vscode/src/ui-config.ts`, `packages/vscode/src/manifest.ts`, `packages/vscode/README.md` ("Options", "Manifest", "Packaging" sections; the page replaces them), `packages/provider/skills/creating-provider-repo/templates/vscode/package.json`, README.md "Upgrading to 0.10"

**Facts the page carries:**

`defineProvider(provider)` returns its argument after these checks, in order, each throwing a plain `Error`:

1. `Provider command name "<n>" must match /^[a-z]+$/.`
2. `Provider command "/<n>" collides with a built-in command.` (login, logout, new, reopen, copy, help)
3. `Provider command "/<n>" is defined twice.`
4. `URL hook RegExp <re> must not use the g or y flag (it makes .test stateful).`
5. `Provider browser.reducedMotion must be "reduce" or "no-preference", got …`
6. `Provider idle.timeoutMs must be a non-negative finite number, got …`
7. `Provider responseFormat must be "markdown" or "text", got …`
8. `Provider streaming.responseText must be a function.`
9. `Provider streaming.pollIntervalMs must be a finite number greater than 0, got …`
10. `Provider conversation.<handle|open> must be a function.`

It does not check `name`, `chatUrl`, the required methods or `open`; the CLI loader checks the required members at load time, the runtime checks `name` when the auth store is created.

`createCli(options)` from `@chatbridge/cli`:

| Option | Type | Notes |
|---|---|---|
| `name` | string | help, errors, default `configDir` |
| `version?` | string | `--version` and the default banner |
| `provider?` | Provider | pins it; `--provider` is then an error, `defaultProvider` ignored |
| `configDir?` | string | under `~/.config`; default `name` |
| `banner?` | `string[]` or `{ lines, colors?, mode?, direction? }` | `mode` `per-line` (default) / `per-char` / `gradient`; `direction` `vertical` (default) / `horizontal` / `diagonal`, gradient only; colours ANSI 0-255 or `#rrggbb`; gradient needs >= 2 hex colours; validated at startup with a plain Error |
| `spinner?` | `{ frames?, intervalMs?, label?, frameColor?, labelColor? }` | defaults `["●○○","○●○","○○●","○●○"]`, 120, `Thinking…`; `label` may be an array, one picked per turn |
| `shell?` | `Partial<{ leadIn, autoSend }>` | vendor defaults for `!` mode; the user's config.json overrides key by key |

Returns an object whose `run(process.argv)` resolves to the exit code; `bin.ts` pattern: `process.exitCode = await createCli({...}).run(process.argv)`.

`createExtension(options)` from `@chatbridge/vscode`:

| Option | Type | Notes |
|---|---|---|
| `id` | string | prefix of every contributed id; default `configDir` |
| `displayName` | string | view title, notifications, Output channel |
| `provider` | Provider | always pinned |
| `configDir?` | string | use the CLI's so one `auth login` serves both |
| `timeoutMs?` | number | default 120 000; the `<id>.timeoutSec` setting overrides |
| `headless?` | boolean | default true; the `<id>.headless` setting overrides |
| `playwrightCliPath?` | string | default `<extension>/node_modules/playwright/cli.js` |
| `ui?` | `{ welcome?, banner?, footer?, sendButton?: { background?, foreground? }, userMessage?: { borderColor? } }` | `banner` is a png/svg path relative to the extension root, validated at activation: `<p>: banner path must be relative to the extension root`, `<p>: banner image not found (looked for <abs>)` |

Returns `{ activate, deactivate }`; `activate` returns `{ controller, handlers, bridge }`; `deactivate` closes the browser.

Manifest the vendor must carry (activation throws `<displayName>: package.json lacks contributes entries for "<id>": …` otherwise): activity-bar container `<id>`, view `<id>.chat`, commands `<id>.login`, `<id>.logout`, `<id>.newChat` (icon `$(add)`), `<id>.reopen` (icon `$(refresh)`), `<id>.installBrowser`, `<id>.sendSelection`, `<id>.sendFile`, `<id>.focus`. Optional `<id>.help`. Recommended (console.warn only): view/title menu entries newChat `navigation@1`, reopen `navigation@2`, login `1_auth@1`, logout `1_auth@2`, installBrowser `2_setup@1`, help `3_help@1`; keybinding `ctrl+r` / `cmd+r` for `<id>.reopen` when `focusedView == <id>.chat`; editor/context for sendSelection, explorer/context with `!explorerResourceIsFolder` for sendFile. Settings: `<id>.headless` (boolean, default true), `<id>.timeoutSec` and `<id>.idleTimeoutMinutes` declared **without** `default`, because VSCode would otherwise return the default and override the provider's value. Reproduce the template's `contributes` block from `packages/provider/skills/creating-provider-repo/templates/vscode/package.json` verbatim.

Packaging a `.vsix`: bundle with esbuild as CJS to `dist/extension.cjs` with `vscode` and `playwright` external; only `playwright` in `dependencies`; `bun run build`; `rm -rf node_modules && npm install --omit=dev`; `npx @vscode/vsce package` (no `--no-dependencies`); check `unzip -l *.vsix | grep node_modules/playwright/cli.js`; `bun install` to restore; `code --install-extension <file>.vsix`. Chromium is never packaged.

Compatibility notes carried over from the README: since 0.10, `ChatSessionOptions.onIdleExpired(closing: Promise<void>)` for embedders of core, and `copy` reserved as a built-in command name. Point to `packages/provider/skills/upgrading-provider-repo/upgrade-guide.md` for the per-version list.

**Page outline:** `defineProvider` and what it checks · Shipping a CLI (`createCli`) · Shipping a VSCode extension (`createExtension`, manifest, packaging) · Upgrading between versions.

- [ ] **Step 1: Read the sources; reconcile.**
- [ ] **Step 2: Write the page.**
- [ ] **Step 3: Verify:**

```bash
for s in 'must match /^[a-z]+$/' 'collides with a built-in command' 'is defined twice' 'must not use the g or y flag' 'banner path must be relative' 'lacks contributes entries' 'playwrightCliPath'; do grep -rn --include=*.ts -F "$s" packages/*/src | grep -v test | head -1 || echo "MISSING: $s"; done
```

- [ ] **Step 4: Commit**

```bash
git add docs/providers/define-provider.md
git commit -m "docs(providers): defineProvider, createCli, createExtension and the VSCode manifest (Refs #133)"
```

---

### Task 8: `docs/providers/auth-and-browser.md` (Opus)

**Files:**
- Create: `docs/providers/auth-and-browser.md`
- Sources: `packages/runtime/src/auth-store.ts`, `packages/runtime/src/browser-runtime.ts`, `packages/core/src/session.ts:81-122`, `packages/core/src/chat-session.ts:222-246, 579-626`, `packages/core/src/errors.ts`, README.md "Authentication" and "Scope: cooperative services only", `docs/spike-notes/2026-09-08-chatgpt.md`, CLAUDE.md "Bot protection is out of scope"

**Facts the page carries:**

Division of labour: the runtime owns launch (`chromium.launchServer`, so `kill` can SIGKILL), one context per session with `storageState` from the auth file when present and `reducedMotion` from the provider (default `reduce`), the page, `saveAuthState`, `close`, `kill`. The provider owns URLs, selectors, submission, completion, login navigation and login detection.

Auth state: never a username or password. The user logs in by hand in a headful window; `storageState({ indexedDB: true })` (cookies, localStorage, IndexedDB) is written to `~/.config/<configDir>/auth/<name>.json`, dir 0700, file 0600. Loaded at every launch. Re-saved at every clean close when `isLoggedIn` is true, so rotated tokens survive. `logout` deletes the file (idempotent). Never log it; a conversation handle must never embed a credential either.

Login flow (`auth login`, `/login`, the VSCode Log in command): headful, `navigateToLogin`, then `isLoggedIn` once a second until true, no deadline, cancellable. What SSO, MFA or a corporate IdP do inside that window is the user's business; the framework only waits for `isLoggedIn`.

Headless vs headful: the CLI `--headful`, the VSCode `<id>.headless` setting; `auth login` is always headful.

Errors a provider author will meet: `AuthRequiredError` (no file, exit 2), `AuthExpiredError` (`isLoggedIn` false at open, exit 3), `BlockedError` (`detectBlock` returned a description, exit 6, message `Blocked by "<name>": <description>.`), `BrowserUnavailableError` (Chromium missing, exit 7), `ResponseTimeoutError` (exit 4). Which of these the open phase retries: none of the first four.

Bot protection stance, verbatim in spirit from CLAUDE.md: intended targets are company-internal and cooperative services; when a public service blocks automation, implement `detectBlock` so the user sees exit 6 and the `--headful` hint; stealth plugins, UA spoofing and attaching to a personal Chrome profile will not be added. Public services are spike targets only (link to `../spike-notes/2026-09-08-chatgpt.md`).

Reduced motion: every context emulates `prefers-reduced-motion: reduce` because an idle animating page is rasterised on the CPU for as long as the session is open (link to `../spike-notes/2026-09-20-idle-browser-cpu.md`); opt out with `browser: { reducedMotion: "no-preference" }` only when completion detection needs an animation, and prefer DOM-state detection instead.

**Page outline:** Who owns what · Auth state (what, where, when saved, when deleted) · The login flow · Headless and headful · Errors · Bot protection · Reduced motion.

- [ ] **Step 1: Read the sources; reconcile.**
- [ ] **Step 2: Write the page.**
- [ ] **Step 3: Verify:**

```bash
for s in 'indexedDB: true' 'launchServer' '0o700' 'reducedMotion' 'Blocked by'; do grep -rn --include=*.ts -F "$s" packages/runtime/src packages/core/src | grep -v test | head -1 || echo "MISSING: $s"; done
```

- [ ] **Step 4: Commit**

```bash
git add docs/providers/auth-and-browser.md
git commit -m "docs(providers): auth state, login flow, browser ownership, bot-protection stance (Refs #133)"
```

---

### Task 9: `extension-points/commands.md` and the commands recipe (Sonnet)

**Files:**
- Create: `docs/providers/extension-points/commands.md`, `docs/providers/recipes/commands/dummy-title-shout.md`
- Sources: `packages/provider/src/index.ts:35-66`, `packages/core/src/slash-commands.ts`, `packages/core/src/chat-session.ts:526-551`, `packages/cli/src/tui/chat-model.ts:810-858`, `examples/dummy-chat/provider.ts:76-91`

**Facts:** `ProviderCommand { name, description, run(page, args) }`; `name` lower-case letters only, built-ins reserved; `args` is the rest of the line trimmed, `""` when none, may contain newlines. Result `{ kind: "show", text }` prints in the history; `{ kind: "send", prompt }` sends `prompt` as a turn while the history keeps the typed `/name` line. Runs on the chat page under the per-turn timeout, with the same timeout diagnosis as a turn. Interactive UIs only; queued like a message when the chat is busy; `/help` lists them after the built-ins. Unknown: `Unknown provider command "/<name>".` from core, `/<name> is not available in this session.` from the TUI when the session cannot run commands.

**Template on the page:**

```ts
commands: [
  {
    name: "model",
    description: "Show or switch the model picker",
    async run(page, args) {
      if (args === "") return { kind: "show", text: await page.locator("#model").innerText() };
      await page.selectOption("#model", args);
      return { kind: "show", text: `model: ${args}` };
    },
  },
],
```

**Recipe:** the `commands` array of the dummy provider verbatim (`title` → show, `shout` → send), with sections: What it does · The code · Register it (it is already registered in the example; show `defineProvider({ ..., commands })`) · Use it (`/title`, `/shout hello` → the service receives `HELLO`, the history shows `/shout hello`) · Verify (`bun run examples/dummy-chat/serve.ts &`, then `bun packages/cli/src/bin.ts --provider ./examples/dummy-chat/provider.ts`, type `/help`).

- [ ] **Step 1: Read the sources.**
- [ ] **Step 2: Write both pages.**
- [ ] **Step 3: Verify the recipe is identical to the example:**

```bash
diff <(sed -n '/^    commands: \[/,/^    \],/p' examples/dummy-chat/provider.ts) <(awk '/^```ts/{f=1;next}/^```/{f=0}f' docs/providers/recipes/commands/dummy-title-shout.md | sed -n '/^    commands: \[/,/^    \],/p') && echo identical
grep -n 'is not available in this session' packages/cli/src/tui/chat-model.ts | head -1
```

- [ ] **Step 4: Commit**

```bash
git add docs/providers/extension-points/commands.md docs/providers/recipes/commands
git commit -m "docs(providers): commands extension point and the dummy /title and /shout recipe (Refs #133)"
```

---

### Task 10: `extension-points/url-hooks.md` and the Jira recipe (Sonnet)

**Files:**
- Create: `docs/providers/extension-points/url-hooks.md` (from the scratchpad draft `drafts/README.md`, minus its "Recipes" list, which the index now carries), `docs/providers/recipes/url-hooks/jira-datacenter.md` (from `drafts/jira-datacenter.md`, its link to "the URL hooks index" repointed to `../../extension-points/url-hooks.md`)
- Sources: `packages/core/src/expand-url-hooks.ts`, `packages/core/src/attachment.ts`, `packages/provider/src/index.ts:68-85`, `packages/cli/src/tui/expand-input.ts`, `packages/vscode/src/session-controller.ts:288-345`

**Facts:** as in the draft: URL token `https?://\S+`, trailing `.,;:!?'"]>` trimmed, `)` kept while it balances a `(` in the URL; first matching hook wins; all URLs resolve in parallel; each under the per-turn timeout (`timed out after <ms> ms`); 200 KB per result (`<url>: <kb> KB exceeds 200 KB`), 1 MB per message including `@file` mentions; failures collected into one `UrlHookError`, nothing sent; prompt layout `### <label>` + fenced content; the history shows the label; scanned in the typed text only; interactive UIs only (TUI and VSCode); RegExp `match` without `g`/`y`. The dummy provider's hook (`match: (url) => url.startsWith(baseUrl)`) is the in-repo example; quote it.

- [ ] **Step 1: Copy the two drafts into place and repoint links.**
- [ ] **Step 2: Add the dummy hook as a second, verbatim example on the extension-point page.**
- [ ] **Step 3: Verify:**

```bash
for s in 'MAX_FILE_BYTES = 200 * 1024' 'MAX_TOTAL_BYTES = 1024 * 1024' 'timed out after' 'exceeds' ; do grep -rn --include=*.ts -F "$s" packages/core/src | grep -v test | head -1 || echo "MISSING: $s"; done
grep -c 'example.com' docs/providers/recipes/url-hooks/jira-datacenter.md
```

- [ ] **Step 4: Commit**

```bash
git add docs/providers/extension-points/url-hooks.md docs/providers/recipes/url-hooks
git commit -m "docs(providers): URL hooks extension point and the Jira Data Center recipe (Refs #133)"
```

---

### Task 11: `extension-points/streaming.md` and the streaming recipe (Sonnet)

**Files:**
- Create: `docs/providers/extension-points/streaming.md`, `docs/providers/recipes/streaming/dummy-response-text.md`
- Sources: `packages/provider/src/index.ts:87-97`, `packages/core/src/chat-session.ts:483-520` (pollPartial), `packages/cli/src/tui/chat-model.ts:640-665`, `packages/vscode/src/session-controller.ts:575-581`, `examples/dummy-chat/provider.ts:47-63`

**Facts:** `ProviderStreaming { responseText(page): Promise<string | undefined>; pollIntervalMs?: number }`; default 250 ms, must be finite and > 0; core polls only while `waitForResponse` is pending and only when the UI asked for partials; each tick sleeps then calls `responseText`; a throw skips the tick; `undefined`, non-strings and unchanged text are dropped; the UI receives the whole text so far, never a delta; nothing is emitted after `waitForResponse` settles; a hung `responseText` never delays the turn; completion, the final text and timeouts still come from `waitForResponse`. Text is in `responseFormat`. Must never return an earlier turn's text: the trap is the moment after submission when the last assistant bubble still belongs to the previous turn. One-shot mode never streams.

**Template on the page:** the minimal shape (`responseText` reading the last bubble, returning `undefined` until a new bubble exists).

**Recipe:** the dummy provider's `streaming` block verbatim with its three guards explained one by one (busy state, bubble exists, assistant count >= user count), then Verify: run the dummy chat and watch the reply grow in the TUI.

- [ ] **Step 1: Read the sources.**
- [ ] **Step 2: Write both pages.**
- [ ] **Step 3: Verify:**

```bash
diff <(sed -n '/^    streaming: {/,/^    },/p' examples/dummy-chat/provider.ts) <(awk '/^```ts/{f=1;next}/^```/{f=0}f' docs/providers/recipes/streaming/dummy-response-text.md | sed -n '/^    streaming: {/,/^    },/p') && echo identical
grep -n 'DEFAULT_POLL_INTERVAL_MS = 250' packages/core/src/chat-session.ts
```

- [ ] **Step 4: Commit**

```bash
git add docs/providers/extension-points/streaming.md docs/providers/recipes/streaming
git commit -m "docs(providers): streaming extension point and the dummy responseText recipe (Refs #133)"
```

---

### Task 12: `extension-points/conversation.md` and the conversation recipe (Sonnet)

**Files:**
- Create: `docs/providers/extension-points/conversation.md`, `docs/providers/recipes/conversation/dummy-url-conversation.md`
- Sources: `packages/provider/src/conversation.ts`, `packages/core/src/chat-session.ts:330-358, 391-417, 459-476`, `packages/core/src/conversation-note.ts`, `packages/cli/src/tui/chat-model.ts:950-1015`, `packages/vscode/src/session-controller.ts:730-762`, `examples/dummy-chat/provider.ts:65-66`, `examples/dummy-chat/server.ts:14, 247, 358`

**Facts:** `ProviderConversation { handle(page): Promise<string | undefined>; open(page, handle): Promise<void> }`; the handle is an opaque provider-owned string, stored in memory only, never on disk, must never embed a credential. `handle` runs after every turn with a 5 s budget; a non-empty string is kept. `open` runs on the chat page after the login check when a UI reopens with a handle (Ctrl+R, `/reopen`, the VSCode Reopen command, the reopen after an idle close); it should throw when it cannot open. Outcomes: restored (page origin equals `chatUrl`'s origin), failed (threw or wrong origin → `goto(chatUrl)` and `startNewChat`), timeout (browser replaced, new chat). Restore never fails the open; the UI shows `conversation restored` or `conversation could not be restored`. `/new` and `/logout` forget the handle. `urlConversation({ match })`: `handle` returns `page.url()` when `match` accepts it; `open` navigates and checks the URL still matches (`The handle is not a conversation URL.`, `The conversation did not open.`); `match` is tested against the whole URL including query and fragment, so avoid anchoring with `$` when those can appear; RegExp without `g`/`y`. Cross-process resume is not implemented (backlog #119).

**Recipe:** the dummy's one line `conversation: urlConversation({ match: /\/chat\/c\/[a-z0-9]{8}$/ })` with how the dummy server puts the id in the URL (`history.replaceState` to `/chat/c/<id>` after the first reply, `GET /chat/c/<id>` serves the earlier turns), then Verify: send one message, press Ctrl+R, see `reopened · conversation restored` and the earlier turn still on the page. Also show the by-hand `{ handle, open }` shape for a service whose id is not in the URL.

- [ ] **Step 1: Read the sources.**
- [ ] **Step 2: Write both pages.**
- [ ] **Step 3: Verify:**

```bash
grep -n 'urlConversation({ match: /\\/chat\\/c\\/\[a-z0-9\]{8}\$/ })' examples/dummy-chat/provider.ts docs/providers/recipes/conversation/dummy-url-conversation.md
for s in 'The handle is not a conversation URL.' 'The conversation did not open.' 'RESTORED_NOTE' 'HANDLE_BUDGET_MS'; do grep -rn --include=*.ts -F "$s" packages/provider/src packages/core/src | grep -v test | head -1 || echo "MISSING: $s"; done
```

- [ ] **Step 4: Commit**

```bash
git add docs/providers/extension-points/conversation.md docs/providers/recipes/conversation
git commit -m "docs(providers): conversation extension point and the dummy urlConversation recipe (Refs #133)"
```

---

### Task 13: `extension-points/detect-block.md` (Sonnet)

**Files:**
- Create: `docs/providers/extension-points/detect-block.md`
- Sources: `packages/provider/src/index.ts:122-127`, `packages/core/src/chat-session.ts:222-246`, `packages/core/src/errors.ts:54-61`, `packages/cli/src/exit-codes.ts`, `packages/vscode/src/create-extension.ts:203-206`, `examples/dummy-chat/provider.ts:68-74`

**Facts:** `detectBlock(page): Promise<string | undefined>`; called only after `isLoggedIn` returned false, at open and in the timeout diagnosis, never during login or close; must not throw on an ordinary logged-out page; a string becomes `BlockedError` `Blocked by "<name>": <description>.`, CLI exit 6 with ` Try --headful.`, VSCode remedy `Set the "<id>.headless" setting to false and try again.`; never retried by open retries. Template: the dummy's title check verbatim. Cross-link to auth-and-browser.md for the stance.

- [ ] **Step 1: Read the sources.**
- [ ] **Step 2: Write the page.**
- [ ] **Step 3: Verify:**

```bash
diff <(sed -n '/^    async detectBlock/,/^    },/p' examples/dummy-chat/provider.ts) <(awk '/^```ts/{f=1;next}/^```/{f=0}f' docs/providers/extension-points/detect-block.md | sed -n '/^    async detectBlock/,/^    },/p') && echo identical
```

- [ ] **Step 4: Commit**

```bash
git add docs/providers/extension-points/detect-block.md
git commit -m "docs(providers): detectBlock extension point (Refs #133)"
```

---

### Task 14: `extension-points/open-browser-idle.md` (Sonnet)

**Files:**
- Create: `docs/providers/extension-points/open-browser-idle.md`
- Sources: `packages/provider/src/index.ts:7-33`, `packages/core/src/chat-session.ts:179-220, 258-313`, `packages/core/src/idle-watch.ts`, `packages/cli/src/open-options.ts`, `packages/cli/src/idle-options.ts`, `packages/runtime/src/browser-runtime.ts:44-52`, `docs/spike-notes/2026-09-20-idle-browser-cpu.md`

**Facts:** `open?: { timeoutMs?, retries? }` (built-in 120 000 / 0; per-step timeout of goto, isLoggedIn, startNewChat; retries re-run the whole phase after a launch or navigation failure, closing the browser between; users override via config `open` and `CHATBRIDGE_OPEN_*` in the CLI, and only via `<id>.timeoutSec` in VSCode). `browser?: { reducedMotion? }` (`reduce` default, `no-preference` opt-out, no user override, applies to every context including login). `idle?: { timeoutMs? }` (built-in 86 400 000, 0 disables; the watch ticks every 30 s on the wall clock so sleep counts, pauses during a turn or command; on expiry the UI is told, `Closing the browser after <24 h|N min> idle...`, then close-or-kill with a 5 s budget, auth state saved when logged in; users override via config `idle.timeoutMin`, `CHATBRIDGE_IDLE_TIMEOUT`, `<id>.idleTimeoutMinutes`; one-shot forces 0). Template: the three fields in one `defineProvider` call. Pointer to `../../users/configuration.md` for the user-side precedence.

- [ ] **Step 1: Read the sources.**
- [ ] **Step 2: Write the page.**
- [ ] **Step 3: Verify:**

```bash
for s in 'tickMs' 'IDLE_CLOSE_BUDGET_MS' 'Closing the browser after' 'reducedMotion: opts.provider.browser?.reducedMotion ?? "reduce"'; do grep -rn --include=*.ts -F "$s" packages/core/src packages/runtime/src | grep -v test | head -1 || echo "MISSING: $s"; done
```

- [ ] **Step 4: Commit**

```bash
git add docs/providers/extension-points/open-browser-idle.md
git commit -m "docs(providers): open, browser and idle provider defaults (Refs #133)"
```

---

### Task 15: `contributing/packages.md` and `contributing/testing.md` (Sonnet)

**Files:**
- Create: `docs/contributing/packages.md`, `docs/contributing/testing.md`
- Sources: `package.json` (scripts), `packages/*/package.json` (dependencies, exports, bin), `packages/*/src/index.ts`, `.github/workflows/ci.yml`, `CLAUDE.md` "Current state", memory note that the VSCode E2E is outside `bun run check`, `examples/*/package.json`

**Facts for packages.md:** five packages, direction `cli → core → runtime → provider` and `vscode → core`, never reverse; `provider` (types, `defineProvider`, `urlConversation`, `elementToMarkdown`, `BUILTIN_COMMAND_NAMES`; peer `playwright-core >=1.48 <2`; ships the two skills), `runtime` (`AuthStore`, `BrowserRuntime`, `validateProviderName`, browser-executable helpers; depends on `playwright`), `core` (errors, `runLogin`, `runOneShot`, `ChatSession`, idle watch, slash-command table, attachment helpers, URL-hook expansion, `closeOrKill`; subpath `./slash-commands`), `cli` (`createCli`, config loading, TUI under `src/tui/` with `@opentui/core` loaded lazily, bundled tree-sitter grammars in `assets/`; bin `chatbridge`), `vscode` (`createExtension`, `SessionController`, protocol, webview built by `build:webview`). Examples: `examples/dummy-chat` (server + reference provider, exercises every extension point), `examples/vscode-dummy-chat` (reference extension and manifest). `dist/` is what tests import across packages, so `bun run build` after editing another package.

**Facts for testing.md:** `bun run check` = `biome check .` + `tsc --build` + webview build + `bun test`; required before every commit; `bun test packages/<name>` for one package; Playwright Chromium install command; E2E tests (`*.e2e.test.ts`) run real Chromium under Bun in `runtime`, `core` and `cli`; `bun run e2e:vscode` runs the real-VS-Code suite under `examples/vscode-dummy-chat` and is **not** part of `check`; CI runs check on every push and the VSCode suite under `xvfb-run` when extension files changed; interactive TUI needs Bun >= 1.3 or Node >= 26.4 to run by hand; TDD is the house rule.

- [ ] **Step 1: Read the sources (verify every export name against `src/index.ts`).**
- [ ] **Step 2: Write both pages.**
- [ ] **Step 3: Verify:**

```bash
grep -n '"e2e:vscode"\|"check"' package.json
grep -n 'urlConversation\|elementToMarkdown\|defineProvider' packages/provider/src/index.ts | head -3
grep -n './slash-commands' packages/core/package.json
```

- [ ] **Step 4: Commit**

```bash
git add docs/contributing/packages.md docs/contributing/testing.md
git commit -m "docs(contributing): packages and testing pages (Refs #133)"
```

---

### Task 16: Root README as a front page, package READMEs as pointers (Opus)

**Files:**
- Modify: `README.md`, `packages/cli/README.md`, `packages/core/README.md`, `packages/runtime/README.md`, `packages/provider/README.md`, `packages/vscode/README.md`

**Root README keeps**, in this order: title and one-paragraph description (existing first two paragraphs); Concept (existing diagram and sentence); Quick start (existing block, unchanged); Install (only the two `npm install` lines and the sentence about `--provider` / `defaultProvider` with a link to `docs/users/configuration.md`); a new "Documentation" section:

```markdown
## Documentation

- [Using the CLI, the terminal chat and the VSCode extension](docs/users/README.md)
- [Writing a Provider](docs/providers/README.md)
- [Contributing](docs/contributing/README.md)
- [Roadmap](docs/ROADMAP.md)
```

then License (unchanged). Everything else is deleted: Status, Planned features, the rest of Install, Interactive mode, VSCode extension, Long-running sessions, Authentication, Scope, Provider extension points, Upgrading to 0.10. Before deleting, confirm each deleted fact appears in a guide page (Tasks 2-14); the checklist is the section list above mapped in the spec's "Root README and package READMEs".

**Package READMEs**, each: heading, one sentence on the role, an install line, then "Documentation" with absolute links `https://github.com/7milch/chatbridge-cli/blob/main/docs/...` to the pages that cover it:

- `cli`: users/cli.md, users/configuration.md, users/interactive-mode.md, providers/define-provider.md. Keep the "Bundled grammars" section (licence attribution must stay in the package).
- `core`: contributing/packages.md, providers/contract.md.
- `runtime`: contributing/packages.md, providers/auth-and-browser.md.
- `provider`: providers/README.md, providers/contract.md, providers/extension-points/README.md. Keep the "Skills for coding agents" section.
- `vscode`: users/vscode.md, providers/define-provider.md. Keep the "License" section.

- [ ] **Step 1: Rewrite `README.md` per the list above.**
- [ ] **Step 2: Rewrite the five package READMEs.**
- [ ] **Step 3: Verify no README fact was lost:**

```bash
for s in 'CHATBRIDGE_OPEN_TIMEOUT' 'reducedMotion' 'idleTimeoutMinutes' 'detectBlock' 'urlConversation' 'onIdleExpired' 'Ctrl+J'; do grep -rl -F "$s" docs/users docs/providers >/dev/null || echo "LOST: $s"; done
grep -c '^## ' README.md   # expect 5: Concept, Quick start, Install, Documentation, License
bun run check 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add README.md packages/*/README.md
git commit -m "docs: README becomes a front page, package READMEs point at the guide (Refs #133)"
```

---

### Task 17: Review rule in CLAUDE.md and the skill pointer (Sonnet)

**Files:**
- Modify: `CLAUDE.md` ("Pull requests" list), `packages/provider/skills/upgrading-provider-repo/upgrade-guide.md` (no new entry: nothing vendor-visible changed; confirm and leave it)

- [ ] **Step 1: Add one bullet to "Pull requests" in `CLAUDE.md`, after the upgrade-guide bullet:**

```markdown
- A PR that changes what a user sees — a CLI command or flag, a `config.json`
  key, an environment variable, a built-in interactive command, a VSCode
  command or setting — updates the matching page under `docs/users/` in the
  same PR. A PR that changes what a vendor sees updates `docs/providers/` in
  the same PR as well as the upgrade guide. The whole-branch review checks
  both.
```

- [ ] **Step 2: Update the "Specs live in" paragraph of `CLAUDE.md` "Current state" to also say the reference guide lives under `docs/users/`, `docs/providers/`, `docs/contributing/` with an index in each.**
- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: review rule keeps the reference guide current (Refs #133)"
```

---

### Task 18: Link check and whole-branch review (Fable)

- [ ] **Step 1: Every relative link in `docs/` resolves:**

```bash
cd docs && grep -rhoE '\]\(([^)#]+)' --include=*.md . | sed 's/](//' | sort -u | while read l; do [ -e "$l" ] || [ -e "users/$l" ] || [ -e "providers/$l" ] || echo "check: $l"; done
```
Run it per directory (cd into each) so relative links resolve from the right base; fix any miss.

- [ ] **Step 2: Every directory under `docs/` created by this plan has a `README.md` and every page in the directory is listed in it:**

```bash
for d in docs/users docs/providers docs/providers/extension-points docs/providers/recipes docs/contributing; do for f in $d/*.md; do b=$(basename $f); [ $b = README.md ] || grep -q "($b)" $d/README.md || echo "unlisted: $f"; done; done
for d in docs/providers/recipes/*/; do for f in $d*.md; do grep -q "($(basename $d)/$(basename $f))" docs/providers/recipes/README.md || echo "unlisted: $f"; done; done
```

- [ ] **Step 3: `bun run check` passes. Open the PR** with title `Reference guide under docs/: users, providers, contributing` and label `documentation`; body `Closes #133`. Whole-branch review per CLAUDE.md, then squash-merge on the user's call; afterwards append `### 24. Reference guide — done (issue #133, PR #<p>, <date>)` to `docs/ROADMAP.md` and close the milestone.
