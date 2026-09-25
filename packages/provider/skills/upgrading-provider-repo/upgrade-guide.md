# Upgrade guide

One entry per released `@chatbridge/*` version that changed anything a vendor
repository sees, newest first.

## How to read it

1. Read the old pin: the `@chatbridge/cli` version in `package.json` **before**
   this bump. Read the target: the version you bumped to.
2. Apply every entry **above** the old pin, up to and including the target,
   **oldest first** — so read bottom-up from the entry just above the old pin.
3. **Required** steps are not optional: skipping one breaks the provider at
   runtime or logs a warning at startup. Do them without asking.
4. **Optional** steps are features the provider does not have yet. List them to
   the user, with one line each, and do the ones they pick. Do not adopt one
   because a release note sounds attractive; only this file says what to change.
5. **VSCode manifest** applies only when the repository has a `vscode/`
   directory. `none.` means nothing to do there.
6. Run each `Verify:` line before moving on. Commits: an entry's **Required**
   steps (with its VSCode manifest change) share one commit; every adopted
   **Optional** feature gets its own, because each has its own `Verify:`.

Paths written as `../creating-provider-repo/…` are in the sibling skill
directory; the two skills are always copied together.

`<VENDOR>` in a command is this repository's own env-var prefix, not a literal.
Read it off the existing gate in `src/provider.e2e.test.ts`
(`process.env["…_E2E"]`); if there is no E2E file yet, use the upper-cased,
`-`-to-`_` form of the CLI name passed to `createCli` in `src/bin.ts`, and
record it in the repository's `CLAUDE.md`.

## Before an entry that needs DOM observation

An entry marked `Needs DOM observation: yes` starts from an **open, logged-in
chat page in the `playwright` MCP server**. Produce it once per session, in
this order, before the step the entry names:

1. **MCP servers.** In every case, first make sure `.gitignore` lists `.auth/`
   and `.playwright-mcp/`, and that the repository's own `biome.json` (or other
   formatter config) ignores `.auth` and `.playwright-mcp` as
   `../creating-provider-repo/templates/biome.json` does: `.auth/mcp-profile`
   is a live browser profile, and a `--write` run over it corrupts it. Then, if
   the repository has no `.mcp.json`, copy
   `../creating-provider-repo/templates/mcp.json` to `.mcp.json` and ask the user to restart Claude
   Code (or run `/mcp` and reconnect) so the two Playwright servers load.
   Nothing below works until they have. Then follow the "Set up" section of
   `../creating-provider-repo/dom-discovery.md`, including its
   `() => typeof window.__cbProbe` check, which must return `"object"`.
2. **Entry URL.** Use the constant your `navigateToLogin` passes to
   `page.goto` (the template calls it `ENTRY_URL`) — it is already there.
   `../creating-provider-repo/dom-discovery.md` step 1 only applies when the
   repository has no such constant yet.
3. **A logged-in page.** Run `../creating-provider-repo/dom-discovery.md`
   step 3: `browser_navigate` the `playwright` server to the entry URL, then
   ask the human to log in by hand in that window and wait for their reply.
   Never poll, click or fill anything in the login flow. The profile is
   persistent, so this is once per machine, not once per entry. If the CLI has
   already been through `auth login`, the "Alternative: an already logged-in
   CLI" note in that file's Set up section starts the server from the saved
   state instead.

`../creating-provider-repo/dom-discovery.md` steps 2, 4 and 8 — the logged-out
census, the logged-in census and the new-chat discovery — are **not** needed
when upgrading. They exist to find selectors from scratch; run one only when
the constant an entry builds on is missing or came back stale, or for
"Re-derive the login signal" below.

After adopting the constant an entry adds, confirm it with
`../creating-provider-repo/dom-discovery.md` step 9 on the logged-in chat page
with at least one completed turn. For `ASSISTANT_MESSAGE_BODY` that is the
`within` form, and only that form:

```json
{ "function": "() => window.__cbProbe.verify({ ASSISTANT_MESSAGE: { selector: '<your ASSISTANT_MESSAGE>', many: true }, ASSISTANT_MESSAGE_BODY: { selector: '<your ASSISTANT_MESSAGE_BODY>', within: '<your ASSISTANT_MESSAGE>' } })" }
```

`ok: true` on both is the pass. `error: "within matched nothing: …"` means
`ASSISTANT_MESSAGE` is wrong, not the body selector.

## If your repository predates the templates

