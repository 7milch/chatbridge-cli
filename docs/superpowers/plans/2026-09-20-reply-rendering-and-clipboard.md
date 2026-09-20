# Milestone 17 (v0.10.0): Reply Rendering and TUI Clipboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream and render assistant replies as Markdown in the interactive TUI, move the wait indicator into the history, add clipboard support (`/copy`, select-to-copy) and sticky input focus, and make teardown wait for an idle close that is still saving auth state.

**Architecture:** Providers opt in through two additive fields (`responseFormat`, `streaming.responseText`) and a shared `elementToMarkdown` DOM walker. Core polls `responseText` while the unchanged `waitForResponse` is pending and hands whole-text-so-far to an optional `onPartial`. The TUI keeps the in-flight reply outside the transcript (`ChatModel.partial`) and paints it as the last history row, promoting the same renderable to the settled message. Clipboard transport is one module with injected dependencies; `/copy` is a core built-in implemented by both UIs.

**Tech Stack:** TypeScript, Bun workspaces + `bun test`, Playwright (Chromium), `@opentui/core` 0.5.10 (`MarkdownRenderable`, selection API, `copyToClipboardOSC52`), Biome.

**Specs:** `docs/superpowers/specs/2026-09-20-reply-rendering-design.md` and `docs/superpowers/specs/2026-09-20-tui-clipboard-focus-design.md`. Executors read both.

## Global Constraints

- Tracking issue **#71**, branch **`issue-71`**. Never open another branch.
- Dependency direction is one-way: `cli → core → runtime → provider`. Never import in reverse. Core and Provider never depend on OpenTUI; `@opentui/core` stays lazily loaded and confined to `packages/cli/src/tui/`.
- Everything pushed is English: code comments, commit messages, docs, issue comments.
- TDD. `bun run check` must pass before every commit. Tests import cross-package code from `dist/`, so run `bun run build` after editing another package and before running a dependent package's tests.
- After **every** commit: `gh issue comment 71 --body "<what was committed> + What's next: <next task>"`. One comment per commit, never batched.
- Commit messages end with `(Refs #71)`.
- All new Provider fields are optional; existing providers must compile and behave unchanged.
- Streaming and Markdown display are TUI only. One-shot mode and the VSCode view never pass `onPartial`. The only VSCode changes are the #103 teardown fix (Task 2) and `/copy` (Task 11).
- No bot-protection evasion, no company-specific material, never log auth state or clipboard text.
- Match the surrounding comment density and idiom: doc comments explain *why*.

Model per task (CLAUDE.md policy): **Opus** for Tasks 1, 2, 4, 5, 6, 7, 8, 9, 11, 12, 13 (integration risk, multi-file judgment); **Sonnet** for Tasks 3, 10, 14 (code is fully given). Task reviews use the same model as the task. The final whole-branch review uses **Fable**.

## File Structure

| File | Responsibility |
|---|---|
| `docs/spike-notes/2026-09-20-opentui-markdown-selection.md` (new) | Verified OpenTUI facts the later tasks rely on |
| `packages/provider/src/index.ts` | `responseFormat`, `streaming`, validation, `copy` built-in name, re-export of the helper |
| `packages/provider/src/element-to-markdown.ts` (new) | `elementToMarkdown(locator)` and the in-page walker |
| `packages/runtime/src/element-to-markdown.e2e.test.ts` (new) | Real-Chromium tests of the walker |
| `packages/core/src/chat-session.ts` | `send(prompt, { onPartial })`, polling, `responseFormat`, `onIdleExpired(closing)` |
| `packages/core/src/slash-commands.ts` | `copy` row |
| `examples/dummy-chat/server.ts`, `provider.ts` | Incremental Markdown replies; reference streaming provider |
| `packages/cli/src/tui/chat-model.ts` | `partial`, `incomplete`, `format`, `idleClosing`, `/copy` |
| `packages/cli/src/tui/chat-view.ts` | Pending row, Markdown bodies, status line during a turn, selection copy, focus, flash status |
| `packages/cli/src/tui/theme.ts` | `markdownSyntaxStyle()` |
| `packages/cli/src/tui/clipboard.ts` (new) | Clipboard transport, no OpenTUI import |
| `packages/cli/src/tui/run-interactive.ts` | Teardown waits for `idleClosing`; binds clipboard to the renderer |
| `packages/vscode/src/session-controller.ts` | `idleClosing`, `lastReply()` |
| `packages/vscode/src/commands.ts`, `protocol.ts`, `chat-view-bridge.ts`, `create-extension.ts`, `webview/main.ts` | `/copy` wiring |

---

### Task 1: Verify the OpenTUI facts the plan relies on (Opus)

The plan assumes five things about `@opentui/core` 0.5.10. Verify each with a throwaway script under the scratch directory (not committed) and the test renderer, and record the results. Later tasks read this note.

**Files:**
- Create: `docs/spike-notes/2026-09-20-opentui-markdown-selection.md`

**Interfaces:**
- Produces: a note with a verified answer to each question below. Tasks 8, 9, 12 and 13 cite it.

- [ ] **Step 1: Answer these questions, each with the evidence (script output or `.d.ts` line)**

1. **Markdown in the test renderer.** With `createTestRenderer({ width: 60, height: 20 })` from `@opentui/core/testing`, add `new MarkdownRenderable(renderer, { content: "# Title\n\n- **bold** item\n\n```ts\nconst a = 1;\n```", syntaxStyle: SyntaxStyle.create(), conceal: true })` to `renderer.root`, `await t.renderOnce()` (several times if needed) and print `t.captureCharFrame()`. Does the frame contain `Title`, `bold item` and `const a = 1;` without `#`, `**` or the fence? How many `renderOnce()` calls until it does (tree-sitter is async)?
2. **Streaming mode.** Set `md.streaming = true`, assign `md.content` three times with a growing string that ends inside an open code fence, render, then set the final content and `md.streaming = false`. Does each frame show the text so far, and does the final frame equal a non-streaming render of the same content?
3. **Tree-sitter under both runtimes.** Run the script of question 1 with `bun` and with `node` (>= 26.4, via `node --experimental-strip-types` or the built `dist`). Does the code block get highlight colours (inspect `t.captureSpans()` or the equivalent span capture in `@opentui/core/testing`), and does anything throw or log when the tree-sitter worker cannot load? Record what happens with `treeSitterClient` omitted.
4. **Mouse and selection.** Is `useMouse` on by default for `createCliRenderer({ exitOnCtrlC: false })`? When does the renderer emit `"selection"` (`CliRenderEvents.SELECTION`): on every drag move or once on mouse up? What is the payload — a `Selection` with `getSelectedText()`? Does `selectable: false` on a `TextRenderable` exclude its text from `getSelectedText()`? Use the test renderer's mock mouse (`t.mockMouse.drag(...)`) to check.
5. **Focus.** What moves focus away from the textarea on a click: the renderer's `autoFocus` option (see `CliRendererConfig.autoFocus`)? Does `createCliRenderer({ exitOnCtrlC: false, autoFocus: false })` keep focus on the input after clicking the history, while wheel scrolling of the `ScrollBoxRenderable` still works? Does `Renderable` emit `"blurred"` (`RenderableEvents.BLURRED`) when it loses focus? Do PgUp/PgDn scroll the history today while the textarea has focus?

- [ ] **Step 2: Write the note**

`docs/spike-notes/2026-09-20-opentui-markdown-selection.md`, in English, one `##` section per question: the answer in one or two sentences, then the evidence. End with a `## Consequences for the plan` section listing any task whose approach must change (for example "Task 13 uses `autoFocus: false`" or "Task 13 uses the `blurred` refocus").

- [ ] **Step 3: Commit and sync**

```bash
bun run check
git add docs/spike-notes/2026-09-20-opentui-markdown-selection.md
git commit -m "docs: verify OpenTUI markdown, selection and focus behaviour (Refs #71)"
gh issue comment 71 --body "Task 1 done: OpenTUI facts verified and recorded in docs/spike-notes/2026-09-20-opentui-markdown-selection.md (tree-sitter under Bun/Node: <result>; selection event: <result>; focus: <result>). What's next: Task 2, #103 idle close hand-over."
```

---

### Task 2: Idle expiry hands over the in-flight close (#103) (Opus)

**Files:**
- Modify: `packages/core/src/chat-session.ts` (`ChatSessionOptions.onIdleExpired`, `startIdleWatch`, `expireIdle`)
- Modify: `packages/cli/src/tui/chat-model.ts` (`ChatModelOptions.openSession`, `open`, `idleExpired`, new `idleClosing`)
- Modify: `packages/cli/src/tui/test-helpers.ts` (types only, follows `ChatModelOptions`)
- Modify: `packages/cli/src/tui/run-interactive.ts` (teardown)
- Modify: `packages/vscode/src/session-controller.ts` (`SessionControllerOptions.openSession`, `open`, `idleExpired`, `close`, new `idleClosing`)
- Test: `packages/core/src/chat-session.test.ts`, `packages/cli/src/tui/chat-model.test.ts`, `packages/cli/src/tui/run-interactive.test.ts`, `packages/vscode/src/session-controller.test.ts`

**Interfaces:**
- Produces: `ChatSessionOptions.onIdleExpired?: (closing: Promise<void>) => void` — `closing` resolves when the idle close (or its kill fallback) has finished and never rejects.
- Produces: `ChatModel.idleClosing: Promise<void> | undefined`, `SessionController` awaits its own copy in `close()`.

- [ ] **Step 1: Write the failing core tests**

In `packages/core/src/chat-session.test.ts`, inside `describe("ChatSession: idle close", ...)`, add:

```ts
test("onIdleExpired receives a promise that settles only after the close", async () => {
  const h = harness();
  const c = clock();
  const { options } = idleOpts(h, c);
  let closing: Promise<void> | undefined;
  let closedWhenTold = -1;
  await ChatSession.open({
    ...options,
    onIdleExpired: (p) => {
      closing = p;
      closedWhenTold = h.closed;
    },
  });
  c.advance(IDLE_MS + 1);
  await waitFor(() => closing !== undefined, "the expiry callback");
  // Told first: nothing was closed yet when the UI heard about it.
  expect(closedWhenTold).toBe(0);
  await closing;
  expect(h.closed).toBe(1);
  expect(h.saved).toBe(1);
});

test("the closing promise resolves after the kill fallback and never rejects", async () => {
  const h = harness();
  const c = clock();
  const { options } = idleOpts(h, c);
  let closing: Promise<void> | undefined;
  await ChatSession.open({
    ...options,
    onIdleExpired: (p) => {
      closing = p;
    },
  });
  h.loginGate = new Promise<void>(() => {}); // close() parks forever
  c.advance(IDLE_MS + 1);
  await waitFor(() => closing !== undefined, "the expiry callback");
  await expect(closing).resolves.toBeUndefined();
  expect(h.killed).toBe(1);
}, 20_000);
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test packages/core -t "closing promise"` and `-t "settles only after"`
Expected: FAIL — `p` is `undefined` (the callback takes no argument today), TypeScript error on the parameter.

- [ ] **Step 3: Implement in core**

In `ChatSessionOptions`:

```ts
  /** Called synchronously when the idle period expires, before anything is
   * awaited, so the UI has dropped its reference by the time the browser
   * starts closing. `closing` settles when that close (or its kill fallback)
   * has finished, and never rejects: a UI that is torn down meanwhile waits
   * for it, so the process does not exit under the auth-state save. */
  onIdleExpired?: (closing: Promise<void>) => void;
```

Replace `expireIdle`:

```ts
  private async expireIdle(
    timeoutMs: number,
    onIdleExpired: ((closing: Promise<void>) => void) | undefined,
  ): Promise<void> {
    let settle!: () => void;
    const closing = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      onIdleExpired?.(closing);
      this.onProgress?.(
        `Closing the browser after ${formatIdleDuration(timeoutMs)} idle...`,
      );
      await closeOrKill(this, IDLE_CLOSE_BUDGET_MS);
    } finally {
      settle();
    }
  }
```

Keep the existing doc comment above it and add one sentence: "The UI also gets the promise of this close, because it no longer holds the session to join it."

- [ ] **Step 4: Run the core tests**

Run: `bun test packages/core`
Expected: PASS, including the existing idle tests (their `onIdleExpired: () => events.push("expired")` still type-checks).

- [ ] **Step 5: Write the failing TUI model test**

In `packages/cli/src/tui/chat-model.test.ts`, next to the existing idle-expiry tests (search for `idleClosed`), add:

```ts
test("idle expiry keeps the in-flight close reachable until it settles", async () => {
  let expire: ((closing: Promise<void>) => void) | undefined;
  let settle!: () => void;
  const closing = new Promise<void>((r) => {
    settle = r;
  });
  const session: ChatSessionLike = {
    send: async () => "ok",
    close: async () => {},
    kill: async () => {},
  };
  const model = new ChatModel({
    login: async () => {},
    clearAuth: async () => {},
    openSession: async (_report, onIdleExpired) => {
      expire = onIdleExpired;
      return session;
    },
  });
  await model.ready;
  expire?.(closing);
  expect(model.session).toBeUndefined();
  expect(model.idleClosing).toBe(closing);
  settle();
  await closing;
  await Promise.resolve();
  expect(model.idleClosing).toBeUndefined();
});
```

- [ ] **Step 6: Implement in `chat-model.ts`**

Change both `openSession` signatures (the option and the private field) to `onIdleExpired: (closing: Promise<void>) => void`. Add the field next to `idleClosed`:

```ts
  /** The idle close core is still running, if any. The model has already
   * dropped that session, so this is the only handle teardown has to wait
   * for the auth-state save. Cleared once it settles. */
  idleClosing: Promise<void> | undefined;
```

In `open()`:

```ts
    const session = await this.openSession(report, (closing) => {
      if (holder.opened !== undefined) this.idleExpired(holder.opened, closing);
    });
```

In `idleExpired(session, closing)` after the stale check:

```ts
    this.current = undefined;
    this.idleClosed = true;
    this.idleClosing = closing;
    void closing.then(() => {
      if (this.idleClosing === closing) this.idleClosing = undefined;
    });
    this.onChange();
```

Update the `openSession` doc comment in `ChatModelOptions` to mention the promise. `test-helpers.ts` needs no code change beyond what the types force.

- [ ] **Step 7: Write the failing teardown test**

In `packages/cli/src/tui/run-interactive.test.ts`, follow the existing teardown tests (they pass `createSession` and `createRenderer` and drive Ctrl+C through the test renderer). Add a test where `createSession` captures `onIdleExpired`, the test calls it with a deferred promise, then quits; assert that `runInteractive` has **not** resolved after 50 ms, resolve the deferred, and assert it resolves. Add a second test with a never-settling promise and a stubbed `process.exit` (the file already stubs it for the close-timeout test — reuse that helper) asserting exit code 1 and the message `browser did not close within 5 s; exiting\n`. If `CLOSE_TIMEOUT_MS` is not injectable in this file's existing timeout test, follow whatever that test does to keep the run short.

- [ ] **Step 8: Implement in `run-interactive.ts`**

In the `finally`, after `const settled = await settleReset(...)`:

```ts
    // The idle close may still be saving the rotated auth state; the model
    // no longer holds that session, only the promise of its close.
    const idleSettled = await settleReset(model?.idleClosing);
    const open = model?.session;
    const closed =
      settled &&
      idleSettled &&
      (open === undefined || (await closeWithTimeout(open, CLOSE_TIMEOUT_MS)));
```

`settleReset` already caps a wait at `CLOSE_TIMEOUT_MS` and never rejects; update its doc comment to say it is used for the idle close too.

- [ ] **Step 9: VSCode — failing test, then implementation**

In `packages/vscode/src/session-controller.test.ts`, next to the existing idle tests, add: open a session through a first `send`, capture `onIdleExpired`, call it with a deferred, call `controller.close()`, assert it is pending after 20 ms, resolve, assert it resolves. Add the never-settling variant with `closeTimeoutMs: 30` asserting `close()` resolves anyway.

In `session-controller.ts`: `openSession: (onIdleExpired: (closing: Promise<void>) => void) => Promise<ChatSessionLike>`; field `private idleClosing: Promise<void> | undefined;`; `open()` passes `(closing) => { if (opened !== undefined) this.idleExpired(opened, closing); }`; `idleExpired` stores it and clears it on settle exactly as the model does; in `close()` before `dropSession()`:

```ts
    await this.settleIdleClose();
```

```ts
  /** Waits for an idle close still in flight, capped like every other
   * close here: deactivate must not hang on a wedged browser. */
  private async settleIdleClose(): Promise<void> {
    const closing = this.idleClosing;
    if (closing === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closing,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.closeTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
```

`create-extension.ts` passes `onIdleExpired` straight through to `ChatSession.open`; confirm it still type-checks.

- [ ] **Step 10: Check, commit, sync**

```bash
bun run check
git add -A packages/core packages/cli packages/vscode
git commit -m "fix: teardown waits for an idle close that is still saving auth state (Refs #71, #103)"
gh issue comment 71 --body "Task 2 done (#103): onIdleExpired now receives the in-flight close promise; the TUI teardown and the VSCode deactivate wait for it under their existing 5 s budgets. What's next: Task 3, Provider contract fields."
```

---

### Task 3: Provider contract — `responseFormat` and `streaming` (Sonnet)

**Files:**
- Modify: `packages/provider/src/index.ts`
- Test: `packages/provider/src/index.test.ts`

