# Milestone 18: a self-contained DOM discovery kit for `creating-provider-repo`

Tracking issue: #113.

## Goal

A Sonnet-class model, working alone in a vendor repository with no larger model
to ask, can take a web chat service from "never seen" to a working provider by
following the skill. The judgment that a larger model would supply at run time
is baked into the skill ahead of time as scripts, templates and decision tables.

The step that fails today is DOM discovery, so that is where the work goes. The
rest of the skill is reorganised only as far as self-containment requires.

Non-goals: a discovery subagent definition, packaging the skill as a plugin or
npm package, any change to `@chatbridge/*` runtime code, bot-protection evasion
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
symlink to `../.claude/skills` so the two cannot drift again.

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

## 7. Order of work

1. Spike: confirm `--init-script` + `browser_evaluate` + `--user-data-dir`
   behave as described, on the dummy chat. Adjust this spec if not.
2. `/hard` skin for the dummy chat.
3. RED baseline run with the current skill; post the findings to #113.
4. Probe script with its tests.
5. Templates with their tests.
6. `dom-discovery.md`, `vscode-extension.md`, slimmed `SKILL.md`, `.agents` symlink.
7. GREEN runs, refactor loop.
8. Whole-branch review, PR labelled `documentation`.
