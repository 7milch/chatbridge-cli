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

The whole procedure is about thirty tool calls. It is not an exploration: do
not browse the app, do not read its source, do not invent selectors. Every
selector you write comes out of probe output you can quote.

## What never leaves the session

Probe output and page snapshots can contain conversation text and internal
URLs. `docs/dom-notes.md` records **structure** — locators, attribute names,
state values, timings, match counts, dates — and never conversation content.
The probe cuts text, labels, roles and the page title to 40 characters, but
**attribute values reach its output at up to 60 characters** — in locators and
in recorded attribute changes — so a user name, an email or a conversation
title held in an attribute can appear there. Never commit probe output,
screenshots or files from `.playwright-mcp/`; the template `gitignore` already
ignores that directory and `.auth/`.

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

**Do** — if you have not already copied `templates/` into the repo root and
renamed `mcp.json`, copy the MCP config now; then restart:

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
`browser_click`, `browser_type`, `browser_wait_for`. If
those tools are not in your tool list, load them first with ToolSearch:
`select:mcp__playwright__browser_evaluate,mcp__playwright-guest__browser_evaluate`
and so on.

**Do** — the probe is installed when a page loads, so navigate first: in
**both** servers, `browser_navigate` to the entry URL (ask step 1's question
now if you do not have it), then `browser_evaluate` in both:

```json
{ "function": "() => typeof window.__cbProbe" }
```

**Read** — the result must be `"object"` in both. `"undefined"` means, in the
order to check: `.claude/skills/creating-provider-repo/` does not exist in this
repository (SKILL.md Procedure step 1 copies it there; `.mcp.json` points into
it), or the `--init-script` path in `.mcp.json` is wrong (it is relative to the
repository root:
`.claude/skills/creating-provider-repo/probes/chatbridge-probes.js`).

The probe object exists on every page of these two browsers, the login
provider's included. It is inert until called. Use it only on services you are
permitted to automate.

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

**Do** — in `playwright-guest`, `browser_navigate`:

```json
{ "url": "<entry URL>" }
```

then `browser_evaluate`:

```json
{ "function": "() => window.__cbProbe.census()",
  "filename": ".playwright-mcp/census-guest.json" }
```

**Read** — from the file:

- `signIn` — the candidates whose name matches log in / sign in / sign up, **on
  the entry page**. The entry URL is often only a login page, so this census
  cannot define the login signal and cannot show whether the chat page serves
  guests: step 4 visits the chat URL as a guest for that.
- `account` — normally `[]` here.
- `title`, `url` — if `title` is `"Just a moment..."` or the page is an IdP
  refusal, see the decision table. A `title` ending in `…` was cut at 40
  characters; read the whole interstitial title with `() => document.title`.

**Write** — §Login: what the entry page is (a login form, a landing page, the
chat itself) and its `url`. Do not fill `SIGN_IN_CONTROL`; step 4 does.
§Errors and rate limits: leave `CHALLENGE_TITLE` at the template's
`"Just a moment..."` unless this census's `title` shows a different
interstitial, and record which of the two you saw.

### Step 3 — the human logs in

**Do** — in `playwright`, `browser_navigate` to the entry URL:

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

**Do** — in `playwright`, after they confirm, `browser_evaluate`:

```json
{ "function": "() => window.__cbProbe.census()",
  "filename": ".playwright-mcp/census-in.json" }
```

`CHAT_URL` = this census's `url` (origin + pathname, already stripped of query
and hash). Then look at the **same URL as a guest**: in `playwright-guest`,
`browser_navigate` to it:

```json
{ "url": "<CHAT_URL>" }
```

and `browser_evaluate`:

```json
{ "function": "() => window.__cbProbe.census()",
  "filename": ".playwright-mcp/census-guest-chat.json" }
```

**Read** — the login signal is the **difference between these two censuses of
the chat URL**, never the composer and never the entry page:

- `ACCOUNT_CONTROL` = the first `locators` entry of an `account` candidate that
  is in the member census and absent from the guest one.
- `SIGN_IN_CONTROL` = the first `locators` entry of a `signIn` candidate that
  is in the guest census and absent from the member one.
