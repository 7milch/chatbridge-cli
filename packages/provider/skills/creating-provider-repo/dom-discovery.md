# DOM discovery

How to turn a web chat service you have never seen into the twelve constants
of `templates/src/selectors.ts`, with every one of them justified by an
observation written into `docs/dom-notes.md`.

Follow this file top to bottom, once per service. Every step has the same four
parts:

- **Do** — the exact tool call, and the MCP server it runs in.
- **Human** — what to ask the user. Only some steps have one.
- **Read** — the fields of the output that matter, and what a normal value
  looks like.
- **Write** — the `docs/dom-notes.md` section and the `src/selectors.ts`
  constants it fills.

The whole procedure is about fifteen tool calls. It is not an exploration: do
not browse the app, do not read its source, do not invent selectors. Every
selector you write comes out of probe output you can quote.

## What never leaves the session

Probe output and page snapshots can contain conversation text and internal
URLs. `docs/dom-notes.md` records **structure** — locators, attribute names,
state values, timings, match counts, dates — and never conversation content.
Do not commit screenshots or files from `.playwright-mcp/`; the template
`gitignore` already ignores that directory and `.auth/`.

Three things you must never do, with what to do instead:

1. **Never type, ask for, or read credentials.** Ask the user to log in in the
   browser window and to tell you when they are done. The framework stores
   browser auth *state*, never a username or a password; a credential in this
   repository is a security bug.
2. **Never clear or read `document.cookie`, `localStorage`, `sessionStorage`
   or IndexedDB**, and never "log out by clearing storage". To see the
   logged-out page, use the `playwright-guest` server (step 2): it is
   `--isolated` and never logged in, so both states are available at the same
   time.
3. **Never read the page's source or its inline scripts** (`curl`, `view-source:`,
   `browser_network_requests` for a bundle). A real target's bundle is minified
   and its login flow is behind SSO, so this costs tokens and answers nothing.
   The DOM as rendered is the only thing a provider selects against, and
   `census()` reports it already ranked.

## Set up

**Do** — copy the MCP config and restart:

```sh
cp .claude/skills/creating-provider-repo/templates/mcp.json .mcp.json
```

Then tell the user: "I added `.mcp.json`; please restart Claude Code (or run
`/mcp` and reconnect) so the two Playwright servers load." Nothing below works
until they have.

`templates/mcp.json` defines two servers, both loading
`probes/chatbridge-probes.js` through `--init-script`, so
`window.__cbProbe` exists in every page without you pasting any code:

| Server | Profile | Used for |
|---|---|---|
| `playwright` | persistent, `.auth/mcp-profile` | everything except step 2; the human logs in here once and it survives restarts |
| `playwright-guest` | `--isolated`, never logged in | step 2 only, the logged-out census |

Both windows are **headed** — a human can log in in them.

Tool names are prefixed with the server name: `mcp__playwright__browser_navigate`,
`mcp__playwright-guest__browser_navigate`, and the same for `browser_evaluate`,
`browser_click`, `browser_type`, `browser_snapshot`, `browser_wait_for`. If
those tools are not in your tool list, load them first with ToolSearch:
`select:mcp__playwright__browser_evaluate,mcp__playwright-guest__browser_evaluate`
and so on.

**Do** — check the probe in **both** servers (a missing probe in one of them is
the failure you would otherwise only discover in step 2):

```json
{ "function": "() => typeof window.__cbProbe" }
```

**Read** — the result must be `"object"` in both. `"undefined"` means the
`--init-script` path in `.mcp.json` is wrong (it is relative to the repository
root: `.claude/skills/creating-provider-repo/probes/chatbridge-probes.js`) or
that you have not navigated anywhere yet — navigate to the entry URL first and
check again.

### Large outputs

`census()` on a real app is long. Pass `filename` to `browser_evaluate` and the
result is written to a file instead of the transcript:

```json
{ "function": "() => window.__cbProbe.census()",
  "filename": ".playwright-mcp/census-out.json" }
```

Then read only what you need from that file, for example with
`grep -o` or by reading it and looking at one key. Use `filename` for both
censuses and for `recordTurn.stop()`; call `verify()` and `replyShape()`
without it, their output is small.

### Alternative: an already logged-in CLI