**Interfaces:**
- Produces: `Provider.responseFormat?: "markdown" | "text"`, `Provider.streaming?: ProviderStreaming`, exported `interface ProviderStreaming { responseText(page: Page): Promise<string | undefined>; pollIntervalMs?: number }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/provider/src/index.test.ts` (reuse the file's existing minimal-provider factory; if it is called something other than `base()`, use that name):

```ts
describe("defineProvider: responseFormat and streaming", () => {
  test("accepts markdown, text and a streaming block", () => {
    expect(() =>
      defineProvider({
        ...base(),
        responseFormat: "markdown",
        streaming: { responseText: async () => undefined, pollIntervalMs: 100 },
      }),
    ).not.toThrow();
    expect(() => defineProvider({ ...base(), responseFormat: "text" })).not.toThrow();
  });

  test("rejects an unknown responseFormat", () => {
    expect(() =>
      defineProvider({ ...base(), responseFormat: "html" as never }),
    ).toThrow('Provider responseFormat must be "markdown" or "text", got "html".');
  });

  test("rejects streaming without a responseText function", () => {
    expect(() =>
      defineProvider({ ...base(), streaming: {} as never }),
    ).toThrow("Provider streaming.responseText must be a function.");
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects pollIntervalMs %p",
    (ms) => {
      expect(() =>
        defineProvider({
          ...base(),
          streaming: { responseText: async () => "", pollIntervalMs: ms },
        }),
      ).toThrow(
        `Provider streaming.pollIntervalMs must be a finite number greater than 0, got ${ms}.`,
      );
    },
  );
});
```

- [ ] **Step 2: Run and see them fail**

Run: `bun test packages/provider`
Expected: FAIL (type errors / no throw).

- [ ] **Step 3: Implement**

Above `Provider`:

```ts
/** Lets interactive UIs show the reply while it is being written. Core polls
 * `responseText` while `waitForResponse` is pending; completion, the final
 * text and timeouts still come from `waitForResponse`. */
export interface ProviderStreaming {
  /** Text so far of the reply to the most recent `sendMessage`, in
   * `responseFormat`. `undefined` while only a placeholder exists. Must
   * never return an earlier turn's text. */
  responseText(page: Page): Promise<string | undefined>;
  /** Poll interval in ms. Default 250. */
  pollIntervalMs?: number;
}
```

In `Provider`, after `detectBlock`:

```ts
  /** Optional. What `waitForResponse` (and `streaming.responseText`) return.
   * "text" (default) is shown verbatim. "markdown" is rendered as Markdown
   * by UIs that support it; `elementToMarkdown` produces it from the DOM. */
  responseFormat?: "markdown" | "text";
  /** Optional. See ProviderStreaming. */
  streaming?: ProviderStreaming;
```

In `defineProvider`, before `return provider;`:

```ts
  const format = provider.responseFormat;
  if (format !== undefined && format !== "markdown" && format !== "text") {
    throw new Error(
      `Provider responseFormat must be "markdown" or "text", got ${JSON.stringify(format)}.`,
    );
  }
  if (provider.streaming !== undefined) {
    if (typeof provider.streaming.responseText !== "function") {
      throw new Error("Provider streaming.responseText must be a function.");
    }
    const poll = provider.streaming.pollIntervalMs;
    if (poll !== undefined && (!Number.isFinite(poll) || poll <= 0)) {
      throw new Error(
        `Provider streaming.pollIntervalMs must be a finite number greater than 0, got ${poll}.`,
      );
    }
  }
```

- [ ] **Step 4: Run, check, commit, sync**

```bash
bun test packages/provider
bun run check
git add packages/provider
git commit -m "feat: provider responseFormat and streaming contract fields (Refs #71)"
gh issue comment 71 --body "Task 3 done: Provider gains optional responseFormat and streaming.responseText with defineProvider validation. What's next: Task 4, elementToMarkdown helper."
```

---

### Task 4: `elementToMarkdown` (Opus)

**Files:**
- Create: `packages/provider/src/element-to-markdown.ts`
- Modify: `packages/provider/src/index.ts` (re-export)
- Create: `packages/runtime/src/element-to-markdown.e2e.test.ts`

**Interfaces:**
- Produces: `elementToMarkdown(locator: Locator): Promise<string>` exported from `@chatbridge/provider`. `Locator` is Playwright's type; import it the same way `index.ts` imports `Page` (type-only), and export the type alongside `Page`.

- [ ] **Step 1: Write the failing E2E test**

`packages/runtime/src/element-to-markdown.e2e.test.ts`. Launch Chromium the way `browser-runtime.e2e.test.ts` does (reuse its launch helper / `chromium.launch()` pattern and its `beforeAll`/`afterAll`), then:

```ts
async function md(html: string): Promise<string> {
  await page.setContent(`<div id="root">${html}</div>`);
  return elementToMarkdown(page.locator("#root"));
}

const CASES: Array<[name: string, html: string, expected: string]> = [
  ["headings", "<h1>A</h1><h3>B</h3>", "# A\n\n### B"],
  ["paragraphs collapse whitespace", "<p>one\n   two</p><p>three</p>", "one two\n\nthree"],
  ["inline marks", "<p><strong>b</strong> <em>i</em> <del>d</del> <b>b2</b> <i>i2</i></p>", "**b** *i* ~~d~~ **b2** *i2*"],
  ["inline code", "<p>run <code>ls -la</code></p>", "run `ls -la`"],
  ["inline code containing a backtick", "<p><code>a`b</code></p>", "``a`b``"],
  ["fenced code with language", '<pre><code class="language-ts">const a = 1;\nconst b = 2;\n</code></pre>', "```ts\nconst a = 1;\nconst b = 2;\n```"],
  ["pre without code, lang- class on pre", '<pre class="lang-sh">echo hi</pre>', "```sh\necho hi\n```"],
  ["code containing a fence", "<pre><code>```\nx\n```</code></pre>", "````\n```\nx\n```\n````"],
  ["unordered list", "<ul><li>a</li><li>b</li></ul>", "- a\n- b"],
  ["ordered list with start", '<ol start="3"><li>a</li><li>b</li></ol>', "3. a\n4. b"],
  ["nested lists", "<ul><li>a<ul><li>a1</li></ul></li><li>b<ol><li>b1</li></ol></li></ul>", "- a\n  - a1\n- b\n  1. b1"],
  ["blockquote", "<blockquote><p>q1</p><p>q2</p></blockquote>", "> q1\n>\n> q2"],
  ["link", '<p><a href="https://example.com/x">site</a></p>', "[site](https://example.com/x)"],
  ["javascript: link is bare text", '<p><a href="javascript:void(0)">x</a></p>', "x"],
  ["table", "<table><thead><tr><th>h1</th><th>h2</th></tr></thead><tbody><tr><td>a|b</td><td>c</td></tr></tbody></table>", "| h1 | h2 |\n| --- | --- |\n| a\\|b | c |"],
  ["hr and br", "<p>a<br>b</p><hr><p>c</p>", "a\nb\n\n---\n\nc"],
  ["image", '<p><img alt="logo" src="https://example.com/l.png"></p>', "![logo](https://example.com/l.png)"],
  ["copy button and icons are skipped", '<div><button>Copy</button><svg><text>x</text></svg><span aria-hidden="true">#</span><p>kept</p></div>', "kept"],
  ["unknown elements pass their children through", "<section><span>a</span><custom-el>b</custom-el></section>", "ab"],
  ["no triple blank lines", "<p>a</p><div></div><div></div><p>b</p>", "a\n\nb"],
];

for (const [name, html, expected] of CASES) {
  test(name, async () => {
    expect(await md(html)).toBe(expected);
  });
}
```

- [ ] **Step 2: Run and see it fail**

Run: `bun run build && bun test packages/runtime -t "headings"`
Expected: FAIL — `elementToMarkdown` is not exported.

- [ ] **Step 3: Implement**

`packages/provider/src/element-to-markdown.ts`:

```ts
import type { Locator } from "playwright";

/** Markdown for the element's subtree, for providers that declare
 * `responseFormat: "markdown"`. Web chat services render Markdown to HTML,
 * and `textContent` flattens it; this walks the DOM back into Markdown.
 * Plain text is not escaped: a reply showing a literal `*` keeps it, and the
 * rare mis-render is accepted over escape noise in copied text. */
export function elementToMarkdown(locator: Locator): Promise<string> {
  return locator.evaluate(walk);
}

/** Runs inside the page: Playwright serialises this one function, so it may
 * not reference anything outside its own body. */
function walk(root: Element): string {
  const SKIP = new Set(["BUTTON", "SVG", "SCRIPT", "STYLE", "NOSCRIPT"]);
  const BLOCK = new Set([
    "P", "DIV", "SECTION", "ARTICLE", "UL", "OL", "LI", "PRE", "BLOCKQUOTE",
    "TABLE", "HR", "H1", "H2", "H3", "H4", "H5", "H6",
  ]);

  const fence = (text: string, min: number): string => {
    let longest = 0;
    for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
    return "`".repeat(Math.max(min, longest + 1));
  };

  const language = (el: Element): string => {
    for (const node of [el, el.querySelector("code")]) {
      for (const cls of Array.from(node?.classList ?? [])) {
        const m = /^(?:language|lang)-(.+)$/.exec(cls);
        if (m?.[1]) return m[1];
      }
    }
    return "";
  };

  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent ?? "").replace(/\s+/g, " ");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || el.getAttribute("aria-hidden") === "true") return "";
    const inner = () => Array.from(el.childNodes).map(inline).join("");
    switch (tag) {
      case "BR":
        return "\n";
      case "STRONG":
      case "B":
        return `**${inner().trim()}**`;
      case "EM":
      case "I":
        return `*${inner().trim()}*`;
      case "DEL":
      case "S":
        return `~~${inner().trim()}~~`;
      case "CODE": {
        const text = el.textContent ?? "";
        const f = fence(text, 1);
        const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
        return `${f}${pad}${text}${pad}${f}`;
      }
      case "A": {
        const href = el.getAttribute("href") ?? "";
        const text = inner().trim();
        if (href === "" || /^\s*javascript:/i.test(href)) return text;
        return `[${text}](${href})`;
      }
      case "IMG":
        return `![${el.getAttribute("alt") ?? ""}](${el.getAttribute("src") ?? ""})`;
      default:
        // A block nested in inline context (a <p> inside an <li>): its
        // blocks, joined, so the caller can indent them.
        return BLOCK.has(tag) ? blocks(el).join("\n\n") : inner();
    }
  };

  const indent = (text: string, pad: string): string =>
    text
      .split("\n")
      .map((line, i) => (i === 0 || line === "" ? line : pad + line))
      .join("\n");

  const list = (el: Element, ordered: boolean): string => {
    let n = Number(el.getAttribute("start") ?? "1");
    if (!Number.isFinite(n)) n = 1;
    const items: string[] = [];
    for (const li of Array.from(el.children)) {
      if (li.tagName.toUpperCase() !== "LI") continue;
      const marker = ordered ? `${n++}. ` : "- ";
      const body = blocks(li).join("\n");
      items.push(marker + indent(body, " ".repeat(marker.length)));
    }
    return items.join("\n");
  };

  const table = (el: Element): string => {
    const rows = Array.from(el.querySelectorAll("tr")).map((tr) =>
      Array.from(tr.children).map((cell) =>
        inline(cell).trim().replace(/\|/g, "\\|").replace(/\n/g, " "),
      ),
    );
    const [head, ...body] = rows;
    if (!head) return "";
    const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
    return [line(head), line(head.map(() => "---")), ...body.map(line)].join("\n");
  };

  /** The element's content as a list of Markdown blocks. Inline runs between
   * block children become paragraphs of their own. */
  function blocks(el: Element): string[] {
    const out: string[] = [];
    let run = "";
    const flush = () => {
      const text = run
        .split("\n")
        .map((l) => l.trim())
        .join("\n")
        .trim();
      if (text) out.push(text);
      run = "";
    };
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType !== Node.ELEMENT_NODE) {
        run += inline(child);
        continue;
      }
      const c = child as Element;
      const tag = c.tagName.toUpperCase();
      if (SKIP.has(tag) || c.getAttribute("aria-hidden") === "true") continue;
      if (!BLOCK.has(tag)) {
        run += inline(c);
        continue;
      }
      flush();
      const heading = /^H([1-6])$/.exec(tag);
      if (heading) {
        out.push(`${"#".repeat(Number(heading[1]))} ${inline2(c)}`);
      } else if (tag === "PRE") {
        const text = (c.textContent ?? "").replace(/\n$/, "");
        const f = fence(text, 3);
        out.push(`${f}${language(c)}\n${text}\n${f}`);
      } else if (tag === "UL" || tag === "OL") {
        const text = list(c, tag === "OL");
        if (text) out.push(text);
      } else if (tag === "BLOCKQUOTE") {
        const text = blocks(c).join("\n\n");
        if (text) {
          out.push(
            text
              .split("\n")
              .map((l) => (l === "" ? ">" : `> ${l}`))
              .join("\n"),
          );
        }
      } else if (tag === "TABLE") {
        const text = table(c);
        if (text) out.push(text);
      } else if (tag === "HR") {
        out.push("---");
      } else {
        out.push(...blocks(c));
      }
    }
    flush();
    return out;
  }

  /** Inline content of a block whose children are all inline (a heading). */
  function inline2(el: Element): string {
    return Array.from(el.childNodes).map(inline).join("").trim();
  }

  return blocks(root).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}
```

In `index.ts`: `export { elementToMarkdown } from "./element-to-markdown.js";` and export the `Locator` type next to `Page`, imported the same way `Page` is. If `packages/provider` declares `playwright` only as a type/peer dependency, follow that — add nothing to `dependencies`.

The test table is the contract. Where the code above and a test case disagree, fix the code, not the expectation; the nested-list and blockquote cases are the likeliest to need adjustment (a `LI` whose nested list must sit on its own line under the item text: `blocks(li).join("\n")`).

- [ ] **Step 4: Run to green**

Run: `bun run build && bun test packages/runtime -t ""` (whole package)
Expected: all cases PASS.

- [ ] **Step 5: Check, commit, sync**

```bash
bun run check
git add packages/provider packages/runtime
git commit -m "feat: elementToMarkdown helper for Markdown-returning providers (Refs #71)"
gh issue comment 71 --body "Task 4 done: @chatbridge/provider exports elementToMarkdown(locator), a dependency-free in-page DOM walker, covered by real-Chromium tests in packages/runtime. What's next: Task 5, core polling and onPartial."
```

---

### Task 5: Core polling — `send(prompt, { onPartial })` (Opus)

**Files:**
- Modify: `packages/core/src/chat-session.ts`
- Modify: `packages/core/src/index.ts` (export `SendOptions`, `DEFAULT_POLL_INTERVAL_MS`)
- Test: `packages/core/src/chat-session.test.ts`

**Interfaces:**
- Consumes: `Provider.streaming`, `Provider.responseFormat` (Task 3).
- Produces:
  - `export interface SendOptions { onPartial?: (textSoFar: string) => void }`
  - `ChatSession.send(prompt: string, opts?: SendOptions): Promise<string>`
  - `ChatSession.responseFormat: "markdown" | "text"` (getter)
  - `ChatSessionOptions.pollSleep?: (ms: number) => Promise<void>` (test only)
  - `export const DEFAULT_POLL_INTERVAL_MS = 250`

- [ ] **Step 1: Write the failing tests**

Add a `describe("ChatSession: streaming partials", ...)`. The existing `harness()` records each `waitForResponse` deferred in `h.replies`. Add streaming to a harness per test by assigning `h.provider.streaming`. Use a manual sleep gate:

```ts
/** A pollSleep the test releases one tick at a time. */
function gate() {
  const waiting: Array<() => void> = [];
  return {
    sleep: () => new Promise<void>((r) => waiting.push(r)),
    /** Releases one pending sleep and lets the poll body run. */
    async tick() {
      await waitFor(() => waiting.length > 0, "a pending poll sleep");
      waiting.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    },
    get pending() {
      return waiting.length;
    },
  };
}

test("emits only when the text changes, skips undefined, returns the final text", async () => {
  const h = harness();
  const g = gate();
  const texts: Array<string | undefined> = [undefined, "He", "He", "Hello"];
  h.provider.streaming = { responseText: async () => texts.shift() };
  const session = await ChatSession.open({ ...opts(h), pollSleep: g.sleep });
  const seen: string[] = [];
  const reply = session.send("hi", { onPartial: (t) => seen.push(t) });
  for (let i = 0; i < 4; i++) await g.tick();
  expect(seen).toEqual(["He", "Hello"]);
  h.replies[0]?.resolve("Hello, world");
  expect(await reply).toBe("Hello, world");
  await session.close();
});

test("never emits after the turn settled", async () => {
  const h = harness();
  const g = gate();
  h.provider.streaming = { responseText: async () => "late" };
  const session = await ChatSession.open({ ...opts(h), pollSleep: g.sleep });
  const seen: string[] = [];
  const reply = session.send("hi", { onPartial: (t) => seen.push(t) });
  await waitFor(() => g.pending === 1, "the first sleep");
  h.replies[0]?.resolve("done");
  await reply;
  await g.tick();
  expect(seen).toEqual([]);
  await session.close();
});