- The guest census's `url` and `composer` say what a logged-out visitor gets.
  Exactly one of three decision-table rows applies: the guest stayed on
  `CHAT_URL` with a `composer` (guest chat), stayed without one, or was
  redirected (`url` differs).
Everything else comes from the member census (`census-in.json`):

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
  whose `ariaLabel` / `text` means "new chat". Confirmed in step 8.
- `lang` — record it if it is not `en`; localized labels mean you prefer
  `data-*` selectors over `aria-label` ones. When a control has no `data-*`
  locator at all, use its `aria-label` locator and note in dom-notes that a
  translation change breaks it.
- A candidate with `locators: []` has no unique selector of its own: take an
  ancestor from `messageLists` and write `<ancestor locator> <tag>` instead.
- `unstable` tells you what was rejected and why (`class: never used as a
  locator`, `…: generated value`). It is information, not a locator source.

**Write** — §Login (`SIGN_IN_CONTROL`, `ACCOUNT_CONTROL`, "guest chat offered:
yes/no", where a guest lands, whether the login page shares the chat page's
origin), §Chat page (`CHAT_URL`, `lang`),
§Composer (`COMPOSER`). `SEND_BUTTON` comes in step 5.

If the login page is on the **same origin** as the chat page, say so in
§Login: the off-origin check at the top of `isLoggedIn` in
`templates/src/provider.ts` is then simply a no-op, and the sign-in / account
pair decides on its own. That is what the pair is for; do not replace it with a
URL test.

### Step 5 — record a streaming turn

Send a prompt whose reply takes a few seconds and contains Markdown structure
with a fenced code block, so that streaming, the "generating" state, any
placeholder turn and (in step 6) the code block's chrome are all visible. A
one-word reply shows none of them.

**Do** — in `playwright`, in this order, one call each. How to send is decided
**before** sending, from what the page shows, never from a button's label — so
it works the same in every language.

1. `browser_evaluate`, with the composer still empty — the visible buttons:
   ```json
   { "function": "() => window.__cbProbe.census().buttons.filter(b => b.visible && b.locators.length > 0).map(b => ({ locator: b.locators[0], label: b.ariaLabel ?? b.text?.head ?? '' }))" }
   ```
2. `browser_type` one character, so that a send button which exists only while
   the composer is non-empty is on the page:
   ```json
   { "element": "message composer", "target": "[data-testid=\"composer-input\"]",
     "text": ".", "submit": false }
   ```
   (`target` takes a CSS selector — use your `COMPOSER` value. Without
   `"slowly": true`, `browser_type` **fills**: it replaces whatever the
   composer holds, so call 5 overwrites this `.` rather than appending to it.
   No clearing step is needed.)
3. `browser_evaluate` — call 1 again, unchanged. Keep the entries whose
   `locator` is **not** in call 1's result: they exist *because* the composer is
   non-empty.

   | New entries | How to send in call 5 |
   |---|---|
   | exactly one | **5a**, clicking that `locator` |
   | none (a send button that is always there cannot be told apart this way) | **5b**, Enter |
   | more than one | **Human** — ask: "Which of these controls sends the message?" and list their `label` values; then **5a** with the one they name |

4. `browser_evaluate`:
   ```json
   { "function": "() => window.__cbProbe.recordTurn.start()" }
   ```
   Returns `"recording"`.
5. Send the real prompt, the way call 3 decided.

   **5a — click.** `browser_type`:
   ```json
   { "element": "message composer", "target": "[data-testid=\"composer-input\"]",
     "text": "Write a Markdown document about the solar system: a heading, a numbered list of 20 one-line facts, a table of four planets, and a fenced python code block of five lines.",
     "submit": false }
   ```
   then `browser_click`:
   ```json
   { "element": "send button", "target": "[data-testid=\"send-button\"]" }
   ```

   **5b — Enter.** One `browser_type`:
   ```json
   { "element": "message composer", "target": "[data-testid=\"composer-input\"]",
     "text": "Write a Markdown document about the solar system: a heading, a numbered list of 20 one-line facts, a table of four planets, and a fenced python code block of five lines.",
     "submit": true }
   ```

   Never click any other button to "try" sending: while a reply is being
   written, the one new button on the page is the **stop** button.