If the scaffolded CLI has already been through `<vendor> auth login`, you can
start the `playwright` server from that saved state instead of logging in
again: replace `--user-data-dir .auth/mcp-profile` in `.mcp.json` with
`--isolated --storage-state <path printed by "<vendor> auth status">`. The
`playwright-guest` server stays as it is.

## Procedure

### Step 1 — the entry URL

**Human** — ask: "What URL do users start at for this service?" Use exactly
what they give you; do not search for it.

**Write** — `docs/dom-notes.md` §Login: the entry URL and today's date.
`ENTRY_URL` in `src/selectors.ts`.

### Step 2 — the logged-out census (guest server)

**Do** — in `playwright-guest`:

```json
{ "url": "<entry URL>" }
```

```json
{ "function": "() => window.__cbProbe.census()",
  "filename": ".playwright-mcp/census-guest.json" }
```

**Read** — from the file:

- `signIn` — the candidates whose name matches log in / sign in / sign up. A
  normal value is one or two entries, each with a `locators` array whose first
  entry is a `[data-testid=…]` or `[role=…][aria-label=…]` selector.
- `account` — normally `[]` here. Whatever appears in `account` in **this**
  census is not a login signal, because a guest has it too.
- `composer` — if this is non-empty, the service offers **guest chat**. That is
  the single most common way a provider ends up treating every visitor as
  logged in.
- `title`, `url` — if `title` is `"Just a moment..."` or the page is an IdP
  refusal, see the decision table.

**Write** — §Login: "guest chat offered: yes/no", the `signIn` locator, and
the note that `account` was empty. Do not fill `SIGN_IN_CONTROL` yet; step 4
confirms it by difference.

### Step 3 — the human logs in

**Do** — in `playwright`, navigate to the entry URL:

```json
{ "url": "<entry URL>" }
```

**Human** — say: "The browser window is open at the login page. Please log in
there by hand and tell me when you are done. I will not ask for and cannot see
your credentials." Then wait for their reply. Do not poll the page, do not
click anything in the login flow, do not fill any field.

If they report that the identity provider refuses the automated browser, note
it in §Login and ask them to finish with an emailed code or a password; that is
an observation, not something to work around.

### Step 4 — the logged-in census (main server)

**Do** — in `playwright`, after they confirm:

```json
{ "function": "() => window.__cbProbe.census()",
  "filename": ".playwright-mcp/census-in.json" }
```

**Read** — compare this census with the guest one from step 2. The login
signal is the **difference**, never the composer:

- `ACCOUNT_CONTROL` = the first `locators` entry of an `account` candidate that
  is present here and absent in step 2's census.
- `SIGN_IN_CONTROL` = the first `locators` entry of a `signIn` candidate that
  was present in step 2's census and is absent here.
- `CHAT_URL` = this census's `url` (origin + pathname, already stripped of
  query and hash).
- `COMPOSER` = the first `locators` entry of the `composer` candidate whose
  `visible` is `true`. A typical census lists a hidden twin first:

  ```json
  "composer": [
    { "locators": [], "tag": "textarea", "visible": false,
      "unstable": ["class: never used as a locator"] },
    { "locators": ["[data-testid=\"composer-input\"]",
                   "[role=\"textbox\"][aria-label=\"Message\"]",
                   "div[contenteditable=\"true\"]"],
      "tag": "div", "visible": true, "role": "textbox" }
  ]
  ```

  Take `[data-testid="composer-input"]`. Never take a `locators` entry from a
  `visible: false` candidate, and never take the generic
  `[role="textbox"]`/`textarea` form when a hidden twin exists — a hidden match
  makes every wait in the provider time out.
- `NEW_CHAT_BUTTON` = the first `locators` entry of the `buttons` candidate
  whose `ariaLabel` / `text` means "new chat". Confirmed in step 7.
- `lang` — record it if it is not `en`; localized labels mean you prefer
  `data-*` selectors over `aria-label` ones.
- A candidate with `locators: []` has no unique selector of its own: take an
  ancestor from `messageLists` and write `<ancestor locator> <tag>` instead.
- `unstable` tells you what was rejected and why (`class: never used as a
  locator`, `…: generated value`). It is information, not a locator source.

