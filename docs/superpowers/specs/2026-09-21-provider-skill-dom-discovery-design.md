# Milestone 18: a self-contained DOM discovery kit for `creating-provider-repo`

Tracking issue: #113.

## Goal

A Sonnet-class model, working alone in a vendor repository with no larger model
to ask, can take a web chat service from "never seen" to a working provider by
following the skill. The judgment that a larger model would supply at run time
is baked into the skill ahead of time as scripts, templates and decision tables.

The step that fails today is DOM discovery, so that is where the work goes. The
rest of the skill is reorganised only as far as self-containment requires.

A second goal, added on review: the same model can bring an **existing** vendor
repository up to a newer framework version on a one-sentence instruction,
including features that need fresh DOM observation (Markdown replies,
streaming).

Non-goals: a discovery subagent definition, a Claude Code plugin, any change
to `@chatbridge/*` runtime code, bot-protection evasion
(`CLAUDE.md`), reading or exporting cookies or tokens.

## Facts this design rests on

Checked on 2026-09-21 against `@playwright/mcp@latest`:

- The MCP browser is **headed by default** (`--headless` is opt-in) and keeps
  its profile on disk unless `--isolated` is given. The current skill's claim
  that "Playwright MCP is headless and cannot take a human login" is wrong.
- `--user-data-dir <path>` picks the profile directory, `--init-script <path>`
  evaluates a JavaScript file in every page before the page's own scripts, and
  `--isolated --storage-state <path>` starts from a saved storage state.
- The skill is copied into a vendor repository's `.claude/skills/`, so it
  cannot reference any path inside `chatbridge-cli`.

## 1. Skill layout

```
.claude/skills/creating-provider-repo/
  SKILL.md               rules, layout, procedure, provider contract, traps
  dom-discovery.md       the Playwright MCP procedure and the decision table
  probes/
    chatbridge-probes.js one init script; installs window.__cbProbe
  templates/             files to copy, `<vendor>` / `<Vendor>` / `<VENDOR>` placeholders
    package.json  tsconfig.json  biome.json  gitignore  mcp.json
    src/selectors.ts  src/provider.ts  src/bin.ts
    src/selectors.test.ts  src/provider.test.ts  src/provider.e2e.test.ts
    docs/dom-notes.md
    CLAUDE.md  README.md
  vscode-extension.md    today's VSCode section, plus templates/vscode/*
```