test("a responseText or onPartial that throws does not fail the turn", async () => {
  const h = harness();
  const g = gate();
  let calls = 0;
  h.provider.streaming = {
    responseText: async () => {
      calls++;
      if (calls === 1) throw new Error("detached");
      return "ok";
    },
  };
  const session = await ChatSession.open({ ...opts(h), pollSleep: g.sleep });
  const reply = session.send("hi", {
    onPartial: () => {
      throw new Error("ui bug");
    },
  });
  await g.tick();
  await g.tick();
  h.replies[0]?.resolve("final");
  expect(await reply).toBe("final");
  await session.close();
});

test("polls do not overlap", async () => {
  const h = harness();
  const g = gate();
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = deferred<string>();
  h.provider.streaming = {
    responseText: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const v = await slow.promise;
      inFlight--;
      return v;
    },
  };
  const session = await ChatSession.open({ ...opts(h), pollSleep: g.sleep });
  const reply = session.send("hi", { onPartial: () => {} });
  await g.tick();
  // The poll body is parked on `slow`: no second sleep was requested.
  expect(g.pending).toBe(0);
  slow.resolve("x");
  await g.tick();
  expect(maxInFlight).toBe(1);
  h.replies[0]?.resolve("final");
  await reply;
  await session.close();
});

test("does not poll without onPartial, or without provider.streaming", async () => {
  const h = harness();
  const g = gate();
  let calls = 0;
  h.provider.streaming = { responseText: async () => (calls++, "x") };
  const session = await ChatSession.open({ ...opts(h), pollSleep: g.sleep });
  const a = session.send("one");
  h.replies[0]?.resolve("r1");
  await a;
  h.provider.streaming = undefined;
  const b = session.send("two", { onPartial: () => {} });
  h.replies[1]?.resolve("r2");
  await b;
  expect(calls).toBe(0);
  expect(g.pending).toBe(0);
  await session.close();
});

test("uses the provider's pollIntervalMs, default 250", async () => {
  const h = harness();
  const asked: number[] = [];
  h.provider.streaming = { responseText: async () => undefined, pollIntervalMs: 40 };
  const session = await ChatSession.open({
    ...opts(h),
    pollSleep: (ms) => {
      asked.push(ms);
      return new Promise(() => {});
    },
  });
  const reply = session.send("hi", { onPartial: () => {} });
  await waitFor(() => asked.length === 1, "the first sleep");
  expect(asked).toEqual([40]);
  h.replies[0]?.resolve("x");
  await reply;
  await session.close();
});

test("responseFormat mirrors the provider, default text", async () => {
  const h = harness();
  const plain = await ChatSession.open(opts(h));
  expect(plain.responseFormat).toBe("text");
  await plain.close();
  h.provider.responseFormat = "markdown";
  const md = await ChatSession.open(opts(h));
  expect(md.responseFormat).toBe("markdown");
  await md.close();
});
```

Also add one case to the existing timeout-diagnosis `describe`: a `send` with `onPartial` and streaming that times out still yields `AuthExpiredError` when `h.loggedIn = false` (copy the existing diagnosis test and add the two options).

- [ ] **Step 2: Run and see them fail**

Run: `bun test packages/core -t "streaming partials"`
Expected: FAIL — `send` takes one argument; `pollSleep`, `responseFormat` do not exist.

- [ ] **Step 3: Implement**

```ts
/** Default interval between `streaming.responseText` polls. */
export const DEFAULT_POLL_INTERVAL_MS = 250;

export interface SendOptions {
  /** Interactive UIs only. Receives the whole reply text so far — not a
   * delta — each time it changes, while the turn is pending. Never called
   * after `send` settles. Needs `provider.streaming`; without it, or without
   * this callback, the turn is not polled at all. */
  onPartial?: (textSoFar: string) => void;
}
```

`ChatSessionOptions` gains:

```ts
  /** Test-only: the wait between two `streaming.responseText` polls. */
  pollSleep?: (ms: number) => Promise<void>;
```

Constructor gains a fifth parameter `private readonly pollSleep: (ms: number) => Promise<void>`; `open()` passes `opts.pollSleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))`.

```ts
  /** What `send` resolves with, for the UI to pick a renderer. */
  get responseFormat(): "markdown" | "text" {
    return this.provider.responseFormat ?? "text";
  }
```

In `send`, replace the `waitForResponse` step:

```ts
      this.onProgress?.("Waiting for response...");
      const waiting = runStep("waitForResponse", this.timeoutMs, () =>
        this.provider.waitForResponse(this.rt.page),
      );
      this.pollPartial(waiting, opts.onPartial);
      return await waiting;
```

```ts
  /** Feeds `onPartial` while `waiting` is pending. Completion, the final text
   * and the timeout all stay with `waitForResponse`; this only reads. One
   * poll at a time, and nothing is emitted once the turn has settled — the
   * loop is not awaited, so a `responseText` parked on a wedged page costs
   * the turn nothing. */
  private pollPartial(
    waiting: Promise<unknown>,
    onPartial: ((textSoFar: string) => void) | undefined,
  ): void {
    const streaming = this.provider.streaming;
    if (onPartial === undefined || streaming === undefined) return;
    let settled = false;
    const done = () => {
      settled = true;
    };
    waiting.then(done, done);
    const interval = streaming.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    void (async () => {
      let last: string | undefined;
      while (!settled) {
        await this.pollSleep(interval);
        if (settled) return;
        let text: string | undefined;
        try {
          text = await streaming.responseText(this.rt.page);
        } catch {
          continue; // a node detached mid-read; the next poll sees the new one
        }
        if (settled) return;
        if (typeof text !== "string" || text === last) continue;
        last = text;
        try {
          onPartial(text);
        } catch {
          // The UI's callback is not ours to trust with the turn.
        }
      }
    })();
  }
```

`send`'s signature: `async send(prompt: string, opts: SendOptions = {}): Promise<string>`. Update its doc comment. Export `SendOptions` and `DEFAULT_POLL_INTERVAL_MS` from `packages/core/src/index.ts`.

- [ ] **Step 4: Run to green, check, commit, sync**

```bash
bun test packages/core
bun run check
git add packages/core
git commit -m "feat: ChatSession.send streams partial text through onPartial (Refs #71)"
gh issue comment 71 --body "Task 5 done: core polls provider.streaming.responseText while waitForResponse is pending and calls onPartial with the whole text so far; no polling without onPartial, final text and timeouts unchanged. ChatSession.responseFormat added. What's next: Task 6, incremental dummy chat."
```

---

### Task 6: Dummy chat — incremental Markdown replies (Opus)

**Files:**
- Modify: `examples/dummy-chat/server.ts`, `examples/dummy-chat/provider.ts`
- Test: `examples/dummy-chat/server.test.ts`, the CLI E2E test that drives the dummy chat (find it with `grep -rl startDummyChat packages/cli/src`)

**Interfaces:**
- Consumes: `elementToMarkdown` (Task 4), `streaming`/`responseFormat` (Task 3), `SendOptions` (Task 5).
- Produces: `DummyChat.setChunkDelayMs(ms: number): void` (default 40). The reply to prompt `P` has the Markdown source `dummyReply(P)`, exported from `server.ts`:

```ts
/** The Markdown source of the reply to `text`. The first line keeps the
 * historical "Echo: " shape every existing test asserts on. */
export function dummyReply(text: string): string {
  if (!text.startsWith("md:")) return `Echo: ${text}`;
  return [
    `Echo: ${text}`,
    "",
    "## Details",
    "",
    "- **bold** item",
    "- second item",
    "",
    "```ts",
    "const a = 1;",
    "```",
    "",
    "| k | v |",
    "| --- | --- |",
    "| a | 1 |",
  ].join("\n");
}
```

- [ ] **Step 1: Write the failing tests**

In `server.test.ts`: (a) `dummyReply("hi")` is `"Echo: hi"`; (b) `dummyReply("md: x")` contains a fenced block and a table. In the CLI E2E file add:

```ts
test("an interactive-style send sees growing partials and a Markdown final text", async () => {
  chat.setChunkDelayMs(60);
  const session = await ChatSession.open({ provider, authStore, headless: true, timeoutMs: 10_000 });
  const partials: string[] = [];
  const reply = await session.send("md: table please", { onPartial: (t) => partials.push(t) });
  await session.close();
  expect(reply).toBe(dummyReply("md: table please"));
  expect(partials.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < partials.length; i++) {
    expect(partials[i]?.length).toBeGreaterThan(partials[i - 1]?.length ?? 0);
  }
});
```

Use the file's existing login/auth-store setup. Keep every existing assertion of `Echo: ...` untouched — they must still pass.

- [ ] **Step 2: Run and see them fail**

Run: `bun run build && bun test examples/dummy-chat packages/cli -t "growing partials"`
Expected: FAIL — `setChunkDelayMs`/`dummyReply` missing.

- [ ] **Step 3: Implement the server**

The page script gets the reply **HTML chunks** from the server so the Markdown→HTML renderer lives in one place (TypeScript, testable). Add to `server.ts`:

```ts
/** Renders the tiny Markdown subset `dummyReply` uses. Not a general
 * renderer: headings, paragraphs, bold, flat lists, fenced code, tables. */
export function renderDummyMarkdown(source: string): string { /* see below */ }
```

Implementation rules (write them exactly; each has a test in `server.test.ts` asserting the HTML for the `md:` reply round-trips through `elementToMarkdown` in the E2E test above):
- split on blank lines into blocks, except inside a fence;
- `## x` → `<h2>x</h2>`; a block of `- ` lines → `<ul><li>…</li></ul>`; a fence → `<pre><code class="language-LANG">ESCAPED</code></pre>`; a block whose second line is `| --- |…` → `<table><thead>…</thead><tbody>…</tbody></table>`; anything else → `<p>…</p>`;
- inline: escape `& < >`, then `**x**` → `<strong>x</strong>`.

Add a `GET /reply?text=…` route (session required, 401 otherwise) returning JSON `{ chunks: string[] }`, where `chunks` is the rendered HTML split **between top-level blocks** (one chunk per block, so every prefix is well-formed HTML). For a plain `Echo:` reply that is a single `<p>` — so split that paragraph's text into 3 chunks of growing text instead: chunks are *cumulative HTML states*, i.e. `chunks[i]` is the whole innerHTML after step `i`. That makes the page script trivial and every intermediate state well-formed:

```js
setTimeout(async () => {
  const res = await fetch("/reply?text=" + encodeURIComponent(text));
  const { chunks } = await res.json();
  const reply = document.createElement("div");
  reply.className = "message assistant";
  log.appendChild(reply);
  for (const html of chunks) {
    reply.innerHTML = html;
    await new Promise((r) => setTimeout(r, chunkDelay));
  }
  log.dataset.state = "idle";
}, wait);
```

`chunkDelay` comes from a second `<meta name="chunk-delay">`, like `reply-delay`. `setChunkDelayMs` sets it for pages served afterwards. Update the file's header comment to list the new hooks.

- [ ] **Step 4: Implement the provider**