**Write** — §Login (`SIGN_IN_CONTROL`, `ACCOUNT_CONTROL`, whether the login
page shares the chat page's origin), §Chat page (`CHAT_URL`, `lang`),
§Composer (`COMPOSER`). `SEND_BUTTON` comes in step 5.

If the login page is on the **same origin** as the chat page, say so in
§Login: the off-origin check at the top of `isLoggedIn` in
`templates/src/provider.ts` is then simply a no-op, and the sign-in / account
pair decides on its own. That is what the pair is for; do not replace it with a
URL test.

### Step 5 — record a streaming turn

Send a prompt whose reply takes a few seconds, so that streaming, the
"generating" state and any placeholder turn are all visible in one recording. A
one-word reply shows none of them.

**Do** — in `playwright`, in this order, one call each:

1. ```json
   { "function": "() => window.__cbProbe.recordTurn.start()" }
   ```
   Returns `"recording"`.
2. Type one character first, so a send button that only exists while the
   composer is non-empty is on the page:
   ```json
   { "element": "message composer", "target": "[data-testid=\"composer-input\"]",
     "text": "." }
   ```
   (`target` takes a CSS selector — use your `COMPOSER` value.)
3. Capture `SEND_BUTTON` while it exists:
   ```json
   { "function": "() => window.__cbProbe.census().buttons.filter(b => /send|submit/i.test((b.ariaLabel ?? '') + (b.text?.head ?? '') + b.locators.join(' ')))" }
   ```
   Take the first `locators` entry. If the result is `[]`, there is no send
   button: see the decision table.
4. Fill in the real prompt and submit:
   ```json
   { "element": "message composer", "target": "[data-testid=\"composer-input\"]",
     "text": "List 30 short facts about the solar system as a numbered list, one line each.",
     "submit": false }
   ```
   then
   ```json
   { "element": "send button", "target": "[data-testid=\"send-button\"]" }
   ```
   with `browser_click`.
5. Immediately, while the reply is being written, capture `STOP_BUTTON`:
   ```json
   { "function": "() => window.__cbProbe.census().buttons.filter(b => /stop|cancel|生成/i.test((b.ariaLabel ?? '') + (b.text?.head ?? '') + b.locators.join(' ')))" }
   ```
6. Wait for the reply to finish:
   ```json
   { "time": 20 }
   ```
   with `browser_wait_for`, then `browser_snapshot` to confirm the reply is
   complete. If it is still being written, wait again.
7. ```json
   { "function": "() => window.__cbProbe.recordTurn.stop()",
     "filename": ".playwright-mcp/turn-1.json" }
   ```

**Read** — from `turn-1.json`. A normal record looks like this, trimmed:

```json
{ "durationMs": 837,
  "added": [
    { "t": 34, "locator": "[data-testid=\"stop-button\"]", "shape": "button[data-testid]",
      "isControl": true, "removedAt": 344 },
    { "t": 34, "locator": "[data-turn=\"user\"]", "shape": "article[data-turn]" },
    { "t": 34, "locator": "[data-turn=\"assistant\"]",
      "shape": "article[data-placeholder][data-turn]", "removedAt": 185 },
    { "t": 186, "locator": "[data-message-id=\"m1\"]", "shape": "article[data-message-id][data-turn]" }],
  "attrs": [],
  "textGrowth": [
    { "locator": "[data-message-id=\"m1\"]",
      "collection": { "selector": "article[data-turn=\"assistant\"]", "count": 2 },
      "firstAt": 187, "lastAt": 312, "updates": 5, "finalLength": 61 }],
  "buttonsSwapped": [
    { "t": 33, "gone": "[data-testid=\"send-button\"]" },
    { "t": 34, "appeared": "[data-testid=\"stop-button\"]" },
    { "t": 344, "gone": "[data-testid=\"stop-button\"]" }],
  "summary": {
    "placeholderTurns": ["[data-turn=\"assistant\"] (article[data-placeholder][data-turn]) added @34ms, removed @185ms"],
    "doneCandidates": ["button gone: [data-testid=\"stop-button\"] @344ms"],
    "streamingElement": "[data-message-id=\"m1\"]",
    "streamingCollection": { "selector": "article[data-turn=\"assistant\"]", "count": 2 } } }
```

Field by field:

- `summary.streamingCollection.selector` → **`ASSISTANT_MESSAGE`**. This is the
  stable selector for every turn of that shape. Its `count` tells you how many
  it matches right now.
- `summary.streamingElement` is this **instance**: it usually carries a
  per-turn id (`[data-message-id="m1"]`). **Never copy it into
  `src/selectors.ts`** — it is correct for this turn and wrong for the next
  one. It is only there to tell you which element grew.
- `summary.placeholderTurns` — each entry is an element added and removed
  inside the turn. Non-empty means the done signal must be waited for *before*
  the count check, and that `ASSISTANT_MESSAGE` may need to exclude the
  placeholder: see the decision table.
- `added[]` rows with `"isControl": true` are buttons that appeared and
  disappeared (a stop button). They are **not** placeholder turns and need no
  `:not(…)`.
- `summary.doneCandidates` — latest first; `doneCandidates[0]` is the done
  signal to build on. `attrs[]` rows carry `detached: true` when the element was
  gone by the time the record was rendered.
- `buttonsSwapped` — the send → stop → nothing sequence; `gone`/`appeared`
  locators are captured at event time.
- `textGrowth[].collection` is the same `{ selector, count, note? }` shape as
  `streamingCollection`, for each growing element.

**Write** — §Messages (`ASSISTANT_MESSAGE`), §Generation indicator
(`STOP_BUTTON`, `doneCandidates[0]`), §Composer (`SEND_BUTTON`), §Streaming
behaviour (which element grew, how the new reply is told apart from the
previous turn's, chunk cadence from `firstAt`/`lastAt`/`updates`).

`USER_MESSAGE` comes from the `added[]` row inserted at the same time as the
prompt (`[data-turn="user"]` above) — take its `shape` and turn it into the
descriptive selector (`article[data-turn="user"]`), not the per-turn id.

### Step 6 — the reply's shape

**Do** — in `playwright`, straight after step 5 (with no argument it uses the
element that just streamed):

```json
{ "function": "() => window.__cbProbe.replyShape()" }
```

**Read** — a normal result:

```json
{ "root": "[data-message-id=\"m1\"]",
  "tagCensus": { "div": 4, "p": 1, "h2": 1, "ul": 1, "pre": 1, "code": 1, "button": 3 },
  "chrome": [ { "locator": "[data-part=\"code-header\"]", "kind": "code-header" },
              { "locator": "button[aria-label=\"Copy\"]", "kind": "button" } ],
  "codeLanguage": "class",
  "contentRoot": "[data-part=\"content\"]",
  "chromeInsideContent": ["code-header: [data-part=\"code-header\"]"] }
```

- `contentRoot` → **`ASSISTANT_MESSAGE_BODY`**, made relative to one turn: drop
  any leading turn part, so what you write matches *inside* a single assistant
  turn (`[data-part="content"]`). The provider applies it under
  `ASSISTANT_MESSAGE` already.
- `chrome` lists what is decoration rather than content; `chromeInsideContent`
  lists the ones still inside `contentRoot`, i.e. what will leak into the
  Markdown.
- `codeLanguage` is `"class"` (the language survives), `"header-label"` (it
  does not, see the decision table), `"none"`, or `"no-code-block"` — if it is
  `"no-code-block"` your prompt had no code in it; that is fine, the fidelity
  E2E in `templates/src/provider.e2e.test.ts` covers it later.
- `contentRoot: null` means the reply has no block-level content yet; re-run
  after the reply is complete.

**Write** — §Streaming behaviour: `contentRoot`, `codeLanguage`,
`chromeInsideContent`. §Messages: `ASSISTANT_MESSAGE_BODY`.

### Step 7 — a second turn

**Do** — repeat step 5's calls 1, 4, 6 and 7 (no need to re-capture the
buttons) with a second, different prompt, saving to
`.playwright-mcp/turn-2.json`.

**Read** — confirm three things:

- `summary.doneCandidates[0]` is the **same** signal as in turn 1. If it is
  not, the first one was a coincidence; use the one that repeats.
- `summary.streamingCollection.selector` is the **same** selector, with `count`
  one higher. That is what makes it safe to write into `src/selectors.ts`.
- `summary.streamingElement` is a **different** instance than in turn 1 — this
  is the answer to "how is the new reply told apart from the previous turn's":
  by counting matches of `ASSISTANT_MESSAGE`, which is what the template's
  `streaming.responseText` does.

**Write** — §Streaming behaviour and §Messages: confirmed, with the counts.

### Step 8 — new chat

**Do** — in `playwright`, click the candidate from step 4 with `browser_click`:

```json
{ "element": "new chat button", "target": "[data-testid=\"new-chat\"]" }
```

then

```json
{ "function": "() => ({ url: location.origin + location.pathname, composer: window.__cbProbe.verify({ COMPOSER: '[data-testid=\"composer-input\"]' }), turns: document.querySelectorAll('article[data-turn=\"assistant\"]').length })" }
```

**Read** — `composer.COMPOSER.ok` must be `true` with `visibleCount: 1`, and
`turns` must be `0`. If new chat turned out to be a navigation rather than a
button, the `url` tells you which one to use — take the `startNewChat` VARIANT
in `templates/src/provider.ts`.

**Write** — §New chat: `NEW_CHAT_BUTTON` (or the URL), and that the composer is
empty afterwards.

### Step 9 — verify every constant

**Do** — fill `src/selectors.ts` completely, then, on the logged-in chat page
with at least one completed turn, call `verify()` with every constant. Build the
call mechanically from the file: each `export const NAME = "…"` becomes
`NAME: '…'`, and each name listed in the file's `MANY` array becomes
`NAME: { selector: '…', many: true }`. `CHALLENGE_TITLE` is a document title,
not a selector — leave it out.

```json
{ "function": "() => window.__cbProbe.verify({ SIGN_IN_CONTROL: '[data-testid=\"sign-in\"]', ACCOUNT_CONTROL: '[data-testid=\"account-menu\"]', COMPOSER: '[data-testid=\"composer-input\"]', SEND_BUTTON: '[data-testid=\"send-button\"]', STOP_BUTTON: '[data-testid=\"stop-button\"]', NEW_CHAT_BUTTON: '[data-testid=\"new-chat\"]', ASSISTANT_MESSAGE: { selector: 'article[data-turn=\"assistant\"]', many: true }, USER_MESSAGE: { selector: 'article[data-turn=\"user\"]', many: true }, ASSISTANT_MESSAGE_BODY: { selector: '[data-part=\"content\"]', many: true } })" }
```

**Read** — each name gets `{ count, visibleCount, ok }`. `ok` is `count === 1`
for a plain selector and `count >= 1` for a `many` one.

- `SIGN_IN_CONTROL` is expected to be **not** `ok` here (`count: 0`): it exists
  only when logged out, and you confirmed it in step 2. Everything else must be
  `ok`.
- `SEND_BUTTON` and `STOP_BUTTON` only exist at particular moments. Verify
  `SEND_BUTTON` with one character typed into the composer, and `STOP_BUTTON`
  during a long turn — re-run the call with just that one name at that moment
  rather than trying to get them all in one snapshot.
- `count: 2` with `visibleCount: 1` means you picked the selector that also
  matches a hidden twin. Go back to step 4's `composer` list.
- `error: "invalid selector: …"` is a syntax error in what you wrote.

**Write** — the `verify() count` and `visible` columns of every table in
`docs/dom-notes.md`, and the `Observed: YYYY-MM-DD` date in each section.
Remove every remaining `Not yet observed.` line. A constant with no dom-notes
entry is a bug; so is a dom-notes section still holding the placeholder.

## Decision table

Read the left column off probe output; do exactly what the right column says.

| Probe shows | Write |
|---|---|
| `composer` non-empty in the step 2 (guest) census | Guest chat exists. Login signal stays `ACCOUNT_CONTROL` present AND `SIGN_IN_CONTROL` absent. A composer is never a login signal |
| `composer` has a `visible: false` entry | Take the `visible: true` candidate's own `locators[0]`; never a selector that also matches the hidden twin |
| A candidate has `locators: []` | Anchor it: `<locator of an ancestor from messageLists> <tag>` |
| `summary.placeholderTurns` non-empty | Wait for the done signal first, then the count check (the template already does). If the placeholder's `shape` shares `ASSISTANT_MESSAGE`'s attributes, exclude it: `article[data-turn="assistant"]:not([data-placeholder])` |
| `ASSISTANT_MESSAGE` would also match the placeholder | Same: `:not([…])` on the attribute shown in the `placeholderTurns` line's `shape` |
| An `added[]` row has `"isControl": true` | It is a control that came and went (a stop button), not a placeholder turn. No `:not(…)`, no entry in §Messages |
| `summary.streamingCollection.selector` is `null` (with a `note`) | No stable attribute or anchor describes the turn. Pick a container from `census().messageLists` and anchor manually: `<container locator> > <tag>`. Verify it in step 9 |
| `streamingCollection.count` counts the user turns too (the turns carry only a class, nothing telling user from assistant apart) | Run `census()` and look at one turn's children for a distinguishing descendant or attribute (`messageLists[n].childShape`, `dataAttrCensus`), and use `<container> > <tag>:has(<that descendant>)`. Confirm with `verify()` that the count is now half what it was. If nothing distinguishes them, record the limitation in §Messages, leave `ASSISTANT_MESSAGE` as the container's children, and note there that the count check in `waitForResponse` advances by two per turn |
| `buttonsSwapped` shows send gone → stop appeared → stop gone, and `doneCandidates[0]` is `button gone: …` | Done = the stop control gone. `STOP_BUTTON` is that selector. Do not wait for the send button to come back: many services render it only while the composer is non-empty |
| `attrs` shows a `data-state` / `aria-busy` flipping back at the end, and it is in `doneCandidates` | Done = that attribute's idle value. Take the `waitForResponse` VARIANT in `templates/src/provider.ts` |
| `doneCandidates` lists **both** a state attribute and a button swap | Prefer the state attribute for the done signal (VARIANT), and keep the button as `STOP_BUTTON` for `sendMessage`'s "generation started" wait |
| `doneCandidates` is empty | There is no done signal. Say so in §Generation indicator, leave `STOP_BUTTON` empty and rely on the stability read alone — expect slower, occasionally truncated turns |
| No send button in the step 5 census filter, and none in `buttonsSwapped` | Take the `sendMessage` VARIANT: `page.keyboard.press("Enter")`. Leave `SEND_BUTTON` empty and say so in §Composer |
| `textGrowth` is empty after a long prompt | The reply is not streamed into the DOM (it is replaced whole). Say so in §Streaming behaviour; `streaming.responseText` still works off the count |
| `replyShape().chromeInsideContent` is non-empty | `ASSISTANT_MESSAGE_BODY` still points at `contentRoot`; list the leaking chrome in §Streaming behaviour so the E2E's expectations are read with it in mind |
| `replyShape().contentRoot` is `null` while a reply is still streaming | `streaming.responseText` returns `undefined` until it exists — the template already returns `undefined` when the body matches nothing |
| `replyShape().codeLanguage` is `"header-label"` | The code language lives in a header label, not a class, so the fence comes out without it. Record it in §Streaming behaviour as a known loss and relax that line of the Markdown fidelity test |
| The Markdown reply carries a stray line just before a fence (the code header's label) | Known framework limitation: `elementToMarkdown` has no skip option. **Accept it** — record it in §Streaming behaviour; do not write a work-around into the provider. Assert Markdown *structure* in the E2E, never exact text |
| `lang` is not `en`, or button names are localized | Prefer `data-*` selectors over `aria-label` ones, and record the locale in §Chat page — a language change would otherwise break every label-based selector |
| `title` is `"Just a moment..."`, or the page is an IdP refusal | Keep `CHALLENGE_TITLE` as the interstitial's title, `detectBlock` returns `"challenge page"`, the CLI tells the user to try `--headful`. Record it in §Errors and rate limits. Bot-protection evasion is out of scope: no stealth plugins, no UA spoofing, no attaching to a personal Chrome profile |
| The login page is on the chat page's own origin | Say so in §Login. The off-origin check in `isLoggedIn` is then a no-op and the sign-in / account pair decides alone. Do not replace the pair with a URL test |

## When a locator stops matching later

A service redesign breaks selectors silently — the symptom is a timeout, not an
error naming the selector.

1. Re-run step 9's `verify()` call on the logged-in chat page.
2. For every name with `ok: false`, re-run the one step that owns it: steps 2
   and 4 for `ENTRY_URL`, `CHAT_URL`, `SIGN_IN_CONTROL`, `ACCOUNT_CONTROL`,
   `COMPOSER`; step 5 for `SEND_BUTTON`, `STOP_BUTTON`, `ASSISTANT_MESSAGE`,
   `USER_MESSAGE`; step 6 for `ASSISTANT_MESSAGE_BODY`; step 8 for
   `NEW_CHAT_BUTTON`. `CHALLENGE_TITLE` changes only when the interstitial
   does.
3. Update the selector, the counts and the `Observed:` date in that
   `docs/dom-notes.md` section. An old date with a new selector is worse than
   no note.