`SKILL.md` keeps: Rules, Layout (now "copy `templates/`, then replace the
placeholders"), Procedure, Provider method contract, Traps. Target: at most
1,300 words (today 2,542). The `bin.ts` commentary moves into
`templates/src/bin.ts` as comments; "Runtime and shebang" stays as its table
and symptom line. Every reference to a `chatbridge-cli` path is replaced by a
file in the skill directory.

`templates/gitignore` and `templates/mcp.json` are stored without the leading
dot so they are neither ignored nor picked up as live config in this
repository; the procedure renames them.

`.agents/skills/` holds a stale second copy of both skills. It becomes a
symlink so the two cannot drift again (see §7.1 for where the source lives).

## 2. The probe script

One file, plain ES2020, no imports, loaded through `--init-script` so the model
never pastes code into a tool call. It installs `window.__cbProbe` and nothing
else. Every method returns JSON-serialisable data, reads structure only, and
never touches `document.cookie`, `localStorage`, `sessionStorage` or
IndexedDB. Text content is reduced to its length plus the first 40 characters,
so a transcript of probe output does not carry conversation bodies.

Calls from the model are one-liners: `browser_evaluate` with
`() => window.__cbProbe.census()`.

### `census()`

Returns candidates grouped by role, each with ready-to-use locators:

```ts
type Candidate = {
  locators: string[];      // best first; each matched exactly this element alone
  tag: string; role?: string; ariaLabel?: string; text?: string;
  visible: boolean;        // non-zero box, not display:none / visibility:hidden, no hidden ancestor
  unstable: string[];      // attributes rejected as locator material, with the reason
};
type Census = {
  url: string; title: string; lang: string;
  composer: Candidate[];   // textarea, [contenteditable], [role=textbox]
  buttons: Candidate[];    // button, [role=button], with an accessible name or data-* attribute
  account: Candidate[];    // name/label/testid matches account|profile|avatar|user|menu
  signIn: Candidate[];     // link or button whose name matches log in|sign in|sign up (+ ja: ログイン|サインイン)
  messageLists: { locator: string; children: number; childShape: string }[];
  stateAttrs: { locator: string; attr: string; value: string }[]; // data-state, aria-busy, data-*-status, …
  dataAttrCensus: Record<string, number>;                          // data-* attribute name → element count
};
```

Locator generation, in preference order: `[data-testid=…]` and other `data-*`
with a non-generated value, `#id` when the id is not generated, `role` +
accessible name, `[aria-label=…]`, `[name=…]`, `[placeholder=…]`. A value is
"generated" when it matches a hash-like pattern (`css-1a2b3c`, `sc-…`,
`:r1a:`, eight or more mixed hex characters, a UUID). Class names are never
emitted. A locator is listed only if `querySelectorAll` finds exactly one
element; a candidate with no unique locator is still returned, with
`locators: []`, so the model sees that it needs an ancestor-scoped locator.

`messageLists` finds containers whose direct children repeat one shape
(same tag and same set of `data-*` / role attributes) at least twice, or once
in a container with `role=log` / `aria-live`.

### `recordTurn.start()` / `recordTurn.stop()`

`start()` attaches one `MutationObserver` to `document.body` (subtree,
childList, attributes, characterData). `stop()` disconnects and returns:

```ts
type TurnRecord = {
  durationMs: number;
  added:   { t: number; locator: string; shape: string; removedAt?: number }[];
  attrs:   { t: number; locator: string; attr: string; from: string | null; to: string | null }[];
  textGrowth: { locator: string; firstAt: number; lastAt: number; updates: number; finalLength: number }[];
  buttonsSwapped: { t: number; gone?: string; appeared?: string }[];
  summary: {
    placeholderTurns: string[];   // added then removed within the turn
    streamingElement?: string;    // the textGrowth entry with the most updates
    doneCandidates: string[];     // state changes and button swaps whose last event is at or after streaming stopped, latest first
  };
};
```

`t` is milliseconds since `start()`. Events are capped at 2,000 with a
`truncated` flag; `characterData` events are folded into `textGrowth` instead
of being listed.

### `verify(selectors)`

Takes `{ name: selector | { selector, many: true } }` and returns, per name,
`{ count, visibleCount, ok }`. `ok` is `count === 1` for a plain selector and
`count >= 1` for a `many` one (message collections). `templates/src/selectors.ts`
exports a `MANY` list naming its collection selectors, so the call is built
mechanically. CSS selectors only; `templates/src/selectors.ts`
therefore holds CSS selectors, and role-based locators from the census are
written in their `[role=…][aria-label=…]` form.

## 3. `dom-discovery.md`

A fixed procedure. Each step names the tool call, what the human does, and
which `dom-notes.md` section it fills.

1. **Set up.** Copy `templates/mcp.json` to `.mcp.json`: `npx @playwright/mcp@latest
   --user-data-dir .auth/mcp-profile --init-script .claude/skills/creating-provider-repo/probes/chatbridge-probes.js`.
   `.auth/` is already git-ignored by the template. Restart Claude Code so the
   server loads. Alternative when the scaffolded CLI already logged in:
   `--isolated --storage-state <file printed by '<vendor> auth status'>`.
2. **Logged out.** `browser_navigate` to the entry URL, `census()`. Record
   `signIn` and whether a composer exists for guests → §Login.
3. **Human logs in** in the MCP window and says so. The model never types
   credentials and never asks for them.
4. **Logged in.** `census()` again. The login signal is what is in `account`
   now and was absent in step 2, together with the `signIn` control that
   disappeared → §Login, §Chat page, §Composer.
5. **One turn.** `recordTurn.start()`, send "Reply with the single word: ping"
   with `browser_type` + the send control, wait for the reply to finish by
   eye (`browser_snapshot`), `recordTurn.stop()` → §Messages, §Generation
   indicator, §Streaming behaviour.
6. **Second turn**, a prompt that streams for a few seconds. Confirms that the
   done signal repeats and answers "how is the new reply told apart from the
   previous turn's".
7. **New chat.** Find the control in `census().buttons`, click it, confirm the
   composer is empty → §New chat.
8. **Verify.** Fill `src/selectors.ts`, then `verify({...})` with its values on
   the logged-in chat page. Every entry must be `ok`. Record the date.

**Decision table** (probe output → what to write), absorbing today's Traps:

| Probe shows | Write |
|---|---|
| `composer` present in step 2 | Guest chat exists: login signal = account present AND sign-in absent |
| `composer` has a `visible: false` entry first | Scope the composer locator so it cannot match the hidden one |
| `summary.placeholderTurns` non-empty | Done signal first, then the count check |
| `buttonsSwapped` shows send → stop → (nothing) | Done = stop control gone; do not wait for send to return |
| `attrs` shows `data-state` / `aria-busy` flipping back at the end | Done = that attribute's idle value |
| `doneCandidates` empty | Fall back to the stability read alone; say so in dom-notes |
| `streamingElement` is set | Implement `streaming.responseText` on it, guarded by the busy state or the user/assistant count |
| `lang` is not `en`, or labels are localized | Prefer `data-*` over names; note the locale in dom-notes |
| A candidate has `locators: []` | Anchor on the nearest ancestor that has a unique locator |
| Title "Just a moment..." or an IdP refusal page | `detectBlock`; suggest `--headful`; no evasion |

**What never leaves the session**: probe output and snapshots can contain
conversation text and internal URLs. `dom-notes.md` records structure
(locators, attribute names, state values, timings), not content. Screenshots
are not committed.

## 4. Templates

`templates/src/provider.ts` is a complete implementation of the contract
written against the names in `templates/src/selectors.ts`: the off-origin
check and bounded visible-wait in `isLoggedIn`, the `WeakMap<Page, number>`
count in `sendMessage`, done-signal → count → stability read in
`waitForResponse`, `responseFormat: "markdown"` with `elementToMarkdown`, a
`streaming.responseText` guarded by the count, and `detectBlock` for the
challenge title. A service that matches the common shape needs only
`selectors.ts` filled in. Where services differ, the template carries a
`// VARIANT:` comment naming the decision-table row that selects the
alternative.

`templates/docs/dom-notes.md` has the eight sections, each with `Not yet
observed.` and the fields that step of the procedure must fill (locator,
match count, date).

The VSCode templates (`templates/vscode/`: `package.json`, `esbuild.mjs`,
`src/extension.ts`, `.vscodeignore`, `media/icon.svg`) are copies of
`examples/vscode-dummy-chat` with placeholders. A test asserts that the
template manifest's `contributes` stays equal to the example's after
substituting the id, so a framework change that adds a required contribution
fails `bun run check` until the template follows.

Version pins in `templates/package.json` are the placeholder `<latest>`; the
procedure resolves it with `npm view @chatbridge/cli version`, as today.

## 5. Test fixture: a realistic skin for the dummy chat

`examples/dummy-chat` is too easy to exercise any of this: every control has
an id. The server gains a second page, `/hard/chat` (and `/hard/login`), backed
by the same session and reply logic, whose DOM has the traps from the skill:

- no ids; class names of the `css-1x2y3z` kind; Japanese button labels with
  `data-testid` on some controls only
- a hidden `<textarea>` before a visible `contenteditable` composer
- a guest composer on the logged-out page, plus a sign-in link
- send button replaced by a stop button while generating; the send button is
  rendered only while the composer is non-empty
- a placeholder assistant element inserted on send and removed before the
  real one is appended
- replies streamed chunk by chunk, no `data-state` on the log

The existing `/chat` page and its tests are untouched.

## 6. Verification

**Automated, in `bun run check`** (`examples/dummy-chat/probes.test.ts`, real
Chromium, loading the probe file from the skill directory with
`context.addInitScript`):

- `census()` on `/hard/chat`: the visible composer has a unique locator and no
  class-based one; the hidden textarea is reported `visible: false`; logged-out
  vs logged-in census differ in `account` and `signIn`.
- `recordTurn` across one turn: `placeholderTurns` has one entry,
  `streamingElement` is the reply element, `doneCandidates[0]` is the stop
  button's disappearance.
- `verify()` flags a selector matching two elements and one matching none.
- The probe source contains none of `cookie`, `localStorage`,
  `sessionStorage`, `indexedDB`.
- `templates/src/provider.ts`, with selectors for `/hard/chat`, passes a
  two-turn conversation where the second answer differs from the first.
- Template type-check: the `templates/src/*.ts` files compile against the
  workspace packages.

**Skill test, by hand, recorded in the tracking issue** (writing-skills
RED/GREEN): a Sonnet subagent gets a scratch directory, the skill, a running
dummy server and the task "build a provider for `http://localhost:<port>/hard`".

- RED, current skill: record where it goes wrong (expected: guessed or
  class-based selectors, hidden textarea, placeholder turn returned).
- GREEN, new skill: `dom-notes.md` has all eight sections filled with unique
  locators, and the two-turn E2E passes. Three runs; variance between runs is
  noted.
- Each new failure becomes a decision-table row or a template fix, then the
  run is repeated.

The subagent drives Playwright MCP with the init script; the "human logs in"
step is played by the controller clicking the dummy login button.

## 7. Following new framework versions in an existing vendor repo

Two problems: the vendor's copy of the skill is as old as the day it was
copied, and nothing tells the model what a version bump asks of a provider.

### 7.1 The skills ship inside `@chatbridge/provider`

The source of truth moves to `packages/provider/skills/` and `"skills"` joins
that package's `files`. `.claude/skills/creating-provider-repo`,
`.claude/skills/upgrading-provider-repo` and `.agents/skills` in this
repository become symlinks into it. A vendor repository therefore always has
the skills that match its installed framework version, and refreshes its copy
with one command, run after every bump:

```sh
rm -rf .claude/skills/creating-provider-repo .claude/skills/upgrading-provider-repo
cp -R node_modules/@chatbridge/provider/skills/. .claude/skills/
```

A packaging test runs `bun pm pack --dry-run` for the package and asserts the
skill files are listed.

### 7.2 A second skill: `upgrading-provider-repo`

Description: "Use when bumping `@chatbridge/*` in an existing vendor provider
repository, or when asked to adopt a framework feature the provider does not
use yet (Markdown replies, streaming, slash commands, URL hooks, idle
timeout)." It shares `probes/` and `templates/` with the sibling skill by
relative path; the two are always copied together.

Procedure, fixed:

1. Read the current pin from `package.json`; `npm view @chatbridge/cli version`
   for the target. Bump every `@chatbridge/*` to the one exact target version
   and `playwright-core` to the runtime's, reinstall, run the nested-copy check.
2. Refresh the skills (7.1) and re-read this skill from the new copy.
3. Open `upgrade-guide.md`, take every entry above the old pin up to the
   target, oldest first. Do each entry's **Required** steps; list its
   **Optional** steps to the user and do the ones they pick.
4. Run each entry's **Verify** block, then `bun run check` and the gated E2E.
5. One commit per entry.

### 7.3 `upgrade-guide.md`

One entry per released version that changed anything a vendor sees, newest
first, in a fixed shape so the model never has to infer an action from
release notes:

```
## 0.10.0
Required: none.
Optional — Markdown replies
  Needs DOM observation: yes → dom-discovery.md step 5, then `replyShape()`
  Change: selectors.ts + provider.ts, exact diff against templates/src/provider.ts
  Verify: the Markdown fidelity E2E (templates/src/provider.e2e.test.ts)
Optional — Streaming …
VSCode manifest: none.
```

Entries are written back to 0.9.0 (slash commands, URL hooks, `<id>.reopen`,
view title bar, idle timeout, reduced motion); older vendors are told to
re-scaffold from the templates instead.

Keeping it current is a process rule, added to `CLAUDE.md` and to
`docs/PUBLISHING.md`: a PR that changes the `Provider` type, `createCli` /
`createExtension` options, or the required VSCode `contributes` adds its
`upgrade-guide.md` entry in the same PR. Detecting "this PR changed the
vendor-facing surface" is too indirect to test reliably, so it is a checklist
item of the whole-branch review. What is tested: the guide has an entry
heading for the current `packages/provider/package.json` minor version, even
if that entry says "Required: none. Optional: none."

### 7.4 Markdown support for the probe and the templates

- `window.__cbProbe.replyShape(selector?)` — for the newest reply element
  (or the given one): its tag census, which descendants are chrome rather than
  content (buttons, toolbars, code-block headers and language labels,
  "thinking" sections, citations), where the code language is carried (class on
  `<pre>` / `<code>`, a header label, nothing), and the smallest descendant
  that contains all content and no chrome. That descendant is the locator to
  hand to `elementToMarkdown`; text is again reported as lengths only.
- Decision-table rows: chrome inside the reply element → point the locator at
  the content child; language only in a header label → note it as a known
  loss; content child absent while streaming → `responseText` returns
  `undefined` until it exists.
- The E2E template gains a **Markdown fidelity** test: it asks the service to
  repeat a fixed sample (heading, nested list, fenced code with a language, a
  table, bold, a link) and asserts on structure (a `#` line, a fence with the
  language, a `|---|` row), never on exact text. The `/hard` skin renders its
  replies with a code-block header and a copy button so the automated tests
  cover the same path.

### 7.5 What the user types

New vendor: "Use the creating-provider-repo skill for `<service URL>`."
Existing vendor: "Bump `@chatbridge/*` to the latest and follow the
upgrading-provider-repo skill." For one feature: "… and adopt Markdown
replies." The README of `@chatbridge/provider` carries these three lines and
the refresh command.

## 8. Order of work

1. Spike: confirm `--init-script` + `browser_evaluate` + `--user-data-dir`
   behave as described, on the dummy chat. Adjust this spec if not.
2. `/hard` skin for the dummy chat.
3. RED baseline run with the current skill; post the findings to #113.
4. Probe script with its tests.
5. Templates with their tests.
6. `dom-discovery.md`, `vscode-extension.md`, slimmed `SKILL.md`.
7. Move the skills into `packages/provider/skills/`, symlinks, packaging test.
8. `upgrading-provider-repo` and `upgrade-guide.md` (entries back to 0.9.0),
   process rule in `CLAUDE.md` and `docs/PUBLISHING.md`.
9. GREEN runs, refactor loop. One extra scenario for the upgrade skill: a
   scratch vendor repo built from the text-only provider of step 3, task
   "adopt Markdown replies".
10. Whole-branch review, PR labelled `enhancement` (the published package
    changes).

## 9. As built — where the implementation departs from the sections above

The design held; these details changed under review and under the RED/GREEN
runs recorded in #113. Where this section and an earlier one disagree, this
section describes what shipped.

- **Two MCP servers (§3 step 1–2).** `templates/mcp.json` defines `playwright`
  (persistent profile, the human logs in here) and `playwright-guest`
  (`--isolated`, never logged in). The baseline showed that a profile that is
  already logged in makes the logged-out page unobservable and the login signal
  is then guessed wrong. The guest census runs on the entry URL (step 2) and
  again on `CHAT_URL` (step 4); the login signal is the difference between the
  guest and the member on `CHAT_URL`.
- **Step 5 decides how to send before sending.** No label matching: the visible
  buttons with an empty composer are compared with those after typing one
  character; one new button is the send control, none means Enter, several means
  asking the human. `SEND_BUTTON` / `STOP_BUTTON` come from the recording's
  `buttonsSwapped`; `STOP_BUTTON` is never `verify()`'d (it lives ~0.5 s).
- **Probe API (§2, §7.4).** `recordTurn.stop().summary` also carries
  `streamingCollection { selector, count, note? }` — the stable selector for
  every turn of that shape, the source of `ASSISTANT_MESSAGE`; `streamingElement`
  is an instance locator and is never copied — and `sent: boolean`. The
  observer ignores mutations inside a composer. `textGrowth[].collection`,
  `added[].isControl`, `attrs[].detached` exist. `replyShape()` also returns
  `contentRootWithin` (relative to the turn: the source of
  `ASSISTANT_MESSAGE_BODY`; `""` = the turn is the content, `null` = none).
  `verify()` accepts `{ selector, within, many? }` (evaluated inside the last
  match of `within`, so `:scope` works) and reports an empty selector as
  `skipped`. `ASSISTANT_MESSAGE_BODY` is not in `MANY`.
- **What never reaches probe output.** Beyond §2: a form control's value
  (only a `<textarea>`'s is read, as `{length, head}`), `value` / `data-value`
  attributes and mutations, per-turn identity attributes in collection or
  body selectors, ids and label attributes in `contentRootWithin`.
- **Templates (§4).** Tests skip while every selector is empty so a fresh
  scaffold passes `check`; `SEND_BUTTON`, `STOP_BUTTON`, `NEW_CHAT_BUTTON` and
  `SIGN_IN_CONTROL` may stay empty where a decision row says so (`isLoggedIn`
  guards the empty case). The template `biome.json` ignores `.auth` and
  `.playwright-mcp`: a formatter run once rewrote a live browser profile. The
  E2E template has a "a guest is not logged in" test. The pin placeholder is
  `<playwright-core>`, resolved from the runtime's `playwright` dependency.
- **Upgrade guide (§7.3).** No `0.10.1` entry: the release number is decided at
  release time. Entries 0.10.0 / 0.9.1 / 0.9.0; 0.10.0 has two Required items
  taken from its release notes. A section for repositories that predate the
  templates maps names by role and offers "Re-derive the login signal".
- **Verification (§6).** The skill runs used `claude -p --model sonnet` in an
  arena whose `.mcp.json` is the template's (plus `--headless`), not a
  subagent with an injected probe. Known limitation filed as #114
  (`elementToMarkdown` cannot skip a code-block header label).