```ts
    responseFormat: "markdown",

    async waitForResponse(page) {
      const log = page.locator("#chat-log");
      const last = log.locator(".message.assistant").last();
      await last.waitFor({ state: "attached" });
      // The busy → idle transition is the completion signal; partial text is
      // what `streaming.responseText` is for.
      await page.waitForSelector('#chat-log[data-state="idle"]');
      return elementToMarkdown(last);
    },

    streaming: {
      async responseText(page) {
        // Only while busy: once idle, the last assistant node may belong to
        // the previous turn until the next reply element is appended.
        const log = page.locator("#chat-log");
        if ((await log.getAttribute("data-state")) !== "busy") return undefined;
        const last = log.locator(".message.assistant").last();
        if ((await last.count()) === 0) return undefined;
        // Busy with no new element yet: the last node is the previous turn's.
        const users = await log.locator(".message.user").count();
        const assistants = await log.locator(".message.assistant").count();
        if (assistants < users) return undefined;
        const text = await elementToMarkdown(last);
        return text === "" ? undefined : text;
      },
      pollIntervalMs: 50,
    },
```

The `assistants < users` guard is the reference implementation of "never return an earlier turn's text"; keep the comment, provider authors copy this file.

- [ ] **Step 5: Run to green**

Run: `bun run build && bun test examples/dummy-chat packages/cli packages/runtime`
Expected: PASS, including every pre-existing `Echo:` assertion (one-shot output for `hi` is still exactly `Echo: hi`).

- [ ] **Step 6: Check, commit, sync**

```bash
bun run check
git add examples/dummy-chat packages/cli
git commit -m "feat: dummy chat streams Markdown replies; reference streaming provider (Refs #71)"
gh issue comment 71 --body "Task 6 done: the dummy chat grows its reply in chunks as rendered Markdown, and the reference provider implements responseFormat markdown + streaming.responseText with the earlier-turn guard. E2E sees growing partials. What's next: Task 7, ChatModel partial/incomplete/format."
```

---

### Task 7: ChatModel — partial, incomplete, format (Opus)

**Files:**
- Modify: `packages/cli/src/tui/chat-model.ts`
- Test: `packages/cli/src/tui/chat-model.test.ts`

**Interfaces:**
- Consumes: `SendOptions` from `@chatbridge/core` (Task 5).
- Produces:
  - `ChatSessionLike.send(prompt: string, opts?: SendOptions): Promise<string>` and `ChatSessionLike.responseFormat?: "markdown" | "text"`
  - `Message.format?: "markdown"`, `Message.incomplete?: true`
  - `ChatModel.partial: string | undefined` — the reply text so far of the turn in flight; `undefined` outside a turn and before the first partial. Never in `messages`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("ChatModel: streaming", () => {
  function streamingSession(format?: "markdown" | "text") {
    const d = deferred<string>();
    let emit: ((t: string) => void) | undefined;
    const session: ChatSessionLike = {
      responseFormat: format,
      send: (_p, opts) => {
        emit = opts?.onPartial;
        return d.promise;
      },
      close: async () => {},
      kill: async () => {},
    };
    return { session, d, emit: (t: string) => emit?.(t) };
  }

  test("partials update model.partial and never enter messages", async () => {
    const s = streamingSession();
    const model = await modelWith(s.session);
    let changes = 0;
    model.onChange = () => changes++;
    void model.submit("hi");
    await waitFor(() => model.status === "busy");
    expect(model.partial).toBeUndefined();
    const before = changes;
    s.emit("He");
    expect(model.partial).toBe("He");
    expect(changes).toBe(before + 1);
    expect(model.messages.map((m) => m.role)).toEqual(["user"]);
    s.d.resolve("Hello");
    await waitFor(() => model.status === "idle");
    expect(model.partial).toBeUndefined();
    expect(model.messages.at(-1)).toEqual({ role: "assistant", text: "Hello" });
  });

  test("a markdown session stamps format on the assistant message", async () => {
    const s = streamingSession("markdown");
    const model = await modelWith(s.session);
    void model.submit("hi");
    await waitFor(() => model.status === "busy");
    s.d.resolve("# T");
    await waitFor(() => model.status === "idle");
    expect(model.messages.at(-1)).toEqual({ role: "assistant", text: "# T", format: "markdown" });
  });

  test("a failed turn keeps the partial as an incomplete assistant message before the error", async () => {
    const s = streamingSession("markdown");
    const model = await modelWith(s.session);
    void model.submit("hi");
    await waitFor(() => model.status === "busy");
    s.emit("half a rep");
    s.d.reject(new ResponseTimeoutError("Timed out during waitForResponse after 1000 ms."));
    await waitFor(() => model.status === "idle");
    expect(model.partial).toBeUndefined();
    expect(model.messages.slice(-2)).toEqual([
      { role: "assistant", text: "half a rep", format: "markdown", incomplete: true },
      { role: "error", text: "Timed out during waitForResponse after 1000 ms." },
    ]);
  });

  test("a failed turn without a partial pushes only the error", async () => {
    const s = streamingSession();
    const model = await modelWith(s.session);
    void model.submit("hi");
    await waitFor(() => model.status === "busy");
    s.d.reject(new ResponseTimeoutError("t"));
    await waitFor(() => model.status === "idle");
    expect(model.messages.map((m) => m.role)).toEqual(["user", "error"]);
  });

  test("a partial from a turn made stale by a reset is dropped", async () => {
    const s = streamingSession();
    const model = await modelWith(s.session, {
      openSession: async () => streamingSession().session,
    });
    void model.submit("hi");
    await waitFor(() => model.status === "busy");
    await model.reset();
    s.emit("stale");
    expect(model.partial).toBeUndefined();
  });
});
```

Use the file's existing `deferred`/`waitFor` helpers (add `waitFor` from the core test's shape if the file has none: poll a predicate every 5 ms up to 1 s).

- [ ] **Step 2: Run and see them fail**

Run: `bun run build && bun test packages/cli/src/tui/chat-model.test.ts -t "streaming"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`ChatSessionLike`:

```ts
  send(prompt: string, opts?: SendOptions): Promise<string>;
  /** Optional so older fakes keep working; absent means "text". */
  readonly responseFormat?: "markdown" | "text";
```

`Message` gains:

```ts
  /** `assistant` entries: render `text` as Markdown. Absent: verbatim. */
  format?: "markdown";
  /** `assistant` entries: the turn failed after this much had arrived. Kept
   * because a timeout is often only the completion check failing. Skipped
   * by `/copy`. */
  incomplete?: true;
```

Field:

```ts
  /** The reply text so far of the turn in flight. Deliberately not a
   * message: nothing that reads `messages` (copying, a future transcript
   * file) can pick up half a reply. */
  partial: string | undefined;
```

`sendPrompt`:

```ts
    const session = this.requireSession();
    const generation = this.generation;
    const format = session.responseFormat === "markdown" ? { format: "markdown" as const } : {};
    try {
      const reply = await session.send(prompt, {
        onPartial: (text) => {
          if (generation !== this.generation) return; // stale: reset ran
          this.partial = text;
          this.onChange();
        },
      });
      if (generation !== this.generation) return; // stale: reset ran
      if (releasesHeld) this.releaseHeld();
      this.partial = undefined;
      this.messages.push({ role: "assistant", text: reply, ...format });
      this.settle("idle");
    } catch (err) {
      if (generation !== this.generation) return; // stale: reset ran
      const partial = this.partial;
      this.partial = undefined;
      if (partial !== undefined) {
        this.messages.push({ role: "assistant", text: partial, ...format, incomplete: true });
      }
      // …existing error push and settle, unchanged
    }
```

In `runReset`, next to `this.generation++`: `this.partial = undefined;`.

- [ ] **Step 4: Run to green, check, commit, sync**

```bash
bun test packages/cli/src/tui/chat-model.test.ts
bun run check
git add packages/cli
git commit -m "feat: ChatModel tracks the streaming partial outside the transcript (Refs #71)"
gh issue comment 71 --body "Task 7 done: ChatModel.partial carries the in-flight reply, a failed turn keeps it as an incomplete assistant message, and Markdown sessions stamp format on replies. What's next: Task 8, the pending row in the history (#96)."
```

---

### Task 8: ChatView — pending row in the history (#96) and streaming text (#71) (Opus)

Read `docs/spike-notes/2026-09-20-opentui-markdown-selection.md` first.

**Files:**
- Modify: `packages/cli/src/tui/chat-view.ts`
- Test: `packages/cli/src/tui/chat-view.test.ts`

**Interfaces:**
- Consumes: `ChatModel.partial`, `Message.incomplete` (Task 7).
- Produces (private to the view, relied on by Tasks 9 and 12):
  - `private pendingRow: { box: BoxRenderable; label: TextRenderable; body: TextRenderable | undefined; tail: TextRenderable } | undefined`
  - `private bodyFor(message: { text: string; format?: "markdown" }, streaming: boolean): Renderable` — in this task always a `TextRenderable` with `wrapMode: "word"`; Task 9 adds the Markdown branch.
  - `export const INCOMPLETE_NOTE = "(incomplete)"`

Behaviour to build:
1. While `model.status === "busy"`, the history's last child is the pending row. No partial: one text row `<frame> <label>  <elapsed>s` (frame/label styled as `paintSpinnerStatus` does today). With a partial: the `assistant` label, a body showing `model.partial`, and a muted tail row `<frame> <elapsed>s`.
2. The banner is replaced by the history as soon as there is a message **or** a pending row (today: only on the first message; the user message always comes first, so this only matters for auto-sent shell output — keep it correct anyway).
3. When the turn settles with an assistant message, the pending row's box is **promoted**: the tail is removed, the body's content is set to the final text, and the box is adopted as that message's box — `update()` must not also append a second box for it. When the turn settles any other way, the pending row is removed and the new messages are appended normally (the incomplete message gets its own box with the muted `(incomplete)` line under the body).
4. The busy status line no longer shows frame or label: `<elapsed>s / <budget>s[  · N queued]`, then ` · ` and `Ctrl+R reopen · Ctrl+C quit`. Muted. It still repaints on the spinner interval (the elapsed time ticks). The `running` (shell) status line is unchanged.
5. The spinner interval drives both the pending row and the status line. `beginTurn()` keeps choosing the label.
6. Every renderable of the pending row is `selectable: false`; promotion sets the body back to `selectable: true`.

- [ ] **Step 1: Write the failing tests**

Add a `describe("ChatView: pending row", ...)`. Use `setup({ session })` with a controllable session (the `streamingSession` shape from Task 7, redefined locally) and the file's `frameWith`/`captureCharFrame` helpers. `setup()` builds the spinner from `resolveSpinner()`; pass `spinner: { ...resolveSpinner(), labels: ["Thinking"] }` so the label is deterministic.

```ts
test("the indicator is the last history row, under the user message, not on the status line", async () => {
  const s = streamingSession();
  const { t, type, enter, frameWith } = await setup({ session: s.session, spinner: fixedSpinner() });
  await type("hello");
  await enter();
  const frame = await frameWith("Thinking");
  const lines = frame.split("\n");
  const user = lines.findIndex((l) => l.includes("hello"));
  const indicator = lines.findIndex((l) => l.includes("Thinking"));
  const inputTop = lines.findIndex((l) => l.includes("─"));
  expect(indicator).toBeGreaterThan(user);
  expect(indicator).toBeLessThan(inputTop);
  // The status line (last row) has the budget but not the label.
  const status = lines.at(-1) ?? "";
  expect(status).toContain("/ 2s");
  expect(status).not.toContain("Thinking");
  s.d.resolve("done");
});

test("a partial replaces the indicator with an assistant body and a tail row", async () => {
  const s = streamingSession();
  const { type, enter, frameWith } = await setup({ session: s.session, spinner: fixedSpinner() });
  await type("hello");
  await enter();
  await frameWith("Thinking");
  s.emit("Partial text");
  const frame = await frameWith("Partial text");
  expect(frame).toContain("assistant");
  expect(frame).not.toContain("Thinking");
  s.d.resolve("Partial text, finished.");
  const done = await frameWith("finished.");
  // Promoted in place: the reply appears exactly once.
  expect(done.split("Partial text").length - 1).toBe(1);
});

test("a failed turn leaves the partial marked incomplete, then the error", async () => {
  const s = streamingSession();
  const { type, enter, frameWith } = await setup({ session: s.session, spinner: fixedSpinner() });
  await type("hello");
  await enter();
  s.emit("half");
  await frameWith("half");
  s.d.reject(new ResponseTimeoutError("Timed out."));
  const frame = await frameWith("Timed out.");
  expect(frame).toContain("half");
  expect(frame).toContain(INCOMPLETE_NOTE);
  expect(frame.indexOf("half")).toBeLessThan(frame.indexOf("Timed out."));
});

test("a queued turn restarts the indicator with a fresh row", async () => {
  // First reply resolves while a second prompt is queued; the second turn
  // must show its own indicator under the second user message.
});
```