An older vendor repository has its own selector names, may have no `MANY`
array in `src/selectors.ts`, and a `docs/dom-notes.md` that is prose rather
than the eight-section table format. Map this guide onto it by role, not by
name:

- When an entry names a constant such as `ASSISTANT_MESSAGE_BODY`, find the
  constant your `src/provider.ts` already uses in the same place — the one
  passed to the locator call the entry describes — and keep your own name. Add
  a new constant only when no constant plays that role yet; then use the
  template's name, so the next entry reads literally.
- When an entry names the `MANY` array and `src/selectors.ts` has none, add it
  exactly as in `../creating-provider-repo/templates/src/selectors.ts`, listing
  the collection selectors your file already has —
  `ASSISTANT_MESSAGE_BODY` is **not** one of them; it is verified with `within`
  instead. `MANY` is only read by the probe's `verify()`; it changes no runtime
  behaviour.
- When an entry says to add a test "verbatim from the template" and there is no
  `src/provider.e2e.test.ts` at all, copy the whole template file
  `../creating-provider-repo/templates/src/provider.e2e.test.ts` and replace
  its placeholders: `<vendor>` in `createAuthStore({ configDir: "<vendor>" })`
  becomes the `configDir` — or, when `configDir` is not passed, the `name` —
  given to `createCli` in `src/bin.ts`, and `<VENDOR>` in
  `const GATE = "<VENDOR>_E2E"` becomes this repository's env-var prefix. The
  `<vendor> real service` describe title is cosmetic; use the CLI name.
- When `src/provider.e2e.test.ts` exists with a harness of its own, do **not**
  copy the template file over it. Copy only the test bodies. In each template
  test, these lines are harness and must be replaced by your file's equivalents:
  the `import` lines, the `createAuthStore({…})` call, the `const enabled = …`
  gate, the `describe.skipIf(!enabled)` wrapper, the
  `await ChatSession.open({ provider, authStore, headless: true, timeoutMs: 120_000 })`
  call and the `finally { await session.close(); }` block. Everything between
  them is the test: the `MARKDOWN_SAMPLE` constant, the `session.send(…)` calls
  including the `{ onPartial }` option, and every `expect(…)`. Copy those
  unchanged — the assertions are structural and do not mention any service.
- When the harness has no `ChatSession` at all and calls the provider's
  methods on a page directly, `session.send(prompt)` reads as
  `await provider.sendMessage(page, prompt)` then
  `await provider.waitForResponse(page)`. The streaming test then has no
  `onPartial`: between those two calls start
  `setInterval(() => void provider.streaming?.responseText(page).then((t) => { if (t) partials.push(t); }).catch(() => {}), 250)`,
  clear it once `waitForResponse` has resolved, and keep the template's three
  assertions — the second answer differs from the first, at least one partial
  was seen, no partial equals the first answer.
- When an entry says "record it in dom-notes §X" and your `docs/dom-notes.md`
  has no such section, append a section with that heading in the format of
  `../creating-provider-repo/templates/docs/dom-notes.md`. A selector with no
  dom-notes entry is a bug.
- Before adopting an entry that needs DOM observation, re-check the selectors
  you already have: run `../creating-provider-repo/dom-discovery.md` step 9
  (`verify()`) against the current `src/selectors.ts`. A constant that comes
  back `count: 0` is stale and must be re-observed before you build on it. The
  stop-button constant is not part of that call — it exists too briefly; the
  `buttonsSwapped` rows of `../creating-provider-repo/dom-discovery.md` step 5
  re-derive it.

### Re-derive the login signal

Optional, for any version: a repository that predates the templates often
treats "a composer is visible" or a URL as logged in, which is true for guests
too.

Needs DOM observation: yes. `.mcp.json` must define the `playwright-guest`
server (copy it from `../creating-provider-repo/templates/mcp.json`). Run
`../creating-provider-repo/dom-discovery.md` steps 2, 3 and 4: the login signal
is the difference between the chat URL seen as a guest and as a member.

Change: `src/selectors.ts` gets the sign-in and account constants; `isLoggedIn`
becomes the template's — off the chat origin → `false`; one bounded wait for
the sign-in **or** the account control to be visible; `true` only when the
account control is present **and** the sign-in control absent; any error →
`false`. Compare with `../creating-provider-repo/templates/src/provider.ts`
line by line, and add the "a guest is not logged in" test from
`../creating-provider-repo/templates/src/provider.e2e.test.ts`. Record both
constants in `docs/dom-notes.md` §Login.