6. `browser_wait_for`:
   ```json
   { "time": 20 }
   ```
   Its result already carries the page snapshot (inline, or as a file to
   read): no separate snapshot call. If the reply is still being written, wait
   again. If there is no new turn at all, do not wait again — go on to call 7, which tells
   you whether anything was sent.
7. `browser_evaluate`:
   ```json
   { "function": "() => window.__cbProbe.recordTurn.stop()",
     "filename": ".playwright-mcp/turn-1.json" }
   ```

**Read** — first, `summary.sent`. The probe ignores everything that happens
inside the composer, so typing, or a newline that Enter inserted, never counts
as a turn. Only `false` is a verdict (`true` can also come from an unrelated
element such as a toast): if `summary.sent` is `false` **and** call 6's
snapshot showed no new turn either, nothing was sent. Then do exactly this,
once: run call 4 again, and **Human** — say: "The message did not send.
The prompt is in the composer: please send it yourself in the browser window,
then tell me when the reply has finished and which control you used to send
it." (After a 5b the composer may hold the prompt plus a stray newline; that is
harmless.) After their reply, run call 7 again and read that record instead.

From `turn-1.json`. A normal record looks like this, trimmed:

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
      "collection": { "selector": "article[data-turn=\"assistant\"]", "count": 1 },
      "firstAt": 187, "lastAt": 312, "updates": 5, "finalLength": 61 }],
  "buttonsSwapped": [
    { "t": 33, "gone": "[data-testid=\"send-button\"]" },
    { "t": 34, "appeared": "[data-testid=\"stop-button\"]" },
    { "t": 344, "gone": "[data-testid=\"stop-button\"]" }],
  "summary": {
    "sent": true,
    "placeholderTurns": ["[data-turn=\"assistant\"] (article[data-placeholder][data-turn]) added @34ms, removed @185ms"],
    "doneCandidates": ["button gone: [data-testid=\"stop-button\"] @344ms"],
    "streamingElement": "[data-message-id=\"m1\"]",
    "streamingCollection": { "selector": "article[data-turn=\"assistant\"]", "count": 1 } } }
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
- `buttonsSwapped` — the send → stop → nothing sequence, captured at event
  time. It is the authority for both button constants:
  - **`SEND_BUTTON`** = the `gone` row with the **largest `t` that is ≤ the
    `t` of the user turn's `added[]` row**
    (`{ "t": 33, "gone": "[data-testid=\"send-button\"]" }` against the user
    turn's `"t": 34` above; an earlier `gone` / `appeared` pair of the same
    button is only the composer re-rendering while it was filled). A send control that stays on the page all along produces no such
    row; it names itself instead through a `changed` row whose `disabled` or
    `aria-disabled` flips at that same moment —
    `{ "t": 33, "changed": "[data-testid=\"send\"] disabled: null → " }` —
    and `SEND_BUTTON` is the locator that row starts with. With neither row:
    after 5a keep the locator you clicked; otherwise see the decision table,
    rows **"no send button"** and "sent by hand".
  - **`STOP_BUTTON`** = the locator that `appeared` early and is `gone` again
    at the end of the turn (`[data-testid="stop-button"]` above); the same
    locator is normally `doneCandidates[0]`.
- `textGrowth[].collection` is the same `{ selector, count, note? }` shape as
  `streamingCollection`, for each growing element. If `textGrowth` is `[]`,
  there is no `streamingElement` and no `streamingCollection` at all: take
  `ASSISTANT_MESSAGE` from `added[]` instead, as the decision table says.

**Write** — §Messages (`ASSISTANT_MESSAGE`), §Generation indicator
(`STOP_BUTTON`, `doneCandidates[0]`), §Composer (`SEND_BUTTON`), §Streaming
behaviour (which element grew, how the new reply is told apart from the
previous turn's, chunk cadence from `firstAt`/`lastAt`/`updates`).

`USER_MESSAGE` comes from the `added[]` row inserted at the same time as the
prompt (`[data-turn="user"]` above) — take its `shape` and turn it into the
descriptive selector (`article[data-turn="user"]`), not the per-turn id.

### Step 6 — the reply's shape

**Do** — in `playwright`, `browser_evaluate`, straight after step 5 (with no
argument it uses the element that just streamed):

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
  "contentRootWithin": "[data-part=\"content\"]",
  "chromeInsideContent": ["code-header: [data-part=\"code-header\"]"] }