Fill the last test following the file's existing queue tests. Use whichever typing/enter helpers `setup()` already returns — the names above are placeholders for them; do not add new ones if equivalents exist. Update every existing test that asserts the busy status line contains the frame or label (search the file for `paintSpinnerStatus`-era expectations such as the label text on the last line) to the new status content.

- [ ] **Step 2: Run and see them fail**

Run: `bun test packages/cli/src/tui/chat-view.test.ts -t "pending row"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Key pieces (adapt names to the file; keep its comment style):

```ts
export const INCOMPLETE_NOTE = "(incomplete)";
/** The key guide appended to the busy status line. */
const BUSY_GUIDE = "Ctrl+R reopen · Ctrl+C quit";
```

```ts
  /** Adds, refreshes or removes the row of the turn in flight. It is the
   * last child of the history and is not a message: it never reaches
   * `model.messages`, and nothing in it is selectable. */
  private syncPending(): void {
    const busy = this.model.status === "busy";
    if (!busy) {
      this.dropPending();
      return;
    }
    if (this.pendingRow === undefined) this.pendingRow = this.buildPending();
    const row = this.pendingRow;
    const partial = this.model.partial;
    if (partial !== undefined && row.body === undefined) {
      row.body = this.bodyFor({ text: partial, ...this.pendingFormat() }, true);
      row.body.selectable = false;
      row.label.content = LABELS.assistant();
      row.box.insertBefore(row.body, row.tail);
    } else if (partial !== undefined && row.body !== undefined) {
      this.setBody(row.body, partial);
    }
    this.paintPending();
  }
```

- `update()` order: (1) banner swap when `messages.length > 0 || status === "busy"`; (2) for each undrawn message: if it is an `assistant` message that is not `incomplete` and a pending row with a body exists, **promote** (`setBody(final)`, remove tail, `selectable = true`, `pendingRow = undefined`) instead of `history.add(this.messageBox(message))`; otherwise, if a pending row exists, drop it first so the new box lands in order, then add; (3) `syncPending()`; (4) shell refresh, queue, status — as today.
- `ScrollBoxRenderable.add` appends; the pending row must stay last, which the drop-then-add order in (2) guarantees. If `BoxRenderable` has no `insertBefore`, build the row as `[label, tail]` and on the first partial `remove(tail)`, `add(body)`, `add(tail)`.
- `messageBox`: build the body through `bodyFor(message, false)` for `user`/`assistant`/`error` (error keeps `theme.errorText`), and for `message.incomplete` add `new TextRenderable(this.renderer, { content: styled(theme.muted(INCOMPLETE_NOTE)), selectable: false })` under the body.
- `paintSpinnerStatus()` busy branch becomes the plain muted line from behaviour 4; add `paintPending()` that writes the indicator or the tail using the existing `frameStyler`/`labelStyler`. The interval tick calls both.
- `pendingFormat()` returns `{}` in this task (Task 9 makes it `{ format: "markdown" }` for Markdown sessions).
- `destroy()` and `torn` paths: `dropPending()` must be safe after the renderer is gone (guard with `this.torn`).

- [ ] **Step 4: Run to green**

Run: `bun test packages/cli/src/tui`
Expected: PASS (new tests and the updated status-line expectations).

- [ ] **Step 5: Manual check**

```bash
bun run build
bun examples/dummy-chat/serve.ts &   # then run the example CLI interactively against it
```

Send `md: hi`; confirm the indicator sits under your message, the reply grows in place, the status line shows only the budget and guide, and scrolling up during streaming is not yanked back. Kill the server afterwards. Record what you saw in the issue comment.

- [ ] **Step 6: Check, commit, sync**

```bash
bun run check
git add packages/cli
git commit -m "feat: wait indicator and streaming reply as the last history row (Refs #71, #96)"
gh issue comment 71 --body "Task 8 done (#96 + streaming display of #71): the turn in flight is painted as the last history row and promoted in place to the settled reply; failed turns keep the partial marked (incomplete); the busy status line shows budget and guide only. Manual check: <what was seen>. What's next: Task 9, Markdown rendering (#72)."
```

---

### Task 9: ChatView — Markdown rendering (#72) (Opus)

Read the spike note first: it says how many render passes Markdown needs in tests and whether tree-sitter highlighting is available.

**Files:**
- Modify: `packages/cli/src/tui/theme.ts`, `packages/cli/src/tui/chat-view.ts`
- Test: `packages/cli/src/tui/theme.test.ts`, `packages/cli/src/tui/chat-view.test.ts`

**Interfaces:**
- Consumes: `bodyFor`, `setBody`, `pendingFormat` (Task 8); `Message.format`, `ChatSessionLike.responseFormat` (Task 7).
- Produces: `markdownSyntaxStyle(): SyntaxStyle` in `theme.ts`.

- [ ] **Step 1: Write the failing tests**

`theme.test.ts`:

```ts
test("markdownSyntaxStyle builds a style with the markup scopes registered", () => {
  const style = markdownSyntaxStyle();
  for (const scope of ["markup.heading", "markup.strong", "markup.italic", "markup.raw", "markup.link"]) {
    expect(style.getStyle(scope)).toBeDefined();
  }
});
```

Confirm the scope names and the lookup method against `syntax-style.d.ts` and `Markdown.d.ts` in `@opentui/core` (the spike note lists them if Task 1 found different names) and adjust both the test and the implementation to the real names.

`chat-view.test.ts`, `describe("ChatView: markdown", ...)`:

```ts
test("a markdown reply is rendered with markup concealed", async () => {
  const session: ChatSessionLike = {
    responseFormat: "markdown",
    send: async () => "## Title\n\n- **bold** item\n\n```ts\nconst a = 1;\n```",
    close: async () => {},
    kill: async () => {},
  };
  const { type, enter, frameWith } = await setup({ session });
  await type("hi");
  await enter();
  const frame = await frameWith("const a = 1;");
  expect(frame).toContain("Title");
  expect(frame).toContain("bold item");
  expect(frame).not.toContain("##");
  expect(frame).not.toContain("**");
  expect(frame).not.toContain("```");
});

test("a text-format reply is shown verbatim", async () => {
  const session: ChatSessionLike = {
    send: async () => "## not a heading **really**",
    close: async () => {},
    kill: async () => {},
  };
  const { type, enter, frameWith } = await setup({ session });
  await type("hi");
  await enter();
  expect(await frameWith("not a heading")).toContain("## not a heading **really**");
});

test("user messages are never rendered as markdown", async () => {
  // responseFormat markdown; the typed text "**x**" must appear verbatim.
});

test("a streaming markdown partial is promoted to the settled reply", async () => {
  // streamingSession("markdown"): emit "## Ti", then "## Title\n\n- a", resolve
  // with the full text; final frame has Title once, no "##".
});
```

- [ ] **Step 2: Run and see them fail**

Run: `bun test packages/cli/src/tui -t "markdown"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`theme.ts` — ANSI indexed colours like the rest of the file, so the terminal palette applies in light and dark themes (the file has no no-colour switch; do not add one):

```ts
/** Styles for MarkdownRenderable, from the same ANSI indices as `theme`, so
 * a reply looks like the rest of the history in any terminal palette. */
export function markdownSyntaxStyle(): SyntaxStyle {
  const green = RGBA.fromIndex(ANSI.green);
  const yellow = RGBA.fromIndex(ANSI.yellow);
  const blue = RGBA.fromIndex(ANSI.blue);
  return SyntaxStyle.fromStyles({
    "markup.heading": { fg: green, bold: true },
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.raw": { fg: yellow },
    "markup.link": { fg: blue, underline: true },
    "markup.list": { fg: MUTED_COLOR },
    "markup.quote": { fg: MUTED_COLOR, italic: true },
  });
}
```

Import `SyntaxStyle` from `@opentui/core` next to the existing imports. `theme.ts` already imports from `@opentui/core`, so the OpenTUI boundary is unchanged.

`chat-view.ts`:

```ts
  private bodyFor(message: { text: string; format?: "markdown" }, streaming: boolean): Renderable {
    if (message.format === "markdown") {
      return new MarkdownRenderable(this.renderer, {
        content: message.text,
        syntaxStyle: this.markdownStyle,
        conceal: true,
        streaming,
      });
    }
    return new TextRenderable(this.renderer, { content: message.text, wrapMode: "word" });
  }

  private setBody(body: Renderable, text: string, settled = false): void {
    if (body instanceof MarkdownRenderable) {
      body.content = text;
      if (settled) body.streaming = false;
      return;
    }
    (body as TextRenderable).content = text;
  }

  private pendingFormat(): { format?: "markdown" } {
    return this.model.session?.responseFormat === "markdown" ? { format: "markdown" } : {};
  }
```

`markdownStyle` is created once in the constructor. Promotion in `update()` calls `setBody(row.body, message.text, true)`. Only `assistant` messages pass `format` through; `user` and `error` always get the text branch. If the spike note says tree-sitter cannot load under one runtime, pass nothing extra — code blocks render unhighlighted, which is the specified behaviour; make sure no error reaches stderr (the TUI owns the terminal), and if OpenTUI logs one, route it through the buffered `onProgress` path in `run-interactive.ts`.

- [ ] **Step 4: Run to green; manual check**

Run: `bun test packages/cli/src/tui`, then repeat Task 8's manual check with `md: hi` and confirm heading, list, code block and table render, under `bun` and under `node`.

- [ ] **Step 5: Check, commit, sync**

```bash
bun run check
git add packages/cli
git commit -m "feat: render Markdown replies in the TUI history (Refs #71, #72)"
gh issue comment 71 --body "Task 9 done (#72): replies of responseFormat markdown providers render through OpenTUI's MarkdownRenderable (streaming while pending, settled in place); everything else is verbatim. Manual check under bun and node: <result>. What's next: Task 10, clipboard transport."
```

---

### Task 10: Clipboard transport (Sonnet)