Verify: `<VENDOR>_E2E=1 bun test src/provider.e2e.test.ts` — "a guest is not
logged in" passes: a fresh browser context on the chat URL reads as logged
out, while the two-turn test still reads the saved state as logged in.

## 0.12.0

**Required:** none. VSCode only: the chat composer shows the active editor's
file as a dashed `+ <name>` chip in the attachment row, and one click attaches
it through the same path as a drop or the `+` picker. Nothing a vendor
repository built on `createExtension` sees changes.

**Optional:** a repository that supplies its own `VscodeUi` (rather than the
`createVscodeUi` the framework wires in) may implement the new optional
`onDidChangeActiveEditor(listener)` method to get the tip; without it the
composer shows no tip and everything else is unchanged. The listener takes an
`ActiveFile | undefined` (`{ uri, path, name }`, `file:` URIs only) and is
called once on subscribe.

**VSCode manifest:** none.

## 0.11.3

**Required:** none. TUI-only: `@chatbridge/cli` now ships tree-sitter grammars
for Python, Ruby, JSON, Bash and Go, so those fenced blocks get per-token
colours in the interactive TUI; the package grows by about 4 MB unpacked
(528 KB in the tarball). Nothing a vendor repository sees changes.

**Optional:** none.

**VSCode manifest:** none.

## 0.11.2

**Required:** none. One TUI-only change: a fenced code block in a Markdown reply
gets a muted left-border frame once the reply settles, and JavaScript /
TypeScript blocks get per-token colours. Nothing a vendor repository sees
changes.

**Optional:** none.

**VSCode manifest:** none.

## 0.11.1

**Required:** none. Two fixes with no vendor-facing change: `elementToMarkdown`
no longer doubles KaTeX math (it skips MathML `<annotation>`), and the TUI
styles Markdown headings and fenced code again.

**Optional:** none.

**VSCode manifest:** none.

## 0.11.0

**Required:** none.

**Optional:**

### Conversation handle

Needs DOM observation: yes.

Change: when the service puts the conversation id in the page URL, add to
`src/provider.ts` a top-level `conversation: urlConversation({ match })`, with
`urlConversation` imported from `@chatbridge/provider` and `match` a RegExp
(no `g` or `y` flag) that accepts a conversation URL and rejects the plain chat
page. Observe the URL after the first reply of a new chat to write it, and note
it in `docs/dom-notes.md`. `match` is tested against the full `page.url()`,
including any query string or fragment; if conversation URLs can carry one, do
not anchor with `$` — use e.g. `/\/c\/[0-9a-f-]+(?:[/?#]|$)/`. If the separator
stays a plain `reopened` after two turns, `match` never matched. The interactive
UIs then return to the same
conversation after `/reopen` and after an idle close; `/new` still starts a
fresh one. When the id is not in the URL, implement
`conversation: { handle(page), open(page, handle) }` by hand: `handle` returns a
string naming the conversation or `undefined` before the first turn, and `open`
throws when it cannot show that conversation.

Verify: `bun run check`, then interactively send two turns, type `/reopen`, and
ask something that depends on the earlier turns — the answer is in context and
the separator reads `reopened · conversation restored`.

### Markdown and streaming in the VSCode view

Needs DOM observation: no.

Change: nothing in `src/provider.ts`. Bump `@chatbridge/vscode` in `vscode/`
and rebuild so `dist/webview` is copied again. The view renders replies as
Markdown when the provider has `responseFormat: "markdown"` and shows them while
they are written when it has `streaming`.

Verify: build and launch the extension, send a prompt whose reply has a list and
a code block — the reply grows while it is written and ends formatted, and the
code block's Copy button works.

**VSCode manifest:** none.

## 0.10.1

**Required:** none. No runtime code changed; 0.10.1 only adds the skills to the
`@chatbridge/provider` package.

**Optional:**

### Provider skills in the package
Needs DOM observation: no.
Change:
1. Copy the skills from the package (the refresh that `SKILL.md` asks for after
   every bump; from this version on `node_modules/@chatbridge/provider/skills/`
   exists):
   `mkdir -p .claude/skills && rm -rf .claude/skills/creating-provider-repo .claude/skills/upgrading-provider-repo && cp -R node_modules/@chatbridge/provider/skills/. .claude/skills/`
