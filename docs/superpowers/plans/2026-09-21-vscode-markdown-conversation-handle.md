# VSCode Markdown/Streaming and Conversation Handle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The VSCode chat view renders Markdown and streams partial replies, and both interactive UIs return to the same service-side conversation after an idle close or a reopen, through a provider-exposed conversation handle.

**Architecture:** `Provider` gains an optional `conversation: { handle, open }` pair plus a `urlConversation({ match })` helper. `ChatSession.open` accepts a handle, restores it after the login check and falls back to `startNewChat` when restoring fails; the session refreshes its handle after every successful turn. The TUI `ChatModel` and the VSCode `SessionController` remember the handle in memory and pass it on the next open. In the VSCode webview, `marked`'s lexer feeds a pure token→tree module; `main.ts` turns the tree into DOM with `createElement`/`textContent` only, renders the history incrementally, and updates one streaming node from a light `partial` frame.

**Tech Stack:** TypeScript, Bun (workspaces, `bun test`), Playwright (Chromium), esbuild (webview bundle), `marked` (lexer only, new devDependency of `@chatbridge/vscode`), Biome.

**Spec:** `docs/superpowers/specs/2026-09-21-vscode-markdown-conversation-handle-design.md` — read it first. Tracking issue: #109 (bundles #73). Branch: `issue-109`.

## Global Constraints

- Everything committed is English (docs, comments, commit messages, issue comments).
- `bun run check` passes before every commit. After editing one package, run `bun run build` before another package's tests: tests import cross-package code from `dist`.
- Commit trailer: `Co-Authored-By: <the model that made the commit> <noreply@anthropic.com>` and the `Claude-Session:` line. Commit messages end with `(Refs #109)`; tasks 1–4 also `#73`.
- After every commit: `gh issue comment 109 --body "<what was committed> + What's next: <…>"`.
- Dependency direction `cli → core → runtime → provider` and `vscode → core`. Never import in reverse. Core and provider never depend on a UI.
- The webview bundle imports nothing outside `packages/vscode/src/webview/` except `../protocol.js` types and `marked`.
- `innerHTML`, `outerHTML`, `insertAdjacentHTML` and `document.write` never appear in `packages/vscode/src/webview/`. No inline styles added by the Markdown renderer, no injected `<style>`. The CSP string in `packages/vscode/src/webview-html.ts` does not change.
- The conversation handle is never logged, never put in an error message, never sent to `onProgress`.
- Restoring a conversation never fails an open: every restore failure falls back to a new chat.
- `createExtension` options and the required manifest `contributes` do not change.
- `runOneShot` does not change.
- No vendor-specific material anywhere.
- Exact separator notes: `conversation restored` and `conversation could not be restored`, joined to a separator with ` · ` (space, U+00B7, space).

## File Structure

```
packages/provider/src/
  conversation.ts            NEW  ProviderConversation type + urlConversation helper
  conversation.test.ts       NEW
  index.ts                   MOD  Provider.conversation, defineProvider branch, re-exports
  index.test.ts              MOD  validation tests
packages/core/src/
  conversation-note.ts       NEW  RESTORED_NOTE / NOT_RESTORED_NOTE / withRestoreNote
  conversation-note.test.ts  NEW
  chat-session.ts            MOD  options.conversation, restore + fallback, handle refresh, getters
  chat-session.test.ts       MOD
  index.ts                   MOD  exports
  session.e2e.test.ts        MOD  restore E2E against dummy-chat
examples/dummy-chat/
  server.ts                  MOD  /chat/c/<id>, server-side turn count, "turns?" reply
  server.test.ts             MOD
  provider.ts                MOD  conversation: urlConversation(...)
packages/cli/src/tui/
  chat-model.ts              MOD  remember / pass / forget, separator notes
  chat-model.test.ts         MOD
  run-interactive.ts         MOD  pass `conversation` into ChatSession.open
packages/vscode/
  package.json               MOD  devDependency marked (exact pin)
  src/protocol.ts            MOD  Message.format/incomplete, partial frame, copyText
  src/chat-view-bridge.ts    MOD  isToHost accepts copyText; postPartial
  src/session-controller.ts  MOD  onPartial, incomplete, format, handle, notes
  src/create-extension.ts    MOD  wiring: conversation, onPartial → bridge, copyText → clipboard
  src/webview/markdown-tree.ts       NEW  marked tokens → TreeNode[]
  src/webview/markdown-tree.test.ts  NEW
  src/webview/stream-state.ts        NEW  partial lifecycle + history diff
  src/webview/stream-state.test.ts   NEW
  src/webview/main.ts        MOD  renderTree, incremental render, streaming node, code-block header
  src/webview/style.css      MOD  Markdown classes
packages/provider/skills/
  upgrading-provider-repo/upgrade-guide.md            MOD  ## 0.11.0
  creating-provider-repo/templates/src/provider.ts    MOD  commented urlConversation line
```

Model policy (CLAUDE.md): tasks marked **Sonnet** carry their full code here; tasks marked **Opus** have integration risk and need judgment inside existing large files. Reviews use the same model class as the task. Task 10 is **Fable**.

---

### Task 1: Provider contract — `ProviderConversation` and `urlConversation` (Sonnet)

**Files:**
- Create: `packages/provider/src/conversation.ts`, `packages/provider/src/conversation.test.ts`
- Modify: `packages/provider/src/index.ts` (the `Provider` interface near `urlHooks`, `defineProvider`, exports), `packages/provider/src/index.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProviderConversation {
    handle(page: Page): Promise<string | undefined>;
    open(page: Page, handle: string): Promise<void>;
  }
  export function urlConversation(options: {
    match: RegExp | ((url: string) => boolean);
  }): ProviderConversation;
  // Provider gains: conversation?: ProviderConversation;
  ```

- [ ] **Step 1: Write the failing tests** — `packages/provider/src/conversation.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { urlConversation } from "./conversation.js";

/** A page that only knows its URL; `goto` lands on `landsOn ?? target`. */
function fakePage(start: string, landsOn?: string) {
  let current = start;
  const visited: string[] = [];
  const page = {
    url: () => current,
    goto: async (target: string) => {
      visited.push(target);
      current = landsOn ?? target;
      return null;
    },
  } as unknown as Page;
  return { page, visited };
}

const MATCH = /\/chat\/c\/[a-z0-9]+$/;

describe("urlConversation", () => {
  test("handle is the page URL on a conversation page", async () => {
    const { page } = fakePage("https://x.test/chat/c/abc1");
    expect(await urlConversation({ match: MATCH }).handle(page)).toBe(
      "https://x.test/chat/c/abc1",
    );
  });

  test("handle is undefined off a conversation page", async () => {
    const { page } = fakePage("https://x.test/chat");
    expect(
      await urlConversation({ match: MATCH }).handle(page),
    ).toBeUndefined();
  });

  test("a function match works the same", async () => {
    const { page } = fakePage("https://x.test/t/9");
    const conv = urlConversation({ match: (u) => u.includes("/t/") });
    expect(await conv.handle(page)).toBe("https://x.test/t/9");
  });

  test("open navigates to the handle", async () => {
    const { page, visited } = fakePage("https://x.test/chat");
    await urlConversation({ match: MATCH }).open(
      page,
      "https://x.test/chat/c/abc1",
    );
    expect(visited).toEqual(["https://x.test/chat/c/abc1"]);
  });

  test("open rejects a handle that is not a conversation URL, without navigating", async () => {
    const { page, visited } = fakePage("https://x.test/chat");
    await expect(
      urlConversation({ match: MATCH }).open(page, "https://evil.test/"),
    ).rejects.toThrow("not a conversation URL");
    expect(visited).toEqual([]);
  });

  test("open rejects when the service redirected away from the conversation", async () => {
    const { page } = fakePage("https://x.test/chat", "https://x.test/chat");
    await expect(
      urlConversation({ match: MATCH }).open(
        page,
        "https://x.test/chat/c/gone",
      ),
    ).rejects.toThrow("did not open");
  });

  test("the error never contains the handle", async () => {
    const { page } = fakePage("https://x.test/chat", "https://x.test/chat");
    const err = await urlConversation({ match: MATCH })
      .open(page, "https://x.test/chat/c/secretid")
      .catch((e: Error) => e);
    expect(String(err)).not.toContain("secretid");
  });

  test.each(["g", "y"])("rejects a RegExp with the %s flag", (flag) => {
    expect(() =>
      urlConversation({ match: new RegExp("/c/", flag) }),
    ).toThrow("must not use the g or y flag");
  });
});
```