```

- `contentRootWithin` → **`ASSISTANT_MESSAGE_BODY`**, as printed. The probe
  computes it *inside* the reply element, so it never carries anything from
  above the turn and it works on every later turn. The template uses it as
  `page.locator(ASSISTANT_MESSAGE).last().locator(ASSISTANT_MESSAGE_BODY).first()`,
  and step 9 verifies it the same way, with `within`. Four shapes come back:

  | `contentRootWithin` | Write |
  |---|---|
  | `[data-part="content"]` | that value |
  | a `:scope …` form — `:scope > div`, `:scope > div[role="…"]`, `:scope div` (the content element has no descriptive `data-*` attribute; ids and labels are never used) | that value — `:scope` is valid because the selector is always evaluated under one turn |
  | `""` (empty: the turn element *is* the content) | `ASSISTANT_MESSAGE`'s own value, plus the `newestBody` VARIANT in `templates/src/provider.ts` |
  | `null` (no relative selector exists) | see the decision table |

  `contentRoot` is the same element written as a page-wide locator. Read it to
  understand the reply; never copy it into `src/selectors.ts` — it can be
  anchored on an ancestor **above** the turn (`[data-testid="thread"] > div`),
  which matches the first turn only.
- `chrome` lists what is decoration rather than content; `chromeInsideContent`
  lists the ones still inside `contentRoot`, i.e. what will leak into the
  Markdown.
- `codeLanguage` is `"class"` (the language survives), `"header-label"` (it
  does not, see the decision table), `"none"`, or `"no-code-block"` — the reply
  had no code although the prompt asked for some; run `replyShape()` again
  after step 7, whose prompt asks again. If it still says so, the fidelity E2E
  in `templates/src/provider.e2e.test.ts` covers it later.
- `contentRoot: null` means the reply has no block-level content yet; re-run
  after the reply is complete.

**Write** — §Streaming behaviour: `contentRootWithin`, `codeLanguage`,
`chromeInsideContent`. §Messages: `ASSISTANT_MESSAGE_BODY`.

### Step 7 — a second turn

**Do** — repeat step 5's calls 4 to 7 with a second, different prompt that
also asks for a fenced code block, sending
the same way as in step 5 (5a, 5b, or the user by hand), saving to
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

**Do** — in `playwright`, `browser_click` on the candidate from step 4:

```json
{ "element": "new chat button", "target": "[data-testid=\"new-chat\"]" }
```

then `browser_evaluate`:

```json
{ "function": "() => ({ url: location.origin + location.pathname, composer: window.__cbProbe.verify({ COMPOSER: '[data-testid=\"composer-input\"]' }), turns: document.querySelectorAll('article[data-turn=\"assistant\"]').length })" }
```

**Read** — `composer.COMPOSER.ok` must be `true` with `visibleCount: 1`, and
`turns` must be `0`. If new chat turned out to be a navigation rather than a
button, the `url` tells you which one it is — see the decision table, row
**"new chat is a URL"**.

**Write** — §New chat: `NEW_CHAT_BUTTON` (or the URL), and that the composer is
empty afterwards.

### Step 9 — verify every constant

**Do** — fill `src/selectors.ts` completely. Then, in `playwright`:

1. Step 8 emptied the chat and `verify()` needs a completed turn: send
   `Reply with the single word: ping` the way step 5 decided (5a, 5b, or the
   user by hand), then `browser_wait_for` `{ "time": 10 }`.
2. `browser_type` one character (`"text": ".", "submit": false`) so that a
   `SEND_BUTTON` which exists only while the composer is non-empty is there.
3. `browser_evaluate` the `verify()` call, built mechanically from the file,
   four rules and no others:

   - `STOP_BUTTON` is left out: it exists for a fraction of a second, which no
     separate call can hit. Its evidence is the recording — the same locator
     `appeared` and was `gone` in `buttonsSwapped` in steps 5 **and** 7;
   - a name listed in the file's `MANY` array → `NAME: { selector: '…', many: true }`;
   - `ASSISTANT_MESSAGE_BODY` → `{ selector: '…', within: '<your ASSISTANT_MESSAGE>' }`,
     always, because that is how the provider evaluates it (under the last turn),
     and it is the only form in which a `:scope > …` value can match;
   - every other name → `NAME: '…'`.

   `CHALLENGE_TITLE` is a document title, not a selector — leave it out.

```json
{ "function": "() => window.__cbProbe.verify({ SIGN_IN_CONTROL: '[data-testid=\"sign-in\"]', ACCOUNT_CONTROL: '[data-testid=\"account-menu\"]', COMPOSER: '[data-testid=\"composer-input\"]', SEND_BUTTON: '[data-testid=\"send-button\"]', NEW_CHAT_BUTTON: '[data-testid=\"new-chat\"]', ASSISTANT_MESSAGE: { selector: 'article[data-turn=\"assistant\"]', many: true }, USER_MESSAGE: { selector: 'article[data-turn=\"user\"]', many: true }, ASSISTANT_MESSAGE_BODY: { selector: '[data-part=\"content\"]', within: 'article[data-turn=\"assistant\"]' } })" }
```

**Read** — each name gets `{ count, visibleCount, ok }`. `ok` is `count === 1`
for a plain selector, and `count >= 1` for a `many` or a `within` one.

- `SIGN_IN_CONTROL` is expected to be **not** `ok` here (`count: 0`): it exists
  only when logged out, and you confirmed it in step 4's guest census of `CHAT_URL`. Everything else must be
  `ok`.
- `skipped: "empty — allowed only where a VARIANT says so"` with `ok: true` is
  what an empty constant returns. It is legitimate for exactly three names —
  `SIGN_IN_CONTROL`, `SEND_BUTTON`, `NEW_CHAT_BUTTON` — and only when a decision row told you to
  leave that one empty and take a VARIANT. Any other `skipped` means you have
  not filled the constant yet: go back to the step that owns it.
- `count: 2` with `visibleCount: 1` means you picked the selector that also
  matches a hidden twin. Go back to step 4's `composer` list.
- `error: "within matched nothing: …"` and
  `error: "invalid within selector: …"` both point at the `within` value —
  your `ASSISTANT_MESSAGE` — not at the body selector: fix that first and
  re-run.
- `error: "invalid selector: …"` is a syntax error in the constant named on
  that line.

**Write** — the `verify() count` and `visible` columns of every table in
`docs/dom-notes.md` (for `STOP_BUTTON`: `buttonsSwapped, steps 5 and 7`), and the `Observed: YYYY-MM-DD` date in each section.
Remove every remaining `Not yet observed.` line. A constant with no dom-notes
entry is a bug; so is a dom-notes section still holding the placeholder.

## Decision table

Read the left column off probe output; do exactly what the right column says.

| Probe shows | Write |
|---|---|
| Step 4's guest census stayed on `CHAT_URL` and its `composer` is non-empty | Guest chat exists. Login signal stays `ACCOUNT_CONTROL` present AND `SIGN_IN_CONTROL` absent, both from step 4's pair. A composer is never a login signal |
| Step 4's guest census stayed on `CHAT_URL` and its `composer` is `[]` | No guest chat, the chat page itself shows the sign-in control. Same pair, nothing else to do |
| Step 4's guest census has `signIn: []` on the page it shows (a label the probe's word list misses) | In the guest census's `buttons`, keep the `visible` entries whose `locators[0]` is absent from the member census's `buttons`. Exactly one → that is `SIGN_IN_CONTROL`. None or several (the census lists buttons, not plain links) → leave `SIGN_IN_CONTROL` empty: `isLoggedIn` in `templates/src/provider.ts` — decision table **"no sign-in control found"** — then lets `ACCOUNT_CONTROL` decide alone, at a cost: a logged-out page takes the full 10 s wait to read as logged out (at startup, and at close on an expired session). Record it in §Login; step 9 reports it as `skipped` |
| Step 4's guest census has a different `url` (redirected to a login page or an IdP) | No guest chat. `SIGN_IN_CONTROL` = `locators[0]` of a `signIn` candidate of that guest census (the page it landed on); `ACCOUNT_CONTROL` as usual. If the landed `url` is on another origin, say so in §Login: the off-origin check in `isLoggedIn` answers before `SIGN_IN_CONTROL` is ever looked at |
| A locator's value is personal — an email, a user name, a conversation title (`[data-user-email="…"]`) | Do not use it and do not write it into dom-notes. Take the next entry of that candidate's `locators`, or anchor on the parent: `<parent locator> > <tag>` |
| `composer` has a `visible: false` entry | Take the `visible: true` candidate's own `locators[0]`; never a selector that also matches the hidden twin |
| A candidate has `locators: []` | Anchor it: `<locator of an ancestor from messageLists> <tag>` |
| `summary.placeholderTurns` non-empty | Wait for the done signal first, then the count check (the template already does) |
| A `summary.placeholderTurns` entry's `shape` is matched by `summary.streamingCollection.selector` (same tag, and every attribute the selector names is in the shape). `verify()` cannot show this: the placeholder is gone before the turn ends | Exclude it with `:not([…])`. The attribute to use is the one present in the placeholder's `shape` and **absent** from the real assistant turn's `added[]` `shape`. Example: placeholder `article[data-placeholder][data-turn]`, real turn `article[data-message-id][data-turn]` → the attribute is `data-placeholder`, so `ASSISTANT_MESSAGE` becomes `article[data-turn="assistant"]:not([data-placeholder])` |
| An `added[]` row has `"isControl": true` | It is a control that came and went (a stop button), not a placeholder turn. No `:not(…)`, no entry in §Messages |
| `summary.streamingCollection.selector` is `null` (with a `note`) | No stable attribute or anchor describes the turn. Pick a container from `census().messageLists` and anchor manually: `<container locator> > <tag>`. Verify it in step 9 |
| `streamingCollection.count` counts the user turns too (the turns carry only a class, nothing telling user from assistant apart) | Run `census()` and look at one turn's children for a distinguishing descendant or attribute (`messageLists[n].childShape`, `dataAttrCensus`), and use `<container> > <tag>:has(<that descendant>)`. Confirm with `verify()` that the count is now half what it was. If nothing distinguishes them, record the limitation in §Messages, leave `ASSISTANT_MESSAGE` as the container's children, and note there that the count check in `waitForResponse` advances by two per turn |
| `buttonsSwapped` shows send gone → stop appeared → stop gone, and `doneCandidates[0]` is `button gone: …` | Done = the stop control gone. `STOP_BUTTON` is that selector. Do not wait for the send button to come back: many services render it only while the composer is non-empty |
| `attrs` shows a `data-state` / `aria-busy` flipping back at the end, and it is in `doneCandidates` | Done = that attribute's idle value. Take the `waitForResponse` VARIANT in `templates/src/provider.ts` — decision table **"state attribute"** |
| `doneCandidates` lists **both** a state attribute and a button swap | Prefer the state attribute for the done signal (VARIANT), and keep the button as `STOP_BUTTON` for `sendMessage`'s "generation started" wait |
| `doneCandidates` is empty | There is no done signal. Say so in §Generation indicator, leave `STOP_BUTTON` empty — the template then skips the done-signal wait with no code edit — and rely on the new turn's arrival and the stability read alone; `ASSISTANT_MESSAGE`'s placeholder exclusion (the row above on `placeholderTurns`) is then all that keeps a placeholder from being read as the answer — expect slower, occasionally truncated turns |
| Step 5 sent with Enter (5b) and `buttonsSwapped` has neither a `gone` row nor a `disabled` / `aria-disabled` `changed` row at the moment the user turn was added | Take the `sendMessage` VARIANT in `templates/src/provider.ts` — decision table **"no send button"** — `page.keyboard.press("Enter")`. Leave `SEND_BUTTON` empty — step 9 reports it as `skipped` — and say so in §Composer. Step 5 already sent this way, so you know it works |
| Step 5's `summary.sent` was `false` and the user sent by hand | Read `SEND_BUTTON` off the new record's `buttonsSwapped` as step 5 says (`gone` row, or `disabled` `changed` row). Only with neither: `SEND_BUTTON` = `locators[0]` of the step 4 `buttons` candidate that is the control the user named; if they pressed a key instead, leave it empty and adapt the **"no send button"** VARIANT to that key. Record in §Composer that Enter does not send. Verify in step 9 |
| `textGrowth` is empty after a long prompt | The reply is not streamed into the DOM (it is replaced whole), so there is no `streamingElement` and no `streamingCollection`. Take `ASSISTANT_MESSAGE` from the `added[]` row for the assistant turn instead: turn its **descriptive** `shape` into a selector the same way as for `USER_MESSAGE` (`article[data-message-id][data-turn]` → `article[data-turn="assistant"]`, dropping identity attributes), and confirm it in step 9 as a `many` selector whose `count` equals the number of replies on the page. Say in §Streaming behaviour that nothing grew; `streaming.responseText` still works off the count |
| `replyShape().chromeInsideContent` is non-empty | `ASSISTANT_MESSAGE_BODY` still takes `contentRootWithin` as printed; list the leaking chrome in §Streaming behaviour so the E2E's expectations are read with it in mind |
| `replyShape().contentRoot` is `null` while a reply is still streaming | `streaming.responseText` returns `undefined` until it exists — the template already returns `undefined` when the body matches nothing |
| `replyShape().codeLanguage` is `"header-label"` | The code language lives in a header label, not a class, so the fence comes out without it. Record it in §Streaming behaviour as a known loss and relax that line of the Markdown fidelity test |
| The Markdown reply carries a stray line just before a fence (the code header's label) | Known framework limitation: `elementToMarkdown` has no skip option. **Accept it** — record it in §Streaming behaviour; do not write a work-around into the provider. Assert Markdown *structure* in the E2E, never exact text |
| `lang` is not `en`, or button names are localized | Prefer `data-*` selectors over `aria-label` ones, and record the locale in §Chat page — a language change would otherwise break every label-based selector |
| `title` is `"Just a moment..."`, or the page is an IdP refusal | Keep `CHALLENGE_TITLE` as the interstitial's title, `detectBlock` returns `"challenge page"`, the CLI tells the user to try `--headful`. Record it in §Errors and rate limits. Bot-protection evasion is out of scope: no stealth plugins, no UA spoofing, no attaching to a personal Chrome profile |
| No new-chat control in `census().buttons`, or clicking it navigates (step 8's `url` changed) | New chat is a URL — decision table **"new chat is a URL"**. Leave `NEW_CHAT_BUTTON` empty: `startNewChat` in `templates/src/provider.ts` then navigates to `CHAT_URL` with no code edit. Only when new chat has a URL of its own, take the VARIANT there (a `NEW_CHAT_URL` constant in `src/selectors.ts`). Record the URL, not a selector, in §New chat; step 9 reports `NEW_CHAT_BUTTON` as `skipped` |
| `replyShape().contentRootWithin` is `""` (the reply element has no content child) | The turn element *is* the content. Set `ASSISTANT_MESSAGE_BODY` to the same value as `ASSISTANT_MESSAGE` and take the `newestBody` VARIANT in `templates/src/provider.ts` — decision table **"the reply has no content child"** — which drops the second `.locator()` call |
| `replyShape().contentRootWithin` is `null` | No structural selector reaches the content element first from inside the turn (for example it is the second of two `div` children). Use `ASSISTANT_MESSAGE`'s own value for `ASSISTANT_MESSAGE_BODY` with the `newestBody` VARIANT, and record in §Messages that the reply's chrome (`chrome`) will appear in the Markdown |
| The login page is on the chat page's own origin | Say so in §Login. The off-origin check in `isLoggedIn` is then a no-op and the sign-in / account pair decides alone. Do not replace the pair with a URL test |

## When a locator stops matching later

A service redesign breaks selectors silently — the symptom is a timeout, not an
error naming the selector.

1. Re-run step 9's calls on the logged-in chat page. `STOP_BUTTON` is not in
   them; step 5 re-derives it.
2. For every name with `ok: false`, re-run the one step that owns it: step 1
   for `ENTRY_URL`; step 4 for `CHAT_URL`, `SIGN_IN_CONTROL`, `ACCOUNT_CONTROL`,
   `COMPOSER`; step 5 for `SEND_BUTTON`, `STOP_BUTTON`, `ASSISTANT_MESSAGE`,
   `USER_MESSAGE`; step 6 for `ASSISTANT_MESSAGE_BODY`; step 8 for
   `NEW_CHAT_BUTTON`. `CHALLENGE_TITLE` changes only when the interstitial
   does.
3. Update the selector, the counts and the `Observed:` date in that
   `docs/dom-notes.md` section. An old date with a new selector is worse than
   no note.