2. If `.mcp.json` is missing, copy
   `../creating-provider-repo/templates/mcp.json` to `.mcp.json`. Add `.auth/`
   and `.playwright-mcp/` to `.gitignore`, and `.auth`, `.playwright-mcp` to
   the ignore list of `biome.json`: a formatter must never write into `.auth/`,
   a live browser profile.
3. If this repository predates the templates, read "If your repository
   predates the templates" above and offer "Re-derive the login signal" to the
   user.
Verify: `ls .claude/skills/creating-provider-repo/probes/chatbridge-probes.js .claude/skills/upgrading-provider-repo/upgrade-guide.md`
prints both paths, and `bun run check` passes.

**VSCode manifest:** none.

## 0.10.0

**Required:**

1. `src/provider.ts`: if `commands` contains one named `copy`, rename it.
   `copy` became a built-in command name and `defineProvider()` now throws on
   it, so the CLI fails at import time.
2. If — and only if — the repository calls `ChatSession.open` directly and
   passes `onIdleExpired`, its argument is now `(closing: Promise<void>) => void`.
   Await `closing` with a cap at teardown so the process does not exit while
   the idle close is still saving the auth state. A repository that only calls
   `createCli` / `createExtension` has nothing to do.

**Optional:**

### Markdown replies

Needs DOM observation: yes. First do "Before an entry that needs DOM
observation" above, which leaves an open, logged-in chat page. Then run
`../creating-provider-repo/dom-discovery.md` step 5 (record a streaming turn:
send a prompt whose reply takes a few seconds), and on the same page
`../creating-provider-repo/dom-discovery.md` step 6 (`replyShape()`), which
yields `contentRootWithin`, `chromeInsideContent` and `codeLanguage`.

Change:

1. `src/selectors.ts`: add `ASSISTANT_MESSAGE_BODY` —
   `replyShape().contentRootWithin`, as printed; it is already relative to one
   assistant turn. Never copy `contentRoot` instead: it can be anchored above
   the turn and then matches the first turn only. Do **not** add it to `MANY`:
   it is verified with `{ selector, within: <ASSISTANT_MESSAGE> }`. Compare
   with `../creating-provider-repo/templates/src/selectors.ts`. Record it in
   `docs/dom-notes.md` §Messages, and record `contentRootWithin`,
   `codeLanguage` and `chromeInsideContent` in §Streaming behaviour. Then run
   the `within` `verify()` call from "Before an entry that needs DOM
   observation" before writing any code against it.
2. `src/provider.ts`: add the top-level field `responseFormat: "markdown"`, and
   import `elementToMarkdown` from `@chatbridge/provider` alongside
   `defineProvider`. Add the `newestBody(page)` helper from
   `../creating-provider-repo/templates/src/provider.ts` — the
   `page.locator(ASSISTANT_MESSAGE).last().locator(ASSISTANT_MESSAGE_BODY).first()`
   chain, written with your file's import style: the template imports the
   selectors as a namespace and so writes `S.ASSISTANT_MESSAGE` and
   `S.ASSISTANT_MESSAGE_BODY`; keep named imports if that is what your file
   uses — and in `waitForResponse` replace every `innerText()` /
   `textContent()` read of the reply with `await elementToMarkdown(newestBody(page))`,
   including the two reads of the stability loop. Change nothing else: keep the
   done-signal → count-exceeds-`countBefore` → stability order, and keep every
   wait bounded by an explicit `timeout`. Compare the finished method against
   the template's line by line.
3. `src/provider.test.ts`: assert `provider.responseFormat === "markdown"`.
4. `src/provider.e2e.test.ts`: add the "Markdown fidelity" test verbatim from
   `../creating-provider-repo/templates/src/provider.e2e.test.ts`, including its
   `MARKDOWN_SAMPLE` constant.

Pitfalls, all three seen in real adoptions:

- Point `elementToMarkdown` at the content root, never at the whole turn
  element. Copy buttons, code-block headers and citation chrome sit inside the
  turn and leak into the Markdown as stray lines.
- When `replyShape().codeLanguage` is `"header-label"`, the language label of a
  code block still leaks as one stray line above the fence, because the label
  is text rather than a class. This is a known framework limitation: record it
  in `docs/dom-notes.md` §Streaming behaviour and leave it. Never post-process
  the Markdown in the provider.
- `contentRootWithin: ""` means the turn element *is* the content: set
  `ASSISTANT_MESSAGE_BODY` to `ASSISTANT_MESSAGE`'s own value and take the
  `newestBody` VARIANT in the template, which drops the second `.locator()`
  call. `contentRoot: null` means the reply had no block-level content yet —
  re-run `replyShape()` on a completed reply rather than guessing a selector.