**Files:**
- Create: `packages/cli/src/tui/clipboard.ts`
- Test: `packages/cli/src/tui/clipboard.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ClipboardProcess {
  /** Resolves with the exit code, or rejects when the command cannot start. */
  run(command: string, args: string[], stdin: string, timeoutMs: number): Promise<number>;
}
export interface ClipboardDeps {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  process: ClipboardProcess;
  /** Writes an OSC 52 sequence; true when it was written. */
  osc52: (text: string) => boolean;
}
export const CLIPBOARD_TIMEOUT_MS = 2_000;
export function clipboardCommand(platform: NodeJS.Platform, env: Record<string, string | undefined>): { command: string; args: string[] } | undefined;
export function copyToClipboard(text: string, deps: ClipboardDeps): Promise<boolean>;
export const spawnClipboardProcess: ClipboardProcess;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { type ClipboardDeps, clipboardCommand, copyToClipboard } from "./clipboard.js";

function deps(over: Partial<ClipboardDeps> & { exit?: number | Error } = {}) {
  const runs: Array<{ command: string; args: string[]; stdin: string }> = [];
  const osc: string[] = [];
  const d: ClipboardDeps = {
    env: {},
    platform: "darwin",
    process: {
      run: async (command, args, stdin) => {
        runs.push({ command, args, stdin });
        if (over.exit instanceof Error) throw over.exit;
        return over.exit ?? 0;
      },
    },
    osc52: (text) => {
      osc.push(text);
      return true;
    },
    ...over,
  };
  return { d, runs, osc };
}

describe("clipboardCommand", () => {
  test("per platform", () => {
    expect(clipboardCommand("darwin", {})).toEqual({ command: "pbcopy", args: [] });
    expect(clipboardCommand("win32", {})).toEqual({ command: "clip.exe", args: [] });
    expect(clipboardCommand("linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual({ command: "wl-copy", args: [] });
    expect(clipboardCommand("linux", {})).toEqual({ command: "xclip", args: ["-selection", "clipboard"] });
    expect(clipboardCommand("freebsd", {})).toBeUndefined();
  });
});

describe("copyToClipboard", () => {
  test("local: the platform command gets the text on stdin, OSC 52 is not used", async () => {
    const { d, runs, osc } = deps();
    expect(await copyToClipboard("hello", d)).toBe(true);
    expect(runs).toEqual([{ command: "pbcopy", args: [], stdin: "hello" }]);
    expect(osc).toEqual([]);
  });

  test.each(["SSH_TTY", "SSH_CONNECTION"])("over SSH (%s): OSC 52 only", async (name) => {
    const { d, runs, osc } = deps({ env: { [name]: "x" } });
    expect(await copyToClipboard("hello", d)).toBe(true);
    expect(runs).toEqual([]);
    expect(osc).toEqual(["hello"]);
  });

  test("falls back to OSC 52 when the command is missing", async () => {
    const { d, osc } = deps({ exit: new Error("ENOENT") });
    expect(await copyToClipboard("hello", d)).toBe(true);
    expect(osc).toEqual(["hello"]);
  });

  test("falls back to OSC 52 on a non-zero exit", async () => {
    const { d, osc } = deps({ exit: 1 });
    expect(await copyToClipboard("hello", d)).toBe(true);
    expect(osc).toEqual(["hello"]);
  });

  test("false when the command fails and OSC 52 is not written", async () => {
    const { d } = deps({ exit: 1, osc52: () => false });
    expect(await copyToClipboard("hello", d)).toBe(false);
  });

  test("no command for the platform: OSC 52", async () => {
    const { d, runs, osc } = deps({ platform: "freebsd" });
    expect(await copyToClipboard("hello", d)).toBe(true);
    expect(runs).toEqual([]);
    expect(osc).toEqual(["hello"]);
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `bun test packages/cli/src/tui/clipboard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { spawn } from "node:child_process";

export interface ClipboardProcess {
  /** Resolves with the exit code, or rejects when the command cannot start. */
  run(command: string, args: string[], stdin: string, timeoutMs: number): Promise<number>;
}

export interface ClipboardDeps {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  process: ClipboardProcess;
  /** Writes an OSC 52 sequence; true when it was written. */
  osc52: (text: string) => boolean;
}

export const CLIPBOARD_TIMEOUT_MS = 2_000;

/** The platform's clipboard writer, or undefined when there is none we know. */
export function clipboardCommand(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): { command: string; args: string[] } | undefined {
  if (platform === "darwin") return { command: "pbcopy", args: [] };
  if (platform === "win32") return { command: "clip.exe", args: [] };
  if (platform === "linux") {
    return env.WAYLAND_DISPLAY
      ? { command: "wl-copy", args: [] }
      : { command: "xclip", args: ["-selection", "clipboard"] };
  }
  return undefined;
}

/** Puts `text` on the system clipboard. Over SSH only OSC 52 reaches the
 * user's machine; a platform command would fill the remote clipboard.
 * Locally the command goes first, because OSC 52 cannot report success and
 * some terminals (macOS Terminal.app) ignore it. The text goes to stdin,
 * never to argv, and is never logged. */
export async function copyToClipboard(text: string, deps: ClipboardDeps): Promise<boolean> {
  const remote = Boolean(deps.env.SSH_TTY || deps.env.SSH_CONNECTION);
  const command = remote ? undefined : clipboardCommand(deps.platform, deps.env);
  if (command !== undefined) {
    try {
      const code = await deps.process.run(command.command, command.args, text, CLIPBOARD_TIMEOUT_MS);
      if (code === 0) return true;
    } catch {
      // Not installed, or it timed out: OSC 52 is the fallback.
    }
  }
  return deps.osc52(text);
}