Append to `packages/provider/src/index.test.ts` (reuse that file's existing minimal-provider helper; if it is named differently than `base`, use its name):

```ts
describe("defineProvider conversation", () => {
  test("accepts a handle/open pair", () => {
    const conversation = {
      handle: async () => undefined,
      open: async () => {},
    };
    expect(defineProvider({ ...base, conversation }).conversation).toBe(
      conversation,
    );
  });

  test.each(["handle", "open"])("rejects a missing %s", (key) => {
    const conversation = {
      handle: async () => undefined,
      open: async () => {},
      [key]: undefined,
    };
    expect(() =>
      defineProvider({ ...base, conversation: conversation as never }),
    ).toThrow(`Provider conversation.${key} must be a function.`);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/provider`
Expected: FAIL — `./conversation.js` not found; `conversation` not on `Provider`.

- [ ] **Step 3: Implement** — `packages/provider/src/conversation.ts`:

```ts
import type { Page } from "playwright-core";

/** Lets an interactive UI return to the same service-side conversation
 * after the browser was closed (idle timeout, reopen). The handle is an
 * opaque string owned by the provider; the framework only stores it and
 * hands it back. It must never embed credentials. */
export interface ProviderConversation {
  /** Handle of the conversation on the page; `undefined` when there is none
   * yet (a new chat before its first turn). Called after every turn. */
  handle(page: Page): Promise<string | undefined>;
  /** Bring the page to the conversation `handle` names. Called on the chat
   * page, after the login check. Throw when it cannot be opened: the
   * framework then starts a new chat instead. */
  open(page: Page, handle: string): Promise<void>;
}

/** The common case: the conversation id is in the page URL. `match` tells a
 * conversation URL from the plain chat page. */
export function urlConversation(options: {
  match: RegExp | ((url: string) => boolean);
}): ProviderConversation {
  const { match } = options;
  if (match instanceof RegExp && /[gy]/.test(match.flags)) {
    throw new Error(
      `urlConversation match ${match} must not use the g or y flag (it makes .test stateful).`,
    );
  }
  const matches = (url: string) =>
    match instanceof RegExp ? match.test(url) : match(url);
  return {
    async handle(page) {
      const url = page.url();
      return matches(url) ? url : undefined;
    },
    async open(page, handle) {
      // Messages stay free of the handle: it identifies a conversation.
      if (!matches(handle)) {
        throw new Error("The handle is not a conversation URL.");
      }
      await page.goto(handle);
      // A service answers an unknown id by redirecting to the plain chat
      // page; that must read as a failure, not as a restored conversation.
      if (!matches(page.url())) {
        throw new Error("The conversation did not open.");
      }
    },
  };
}
```

In `packages/provider/src/index.ts`: import and re-export (`export { urlConversation, type ProviderConversation } from "./conversation.js";` — match the file's existing import/export style), add to `Provider` after `urlHooks`:

```ts
  /** Optional. Lets interactive UIs return to the same conversation after
   * the browser was closed. See ProviderConversation and urlConversation. */
  conversation?: ProviderConversation;
```

and in `defineProvider`, before `return provider;`:

```ts
  if (provider.conversation !== undefined) {
    for (const key of ["handle", "open"] as const) {
      if (typeof provider.conversation[key] !== "function") {
        throw new Error(`Provider conversation.${key} must be a function.`);
      }
    }
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/provider` → PASS. Then `bun run check` → PASS.

- [ ] **Step 5: Commit and sync**

```bash
git add packages/provider/src
git commit -m "feat(provider): conversation handle contract and urlConversation helper (Refs #109, #73)"
gh issue comment 109 --body "Task 1 done: Provider.conversation + urlConversation. What's next: Task 2, core restore in ChatSession.open."
```

---

### Task 2: Core — restore on open, handle refresh, restore notes (Opus)

**Files:**
- Create: `packages/core/src/conversation-note.ts`, `packages/core/src/conversation-note.test.ts`
- Modify: `packages/core/src/chat-session.ts` (`ChatSessionOptions`, `open`, `attempt` at ~:269-292, `send` at ~:300-327, getters next to `responseFormat`), `packages/core/src/chat-session.test.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Provider.conversation` (Task 1).
- Produces:
  ```ts
  // ChatSessionOptions gains:
  conversation?: string;
  // ChatSession gains:
  get conversation(): string | undefined;   // last known handle
  get restored(): boolean | undefined;      // true restored, false fell back, undefined not attempted
  // conversation-note.ts
  export const RESTORED_NOTE = "conversation restored";
  export const NOT_RESTORED_NOTE = "conversation could not be restored";
  export function restoreNote(restored: boolean | undefined): string | undefined;
  export function withRestoreNote(separator: string, restored: boolean | undefined): string;
  ```

- [ ] **Step 1: Notes module, test first** — `conversation-note.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  NOT_RESTORED_NOTE,
  RESTORED_NOTE,
  restoreNote,
  withRestoreNote,
} from "./conversation-note.js";

test("restoreNote", () => {
  expect(restoreNote(true)).toBe(RESTORED_NOTE);
  expect(restoreNote(false)).toBe(NOT_RESTORED_NOTE);
  expect(restoreNote(undefined)).toBeUndefined();
});

test("withRestoreNote joins with a middle dot, or leaves the separator alone", () => {
  expect(withRestoreNote("reopened", true)).toBe(
    "reopened · conversation restored",
  );
  expect(withRestoreNote("reopened", false)).toBe(
    "reopened · conversation could not be restored",
  );
  expect(withRestoreNote("reopened", undefined)).toBe("reopened");
});
```

`conversation-note.ts`:

```ts
/** Wording shared by the interactive UIs, so the TUI and the VSCode view
 * describe a restore the same way. */
export const RESTORED_NOTE = "conversation restored";
export const NOT_RESTORED_NOTE = "conversation could not be restored";

/** `undefined`: no restore was attempted, so there is nothing to say. */
export function restoreNote(restored: boolean | undefined): string | undefined {
  if (restored === undefined) return undefined;
  return restored ? RESTORED_NOTE : NOT_RESTORED_NOTE;
}

export function withRestoreNote(
  separator: string,
  restored: boolean | undefined,
): string {
  const note = restoreNote(restored);
  return note === undefined ? separator : `${separator} · ${note}`;
}
```

Export all four from `packages/core/src/index.ts`.

- [ ] **Step 2: Write the failing session tests** in `chat-session.test.ts`, using that file's existing fake runtime/provider helpers. The fake page needs a `url()` and the fake provider a `conversation` whose calls are recorded. Required cases (one `test` each):

  1. No `conversation` option → `startNewChat` called, `conversation.open` not called, `session.restored === undefined`.
  2. Option given but provider has no `conversation` → same as 1.
  3. Option given, `open` resolves, page stays on the chat origin → `startNewChat` **not** called, `restored === true`, `session.conversation === <the handle>`.
  4. `open` throws → `page.goto(chatUrl)` called a second time, `startNewChat` called, `restored === false`, `ChatSession.open` resolves.
  5. `open` never settles → same fallback after the opening timeout (use a small `open.timeoutMs`).
  6. `open` resolves but `page.url()` is then `https://other.test/x` → fallback, `restored === false`.
  7. After a successful `send`, `conversation.handle` is called and `session.conversation` is its value.
  8. `handle` throws → `send` still resolves with the reply; `session.conversation` keeps the previous value.
  9. `handle` returns `undefined` → previous value kept.
  10. With a restored handle `"H-SECRET"` and an `onProgress` spy, open + send + close: no progress message contains `"H-SECRET"`; in case 4 the thrown-and-swallowed error does not surface it either.
  11. A retried opening phase (`open.retries: 1`, first attempt's `goto` fails with a retryable error) passes the handle to the second attempt too.

- [ ] **Step 3: Run to verify they fail** — `bun test packages/core/src/chat-session.test.ts` → the new cases FAIL.

- [ ] **Step 4: Implement.** In `ChatSessionOptions`:

```ts
  /** Interactive callers only. A handle from an earlier session's
   * `conversation` getter: the opening phase restores that conversation
   * instead of starting a new chat, when the provider has `conversation`.
   * Restoring never fails the open; see `restored`. */
  conversation?: string;
```

`attempt` takes the handle and returns the outcome:

```ts
  private static async attempt(
    launch: () => Promise<RuntimeLike>,
    preCheck: (() => string | undefined) | undefined,
    provider: Provider,
    timeoutMs: number,
    conversation: string | undefined,
  ): Promise<{ rt: RuntimeLike; restored: boolean | undefined }> {
    const rt = await launchRuntime(launch, preCheck);
    try {
      rt.page.setDefaultTimeout(timeoutMs);
      await runStep("goto", timeoutMs, () => rt.page.goto(provider.chatUrl));
      await ChatSession.assertLoggedIn(provider, rt.page, timeoutMs);
      let restored: boolean | undefined;
      if (conversation !== undefined && provider.conversation !== undefined) {
        restored = await ChatSession.restore(
          provider,
          provider.conversation,
          rt.page,
          conversation,
          timeoutMs,
        );
        // The failed restore may have left the page anywhere.
        if (!restored) {
          await runStep("goto", timeoutMs, () =>
            rt.page.goto(provider.chatUrl),
          );
        }
      }
      if (restored !== true) {
        await runStep("startNewChat", timeoutMs, () =>
          provider.startNewChat(rt.page),
        );
      }
      return { rt, restored };
    } catch (err) {
      await rt.close().catch(() => {});
      throw err;
    }
  }

  /** True when the page now shows the conversation. Every failure is a
   * `false`, never a throw: a conversation that cannot be restored costs the
   * user the context, not the session. A provider's `open` must not be able
   * to park the session on another site either. */
  private static async restore(
    provider: Provider,
    conversation: ProviderConversation,
    page: Page,
    handle: string,
    timeoutMs: number,
  ): Promise<boolean> {
    try {
      await runStep("openConversation", timeoutMs, () =>
        conversation.open(page, handle),
      );
      return new URL(page.url()).origin === new URL(provider.chatUrl).origin;
    } catch {
      return false;
    }
  }
```

If `runStep`'s first parameter is a string-literal union, add `"openConversation"` and `"conversationHandle"` to it. `open()` passes `opts.conversation` to `attempt`, destructures `{ rt, restored }`, and hands both to the constructor (add two private fields: `restoredFlag: boolean | undefined` and `handle: string | undefined`, the latter initialised to `opts.conversation` only when `restored === true`). Getters:

```ts
  /** Handle of the conversation on the page, as of the last successful
   * turn. A UI keeps it to pass as `conversation` on its next open. */
  get conversation(): string | undefined {
    return this.handle;
  }

  /** `true`: the opening phase restored `opts.conversation`. `false`: it
   * tried and fell back to a new chat. `undefined`: nothing to restore. */
  get restored(): boolean | undefined {
    return this.restoredFlag;
  }
```

In `send`, replace `return await waiting;` with:

```ts
      const reply = await waiting;
      await this.refreshConversation();
      return reply;
```

```ts
  /** How long a turn may wait for the provider to name its conversation. */
  const HANDLE_BUDGET_MS = 5_000; // module scope, next to IDLE_CLOSE_BUDGET_MS

  /** After a turn: a new chat only gets its id once the first reply exists.
   * Best effort, and capped well below the turn timeout: the reply is
   * already here and must not wait on a wedged page. */
  private async refreshConversation(): Promise<void> {
    const conversation = this.provider.conversation;
    if (conversation === undefined) return;
    try {
      const handle = await runStep(
        "conversationHandle",
        Math.min(this.timeoutMs, HANDLE_BUDGET_MS),
        () => conversation.handle(this.rt.page),
      );
      if (typeof handle === "string" && handle !== "") this.handle = handle;
    } catch {
      // Keep the previous handle.
    }
  }
```

- [ ] **Step 5: Run** `bun test packages/core` → PASS; `bun run check` → PASS.

- [ ] **Step 6: Commit and sync**

```bash
git add packages/core/src
git commit -m "feat(core): restore a conversation on open, refresh its handle after each turn (Refs #109, #73)"
gh issue comment 109 --body "Task 2 done: ChatSession.open({conversation}), restored/conversation getters, restore notes. What's next: Task 3, dummy-chat conversation URLs + E2E."
```

---

### Task 3: dummy-chat conversation URLs and the restore E2E (Opus)

**Files:**
- Modify: `examples/dummy-chat/server.ts` (`dummyReply`, `chatHtml`, the `/chat` and `/reply` routes), `examples/dummy-chat/server.test.ts`, `examples/dummy-chat/provider.ts`, `packages/core/src/session.e2e.test.ts`

**Interfaces:**
- Consumes: `urlConversation` (Task 1), `ChatSession.open({ conversation })`, `session.conversation`, `session.restored` (Task 2).
- Produces: dummy-chat behaviour other tasks' manual checks rely on:
  - `GET /chat` — a new chat, as today.
  - `POST /reply` with header `x-conversation: <id>` (absent for the first turn) → `{ chunks, conversation: <id> }`. The server keeps, per id, the list of `{ prompt, replyHtml }` turns in memory.
  - After the first reply the page runs `history.replaceState(null, "", "/chat/c/" + id)`.
  - `GET /chat/c/<id>` with a valid session: a known id serves the chat page with the earlier turns already in `#chat-log` (same `.message.user` / `.message.assistant` markup) and the id in `<meta name="conversation">`; an unknown id → `302 /chat`. Without a session → `302 /login`, as `/chat`.
  - The prompt `turns?` is answered `Echo: turns? (turn N)` where N is that conversation's turn count including this one. Every other reply is unchanged, so existing assertions on `Echo: …` hold.
  - Ids are `[a-z0-9]{8}`. Prior-turn user text goes through the existing `escapeHtml`.
  - The `/hard/*` skin is untouched.

- [ ] **Step 1: Failing server tests** in `server.test.ts` (follow the file's existing fetch-with-cookie helper):
  - first `POST /reply` returns a `conversation` matching `/^[a-z0-9]{8}$/`; a second one sending that header returns the same id;
  - `turns?` as second turn → chunks' last element contains `turn 2`;
  - `GET /chat/c/<id>` → 200, body contains the first prompt (escaped) and `<meta name="conversation" content="<id>">`;
  - `GET /chat/c/zzzzzzzz` → 302 with `location: /chat`;
  - `GET /chat/c/<id>` without cookie → 302 `/login`;
  - a prompt `<b>x</b>` appears in the restored page as `&lt;b&gt;x&lt;/b&gt;`.
- [ ] **Step 2:** `bun test examples/dummy-chat/server.test.ts` → new cases FAIL.
- [ ] **Step 3: Implement** the server changes above. `dummyReply(text, turn = 1)` keeps its current signature compatible (second parameter optional). In the page script, read the meta, send the header when an id is known, and `replaceState` when the response carries an id the page does not have yet.
- [ ] **Step 4: Provider.** In `examples/dummy-chat/provider.ts` import `urlConversation` and add, after `streaming`:

```ts
    // The conversation id is in the URL once the first reply exists.
    conversation: urlConversation({ match: /\/chat\/c\/[a-z0-9]{8}$/ }),
```

- [ ] **Step 5: Failing E2E** appended to `packages/core/src/session.e2e.test.ts`, using that file's existing server/auth-store setup helpers:

```ts
test("a later session restores the conversation from its handle", async () => {
  const first = await ChatSession.open(sessionOpts());
  await first.send("hello");
  expect(await first.send("turns?")).toContain("turn 2");
  const handle = first.conversation;
  expect(handle).toMatch(/\/chat\/c\/[a-z0-9]{8}$/);
  await first.close();

  const second = await ChatSession.open({
    ...sessionOpts(),
    conversation: handle,
  });
  try {
    expect(second.restored).toBe(true);
    expect(await second.send("turns?")).toContain("turn 3");
  } finally {
    await second.close();
  }
});

test("an unknown handle falls back to a new chat", async () => {
  const session = await ChatSession.open({
    ...sessionOpts(),
    conversation: `${chat.url}/chat/c/zzzzzzzz`,
  });
  try {
    expect(session.restored).toBe(false);
    expect(await session.send("turns?")).toContain("turn 1");
  } finally {
    await session.close();
  }
});
```

(`sessionOpts()` / `chat` stand for whatever that file already names its options builder and dummy server; keep its names.)

- [ ] **Step 6:** `bun run build && bun test packages/core examples/dummy-chat` → PASS. `bun run check` → PASS (the streaming check in the dummy provider counts user vs assistant nodes; a restored page has equal counts, so it keeps working — the E2E above proves it).
- [ ] **Step 7: Commit and sync**

```bash
git add examples/dummy-chat packages/core/src/session.e2e.test.ts
git commit -m "test: dummy-chat conversation URLs and the restore E2E (Refs #109, #73)"
gh issue comment 109 --body "Task 3 done: dummy-chat serves /chat/c/<id>; E2E covers restore and fallback. What's next: Task 4, TUI ChatModel remembers the handle."
```

---

### Task 4: TUI — remember, pass, forget (Opus)

**Files:**
- Modify: `packages/cli/src/tui/chat-model.ts` (`ChatSessionLike` ~:42, `ChatModelOptions.openSession` ~:122, `open` ~:291, `sendPrompt` ~:610-645, `runSlash` cases `new`/`logout` ~:732-752, `reset`/`runReset` ~:924-968), `packages/cli/src/tui/chat-model.test.ts`, `packages/cli/src/tui/run-interactive.ts` (~:196-208)

**Interfaces:**
- Consumes: `session.conversation`, `session.restored`, `withRestoreNote` from `@chatbridge/core` (Task 2).
- Produces:
  ```ts
  // ChatSessionLike gains (optional so older fakes keep working):
  readonly conversation?: string;
  readonly restored?: boolean;
  // ChatModelOptions.openSession becomes:
  openSession: (
    report: (message: string) => void,
    onIdleExpired: (closing: Promise<void>) => void,
    conversation: string | undefined,
  ) => Promise<ChatSessionLike>;
  // reset gains an options bag:
  reset(separator?: string, opts?: { forget?: boolean }): Promise<void>;
  ```

Behaviour:
- A private `conversationHandle: string | undefined`. After every successful `session.send` in `sendPrompt` (past the stale-generation check): `this.conversationHandle = session.conversation ?? this.conversationHandle`.
- `open()` passes `this.conversationHandle` as the third argument.
- `runReset(separator, forget)`: when `forget`, clear the handle **before** opening. After a successful open, push `withRestoreNote(separator, this.current.restored)` instead of `separator`. A failed restore (`restored === false`) also clears the handle, so the next reopen does not retry a dead one.
- `/new` → `reset(NEW_CHAT_SEPARATOR, { forget: true })`. `/logout` → its final `reset(undefined, { forget: true })`. `/reopen`, Ctrl+R, the idle reopen (`IDLE_SEPARATOR`) and the reset after `/login` keep the handle.
- The initial open at startup passes `undefined` (nothing remembered yet) — no behaviour change.
- The comment on `IDLE_SEPARATOR` ("tells the user the service-side conversation is a new chat") is now only true without a restore; reword it.

- [ ] **Step 1: Failing tests** in `chat-model.test.ts` with the file's fake-session factory, extended to record the third `openSession` argument and to expose settable `conversation` / `restored`:
  1. after a turn on a session whose `conversation` is `"H1"`, `/reopen` opens with `"H1"`; separator is `reopened · conversation restored` when the new fake reports `restored: true`;
  2. `restored: false` → `reopened · conversation could not be restored`, and a further `/reopen` opens with `undefined`;
  3. a fake without `restored` → plain `reopened`;
  4. `/new` opens with `undefined`, separator exactly `new chat`;
  5. `/logout` opens with `undefined`;
  6. idle close then a prompt → opens with `"H1"`, separator `reopened after idle · conversation restored`;
  7. a turn that fails does not overwrite the remembered handle;
  8. a stale turn (reset during the send) does not write its session's handle.
- [ ] **Step 2:** `bun test packages/cli/src/tui/chat-model.test.ts` → new cases FAIL.
- [ ] **Step 3: Implement** as described; in `run-interactive.ts`:

```ts
        ((report, onIdleExpired, conversation) =>
          ChatSession.open({
            ...sessionOpts,
            onOpenProgress: report,
            onIdleExpired,
            conversation,
          })),
```

- [ ] **Step 4:** `bun run build && bun test packages/cli` → PASS; `bun run check` → PASS.
- [ ] **Step 5: Manual check.** `bun examples/dummy-chat/serve.ts` in one terminal; in another run the example CLI interactively against it (see `examples/dummy-chat/package.json` scripts), send `hello`, `turns?` (→ turn 2), `/reopen`, `turns?` → `turn 3` and the separator reads `reopened · conversation restored`. `/new`, `turns?` → `turn 1`.
- [ ] **Step 6: Commit and sync**

```bash
git add packages/cli/src/tui
git commit -m "feat(cli): the TUI returns to the same conversation after a reopen or an idle close (Refs #109, #73)"
gh issue comment 109 --body "Task 4 done: ChatModel remembers/passes/forgets the handle. What's next: Task 5, VSCode protocol + SessionController."
```

---

### Task 5: VSCode host — protocol, streaming, handle (Opus)

**Files:**
- Modify: `packages/vscode/src/protocol.ts`, `packages/vscode/src/chat-view-bridge.ts` (+ its test), `packages/vscode/src/session-controller.ts` (+ its test), `packages/vscode/src/create-extension.ts`

**Interfaces:**
- Consumes: `SendOptions`, `withRestoreNote`, `restoreNote` from `@chatbridge/core`.
- Produces (`protocol.ts`):
  ```ts
  export interface Message {
    role: Role;
    text: string;
    attachments?: Attachment[];
    /** `assistant` entries: how to render `text`. Absent means "text". */
    format?: "markdown" | "text";
    /** `assistant` entries: the turn failed after this much had streamed. */
    incomplete?: true;
  }
  // ToHost gains:
  | { type: "copyText"; text: string }
  // ToWebview gains:
  /** The reply being streamed, whole text so far. Not part of `State`: a
   * state frame carries the whole history and is far too heavy for the
   * polling rate. The next `state` frame that is not `busy` ends it. */
  | { type: "partial"; text: string; format: "markdown" | "text" }
  ```
- Produces (`session-controller.ts`):
  ```ts
  export interface ChatSessionLike {
    send(prompt: string, opts?: SendOptions): Promise<string>;
    readonly responseFormat?: "markdown" | "text";
    readonly conversation?: string;
    readonly restored?: boolean;
    runCommand?(name: string, args: string): Promise<ProviderCommandResult>;
    close(): Promise<void>;
    kill(): Promise<void>;
  }
  // SessionControllerOptions:
  openSession: (
    onIdleExpired: (closing: Promise<void>) => void,
    conversation: string | undefined,
  ) => Promise<ChatSessionLike>;
  /** Called with the streamed text of the turn in flight. */
  onPartial?: (text: string, format: "markdown" | "text") => void;
  ```

Behaviour in `SessionController`:
- `runTurn`: keep `let partial: string | undefined`. Call `session.send(prompt, { onPartial: (t) => { if (generation !== this.generation) return; partial = t; this.opts.onPartial?.(t, session.responseFormat ?? "text"); } })`.
- Success: push `{ role: "assistant", text: reply, ...(format === "markdown" ? { format } : {}) }`; then `this.conversationHandle = session.conversation ?? this.conversationHandle`.
- Failure (current generation only): when `partial` is a non-empty string, push `{ role: "assistant", text: partial, format?, incomplete: true }` **before** `fail(err)` pushes the error.
- `open()` passes `this.conversationHandle` to `openSession`.
- `ensureSession` (the lazy open, which is also the path after `closed after idle` and after a fatal drop): when the opened session's `restored !== undefined`, insert a separator `restoreNote(restored)` — before the trailing `user` message when the last history entry is one, otherwise at the end — and clear the handle when `restored === false`.
- `runReopen`: push `withRestoreNote(REOPENED_SEPARATOR, session.restored)`; clear the handle when `restored === false`.
- `discard(separator)` (new chat, logout): clear the handle before dropping the session.
- Update the comment on `IDLE_CLOSED_SEPARATOR`: the conversation now starts over only when it cannot be restored.
- `copyText`: `chat-view-bridge.ts` `isToHost` accepts `{ type: "copyText", text: string }` (string check, same length cap the file applies to `send` text if it has one); `ChatViewBridge` gets `postPartial(text, format)`; `create-extension.ts` wires `onPartial: (t, f) => bridge.postPartial(t, f)`, passes `conversation` into `ChatSession.open`, and handles `copyText` with `vscode.env.clipboard.writeText(text)`.

- [ ] **Step 1: Failing tests** in `session-controller.test.ts` (fake session whose `send` invokes `opts.onPartial` before resolving/rejecting, and records `openSession`'s second argument):
  1. partials reach `onPartial` with the session's format; the settled assistant message carries `format: "markdown"`;
  2. a `text` provider → no `format` key on the message, `onPartial` format `"text"`;
  3. `send` rejects after a partial `"half"` → history ends `assistant{ text:"half", incomplete:true }`, `error`;
  4. rejects with no partial → only the `error`;
  5. a partial delivered after `reopen()` bumped the generation is not forwarded;
  6. handle `"H1"` after a turn → `reopen()` opens with `"H1"`; separator `reopened · conversation restored` / `… could not be restored` / plain `reopened` by `restored`;
  7. `restored: false` clears the handle (next open gets `undefined`);
  8. idle expiry then `send("x")` → lazy open with `"H1"`; history is `…, separator "closed after idle", separator "conversation restored", user "x", assistant`;
  9. `newChat()` and `discard("Logged out")` → next open gets `undefined`;
  10. a failed turn does not overwrite the handle.
  In `chat-view-bridge.test.ts`: `copyText` with a string passes `isToHost`, with a number does not; `postPartial` posts `{ type: "partial", text, format }`.
- [ ] **Step 2:** `bun test packages/vscode` → new cases FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `bun run build && bun test packages/vscode` → PASS; `bun run check` → PASS (includes `check:webview`: `main.ts` must still compile against the widened `ToWebview` — add an empty `else if (m.type === "partial") {}` branch if the type-checker demands exhaustiveness; Task 8 fills it).
- [ ] **Step 5: Commit and sync**

```bash
git add packages/vscode/src
git commit -m "feat(vscode): stream partial replies to the view and return to the same conversation after a reopen (Refs #109, #73)"
gh issue comment 109 --body "Task 5 done: host-side streaming, format/incomplete, handle, copyText. What's next: Task 6, markdown-tree."
```

---

### Task 6: Webview — `markdown-tree.ts` (Opus)

**Files:**
- Modify: `packages/vscode/package.json` (devDependency)
- Create: `packages/vscode/src/webview/markdown-tree.ts`, `packages/vscode/src/webview/markdown-tree.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TreeNode {
    /** An HTML tag name, or "#text" for a text node. */
    tag: string;
    className?: string;
    /** "#text": the text. "pre": the code. */
    text?: string;
    /** "a" only, and only http(s). */
    href?: string;
    /** "pre" only: the fence language, when given. */
    lang?: string;
    /** "input" only (task list): checked state. */
    checked?: boolean;
    children?: TreeNode[];
  }
  export function toTree(markdown: string): TreeNode[];
  ```

- [ ] **Step 1: Add the dependency.** `cd packages/vscode && bun add -d --exact marked` — it must resolve to **13.0.0 or newer** (since 13 the lexer leaves text unescaped; older versions HTML-escape `codespan`/`escape` token text, which would show `&lt;` literally). Pin exactly, like `esbuild`. Verify the lock with a clean `bun install`.

- [ ] **Step 2: Failing tests** — `markdown-tree.test.ts`. A helper keeps assertions short:

```ts
import { describe, expect, test } from "bun:test";
import { type TreeNode, toTree } from "./markdown-tree.js";

/** Flattens to a compact string: tag(children) with text in quotes. */
function show(nodes: TreeNode[]): string {
  return nodes
    .map((n) => {
      if (n.tag === "#text") return JSON.stringify(n.text);
      const attrs = [
        n.href !== undefined ? `href=${n.href}` : "",
        n.lang !== undefined ? `lang=${n.lang}` : "",
        n.className ? `.${n.className}` : "",
        n.checked !== undefined ? `checked=${n.checked}` : "",
      ].join("");
      const body =
        n.children !== undefined
          ? show(n.children)
          : n.text !== undefined
            ? JSON.stringify(n.text)
            : "";
      return `${n.tag}${attrs}(${body})`;
    })
    .join("");
}

/** Every text in the tree, concatenated. */
function allText(nodes: TreeNode[]): string {
  return nodes
    .map((n) => (n.text ?? "") + allText(n.children ?? []))
    .join("");
}

describe("toTree blocks", () => {
  test("heading and paragraph", () => {
    expect(show(toTree("## Title\n\nbody"))).toBe('h2("Title")p("body")');
  });
  test("nested list", () => {
    expect(show(toTree("- a\n  - b\n- c"))).toBe(
      'ul(li("a"ul(li("b")))li("c"))',
    );
  });
  test("ordered list keeps a start other than 1", () => {
    const [ol] = toTree("3. x\n4. y");
    expect(ol?.tag).toBe("ol");
    expect(ol?.className).toBe("start-3"); // consumed by main.ts as the start attribute
  });
  test("task list", () => {
    expect(show(toTree("- [x] done\n- [ ] todo"))).toContain(
      "input.taskchecked=true()",
    );
  });
  test("fenced code keeps language and literal text", () => {
    expect(show(toTree("```ts\nconst a = 1 < 2;\n```"))).toBe(
      'prelang=ts("const a = 1 < 2;")',
    );
  });
  test("blockquote, hr", () => {
    expect(show(toTree("> q\n\n---"))).toBe('blockquote(p("q"))hr()');
  });
  test("table with alignment classes", () => {
    const out = show(toTree("| k | v |\n| :-- | --: |\n| a | 1 |"));
    expect(out).toContain('th.align-left("k")');
    expect(out).toContain('td.align-right("1")');
  });
});

describe("toTree inline", () => {
  test("strong, em, del, code, br", () => {
    expect(show(toTree("**b** *i* ~~d~~ `c`"))).toBe(
      'p(strong("b")" "em("i")" "del("d")" "code("c"))',
    );
  });
  test("literal characters are not entity-escaped", () => {
    expect(allText(toTree("a < b & c and `<x>` and \\*"))).toBe(
      "a < b & c and <x> and *",
    );
  });
  test("http(s) link", () => {
    expect(show(toTree("[t](https://e.test/p)"))).toBe(
      'p(ahref=https://e.test/p("t"))',
    );
  });
});

describe("toTree safety", () => {
  test.each([
    "[x](javascript:alert(1))",
    "[x](data:text/html,hi)",
    "[x](vscode://ext/cmd)",
    "[x](command:workbench.action.quit)",
    "[x](//e.test/p)",
    "[x](/relative)",
  ])("%s gets no href", (md) => {
    const flat = show(toTree(md));
    expect(flat).not.toContain("href=");
    expect(flat).toContain('"x"');
  });
  test("raw HTML is text, never a node", () => {
    const tree = toTree('<img src=x onerror=alert(1)>\n\n<b>hi</b> <script>x</script>');
    const flat = show(tree);
    expect(flat).not.toMatch(/\b(img|script|b)\(/);
    expect(allText(tree)).toContain("<img src=x onerror=alert(1)>");
    expect(allText(tree)).toContain("<script>");
  });
  test("an image becomes a link with its alt text, never an img", () => {
    expect(show(toTree("![cat](https://e.test/c.png)"))).toBe(
      'p(ahref=https://e.test/c.png.image("cat"))',
    );
  });
  test("only allow-listed tags are ever produced", () => {
    const ALLOWED = new Set([
      "#text", "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li",
      "blockquote", "hr", "pre", "table", "thead", "tbody", "tr", "th", "td",
      "strong", "em", "del", "code", "a", "br", "input",
    ]);
    const walk = (ns: TreeNode[]): void => {
      for (const n of ns) {
        expect(ALLOWED.has(n.tag)).toBe(true);
        walk(n.children ?? []);
      }
    };
    walk(toTree("# h\n\n<div>x</div>\n\n- [ ] t\n\n|a|\n|-|\n|b|\n\n![i](https://e.test/i)"));
  });
});

describe("toTree on streaming input", () => {
  test.each([
    "```ts\nconst a",
    "**bo",
    "| a | b |\n| -",
    "- item\n  - ",
    "[link](https://e.te",
    "",
  ])("never throws on %j", (partial) => {
    expect(() => toTree(partial)).not.toThrow();
  });
  test("an unclosed fence is a code block", () => {
    expect(show(toTree("```ts\nconst a"))).toBe('prelang=ts("const a")');
  });
  test("every prefix of a full reply renders", () => {
    const full =
      "Echo: md:x\n\n## Details\n\n- **bold** item\n- second item\n\n```ts\nconst a = 1;\n```\n\n| k | v |\n| --- | --- |\n| a | 1 |";
    for (let i = 0; i <= full.length; i++) {
      expect(() => toTree(full.slice(0, i))).not.toThrow();
    }
  });
});
```

- [ ] **Step 3:** `bun test packages/vscode/src/webview/markdown-tree.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement** `markdown-tree.ts`. Shape:

```ts
import { type Token, type Tokens, marked } from "marked";

// (TreeNode as in Interfaces)

const text = (value: string): TreeNode => ({ tag: "#text", text: value });

/** http(s) only, absolute only. Everything else — javascript:, data:,
 * command:, vscode:, protocol-relative, relative — is shown as text: a
 * webview link must never run a command or open a local resource. */
function safeHref(href: string): string | undefined {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:"
      ? href
      : undefined;
  } catch {
    return undefined;
  }
}

export function toTree(markdown: string): TreeNode[] {
  try {
    return blocks(marked.lexer(markdown, { gfm: true }));
  } catch {
    // Never let a parser edge case blank the reply.
    return [{ tag: "p", children: [text(markdown)] }];
  }
}
```

`blocks(tokens)` switches on `token.type`: `heading` → `h${depth}` with `inline(token.tokens)`; `paragraph` → `p`; `text` (block-level, inside tight list items) → its inline children without a wrapper; `list` → `ul`/`ol` (`className: "start-N"` when `ordered` and `start !== 1`), each item `li` with `blocks(item.tokens)`, and for `item.task` a leading `{ tag: "input", className: "task", checked: item.checked === true }`; `blockquote` → `blockquote` with `blocks(token.tokens)`; `code` → `{ tag: "pre", lang: first word of token.lang or undefined, text: token.text }`; `table` → `table > thead > tr > th*` and `tbody > tr* > td*` with `className: "align-left|center|right"` from `token.align[i]`; `hr` → `hr`; `space` → nothing; `html` and every unknown type → `{ tag: "p", children: [text(token.raw)] }`.

`inline(tokens)`: `text`/`escape` → `text(token.text)` (a `text` token with nested `tokens` recurses); `strong`/`em`/`del` → that tag with `inline(token.tokens)`; `codespan` → `{ tag: "code", children: [text(token.text)] }`; `br` → `br`; `link` → with `safeHref`: `{ tag: "a", href, children: inline(token.tokens) }`, otherwise just `inline(token.tokens)` followed by nothing (the visible text survives, the target does not); `image` → with `safeHref`: `{ tag: "a", href, className: "image", children: [text(token.text || token.href)] }`, otherwise `text(token.text)`; `html` and unknown → `text(token.raw)`.

No `marked.parse`, no renderer, no `marked.use`: only `marked.lexer`. If the literal-characters test shows entity-escaped text, the installed `marked` is older than 13 — fix the version, do not unescape by hand.

- [ ] **Step 5:** tests PASS; `bun run check` PASS (esbuild must bundle `marked` into `dist/webview/main.js` once Task 8 imports it; nothing imports it yet, so the bundle is unchanged here).
- [ ] **Step 6: Commit and sync**

```bash
git add packages/vscode/package.json bun.lock packages/vscode/src/webview/markdown-tree.ts packages/vscode/src/webview/markdown-tree.test.ts
git commit -m "feat(vscode): Markdown to a plain node tree for the webview, lexer only (Refs #109)"
gh issue comment 109 --body "Task 6 done: markdown-tree with its safety rules. What's next: Task 7, stream-state."
```

---

### Task 7: Webview — `stream-state.ts` (Sonnet)

**Files:**
- Create: `packages/vscode/src/webview/stream-state.ts`, `packages/vscode/src/webview/stream-state.test.ts`

**Interfaces:**
- Consumes: `Message`, `Status` from `../protocol.js` (Task 5).
- Produces:
  ```ts
  export function messageKey(m: Message): string;
  export function commonPrefix(prev: readonly string[], next: readonly string[]): number;
  export interface StreamState { text: string; format: "markdown" | "text"; at: number }
  export function onPartial(current: StreamState | undefined, text: string, format: "markdown" | "text", messageCount: number): StreamState;
  export function onState(current: StreamState | undefined, status: Status, messageCount: number): StreamState | undefined;
  ```

- [ ] **Step 1: Failing tests** — `stream-state.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Message } from "../protocol.js";
import { commonPrefix, messageKey, onPartial, onState } from "./stream-state.js";

const user = (text: string): Message => ({ role: "user", text });

describe("messageKey", () => {
  test("equal messages share a key", () => {
    expect(messageKey(user("a"))).toBe(messageKey(user("a")));
  });
  test.each<[string, Message, Message]>([
    ["text", user("a"), user("b")],
    ["role", user("a"), { role: "assistant", text: "a" }],
    ["format", { role: "assistant", text: "a" }, { role: "assistant", text: "a", format: "markdown" }],
    ["incomplete", { role: "assistant", text: "a" }, { role: "assistant", text: "a", incomplete: true }],
    ["attachments", user("a"), { role: "user", text: "a", attachments: [{ path: "f", bytes: 1 }] }],
  ])("%s changes the key", (_n, a, b) => {
    expect(messageKey(a)).not.toBe(messageKey(b));
  });
});

describe("commonPrefix", () => {
  test("append keeps everything", () => {
    expect(commonPrefix(["a", "b"], ["a", "b", "c"])).toBe(2);
  });
  test("a popped tail keeps the rest", () => {
    expect(commonPrefix(["a", "b", "c"], ["a", "b"])).toBe(2);
  });
  test("a replaced entry cuts there", () => {
    expect(commonPrefix(["a", "x", "c"], ["a", "y", "c"])).toBe(1);
  });
  test("empty", () => {
    expect(commonPrefix([], ["a"])).toBe(0);
  });
});

describe("partial lifecycle", () => {
  test("a partial remembers where it started", () => {
    expect(onPartial(undefined, "he", "markdown", 3)).toEqual({
      text: "he", format: "markdown", at: 3,
    });
  });
  test("later partials keep the first position", () => {
    const first = onPartial(undefined, "he", "markdown", 3);
    expect(onPartial(first, "hello", "markdown", 3).at).toBe(3);
  });
  test("a busy state frame with the same history keeps it (a queue change)", () => {
    const s = onPartial(undefined, "he", "text", 3);
    expect(onState(s, "busy", 3)).toBe(s);
  });
  test("the settled reply ends it", () => {
    const s = onPartial(undefined, "he", "text", 3);
    expect(onState(s, "idle", 4)).toBeUndefined();
  });
  test("busy again with a longer history is the next turn: the old partial is gone", () => {
    const s = onPartial(undefined, "he", "text", 3);
    expect(onState(s, "busy", 5)).toBeUndefined();
  });
  test.each(["closed", "opening", "reopening", "dead", "idle"] as const)(
    "%s ends it",
    (status) => {
      const s = onPartial(undefined, "he", "text", 3);
      expect(onState(s, status, 3)).toBeUndefined();
    },
  );
  test("nothing in, nothing out", () => {
    expect(onState(undefined, "busy", 1)).toBeUndefined();
  });
});
```

- [ ] **Step 2:** `bun test packages/vscode/src/webview/stream-state.test.ts` → FAIL.
- [ ] **Step 3: Implement** — `stream-state.ts`:

```ts
import type { Message, Status } from "../protocol.js";

/** Identity of a rendered message: two messages with the same key render
 * the same DOM, so the node can be kept. */
export function messageKey(m: Message): string {
  return JSON.stringify([
    m.role,
    m.text,
    m.format ?? "text",
    m.incomplete === true,
    (m.attachments ?? []).map((a) => [a.path, a.bytes]),
  ]);
}

/** How many leading rendered messages survive a new state frame. The
 * history is append-mostly (a retry pops the trailing error), so a common
 * prefix is all the diff it needs. */
export function commonPrefix(
  prev: readonly string[],
  next: readonly string[],
): number {
  const max = Math.min(prev.length, next.length);
  let i = 0;
  while (i < max && prev[i] === next[i]) i++;
  return i;
}

/** The reply being streamed. `at` is the history length when it started:
 * a state frame with a different length means the turn moved on. */
export interface StreamState {
  text: string;
  format: "markdown" | "text";
  at: number;
}

export function onPartial(
  current: StreamState | undefined,
  text: string,
  format: "markdown" | "text",
  messageCount: number,
): StreamState {
  return { text, format, at: current?.at ?? messageCount };
}

/** A partial lives only while its own turn is in flight. */
export function onState(
  current: StreamState | undefined,
  status: Status,
  messageCount: number,
): StreamState | undefined {
  if (current === undefined) return undefined;
  return status === "busy" && messageCount === current.at ? current : undefined;
}
```

- [ ] **Step 4:** tests PASS; `bun run check` PASS.
- [ ] **Step 5: Commit and sync**

```bash
git add packages/vscode/src/webview/stream-state.ts packages/vscode/src/webview/stream-state.test.ts
git commit -m "feat(vscode): webview stream state and history diff (Refs #109)"
gh issue comment 109 --body "Task 7 done: stream-state. What's next: Task 8, the DOM layer in main.ts."
```

---

### Task 8: Webview — DOM layer, streaming node, styles (Opus)

**Files:**
- Modify: `packages/vscode/src/webview/main.ts` (`renderMessage` ~:132-151, `render` ~:256-261, the message listener ~:475-500), `packages/vscode/src/webview/style.css`
- Test: no DOM harness exists (#102, out of scope). Keep this layer free of decisions — every branch that can be pure already lives in Tasks 6–7. Add one source-level guard test, `packages/vscode/src/webview/no-html-injection.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

test("the webview never injects HTML", () => {
  const dir = import.meta.dir;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const source = readFileSync(join(dir, file), "utf8");
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      expect(`${file}: ${source.includes(banned)}`).toBe(`${file}: false`);
    }
  }
});
```

**Interfaces:**
- Consumes: `toTree`, `TreeNode` (Task 6); `messageKey`, `commonPrefix`, `onPartial`, `onState`, `StreamState` (Task 7); `partial` frame, `Message.format` / `incomplete`, `copyText` (Task 5).

Requirements:

1. `renderTree(nodes: TreeNode[]): DocumentFragment` — `#text` → `document.createTextNode`; otherwise `document.createElement(tag)`, `className` when set, children recursively. Special cases: `a` → `setAttribute("href", node.href)` only when `href` is set, plus `rel="noopener noreferrer"`; `input` → `type="checkbox"`, `disabled`, `checked` from the node; `ol` with `className` `start-N` → `setAttribute("start", N)` and drop the class; `pre` → a wrapper `div.code-block` holding `div.code-header` (a `span.code-lang` with `lang ?? ""` and a `button.action.code-copy` labelled `Copy`) and `pre > code` whose `textContent` is `node.text`. The button posts `{ type: "copyText", text }` and shows `Copied` for 1.5 s.
2. `renderMessage`: an `assistant` message with `format === "markdown"` gets `div.text.markdown` filled from `renderTree(toTree(m.text))`; everything else stays `textContent`. `incomplete` adds the class `incomplete` and a trailing `div.incomplete-note` with the text `(incomplete)`.
3. `render(s)`: keep `let renderedKeys: string[] = []`. `next = s.messages.map(messageKey)`, `keep = commonPrefix(renderedKeys, next)`; remove history children from index `keep` on (the streaming node is handled separately and is always the last child when present); append `renderMessage` for `s.messages.slice(keep)`; store `next`. Then `stream = onState(stream, s.status, s.messages.length)` and sync the streaming node (remove it when `stream` is `undefined`).
4. Scrolling: measure `atBottom` (the existing 2 px rule from `fitComposer`) **before** mutating; after, scroll to the end when `atBottom` was true or when the appended messages include a `user` message. Replace the unconditional `history.scrollTop = history.scrollHeight`.
5. `partial` frame: `stream = onPartial(stream, m.text, m.format, lastState?.messages.length ?? 0)`; schedule one `requestAnimationFrame` (a boolean guard coalesces frames) that creates the streaming node on first use — `div.message.assistant.streaming > div.text` — and replaces its content: `renderTree(toTree(text))` for markdown (add class `markdown`), `textContent` otherwise. A frame that fires after `stream` became `undefined` does nothing. The "Waiting..." status line keeps working as today.
6. `style.css`: classes only, VSCode theme variables only. Cover `.markdown` headings (scaled down for a sidebar: h1 1.3em … h6 1em), paragraphs and lists spacing, `blockquote` (left border `--vscode-textBlockQuote-border`, background `--vscode-textBlockQuote-background`), inline `code` and `.code-block pre` (`--vscode-textCodeBlock-background`, `--vscode-editor-font-family`, `overflow-x: auto`), `.code-header` (flex, small, `--vscode-descriptionForeground`), tables (`border-collapse`, `--vscode-panel-border`, horizontal scroll wrapper not required: `display: block; overflow-x: auto` on `table`), `.align-left/center/right`, links (`--vscode-textLink-foreground`), `a.image::before { content: "🖼 "; }`, `.incomplete-note` (`--vscode-descriptionForeground`, italic), `input.task` margin.