Verify: `<VENDOR>_E2E=1 bun test src/provider.e2e.test.ts` with a saved auth
state — the "Markdown fidelity" test passes, meaning the reply carries a
heading line, an indented nested list item, a ` ```ts ` fence, a `|---|` table
row, `**bold**` and a link. Then `bun run check`. One manual look, which no
test replaces: run the CLI interactively and ask for a bulleted list and a code
block — the history must render them as a formatted list and a highlighted
code block, not as literal `-` and backticks.

### Streaming

Needs DOM observation: yes. First do "Before an entry that needs DOM
observation" above. Then run `../creating-provider-repo/dom-discovery.md`
step 5, whose `recordTurn.stop()` summary gives `streamingElement` and
`streamingCollection`, and on the same page
`../creating-provider-repo/dom-discovery.md` step 7 (a second turn), which
confirms how a new reply is told apart from the previous turn's. When this
entry follows Markdown replies in the same session,
`../creating-provider-repo/dom-discovery.md` step 5 has already been run and
its recording still answers both. No new selector is needed when
Markdown replies were adopted first: streaming reuses `ASSISTANT_MESSAGE` and
`ASSISTANT_MESSAGE_BODY`. If `textGrowth` is `[]` there is no streaming element
at all and this feature does not apply to the service — record that in
`docs/dom-notes.md` §Streaming behaviour and stop.

Change:

1. `src/provider.ts`: this feature needs the pre-send assistant-turn count. If
   `sendMessage` does not already record one, add the module-level
   `const countBefore = new WeakMap<Page, number>();` and the
   `countBefore.set(page, await page.locator(ASSISTANT_MESSAGE).count())` line
   as the **first** statement of `sendMessage`, both from
   `../creating-provider-repo/templates/src/provider.ts` (which also declares
   `import type { Locator, Page } from "playwright-core"`). Then make
   `waitForResponse` recognise the new turn by that count and nothing else:
   `const before = countBefore.get(page) ?? 0;` as its first line, and a
   `page.waitForFunction` that compares
   `document.querySelectorAll(selector).length > count` against `before`, placed
   **after** the done-signal wait. Replace whatever your `waitForResponse` used
   to recognise the new turn with that. Separately, and unchanged by this
   feature: every wait in `waitForResponse` carries an explicit `timeout`, and
   the template's `const deadline = …` bounds the stability loop only — it is
   set at the top so the whole method shares one budget, as the template's
   comment explains.
2. `src/provider.ts`: add the `streaming: { async responseText(page) { … } }`
   field from `../creating-provider-repo/templates/src/provider.ts`. It must, in
   this order: read `countBefore.get(page) ?? 0`; return `undefined` while
   `await page.locator(ASSISTANT_MESSAGE).count()` is `<=` that number; return
   `undefined` while `newestBody(page).count()` is `0`; otherwise return
   `await elementToMarkdown(newestBody(page))`, mapping `""` to `undefined`.
   `pollIntervalMs` is optional and defaults to 250 ms; leave it out.
3. `src/provider.e2e.test.ts`: add the "streaming never shows the previous
   turn" test verbatim from the template.

Pitfalls:

- The count guard is the whole point. Without it, `responseText` returns the
  **previous** turn's text for the first seconds of every turn, and the user
  watches the last answer replayed. `responseText` is polled while
  `waitForResponse` is still pending, so the new turn genuinely does not exist
  yet at the first polls.
- `responseText` runs on the live page several times a second. Keep it to the
  counts and the one read above; never add a wait, a `waitFor` or a navigation
  to it.
- Adopting streaming changes nothing in `waitForResponse`. The done-signal →
  count → stability order still decides the final answer.

Verify: `<VENDOR>_E2E=1 bun test src/provider.e2e.test.ts` — the "streaming
never shows the previous turn" test passes, meaning at least one partial was
delivered and no partial equalled the previous turn's answer. Then
`bun run check`. Manual look: in interactive mode a long reply grows in place
while it is written.

**VSCode manifest:** none. The VSCode view gained `/copy` only; it does not
stream or render Markdown in this version, and no `contributes` entry changed.

## 0.9.1

**Required:** none. An extension built for 0.9.0 keeps activating; it logs a
one-time warning naming the manifest entries it is missing.

**Optional:**

### Idle browser timeout

Needs DOM observation: no.

Change: `src/provider.ts` may set a top-level `idle: { timeoutMs }` to change
the framework default of 24 h for this service (`0` disables it). Only set it
when the service's sessions expire sooner or later than that; the user can
already override it with `idle.timeoutMin` in `config.json` and
`CHATBRIDGE_IDLE_TIMEOUT`. An idle interactive session closes its browser and
reopens it on the next prompt, as a new chat on the service side; one-shot
mode (`-p`) is unaffected.

Verify: `bun run check`, then interactively set `CHATBRIDGE_IDLE_TIMEOUT=1`,
send one turn, wait a minute and send another — the second turn answers, in a
fresh chat.

### Reduced motion

Needs DOM observation: no, unless the check below fails.

Change: every browser context now asks for `prefers-reduced-motion: reduce`,
which stops an idle headless page burning CPU on animations. Do nothing if the
service behaves. Only if this bump made turns hang or a control stop appearing,
set `browser: { reducedMotion: "no-preference" }` in `src/provider.ts` and note
the reason in `docs/dom-notes.md` §Generation indicator. The better fix is a
`waitForResponse` written against DOM state rather than an animation.

Verify: `<VENDOR>_E2E=1 bun test src/provider.e2e.test.ts` — the two-turn test
still passes.

**VSCode manifest:** update `vscode/package.json` from
`../creating-provider-repo/templates/vscode/package.json`, replacing
`<vendor>` / `<Vendor>` as you copy:

1. Add the `<vendor>.help` command (title `Help`).
2. Give `<vendor>.newChat` the icon `$(add)` and `<vendor>.reopen` the icon
   `$(refresh)`.
3. Add the six `view/title` menu entries, all with `"when": "view == <vendor>.chat"`:
   `newChat` in `navigation@1`, `reopen` in `navigation@2`, `login` in
   `1_auth@1`, `logout` in `1_auth@2`, `installBrowser` in `2_setup@1`,
   `help` in `3_help@1`. The first two become title-bar icons; the rest go to
   the overflow menu.
4. Add the `<vendor>.idleTimeoutMinutes` configuration property, `type:
   "number"`, and make sure `<vendor>.timeoutSec` is there too. Neither may
   have a `default`: a declared default silently overrides the provider's own
   value. State the fallback in the `description`, as the template does.

Verify: reload the extension (F5 in VSCode) — the chat view's title bar shows
the New Chat and Reopen icons, its overflow menu lists Log in, Log out, Install
Browser and Help, and no "missing contributions" warning appears in the
extension host log.

## 0.9.0

**Required:** none.

**Optional:**

### Slash commands

Needs DOM observation: no.

Change: `src/provider.ts` may add a top-level `commands` array of
`{ name, description, run(page, args) }`. `run` returns
`{ kind: "show", text }` to print text locally or `{ kind: "send", prompt }` to
send a prompt as a turn. Names are lower-case and must not collide with a
built-in (`copy` among them from 0.10.0). Commands run in the TUI and in
VSCode only, never in one-shot mode. Add a smoke test in `src/provider.test.ts`
asserting each command's `name` and `description`.

Verify: `bun run check`, then interactively type `/` — the completion list
includes the new commands — and run each one.

### URL hooks

Needs DOM observation: no.

Change: `src/provider.ts` may add a top-level `urlHooks` array of
`{ match, resolve(url) => { label, content } }`. Fetching is the provider's
own business; the framework appends `content` as an attachment, under the
session timeout and the `MAX_*_BYTES` caps, after trimming trailing prose
punctuation from the matched URL. Never put credentials in `resolve`; it uses
the same auth state as the session.

Verify: `bun run check`, then interactively paste a matching URL into a prompt
— the composer shows the attachment with your `label` and the turn succeeds.

**VSCode manifest:** none.

Older than 0.9.0: do not walk older entries. Re-scaffold the repository from
`../creating-provider-repo/templates/` following the creating-provider-repo
skill, and carry `src/selectors.ts` and `docs/dom-notes.md` over unchanged.
That also brings the pre-0.9.0 vendor-facing additions in one step:
`createExtension({ ui })` (0.8.0), the VSCode `<id>.reopen` command and its
`ctrl+r` / `cmd+r` keybinding (0.8.1), the `createCli({ banner })` object form
with `colors` / `mode` / `direction` and `createCli({ spinner })` (0.8.2), and
`createCli({ shell })` for `!` shell mode (0.7.0).
