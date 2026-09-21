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
6. Run each entry's `Verify:` line before moving to the next entry, and commit
   per entry.

Paths written as `../creating-provider-repo/…` are in the sibling skill
directory; the two skills are always copied together.

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
- When an entry says "add it to `MANY`" and `src/selectors.ts` has no `MANY`
  array, add the array exactly as in
  `../creating-provider-repo/templates/src/selectors.ts` with the collection
  selectors your file already has. `MANY` is only read by the probe's
  `verify()`; it changes no runtime behaviour.
- When an entry says "record it in dom-notes §X" and your `docs/dom-notes.md`
  has no such section, append a section with that heading in the format of
  `../creating-provider-repo/templates/docs/dom-notes.md`. A selector with no
  dom-notes entry is a bug.
- Before adopting an entry that needs DOM observation, re-check the selectors
  you already have: run `../creating-provider-repo/dom-discovery.md` step 9
  (`verify()`) against the current `src/selectors.ts`. A constant that comes
  back `count: 0` is stale and must be re-observed before you build on it.

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

Needs DOM observation: yes — `../creating-provider-repo/dom-discovery.md` step
5 (record a streaming turn), then step 6 (`replyShape()`), which yields
`contentRoot`, `chromeInsideContent` and `codeLanguage`. If the repository has
no `.mcp.json`, set the MCP servers up first: copy
`../creating-provider-repo/templates/mcp.json` to `.mcp.json` and add `.auth/`
and `.playwright-mcp/` to `.gitignore`, then follow the sibling file's "Set up"
section.

Change:

1. `src/selectors.ts`: add `ASSISTANT_MESSAGE_BODY` — `replyShape().contentRoot`
   made relative to one assistant turn by step 6's three mapping rules — and add
   its name to the `MANY` array. Compare with
   `../creating-provider-repo/templates/src/selectors.ts`. Record it in
   `docs/dom-notes.md` §Messages, and record `contentRoot`, `codeLanguage` and
   `chromeInsideContent` in §Streaming behaviour.
2. `src/provider.ts`: add the top-level field `responseFormat: "markdown"`, and
   import `elementToMarkdown` from `@chatbridge/provider` alongside
   `defineProvider`. Add the `newestBody(page)` helper from
   `../creating-provider-repo/templates/src/provider.ts` — the
   `page.locator(ASSISTANT_MESSAGE).last().locator(ASSISTANT_MESSAGE_BODY).first()`
   chain — and in `waitForResponse` replace every `innerText()` /
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
- `contentRoot: null` means the reply had no block-level content yet. Re-run
  `replyShape()` on a completed reply rather than guessing a selector.

Verify: `<VENDOR>_E2E=1 bun test src/provider.e2e.test.ts` with a saved auth
state — the "Markdown fidelity" test passes, meaning the reply carries a `#`
heading line, an indented nested list item, a ` ```ts ` fence, a `|---|` table
row, `**bold**` and a link. Then `bun run check`. One manual look, which no
test replaces: run the CLI interactively and ask for a bulleted list and a code
block — the history must render them as a formatted list and a highlighted
code block, not as literal `-` and backticks.

### Streaming

Needs DOM observation: yes — `../creating-provider-repo/dom-discovery.md` step
5, whose `recordTurn.stop()` summary gives `streamingElement` and
`streamingCollection`, and step 7 (a second turn), which confirms how a new
reply is told apart from the previous turn's. No new selector is needed when
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
   `../creating-provider-repo/templates/src/provider.ts`, and read it back in
   `waitForResponse` instead of whatever it uses today.
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