export const spawnClipboardProcess: ClipboardProcess = {
  run(command, args, stdin, timeoutMs) {
    return new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${command} timed out`));
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
      child.stdin.on("error", () => {}); // EPIPE when the command exits early
      child.stdin.end(stdin);
    });
  },
};
```

- [ ] **Step 4: Run to green, check, commit, sync**

```bash
bun test packages/cli/src/tui/clipboard.test.ts
bun run check
git add packages/cli/src/tui/clipboard.ts packages/cli/src/tui/clipboard.test.ts
git commit -m "feat: clipboard transport for the TUI (platform command, OSC 52 over SSH) (Refs #71)"
gh issue comment 71 --body "Task 10 done: tui/clipboard.ts copies through the platform command locally and OSC 52 over SSH or as fallback; no OpenTUI import. What's next: Task 11, the /copy built-in in both UIs (#100)."
```

---

### Task 11: `/copy` built-in in both UIs (#100) (Opus)

**Files:**
- Modify: `packages/provider/src/index.ts` (`BUILTIN_COMMAND_NAMES`), `packages/core/src/slash-commands.ts` (`SLASH_COMMANDS`)
- Modify: `packages/cli/src/tui/chat-model.ts`, `packages/cli/src/tui/chat-view.ts`, `packages/cli/src/tui/run-interactive.ts`
- Modify: `packages/vscode/src/protocol.ts`, `chat-view-bridge.ts`, `commands.ts`, `session-controller.ts`, `create-extension.ts`, `webview/main.ts`
- Test: `packages/provider/src/index.test.ts`, `packages/core/src/slash-commands.test.ts`, `packages/cli/src/tui/chat-model.test.ts`, `packages/cli/src/tui/chat-view.test.ts`, `packages/vscode/src/commands.test.ts`, `packages/vscode/src/session-controller.test.ts`, `packages/vscode/src/chat-view-bridge.test.ts`

**Interfaces:**
- Consumes: `copyToClipboard`, `spawnClipboardProcess` (Task 10); `Message.incomplete` (Task 7).
- Produces:
  - `"copy"` in `BUILTIN_COMMAND_NAMES` and `{ name: "copy", description: "Copy the last reply to the clipboard" }` in `SLASH_COMMANDS`, placed before `help`.
  - `ChatModelOptions.copy?: (text: string) => Promise<boolean>`; `ChatModel.notice: string | undefined` with `export const COPIED_NOTICE = "copied"`, `COPY_FAILED_NOTICE = "copy failed"`, `NOTHING_TO_COPY_NOTICE = "nothing to copy yet"`; `ChatModel.notify(text: string): void` (sets `notice`, calls `onChange`) — Task 12 reuses it.
  - `ChatView` shows `model.notice` on the status line for `NOTICE_MS = 2_000`, then clears it (`model.notice = undefined`) and repaints.
  - `SessionController.lastReply(): string | undefined`
  - `CommandDeps.writeClipboard?: (text: string) => Thenable<void>` and `CommandHandlers.copy(): Promise<void>` in `packages/vscode/src/commands.ts`; `"copy"` in `WebviewCommand` and `COMMAND_LIST`.

- [ ] **Step 1: Failing tests — provider and core**

`index.test.ts`: a provider command named `copy` throws `Provider command "/copy" collides with a built-in command.` `slash-commands.test.ts`: `parseSlashCommand("/copy", new Set())` is `{ command: "copy" }`; `parseSlashCommand("/copy 2", new Set())` is the same `{ error: … }` shape the file already asserts for a built-in given arguments; `helpText([])` contains `/copy`.

- [ ] **Step 2: Implement provider + core, run**

Add `"copy"` before `"help"` in `BUILTIN_COMMAND_NAMES`; add the row before `help` in `SLASH_COMMANDS`. Run `bun run build && bun test packages/provider packages/core`. TypeScript now reports every non-exhaustive `switch (slash.command)` — that is the to-do list for the next steps.

- [ ] **Step 3: Failing tests — ChatModel**

```ts
describe("ChatModel: /copy", () => {
  test("copies the newest complete assistant reply, as the provider returned it", async () => {
    const copied: string[] = [];
    const model = await modelWith(echoSession(), { copy: async (t) => (copied.push(t), true) });
    await model.submit("one");
    await model.submit("two");
    const before = model.messages.length;
    expect(await model.submit("/copy")).toBe(true);
    expect(copied).toEqual(["Echo: two"]);
    expect(model.notice).toBe(COPIED_NOTICE);
    expect(model.messages.length).toBe(before); // no turn, no entry
  });

  test("skips an incomplete reply", async () => {
    // one complete reply, then a failed streaming turn that left an
    // incomplete message: /copy yields the complete one.
  });

  test("nothing to copy yet", async () => {
    const model = await modelWith(echoSession(), { copy: async () => true });
    await model.submit("/copy");
    expect(model.notice).toBe(NOTHING_TO_COPY_NOTICE);
  });

  test("copy failed", async () => {
    const model = await modelWith(echoSession(), { copy: async () => false });
    await model.submit("hi");
    await model.submit("/copy");
    expect(model.notice).toBe(COPY_FAILED_NOTICE);
  });

  test("works while a turn is pending and after the idle close, without opening a session", async () => {
    // pending: copies the last settled reply and the turn still completes;
    // idle-closed: openSession is not called again by /copy.
  });
});
```

`echoSession()` is the file's existing echo fake (whatever it is named there).

- [ ] **Step 4: Implement in the model**

```ts
      case "copy": {
        const reply = this.messages.findLast((m) => m.role === "assistant" && !m.incomplete);
        if (reply === undefined) {
          this.notify(NOTHING_TO_COPY_NOTICE);
          return true;
        }
        const ok = await this.copy(reply.text).catch(() => false);
        this.notify(ok ? COPIED_NOTICE : COPY_FAILED_NOTICE);
        return true;
      }
```

`this.copy` defaults to `async () => false`. `notify` sets `this.notice` and calls `onChange()`.

- [ ] **Step 5: View — notice on the status line (test first)**

Test: after `/copy` the last frame line contains `copied`; after `NOTICE_MS` (inject a short value through a new optional `ChatViewOptions.noticeMs`, default `2_000`) it shows the idle guide again; a notice during a busy turn shows and then returns to the busy status line. Implement in `update()`: when `model.notice` is set and `!statusPinned`, paint `styled(theme.muted(notice))` instead of the state's line, (re)start one timer that clears `model.notice` and calls `update()`; `destroy()` clears the timer.

- [ ] **Step 6: Wire the TUI**

In `run-interactive.ts`, the model is built before the renderer's `copyToClipboardOSC52` is needed, and the renderer already exists at that point, so:

```ts
      copy: (text) =>
        copyToClipboard(text, {
          env: process.env,
          platform: process.platform,
          process: spawnClipboardProcess,
          osc52: (t) => renderer.copyToClipboardOSC52(t),
        }),
```

Add `copy?: (text: string) => Promise<boolean>` to `InteractiveOptions` as a test seam, the way `login` and `createSession` are, and assert in `run-interactive.test.ts` that it is what the model receives.

- [ ] **Step 7: VSCode — tests first, then implement**

- `session-controller.test.ts`: `lastReply()` is `undefined` on a fresh controller, the newest assistant text after two turns, unaffected by error/separator/help entries after it.
- `commands.test.ts`: `copy()` with a reply calls `writeClipboard(text)` then `ui.showInformationMessage("Copied the last reply.")`; with none, `showInformationMessage("Nothing to copy yet.")` and no write; a rejecting `writeClipboard` → `ui.showWarningMessage("Could not copy the last reply.")`; with `writeClipboard` undefined (a vendor's older wiring) → the warning.
- `chat-view-bridge.test.ts`: a `{ type: "command", name: "copy" }` message is accepted and routed.

Implement: `SessionController.lastReply()` = `this.messages.findLast((m) => m.role === "assistant")?.text`; `commands.ts` gains `copy`; `protocol.ts` `WebviewCommand` gains `/** The host copies the last reply to the clipboard. */ | "copy"`; `COMMAND_LIST` gains `"copy"`; `create-extension.ts` passes `writeClipboard: (text) => vscode.env.clipboard.writeText(text)` into `createCommands`. `webview/main.ts` needs no change if its built-in dispatch is the generic `slash.command === "new" ? "newChat" : slash.command` — confirm the posted name type-checks against `WebviewCommand`. `COMMAND_NAMES` (VS Code palette commands) is **not** extended: `/copy` is a view command only, so no `package.json` contribution or manifest check changes.

- [ ] **Step 8: Run everything, check, commit, sync**

```bash
bun run build && bun test
bun run check
git add -A packages
git commit -m "feat: /copy built-in copies the last reply in the TUI and VSCode (Refs #71, #100)"
gh issue comment 71 --body "Task 11 done (#100): /copy is a core built-in; the TUI copies through tui/clipboard.ts with a status-line notice, VSCode through vscode.env.clipboard with an information message. A provider command named copy is now rejected (release note). What's next: Task 12, select-to-copy (#98)."
```

---

### Task 12: Select to copy (#98) (Opus)

Read the spike note's selection section first; it fixes the event name, its timing and its payload.

**Files:**
- Modify: `packages/cli/src/tui/chat-view.ts`, `packages/cli/src/tui/run-interactive.ts`
- Test: `packages/cli/src/tui/chat-view.test.ts`

**Interfaces:**
- Consumes: `ChatModel.notify`, the notice constants, `ChatModelOptions.copy` (Task 11).
- Produces: `ChatViewOptions.copy?: (text: string) => Promise<boolean>` — `run-interactive.ts` passes the same function it gives the model.

- [ ] **Step 1: Write the failing tests**

```ts
describe("ChatView: select to copy", () => {
  test("a finished selection over a reply copies its text", async () => {
    const copied: string[] = [];
    const { t, type, enter, frameWith } = await setup({ copy: async (x) => (copied.push(x), true) });
    await type("hi");
    await enter();
    const frame = await frameWith("Echo: hi");
    const y = frame.split("\n").findIndex((l) => l.includes("Echo: hi"));
    await t.mockMouse.drag(0, y, 8, y);
    await t.renderOnce();
    expect(copied).toEqual(["Echo: hi"]);
    expect(await frameWith("copied")).toContain("copied");
  });

  test("role labels, separators, attachment lines and the pending row are not selectable", async () => {
    // Drag from the "assistant" label row down through the reply: the copied
    // text is the reply text only.
  });

  test("an empty selection copies nothing", async () => {
    // A click without a drag: copy is not called, no notice.
  });
});
```

Extend `setup()` with a `copy` option forwarded to both the model and the view. Use the mock-mouse API the spike note names.

- [ ] **Step 2: Run and see them fail**

Run: `bun test packages/cli/src/tui/chat-view.test.ts -t "select to copy"`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Set `selectable: false` on: the header, banner lines, role-label renderables, separators, attachment lines, the `(incomplete)` line, shell footers, queue rows, the prompt, the status line, and everything in the pending row (already done in Task 8). Message bodies stay selectable, and so does `/help` text and shell output: both are text a user may want.
- Subscribe in the constructor to the renderer's selection event (name and timing from the spike note). If it fires during the drag as well as at the end, act only when the selection is no longer in progress (the note says which flag). Handler:

```ts
  private onSelection(selection: { getSelectedText(): string } | null): void {
    if (this.torn || this.copy === undefined) return;
    const text = selection?.getSelectedText() ?? "";
    if (text.trim() === "") return;
    void this.copy(text)
      .catch(() => false)
      .then((ok) => this.model.notify(ok ? COPIED_NOTICE : COPY_FAILED_NOTICE));
  }
```

- Unsubscribe in `destroy()`.
- `run-interactive.ts`: build the `copy` function once and pass it to both; if the spike note says `useMouse` is not on by default, pass `useMouse: true` to `createCliRenderer`.

- [ ] **Step 4: Run to green; manual check**

Drag over a reply in a real terminal (local: check the system clipboard; note the terminal used). Confirm wheel scrolling still works.

- [ ] **Step 5: Check, commit, sync**

```bash
bun run check
git add packages/cli
git commit -m "feat: copy a mouse selection in the TUI history to the clipboard (Refs #71, #98)"
gh issue comment 71 --body "Task 12 done (#98): a finished mouse selection over message text is copied; labels, separators, attachment lines and the pending row are not selectable. Manual check: <terminal, result>. What's next: Task 13, sticky input focus (#99)."
```

---

### Task 13: Focus stays on the chat input (#99) (Opus)

Read the spike note's focus section first; it decides between the two approaches below.

**Files:**
- Modify: `packages/cli/src/tui/chat-view.ts` (and `run-interactive.ts` if `autoFocus: false` is the approach)
- Test: `packages/cli/src/tui/chat-view.test.ts`

**Interfaces:** none new.

- [ ] **Step 1: Write the failing tests**

```ts
describe("ChatView: input focus", () => {
  test("typing still reaches the input after clicking the history", async () => {
    const { t, view, type, enter, frameWith } = await setup();
    await type("hi");
    await enter();
    const frame = await frameWith("Echo: hi");
    const y = frame.split("\n").findIndex((l) => l.includes("Echo: hi"));
    await t.mockMouse.click(2, y);
    await t.renderOnce();
    await type("again");
    expect(view.inputText).toBe("again");
  });

  test("clicking the status line or the header does not steal focus", async () => {
    // same shape, click (2, 0) and (2, lastRow)
  });

  test("PgUp/PgDn scroll the history while the input has focus", async () => {
    // Fill the history past the viewport, press pageup, assert an early
    // message is visible; press pagedown, assert the latest is visible.
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `bun test packages/cli/src/tui/chat-view.test.ts -t "input focus"`
Expected: the click tests FAIL; the PgUp/PgDn test fails only if the spike note found that key scrolling depends on the scroll box having focus.

- [ ] **Step 3: Implement the approach the spike note chose**

- **Approach A (`autoFocus: false` keeps focus put):** pass `autoFocus: false` in `createCliRenderer({ exitOnCtrlC: false, autoFocus: false })` and in the tests' `createTestRenderer` options. Nothing else moves focus, so the constructor's `this.input.focus()` is enough.
- **Approach B (hand focus back):** in the constructor,

```ts
    // The cursor always lives in the input: anything that takes focus (a
    // click on the history) hands it straight back.
    this.input.on("blurred", () => {
      if (!this.torn) this.input.focus();
    });
```

Use A when the note says it works and wheel scrolling plus selection still work with it; otherwise B. Do not do both.

- If PgUp/PgDn need it, add to `handleKey` before the popup switch:

```ts
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      const page = Math.max(1, this.history.height - 1);
      this.history.scrollBy(key.name === "pageup" ? -page : page);
      return;
    }
```

(Confirm `scrollBy`'s signature in `ScrollBox.d.ts`.)

- [ ] **Step 4: Run to green; manual check**

Click around in a real terminal, keep typing, scroll by wheel and by key, open the `@` and `/` popups after a click.

- [ ] **Step 5: Check, commit, sync**

```bash
bun run check
git add packages/cli
git commit -m "fix: keep keyboard focus on the TUI chat input when clicking elsewhere (Refs #71, #99)"
gh issue comment 71 --body "Task 13 done (#99): approach <A|B>; typing keeps reaching the input after clicks, wheel and PgUp/PgDn scrolling work. What's next: Task 14, documentation."
```

---

### Task 14: Documentation (Sonnet)

**Files:**
- Modify: `README.md`, `packages/cli/README.md`, `packages/vscode/README.md`, `packages/provider/README.md` (or wherever the provider authoring guide lives — `grep -rl "waitForResponse" --include=README.md . docs`), `.claude/skills/creating-provider-repo/SKILL.md`
- Modify: `CLAUDE.md` only if a command or rule changed (none expected)

- [ ] **Step 1: Write the docs**

1. Root README, interactive-mode section: replies stream and render as Markdown when the provider supports it; the wait indicator sits under your message; one-shot mode and the VSCode view are unchanged (whole reply, plain text).
2. CLI README: add `/copy` to the command table; add a "Copying text" section — drag to copy the text you see, `/copy` for the last reply's source; over SSH the copy uses OSC 52, which some terminals disable (name tmux's `set-clipboard` and that macOS Terminal.app ignores OSC 52).
3. VSCode README: `/copy` in the command list.
4. Provider guide: `responseFormat`, `elementToMarkdown(locator)` with a four-line example, `streaming.responseText` with the rule **"never return an earlier turn's text"** and the dummy provider's `assistants < users` guard as the pattern; `pollIntervalMs`.
5. `creating-provider-repo` skill: add the three fields to its provider checklist, and a DOM-notes prompt: "which element grows while the reply streams, and how do you tell it from the previous turn's?"
6. Embedders note (root README changelog pointer or `docs/PUBLISHING.md` release-notes checklist): `onIdleExpired` now receives the in-flight close promise; a provider command named `copy` is rejected.

- [ ] **Step 2: Check, commit, sync**

```bash
bun run check
git add -A README.md packages/*/README.md .claude/skills docs
git commit -m "docs: streaming, Markdown, /copy and select-to-copy (Refs #71)"
gh issue comment 71 --body "Task 14 done: READMEs, the provider guide and the creating-provider-repo skill cover responseFormat, elementToMarkdown, streaming.responseText, /copy and select-to-copy. What's next: whole-branch review (Fable), then the PR: title for release notes, label enhancement, 'Closes #71, closes #72, closes #96, closes #98, closes #99, closes #100, closes #103'."
```

---

## After the last task

1. Whole-branch review with **Fable** (`superpowers:requesting-code-review`), fix loop as needed.
2. PR from `issue-71`, squash-merge, label `enhancement`, body with one `Closes #n` keyword per issue: #71, #72, #96, #98, #99, #100, #103. Verify each closed after merging.
3. Append `### 17. …` to `docs/ROADMAP.md`, close milestone 17, open backlog issues for anything the reviews defer (including "Markdown and streaming in the VSCode chat view").
4. v0.10.0 is a minor bump the user already chose; hand-edit the generated release notes to call out the `onIdleExpired` signature and the reserved `copy` command name.