- [ ] **Step 1:** add the guard test; run it → PASS already (it guards the future).
- [ ] **Step 2:** implement 1–6.
- [ ] **Step 3:** `bun run check` → PASS. Confirm the bundle grew by roughly the size of `marked` and contains no `innerHTML`: `grep -c innerHTML packages/vscode/dist/webview/main.js` → `0`. (If `marked`'s own bundle contains the word, relax the grep to the webview sources only and say so in the commit body.)
- [ ] **Step 4: Manual verification** with `examples/vscode-dummy-chat` (its README/`package.json` say how to launch the Extension Development Host; the dummy server must be running):
  - `md:hello` → the reply grows while streaming and ends as heading, list with bold, highlighted-less `ts` code block with header + Copy, table;
  - select text in an earlier reply, send another prompt: the selection survives the stream;
  - scroll up during a stream: the view does not jump; stay at the bottom: it follows;
  - Copy puts the code on the clipboard;
  - `slow:x` then Reopen mid-turn → no stale streaming node remains;
  - two turns, Reopen, `turns?` → `turn 3`, separator `reopened · conversation restored`; New chat, `turns?` → `turn 1`;
  - light and dark theme both readable.
  Record the results in the issue comment.
- [ ] **Step 5: Commit and sync**

```bash
git add packages/vscode/src/webview
git commit -m "feat(vscode): render Markdown replies and stream them in the chat view (Refs #109)"
gh issue comment 109 --body "Task 8 done: webview DOM layer; manual verification: <results>. What's next: Task 9, vendor docs."
```

---

### Task 9: Vendor-facing docs and templates (Sonnet)

**Files:**
- Modify: `packages/provider/skills/upgrading-provider-repo/upgrade-guide.md` (new section above `## 0.10.1`), `packages/provider/skills/creating-provider-repo/templates/src/provider.ts`, `packages/provider/README.md`, `packages/vscode/README.md`, root `README.md` where the Provider surface or VSCode features are listed.

- [ ] **Step 1:** Insert above `## 0.10.1`:

```markdown
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
it in `docs/dom-notes.md`. The interactive UIs then return to the same
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
```

- [ ] **Step 2:** In the provider template, after the `streaming` block, add (commented, like other optional parts of that template):

```ts
  // Optional. When the conversation id is in the URL, this lets the UIs
  // return to the same conversation after /reopen or an idle close.
  // conversation: urlConversation({ match: /\/c\/[0-9a-f-]+$/ }),
```

Do not add an unused import; mention the import in the comment's first line instead if Biome flags it.

- [ ] **Step 3:** READMEs: one short paragraph each — `conversation` / `urlConversation` in the provider README's optional-surface list; Markdown + streaming + code-block copy in the VSCode README's feature list.
- [ ] **Step 4:** `bun run check` → PASS (`packages/provider/skills.test.ts` checks the guide's shape and ordering, and `examples/dummy-chat/templates.test.ts` the templates).
- [ ] **Step 5: Commit and sync**

```bash
git add packages/provider packages/vscode/README.md README.md
git commit -m "docs: upgrade guide 0.11.0, template hint and READMEs for the conversation handle and the VSCode Markdown view (Refs #109)"
gh issue comment 109 --body "Task 9 done: vendor docs. What's next: Task 10, whole-branch review and PR."
```

---

### Task 10: Whole-branch review, PR (Fable / controller)

- [ ] **Step 1:** Whole-branch review with Fable against the spec. Checklist beyond correctness: the handle never reaches a log, progress line or error text; no HTML injection path and the CSP test untouched; `runOneShot` untouched; `createExtension` options and required `contributes` untouched; upgrade-guide entry present and accurate; dependency direction intact; every restore failure path ends in a usable new chat.
- [ ] **Step 2:** Fix loop on findings (Opus; escalate per CLAUDE.md).
- [ ] **Step 3:** `bun run check` → PASS. Open the PR from `issue-109`:
  - Title (release-note quality): `The VSCode chat view renders Markdown and streams replies, and a reopened or idle-closed chat returns to the same conversation`
  - Label: `enhancement`.
  - Body: summary, vendor impact (none required; two optional entries), manual verification results, then `Closes #109` and `Closes #73` on separate lines, a mention of #119 as the follow-up, and the Claude Code footer.
- [ ] **Step 4:** File `backlog` issues for anything the reviews deferred. After the merge: verify #109 and #73 actually closed, append `### 19. …` to `docs/ROADMAP.md`, close the milestone, set the board items to `Done`. Ask the maintainer before the 0.11.0 bump; #118 rides along.
