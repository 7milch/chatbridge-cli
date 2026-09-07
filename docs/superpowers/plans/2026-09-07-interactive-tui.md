# Interactive TUI (Milestone 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-turn `ChatSession` to Core and an OpenTUI-based interactive chat mode to the CLI, started by running the CLI with no `-p`.

**Architecture:** Core gains `ChatSession` (`open` / `send` / `close`) that keeps the browser open across turns; `runOneShot` becomes a one-turn wrapper over it. The CLI gains `packages/cli/src/tui/` with three units: `ChatModel` (pure state), `ChatView` (OpenTUI tree), and `runInteractive` (lifecycle). `createCli` loads the TUI lazily so one-shot mode keeps running on Node 20.

**Tech Stack:** TypeScript, Bun 1.4 (workspaces, `bun test`), Playwright (Chromium), `@opentui/core` 0.5.10 (+ its `testing` entry for a mock terminal), Biome.

**Spec:** `docs/superpowers/specs/2026-09-07-interactive-tui-design.md`

**Issue / branch:** https://github.com/7milch/chatbridge-cli/issues/7 — branch `issue-7` (already created and pushed).

## Global Constraints

- Every committed document, comment, and commit message is in English. Issue comments too.
- Dependency direction is one-way: `cli → core → runtime → provider`. Core, runtime, and provider never import `@opentui/core`.
- `bun run check` (Biome lint + `tsc --build` + `bun test`) must pass before every commit. Tests import cross-package code from `dist/`, so `bun run build` after editing another package.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Q7b7Rr7gCDgHpZzedM4NBD
  ```
- After every commit: `gh issue comment 7 --body "<what was committed> + <what's next>"` (English).
- One-shot progress messages stay exactly `Opening browser...`, `Sending prompt...`, `Waiting for response...`.
- Interactive guide string is exactly `Enter send · Shift+Enter / Ctrl+J newline · Ctrl+C quit`.
- Non-TTY message: `interactive mode needs a terminal; use -p <prompt> for one-shot`. Runtime message: `interactive mode needs Bun >= 1.3 or Node >= 26.4; use -p <prompt> on this runtime`. Both exit 1.
- `@chatbridge/cli` `engines` becomes `{ "node": ">=20", "bun": ">=1.3" }`; `bin` shebang stays `#!/usr/bin/env node`.
- Auth state is never logged.

## File structure

| File | Responsibility |
|---|---|
| `packages/core/src/run-step.ts` (new) | `runStep` moved here so `session.ts` and `chat-session.ts` can both import it without a cycle |
| `packages/core/src/chat-session.ts` (new) | `ChatSession` class and `RuntimeLike` |
| `packages/core/src/errors.ts` | + `InvalidStateError` (`INVALID_STATE`) |
| `packages/core/src/session.ts` | `runOneShot` rewritten over `ChatSession`; `runLogin` unchanged; re-exports `runStep` |
| `packages/core/src/index.ts` | export `ChatSession`, `ChatSessionOptions`, `RuntimeLike` |
| `packages/provider/src/index.ts` | doc comments on `sendMessage` / `waitForResponse` |
| `examples/dummy-chat/server.ts` | `slow:` prefix makes one reply take 5 s (for the timeout-recovery E2E) |
| `packages/cli/src/tui/chat-model.ts` (new) | `ChatModel`, `ChatSessionLike`, `Message`, `Role`, `Status` |
| `packages/cli/src/tui/chat-view.ts` (new) | `ChatView`, `GUIDE` |
| `packages/cli/src/tui/run-interactive.ts` (new) | `runInteractive`, Ctrl+C handling, bounded close |
| `packages/cli/src/tui/runtime-check.ts` (new) | `supportsInteractive(versions)` pure version check |
| `packages/cli/src/create-cli.ts` | interactive branch, TTY/runtime checks, help text, `isTerminal` test option |
| `packages/cli/package.json`, `packages/cli/tsconfig.json` | `@opentui/core` dependency, `engines`, `skipLibCheck` |
| `README.md`, `packages/cli/README.md`, `docs/ROADMAP.md` | docs |

---

### Task 1: `InvalidStateError` and `runStep` extraction

**Files:**
- Modify: `packages/core/src/errors.ts`
- Modify: `packages/core/src/errors.test.ts`
- Create: `packages/core/src/run-step.ts`
- Modify: `packages/core/src/session.ts` (remove `runStep` body, re-export it)
- Modify: `packages/cli/src/create-cli.ts:25-33` (exit-code table)

**Interfaces:**
- Produces: `class InvalidStateError extends ChatBridgeError` with `code === "INVALID_STATE"`; `runStep<T>(name: string, timeoutMs: number, fn: () => Promise<T>): Promise<T>` importable from `./run-step.js` and still from `./session.js`.

- [ ] **Step 1: Write the failing test**

In `packages/core/src/errors.test.ts`, add `InvalidStateError` to the import list and add this entry to the `cases` array:

```typescript
      [new InvalidStateError("busy"), "INVALID_STATE"],
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/errors.test.ts`
Expected: FAIL — `InvalidStateError` is not exported.

- [ ] **Step 3: Add the error class**

Append to `packages/core/src/errors.ts`:

```typescript
/** A ChatSession method was called in a state that does not allow it
 * (send while a send is pending, or after close). Caller bug, not a user
 * condition. */
export class InvalidStateError extends ChatBridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super("INVALID_STATE", message, options);
  }
}
```

In `packages/cli/src/create-cli.ts` add to `EXIT_CODES`:

```typescript
  INVALID_STATE: 1,
```

- [ ] **Step 4: Move `runStep`**

Create `packages/core/src/run-step.ts`:

```typescript
import { ResponseTimeoutError } from "./errors.js";

/** Runs one browser step; a Playwright TimeoutError becomes a framework
 * ResponseTimeoutError that names the step and keeps the original as cause. */
export async function runStep<T>(
  name: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ResponseTimeoutError(
        `Timed out during ${name} after ${timeoutMs} ms.`,
        { cause: err },
      );
    }
    throw err;
  }
}
```

In `packages/core/src/session.ts` delete the `runStep` function (lines 19–37) and replace it with:

```typescript
import { runStep } from "./run-step.js";
export { runStep };
```

(keep the other imports; `ResponseTimeoutError` is no longer used there, so remove it from the import list).

- [ ] **Step 5: Run checks**

Run: `bun run check`
Expected: lint clean, build ok, all tests pass (including `session.test.ts`, which still imports `runStep` from `./session.js`).

- [ ] **Step 6: Commit and sync**

```bash
git add packages/core/src packages/cli/src/create-cli.ts
git commit -m "feat(core): add InvalidStateError; extract runStep (Refs #7)"
gh issue comment 7 --body "Committed: InvalidStateError (exit 1) and runStep moved to run-step.ts. Next: ChatSession in core (Task 2)."
```

---

### Task 2: `ChatSession` in Core

**Files:**
- Create: `packages/core/src/chat-session.ts`
- Create: `packages/core/src/chat-session.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `runStep` from `./run-step.js`; `AuthRequiredError`, `AuthExpiredError`, `InvalidStateError` from `./errors.js`; `BrowserRuntime`, `AuthStore`, `LaunchOptions` from `@chatbridge/runtime`.
- Produces:
  ```typescript
  export interface RuntimeLike { readonly page: Page; close(): Promise<void>; }
  export interface ChatSessionOptions {
    provider: Provider; authStore: AuthStore; headless: boolean; timeoutMs: number;
    onProgress?: (message: string) => void;
    launch?: (opts: LaunchOptions) => Promise<RuntimeLike>;   // test-only
  }
  export class ChatSession {
    static open(opts: ChatSessionOptions): Promise<ChatSession>;
    send(prompt: string): Promise<string>;
    close(): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/chat-session.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { Page, Provider } from "@chatbridge/provider";
import type { AuthStore } from "@chatbridge/runtime";
import { ChatSession, type RuntimeLike } from "./chat-session.js";
import {
  AuthExpiredError,
  AuthRequiredError,
  InvalidStateError,
} from "./errors.js";

/** Deferred promise so a test can decide when waitForResponse resolves. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakePage(): Page {
  return {
    setDefaultTimeout() {},
    goto: async () => null,
  } as unknown as Page;
}

interface Harness {
  provider: Provider;
  sent: string[];
  replies: Array<ReturnType<typeof deferred<string>>>;
  closed: number;
  launch: () => Promise<RuntimeLike>;
  loggedIn: boolean;
}

function harness(): Harness {
  const h: Harness = {
    sent: [],
    replies: [],
    closed: 0,
    loggedIn: true,
    provider: undefined as unknown as Provider,
    launch: undefined as unknown as Harness["launch"],
  };
  h.provider = {
    name: "fake",
    chatUrl: "http://127.0.0.1:1/chat",
    async navigateToLogin() {},
    async isLoggedIn() {
      return h.loggedIn;
    },
    async startNewChat() {},
    async sendMessage(_page, prompt) {
      h.sent.push(prompt);
    },
    async waitForResponse() {
      const d = deferred<string>();
      h.replies.push(d);
      return d.promise;
    },
  };
  h.launch = async () => ({
    page: fakePage(),
    close: async () => {
      h.closed++;
    },
  });
  return h;
}

function store(has: boolean): AuthStore {
  return { has: () => has } as unknown as AuthStore;
}

function opts(h: Harness, has = true) {
  return {
    provider: h.provider,
    authStore: store(has),
    headless: true,
    timeoutMs: 1000,
    launch: h.launch,
  };
}

describe("ChatSession.open", () => {
  test("throws AuthRequiredError before launching when no auth state", async () => {
    const h = harness();
    await expect(ChatSession.open(opts(h, false))).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
    expect(h.closed).toBe(0);
  });

  test("closes the browser and throws AuthExpiredError when not logged in", async () => {
    const h = harness();
    h.loggedIn = false;
    await expect(ChatSession.open(opts(h))).rejects.toBeInstanceOf(
      AuthExpiredError,
    );
    expect(h.closed).toBe(1);
  });

  test("reports progress in the one-shot order", async () => {
    const h = harness();
    const progress: string[] = [];
    const session = await ChatSession.open({
      ...opts(h),
      onProgress: (m) => progress.push(m),
    });
    const p = session.send("hi");
    h.replies[0]?.resolve("ok");
    await p;
    expect(progress).toEqual([
      "Opening browser...",
      "Sending prompt...",
      "Waiting for response...",
    ]);
    await session.close();
  });
});

describe("ChatSession.send", () => {
  test("returns the provider reply and supports several turns", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    const first = session.send("one");
    h.replies[0]?.resolve("Echo: one");
    expect(await first).toBe("Echo: one");
    const second = session.send("two");
    h.replies[1]?.resolve("Echo: two");
    expect(await second).toBe("Echo: two");
    expect(h.sent).toEqual(["one", "two"]);
    await session.close();
  });

  test("rejects a second send while one is pending", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    const first = session.send("one");
    await expect(session.send("two")).rejects.toBeInstanceOf(InvalidStateError);
    h.replies[0]?.resolve("done");
    await first;
    await session.close();
  });

  test("rejects send after close", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    await session.close();
    await expect(session.send("x")).rejects.toBeInstanceOf(InvalidStateError);
  });

  test("a failed send leaves the session usable", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    const first = session.send("one");
    h.replies[0]?.reject(new Error("boom"));
    await expect(first).rejects.toThrow("boom");
    const second = session.send("two");
    h.replies[1]?.resolve("Echo: two");
    expect(await second).toBe("Echo: two");
    await session.close();
  });
});

describe("ChatSession.close", () => {
  test("is idempotent", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    await session.close();
    await session.close();
    expect(h.closed).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/chat-session.test.ts`
Expected: FAIL — cannot resolve `./chat-session.js`.

- [ ] **Step 3: Implement `ChatSession`**

Create `packages/core/src/chat-session.ts`:

```typescript
import type { Page, Provider } from "@chatbridge/provider";
import {
  type AuthStore,
  BrowserRuntime,
  type LaunchOptions,
} from "@chatbridge/runtime";
import {
  AuthExpiredError,
  AuthRequiredError,
  InvalidStateError,
} from "./errors.js";
import { runStep } from "./run-step.js";

/** The part of BrowserRuntime a session needs; lets tests inject a fake. */
export interface RuntimeLike {
  readonly page: Page;
  close(): Promise<void>;
}

export interface ChatSessionOptions {
  provider: Provider;
  authStore: AuthStore;
  headless: boolean;
  timeoutMs: number;
  /** Progress messages (stderr in the CLI). Never receives auth content. */
  onProgress?: (message: string) => void;
  /** Test-only: replaces BrowserRuntime.launch. */
  launch?: (opts: LaunchOptions) => Promise<RuntimeLike>;
}

/** A conversation that keeps the browser open across turns. Turns are
 * sequential: `send` rejects while a previous send is pending. */
export class ChatSession {
  private pending = false;
  private closed = false;

  private constructor(
    private readonly rt: RuntimeLike,
    private readonly provider: Provider,
    private readonly timeoutMs: number,
    private readonly onProgress?: (message: string) => void,
  ) {}

  /** authStore.has() → launch → goto chatUrl → isLoggedIn → startNewChat.
   * If any step after launch fails, the browser is closed first. */
  static async open(opts: ChatSessionOptions): Promise<ChatSession> {
    const { provider, authStore, onProgress, timeoutMs } = opts;
    if (!authStore.has()) {
      throw new AuthRequiredError(
        `No saved auth state for provider "${provider.name}". Run \`auth login\` first.`,
      );
    }
    onProgress?.("Opening browser...");
    const launch = opts.launch ?? ((o: LaunchOptions) => BrowserRuntime.launch(o));
    const rt = await launch({ headless: opts.headless, provider, authStore });
    try {
      rt.page.setDefaultTimeout(timeoutMs);
      await runStep("goto", timeoutMs, () => rt.page.goto(provider.chatUrl));
      const loggedIn = await runStep("isLoggedIn", timeoutMs, () =>
        provider.isLoggedIn(rt.page),
      );
      if (!loggedIn) {
        throw new AuthExpiredError(
          `Auth state for "${provider.name}" is no longer valid. Run \`auth login\` again.`,
        );
      }
      await runStep("startNewChat", timeoutMs, () =>
        provider.startNewChat(rt.page),
      );
    } catch (err) {
      await rt.close();
      throw err;
    }
    return new ChatSession(rt, provider, timeoutMs, onProgress);
  }

  /** sendMessage → waitForResponse for one turn. A timeout leaves the
   * session usable; the caller may send again. */
  async send(prompt: string): Promise<string> {
    if (this.closed) {
      throw new InvalidStateError("ChatSession is closed.");
    }
    if (this.pending) {
      throw new InvalidStateError("A send is already in progress.");
    }
    this.pending = true;
    try {
      this.onProgress?.("Sending prompt...");
      await runStep("sendMessage", this.timeoutMs, () =>
        this.provider.sendMessage(this.rt.page, prompt),
      );
      this.onProgress?.("Waiting for response...");
      return await runStep("waitForResponse", this.timeoutMs, () =>
        this.provider.waitForResponse(this.rt.page),
      );
    } finally {
      this.pending = false;
    }
  }

  /** Closes the browser. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.rt.close();
  }
}
```

Add to `packages/core/src/index.ts`:

```typescript
export {
  ChatSession,
  type ChatSessionOptions,
  type RuntimeLike,
} from "./chat-session.js";
```

- [ ] **Step 4: Run tests**

Run: `bun run build && bun test packages/core/src/chat-session.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Run full check and commit**

```bash
bun run check
git add packages/core/src
git commit -m "feat(core): ChatSession keeps the browser open across turns (Refs #7)"
gh issue comment 7 --body "Committed: ChatSession (open/send/close) with unit tests on a fake runtime. Next: runOneShot over ChatSession, provider contract wording, multi-turn E2E (Task 3)."
```

---

### Task 3: `runOneShot` over `ChatSession`, provider wording, multi-turn E2E

**Files:**
- Modify: `packages/core/src/session.ts:9-78`
- Modify: `packages/provider/src/index.ts:20-23`
- Modify: `examples/dummy-chat/server.ts:1-4,34-40`
- Modify: `packages/core/src/session.e2e.test.ts`

**Interfaces:**
- Consumes: `ChatSession` from Task 2.
- Produces: unchanged `runOneShot(opts: OneShotOptions): Promise<string>`; dummy chat treats a message starting with `slow:` as a 5-second reply.

- [ ] **Step 1: Write the failing E2E tests**

Append to `packages/core/src/session.e2e.test.ts` (add `ChatSession` and `ResponseTimeoutError` to the imports from `./chat-session.js` / `./errors.js`; extract the auth-preparation code into a helper first):

```typescript
/** Drives the dummy login once so the store holds a valid session. */
async function prepareAuth(provider: Provider, store: AuthStore): Promise<void> {
  const rt = await BrowserRuntime.launch({
    headless: true,
    provider,
    authStore: store,
  });
  await provider.navigateToLogin(rt.page);
  await rt.page.locator("#login-button").click();
  await rt.page.waitForURL("**/chat");
  await rt.saveAuthState();
  await rt.close();
}

describe("ChatSession", () => {
  test("carries a conversation across two turns", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    const store = tempStore(provider.name);
    await prepareAuth(provider, store);

    const session = await ChatSession.open({
      provider,
      authStore: store,
      headless: true,
      timeoutMs: 30_000,
    });
    cleanups.push(() => session.close());
    expect(await session.send("first")).toBe("Echo: first");
    expect(await session.send("second")).toBe("Echo: second");
  }, 60_000);

  test("a response timeout leaves the session usable", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    const store = tempStore(provider.name);
    await prepareAuth(provider, store);

    const session = await ChatSession.open({
      provider,
      authStore: store,
      headless: true,
      timeoutMs: 2_000,
    });
    cleanups.push(() => session.close());
    // "slow:" makes the dummy chat answer after 5 s, past the 2 s budget.
    await expect(session.send("slow:one")).rejects.toBeInstanceOf(
      ResponseTimeoutError,
    );
    expect(await session.send("two")).toBe("Echo: two");
  }, 60_000);
});
```

Replace the inline auth preparation in the existing `runOneShot` test with `await prepareAuth(provider, store);` and add `import type { Provider } from "@chatbridge/provider";`.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `bun run build && bun test packages/core/src/session.e2e.test.ts`
Expected: the two-turn test passes already (the contract needs no change); the timeout test FAILS because `slow:one` is echoed after 300 ms.

- [ ] **Step 3: Teach the dummy chat the `slow:` prefix**

In `examples/dummy-chat/server.ts` change the header comment to:

```typescript
/** Minimal dummy web chat used for E2E verification of the framework.
 * Not a real service: fixed echo responses, cookie-based fake login.
 * Test hooks: invalidateSessions() (simulates an expired login),
 * setReplyDelayMs() (simulates a slow response), and a message starting
 * with "slow:" (that one reply takes 5 s regardless of the delay). */
```

and in the page script replace `setTimeout(() => {` … `}, delay);` with:

```javascript
    const wait = text.startsWith("slow:") ? 5000 : delay;
    setTimeout(() => {
      const reply = document.createElement("div");
      reply.className = "message assistant";
      reply.textContent = "Echo: " + text;
      log.appendChild(reply);
      log.dataset.state = "idle";
    }, wait);
```

- [ ] **Step 4: Rewrite `runOneShot`**

In `packages/core/src/session.ts` replace the whole `runOneShot` function (and the now-unused imports of `BrowserRuntime`, `AuthRequiredError`, `AuthExpiredError` if nothing else uses them — `runLogin` still uses `BrowserRuntime`, keep that) with:

```typescript
import { ChatSession } from "./chat-session.js";

/** One-shot flow: one ChatSession turn, then close. */
export async function runOneShot(opts: OneShotOptions): Promise<string> {
  const session = await ChatSession.open(opts);
  try {
    return await session.send(opts.prompt);
  } finally {
    await session.close();
  }
}
```

`OneShotOptions` keeps its current fields (`ChatSession.open` ignores `prompt`).

- [ ] **Step 5: Provider contract wording**

In `packages/provider/src/index.ts` replace the two doc comments:

```typescript
  /** Submit the prompt. Called once per turn on the same `Page` for a
   * multi-turn conversation. */
  sendMessage(page: Page, prompt: string): Promise<void>;
  /** Wait for response completion and return the response text. Must
   * return the response to the most recent `sendMessage` only, never an
   * earlier turn's. */
  waitForResponse(page: Page): Promise<string>;
```

- [ ] **Step 6: Run everything**

Run: `bun run check`
Expected: PASS, including the existing `runOneShot` E2E and CLI E2E (exit codes 3 and 4) unchanged.

- [ ] **Step 7: Commit and sync**

```bash
git add packages/core/src packages/provider/src examples/dummy-chat/server.ts
git commit -m "feat(core): runOneShot over ChatSession; multi-turn E2E; provider contract wording (Refs #7)"
gh issue comment 7 --body "Committed: runOneShot is now one ChatSession turn; E2E covers two turns and timeout recovery; provider doc states multi-turn semantics. Next: add @opentui/core to cli with a CI smoke test (Task 4)."
```

---

### Task 4: `@opentui/core` dependency and CI smoke test

**Files:**
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/tui/opentui-smoke.test.ts`

**Interfaces:**
- Produces: `@opentui/core` and `@opentui/core/testing` importable from `packages/cli`; `tsc --build` passes with them.

- [ ] **Step 1: Write the smoke test**

Create `packages/cli/src/tui/opentui-smoke.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

// Proves the native OpenTUI binary loads on this platform (CI runs Linux).
test("OpenTUI test renderer draws a frame", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 20,
    height: 3,
  });
  renderer.root.add(new TextRenderable(renderer, { content: "hello opentui" }));
  await renderOnce();
  expect(captureCharFrame()).toContain("hello opentui");
  renderer.destroy();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/cli/src/tui/opentui-smoke.test.ts`
Expected: FAIL — cannot resolve `@opentui/core`.

- [ ] **Step 3: Add the dependency and config**

```bash
cd packages/cli && bun add @opentui/core@0.5.10 && cd ../..
```

Confirm `packages/cli/package.json` now has `"@opentui/core": "0.5.10"` under `dependencies` (pin exactly; if bun wrote `^0.5.10`, edit it to `0.5.10`) and that `bun.lock` also picked up its peer `web-tree-sitter`. Change `engines` to:

```json
  "engines": { "node": ">=20", "bun": ">=1.3" },
```

In `packages/cli/tsconfig.json` add `"skipLibCheck": true` to `compilerOptions`. Reason (put it in the commit message, JSON has no comments): `@opentui/core/lib/KeyHandler.d.ts` fails strict checking (`InternalKeyHandler.emit` is not assignable to its base), which would break `tsc --build`.

- [ ] **Step 4: Run the smoke test and the full check**

Run: `bun run check`
Expected: PASS. If `tsc` reports errors inside `node_modules/@opentui`, `skipLibCheck` is missing.

- [ ] **Step 5: Commit, push, and watch CI**

```bash
git add packages/cli/package.json packages/cli/tsconfig.json packages/cli/src/tui/opentui-smoke.test.ts bun.lock
git commit -m "build(cli): add @opentui/core 0.5.10 with a test-renderer smoke test (Refs #7)

skipLibCheck is enabled for packages/cli because @opentui/core's
KeyHandler.d.ts does not pass strict declaration checking."
git push
gh run list --branch issue-7 --limit 1
gh run watch   # must succeed on ubuntu-latest: proves the linux-x64 native binary loads
gh issue comment 7 --body "Committed: @opentui/core 0.5.10 in cli, tsconfig skipLibCheck, smoke test green on CI (Linux). Next: ChatModel (Task 5)."
```

If CI fails on the native binary, stop and report; the spec assumed the optional-dependency binaries install on Linux.

---

### Task 5: `ChatModel` (pure state)

**Files:**
- Create: `packages/cli/src/tui/chat-model.ts`
- Create: `packages/cli/src/tui/chat-model.test.ts`

**Interfaces:**
- Consumes: `ResponseTimeoutError` from `@chatbridge/core`.
- Produces:
  ```typescript
  export interface ChatSessionLike { send(prompt: string): Promise<string>; close(): Promise<void>; }
  export type Role = "user" | "assistant" | "error";
  export interface Message { role: Role; text: string; }
  export type Status = "idle" | "busy";
  export class ChatModel {
    readonly messages: Message[]; status: Status; fatal: unknown;
    onChange: () => void;                       // settable; default no-op
    constructor(session: ChatSessionLike);
    submit(text: string): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/tui/chat-model.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { ResponseTimeoutError } from "@chatbridge/core";
import { ChatModel, type ChatSessionLike } from "./chat-model.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeSession() {
  const calls: string[] = [];
  const replies: Array<ReturnType<typeof deferred<string>>> = [];
  const session: ChatSessionLike = {
    async send(prompt) {
      calls.push(prompt);
      const d = deferred<string>();
      replies.push(d);
      return d.promise;
    },
    async close() {},
  };
  return { session, calls, replies };
}

describe("ChatModel.submit", () => {
  test("user message, busy, then assistant message and idle", async () => {
    const { session, replies } = fakeSession();
    const model = new ChatModel(session);
    const changes: string[] = [];
    model.onChange = () => changes.push(model.status);

    const p = model.submit("hello");
    expect(model.status).toBe("busy");
    expect(model.messages).toEqual([{ role: "user", text: "hello" }]);
    replies[0]?.resolve("Echo: hello");
    await p;
    expect(model.status).toBe("idle");
    expect(model.messages[1]).toEqual({ role: "assistant", text: "Echo: hello" });
    expect(changes).toEqual(["busy", "idle"]);
  });

  test("trims the prompt and ignores blank input", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session);
    await model.submit("   \n  ");
    expect(calls).toEqual([]);
    expect(model.messages).toEqual([]);
    const p = model.submit("  hi \n");
    replies[0]?.resolve("ok");
    await p;
    expect(calls).toEqual(["hi"]);
  });

  test("ignores input while busy", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session);
    const p = model.submit("one");
    await model.submit("two");
    expect(calls).toEqual(["one"]);
    replies[0]?.resolve("ok");
    await p;
  });

  test("timeout becomes an error message; model stays usable", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session);
    const p = model.submit("one");
    replies[0]?.reject(new ResponseTimeoutError("Timed out during waitForResponse after 10 ms."));
    await p;
    expect(model.status).toBe("idle");
    expect(model.fatal).toBeUndefined();
    expect(model.messages[1]).toEqual({
      role: "error",
      text: "Timed out during waitForResponse after 10 ms.",
    });
    const q = model.submit("two");
    replies[1]?.resolve("Echo: two");
    await q;
    expect(calls).toEqual(["one", "two"]);
  });

  test("any other error is shown and stored as fatal; further input ignored", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session);
    const boom = new Error("page closed");
    const p = model.submit("one");
    replies[0]?.reject(boom);
    await p;
    expect(model.fatal).toBe(boom);
    expect(model.messages[1]).toEqual({ role: "error", text: "page closed" });
    await model.submit("two");
    expect(calls).toEqual(["one"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/cli/src/tui/chat-model.test.ts`
Expected: FAIL — cannot resolve `./chat-model.js`.

- [ ] **Step 3: Implement**

Create `packages/cli/src/tui/chat-model.ts`:

```typescript
import { ResponseTimeoutError } from "@chatbridge/core";

/** What the model needs from a ChatSession; lets tests inject a fake. */
export interface ChatSessionLike {
  send(prompt: string): Promise<string>;
  close(): Promise<void>;
}

export type Role = "user" | "assistant" | "error";
export interface Message {
  role: Role;
  text: string;
}
export type Status = "idle" | "busy";

/** Conversation state for the interactive UI. No OpenTUI dependency. */
export class ChatModel {
  readonly messages: Message[] = [];
  status: Status = "idle";
  /** Set when submit hit an unrecoverable error; the app must exit. */
  fatal: unknown = undefined;
  /** Called after every state change. */
  onChange: () => void = () => {};

  constructor(private readonly session: ChatSessionLike) {}

  /** Sends one turn. Blank input, input while busy, and input after a
   * fatal error are ignored. */
  async submit(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt || this.status === "busy" || this.fatal !== undefined) return;
    this.messages.push({ role: "user", text: prompt });
    this.status = "busy";
    this.onChange();
    try {
      const reply = await this.session.send(prompt);
      this.messages.push({ role: "assistant", text: reply });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({ role: "error", text: message });
      // A timeout leaves the browser usable; anything else ends the session.
      if (!(err instanceof ResponseTimeoutError)) this.fatal = err;
    } finally {
      this.status = "idle";
      this.onChange();
    }
  }
}
```

- [ ] **Step 4: Run tests and check**

Run: `bun run check`
Expected: PASS (5 new tests).

- [ ] **Step 5: Commit and sync**

```bash
git add packages/cli/src/tui/chat-model.ts packages/cli/src/tui/chat-model.test.ts
git commit -m "feat(cli): ChatModel state machine for interactive mode (Refs #7)"
gh issue comment 7 --body "Committed: ChatModel (idle/busy, timeout recoverable, other errors fatal) with unit tests. Next: ChatView on OpenTUI (Task 6)."
```

---

### Task 6: `ChatView` (OpenTUI tree)

**Files:**
- Create: `packages/cli/src/tui/chat-view.ts`
- Create: `packages/cli/src/tui/chat-view.test.ts`

**Interfaces:**
- Consumes: `ChatModel`, `Message`, `Role` from `./chat-model.js`; `BoxRenderable`, `CliRenderer`, `ScrollBoxRenderable`, `TextRenderable`, `TextareaRenderable` from `@opentui/core`.
- Produces:
  ```typescript
  export const GUIDE = "Enter send · Shift+Enter / Ctrl+J newline · Ctrl+C quit";
  export interface ChatViewOptions { title: string; providerName: string; }
  export class ChatView {
    constructor(renderer: CliRenderer, model: ChatModel, opts: ChatViewOptions);
    update(): void;      // reflect model → tree; wire as model.onChange
    destroy(): void;     // stops the spinner timer
  }
  ```
  The constructor sets `model.onChange = () => this.update()` and focuses the textarea.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/tui/chat-view.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ChatModel, type ChatSessionLike } from "./chat-model.js";
import { ChatView, GUIDE } from "./chat-view.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function echoSession(delayMs: number): ChatSessionLike {
  return {
    async send(prompt) {
      await sleep(delayMs);
      return `Echo: ${prompt}`;
    },
    async close() {},
  };
}

let teardown: (() => void) | undefined;
afterEach(() => {
  teardown?.();
  teardown = undefined;
});

async function setup(opts: { kittyKeyboard?: boolean; delayMs?: number } = {}) {
  const t = await createTestRenderer({
    width: 60,
    height: 20,
    kittyKeyboard: opts.kittyKeyboard ?? false,
  });
  const model = new ChatModel(echoSession(opts.delayMs ?? 100));
  const view = new ChatView(t.renderer, model, {
    title: "test-cli",
    providerName: "dummy-chat",
  });
  teardown = () => {
    view.destroy();
    t.renderer.destroy();
  };
  await t.renderOnce();
  /** Polls in real time; OpenTUI's waitForFrame does not advance timers. */
  async function frameWith(text: string, tries = 100): Promise<string> {
    for (let i = 0; i < tries; i++) {
      await sleep(20);
      await t.renderOnce();
      const f = t.captureCharFrame();
      if (f.includes(text)) return f;
    }
    throw new Error(`no frame contained ${JSON.stringify(text)}`);
  }
  return { ...t, model, view, frameWith };
}

describe("ChatView", () => {
  test("shows the header and the guide when idle", async () => {
    const t = await setup();
    const frame = t.captureCharFrame();
    expect(frame).toContain("test-cli · dummy-chat");
    expect(frame).toContain(GUIDE);
  });

  test("Enter submits, clears the box, shows spinner, then the reply", async () => {
    const t = await setup({ delayMs: 300 });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    await t.renderOnce();
    expect(t.model.messages[0]).toEqual({ role: "user", text: "hello" });
    const busy = await t.frameWith("Waiting for response...");
    expect(busy).toContain("You");
    expect(busy).not.toContain(GUIDE);
    const done = await t.frameWith("Echo: hello");
    expect(done).toContain("Assistant");
    expect(done).toContain(GUIDE);
  });

  test("Shift+Enter inserts a newline on kitty terminals", async () => {
    const t = await setup({ kittyKeyboard: true });
    await t.mockInput.typeText("one");
    t.mockInput.pressEnter({ shift: true });
    await t.mockInput.typeText("two");
    t.mockInput.pressEnter();
    await t.renderOnce();
    expect(t.model.messages[0]).toEqual({ role: "user", text: "one\ntwo" });
  });

  test("Ctrl+J inserts a newline on legacy terminals", async () => {
    const t = await setup();
    await t.mockInput.typeText("one");
    t.mockInput.pressKey("LINEFEED");
    await t.mockInput.typeText("two");
    t.mockInput.pressEnter();
    await t.renderOnce();
    expect(t.model.messages[0]).toEqual({ role: "user", text: "one\ntwo" });
  });

  test("Enter while busy keeps the typed text", async () => {
    const t = await setup({ delayMs: 300 });
    await t.mockInput.typeText("first");
    t.mockInput.pressEnter();
    await t.frameWith("Waiting for response...");
    await t.mockInput.typeText("second");
    t.mockInput.pressEnter();
    await t.renderOnce();
    expect(t.model.messages.map((m) => m.text)).toEqual(["first"]);
    const frame = await t.frameWith("Echo: first");
    expect(frame).toContain("second");
  });

  test("error messages are labelled Error", async () => {
    const t = await createTestRenderer({ width: 60, height: 20 });
    const model = new ChatModel({
      async send() {
        throw new Error("page closed");
      },
      async close() {},
    });
    const view = new ChatView(t.renderer, model, {
      title: "test-cli",
      providerName: "dummy-chat",
    });
    teardown = () => {
      view.destroy();
      t.renderer.destroy();
    };
    await model.submit("x");
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Error");
    expect(frame).toContain("page closed");
  });

  test("history scrolls and keeps the latest reply visible", async () => {
    const t = await setup({ delayMs: 10 });
    for (let i = 0; i < 12; i++) {
      await t.mockInput.typeText(`msg ${i}`);
      t.mockInput.pressEnter();
      await t.frameWith(`Echo: msg ${i}`);
    }
    const frame = t.captureCharFrame();
    expect(frame).toContain("Echo: msg 11");
    expect(frame).not.toContain("Echo: msg 0 ");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: FAIL — cannot resolve `./chat-view.js`.

- [ ] **Step 3: Implement**

Create `packages/cli/src/tui/chat-view.ts`:

```typescript
import {
  BoxRenderable,
  type CliRenderer,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
} from "@opentui/core";
import type { ChatModel, Message, Role } from "./chat-model.js";

export const GUIDE = "Enter send · Shift+Enter / Ctrl+J newline · Ctrl+C quit";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const LABELS: Record<Role, string> = {
  user: "You",
  assistant: "Assistant",
  error: "Error",
};

export interface ChatViewOptions {
  title: string;
  providerName: string;
}

/** Builds the OpenTUI tree for one ChatModel and mirrors its state.
 * Layout: header / scrolling history / 4-line textarea / status line. */
export class ChatView {
  private readonly history: ScrollBoxRenderable;
  private readonly input: TextareaRenderable;
  private readonly status: TextRenderable;
  private rendered = 0;
  private spinner: ReturnType<typeof setInterval> | undefined;
  private frame = 0;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly model: ChatModel,
    opts: ChatViewOptions,
  ) {
    const root = new BoxRenderable(renderer, {
      id: "root",
      flexDirection: "column",
      width: "100%",
      height: "100%",
    });
    root.add(
      new TextRenderable(renderer, {
        id: "header",
        content: `${opts.title} · ${opts.providerName}`,
        marginBottom: 1,
      }),
    );
    this.history = new ScrollBoxRenderable(renderer, {
      id: "history",
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    root.add(this.history);

    const inputBox = new BoxRenderable(renderer, {
      id: "input-box",
      border: true,
      height: 6,
    });
    this.input = new TextareaRenderable(renderer, {
      id: "input",
      height: 4,
      placeholder: "Type a message",
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "kpenter", action: "submit" },
        // Shift+Enter needs the kitty keyboard protocol; Ctrl+J arrives
        // as a linefeed byte on every terminal.
        { name: "return", shift: true, action: "newline" },
        { name: "linefeed", action: "newline" },
      ],
    });
    inputBox.add(this.input);
    root.add(inputBox);

    this.status = new TextRenderable(renderer, { id: "status", content: GUIDE });
    root.add(this.status);
    renderer.root.add(root);

    this.input.onSubmit = () => {
      const text = this.input.plainText;
      if (!text.trim() || this.model.status === "busy") return;
      this.input.clear();
      void this.model.submit(text);
    };
    this.model.onChange = () => this.update();
    this.input.focus();
    this.update();
  }

  /** Appends messages not yet drawn and syncs the status line. */
  update(): void {
    for (; this.rendered < this.model.messages.length; this.rendered++) {
      const message = this.model.messages[this.rendered];
      if (message) this.history.add(this.messageBox(message));
    }
    if (this.model.status === "busy") {
      this.startSpinner();
    } else {
      this.stopSpinner();
      this.status.content = GUIDE;
    }
  }

  destroy(): void {
    this.stopSpinner();
  }

  private messageBox(message: Message): BoxRenderable {
    const box = new BoxRenderable(this.renderer, {
      flexDirection: "column",
      marginBottom: 1,
    });
    box.add(new TextRenderable(this.renderer, { content: LABELS[message.role] }));
    box.add(
      new TextRenderable(this.renderer, {
        content: message.text,
        wrapMode: "word",
      }),
    );
    return box;
  }

  private startSpinner(): void {
    if (this.spinner) return;
    const tick = () => {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.status.content = `${SPINNER[this.frame]} Waiting for response...`;
    };
    tick();
    this.spinner = setInterval(tick, SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = undefined;
  }
}
```

If `tsc` rejects `marginBottom` on `TextRenderable` options, wrap the header in a `BoxRenderable` with `marginBottom: 1` instead. If it rejects `wrapMode` on `TextRenderable`, drop that property (the spike did not verify it) and note it in the commit message.

- [ ] **Step 4: Run tests and check**

Run: `bun run check`
Expected: PASS (7 view tests). Frame-based tests poll in real time; if the 12-turn test is flaky on CI, raise `tries` in `frameWith`, do not add sleeps elsewhere.

- [ ] **Step 5: Commit and sync**

```bash
git add packages/cli/src/tui/chat-view.ts packages/cli/src/tui/chat-view.test.ts
git commit -m "feat(cli): ChatView renders the conversation on OpenTUI (Refs #7)"
gh issue comment 7 --body "Committed: ChatView (header, sticky-bottom history, textarea with Enter/Shift+Enter/Ctrl+J bindings, spinner) with test-renderer tests. Next: runInteractive and createCli wiring (Task 7)."
```

---

### Task 7: `runInteractive`, runtime check, and `createCli` wiring

**Files:**
- Create: `packages/cli/src/tui/runtime-check.ts`
- Create: `packages/cli/src/tui/runtime-check.test.ts`
- Create: `packages/cli/src/tui/run-interactive.ts`
- Modify: `packages/cli/src/create-cli.ts`
- Modify: `packages/cli/src/create-cli.test.ts`

**Interfaces:**
- Consumes: `ChatSession`, `ChatSessionOptions` from `@chatbridge/core`; `ChatModel`, `ChatView`.
- Produces:
  ```typescript
  export function supportsInteractive(versions: { bun?: string; node?: string }): boolean;
  export interface InteractiveOptions extends ChatSessionOptions { title: string; }
  export function runInteractive(opts: InteractiveOptions): Promise<{ fatal?: unknown }>;
  ```
  `CreateCliOptions` gains `isTerminal?: boolean` (test-only override of the TTY check).

- [ ] **Step 1: Write the failing runtime-check tests**

Create `packages/cli/src/tui/runtime-check.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { supportsInteractive } from "./runtime-check.js";

describe("supportsInteractive", () => {
  test.each([
    [{ bun: "1.3.0" }, true],
    [{ bun: "1.4.0" }, true],
    [{ bun: "1.2.9" }, false],
    [{ node: "26.4.0" }, true],
    [{ node: "27.0.0" }, true],
    [{ node: "26.3.1" }, false],
    [{ node: "20.11.0" }, false],
    [{}, false],
  ])("%p → %p", (versions, expected) => {
    expect(supportsInteractive(versions)).toBe(expected);
  });
});
```

- [ ] **Step 2: Implement the runtime check**

Create `packages/cli/src/tui/runtime-check.ts`:

```typescript
/** @opentui/core needs Bun >= 1.3 or Node >= 26.4. Bun wins when present. */
export function supportsInteractive(versions: {
  bun?: string;
  node?: string;
}): boolean {
  if (versions.bun) return atLeast(versions.bun, 1, 3);
  if (versions.node) return atLeast(versions.node, 26, 4);
  return false;
}

function atLeast(version: string, major: number, minor: number): boolean {
  const [a = 0, b = 0] = version.split(".").map((n) => Number.parseInt(n, 10));
  return a > major || (a === major && b >= minor);
}
```

Run: `bun test packages/cli/src/tui/runtime-check.test.ts` → PASS.

- [ ] **Step 3: Write the failing createCli tests**

Append to `packages/cli/src/create-cli.test.ts`:

```typescript
describe("interactive mode gate", () => {
  test("bare invocation without a terminal exits 1 with a hint", async () => {
    captureStderr();
    const cli = createCli({
      name: "test-cli",
      provider: stubProvider(),
      isTerminal: false,
    });
    expect(await cli.run(["bun", "cli"])).toBe(1);
    expect(stderrChunks.join("")).toContain("use -p <prompt>");
  });

  test("bare invocation with a terminal but no auth exits 2 before any UI", async () => {
    captureStderr();
    const cli = createCli({
      name: "test-cli",
      provider: stubProvider(),
      baseDir: setup(),
      isTerminal: true,
    });
    expect(await cli.run(["bun", "cli"])).toBe(2);
    expect(stderrChunks.join("")).toContain("auth login");
  });
});
```

Run: `bun test packages/cli/src/create-cli.test.ts`
Expected: FAIL — `isTerminal` is not an option and bare invocation returns 0 (help).

- [ ] **Step 4: Implement `runInteractive`**

Create `packages/cli/src/tui/run-interactive.ts`:

```typescript
import { ChatSession, type ChatSessionOptions } from "@chatbridge/core";
import { type KeyEvent, createCliRenderer } from "@opentui/core";
import { ChatModel } from "./chat-model.js";
import { ChatView } from "./chat-view.js";

export interface InteractiveOptions extends ChatSessionOptions {
  /** Shown in the header, e.g. the CLI name. */
  title: string;
}

const CLOSE_TIMEOUT_MS = 5_000;

/** KeyHandler's `on` is typed through a generic EventEmitter that does not
 * type-check under our config; this is the shape we rely on at runtime. */
interface KeypressSource {
  on(event: "keypress", handler: (key: KeyEvent) => void): unknown;
}

/** Opens a ChatSession (errors propagate before any UI exists), runs the
 * TUI until Ctrl+C or a fatal error, then restores the terminal.
 * Resolves with the fatal error, if any, for the caller to report. */
export async function runInteractive(
  opts: InteractiveOptions,
): Promise<{ fatal?: unknown }> {
  const session = await ChatSession.open(opts);
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  let view: ChatView | undefined;
  try {
    const fatal = await new Promise<unknown>((resolve) => {
      const model = new ChatModel(session);
      view = new ChatView(renderer, model, {
        title: opts.title,
        providerName: opts.provider.name,
      });
      model.onChange = () => {
        view?.update();
        if (model.fatal !== undefined) resolve(model.fatal);
      };
      (renderer.keyInput as unknown as KeypressSource).on("keypress", (key) => {
        if (key.ctrl && key.name === "c") resolve(undefined);
      });
      renderer.start();
    });
    return fatal === undefined ? {} : { fatal };
  } finally {
    await closeWithTimeout(session, CLOSE_TIMEOUT_MS);
    view?.destroy();
    renderer.destroy();
  }
}

/** Playwright close can hang on a wedged browser; never block exit on it. */
async function closeWithTimeout(session: ChatSession, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([session.close(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 5: Wire `createCli`**

In `packages/cli/src/create-cli.ts`:

Add to `CreateCliOptions`:

```typescript
  /** Test-only: overrides "stdin and stdout are a TTY". */
  isTerminal?: boolean;
```

Add the import:

```typescript
import { supportsInteractive } from "./tui/runtime-check.js";
```

Update `help()` — insert as the first usage line and add a sentence:

```typescript
      "Usage:",
      `  ${opts.name}${providerFlag} [--headful] [--timeout <sec>]`,
      `  ${opts.name} -p <prompt>${providerFlag} [--headful] [--timeout <sec>]`,
      ...
      "",
      "Without -p, an interactive chat opens (needs a terminal and Bun >= 1.3 or Node >= 26.4).",
      "One-shot mode prints the AI response to stdout.",
```

Inside `run`, immediately before the existing `if (typeof values.prompt === "string") {` block, add:

```typescript
      if (cmd === undefined && values.prompt === undefined) {
        const isTerminal =
          opts.isTerminal ??
          (process.stdin.isTTY === true && process.stdout.isTTY === true);
        if (!isTerminal) {
          throw new ChatBridgeError(
            "INVALID_ARGUMENT",
            "interactive mode needs a terminal; use -p <prompt> for one-shot",
          );
        }
        if (!supportsInteractive(process.versions)) {
          throw new ChatBridgeError(
            "INVALID_ARGUMENT",
            "interactive mode needs Bun >= 1.3 or Node >= 26.4; use -p <prompt> on this runtime",
          );
        }
        const timeoutMs = parseTimeoutMs(values.timeout);
        const provider = await getProvider(values.provider);
        const authStore = createAuthStore({
          configDir,
          providerName: provider.name,
          baseDir: opts.baseDir,
        });
        // Loaded lazily so one-shot and auth never evaluate @opentui/core.
        const { runInteractive } = await import("./tui/run-interactive.js");
        const result = await runInteractive({
          title: opts.name,
          provider,
          authStore,
          headless: !values.headful,
          timeoutMs,
          onProgress: progress,
        });
        return result.fatal === undefined ? 0 : reportError(result.fatal);
      }
```

`process.versions` has `bun?: string` only under Bun typings; pass `{ bun: process.versions.bun, node: process.versions.node }` if `tsc` complains.

The trailing fallback (`console.log(help()); return cmd === undefined ? 0 : 1;`) now only handles unknown positionals; simplify it to:

```typescript
      console.log(help());
      return 1;
```

- [ ] **Step 6: Run tests and check**

Run: `bun run check`
Expected: PASS. The second new test reaches `ChatSession.open` through `runInteractive`, which throws `AuthRequiredError` (exit 2) before creating a renderer, so it runs safely without a terminal. Check `bun test packages/cli` output shows no leaked renderer (the process exits cleanly).

- [ ] **Step 7: Manual smoke in a real terminal**

Run (in an interactive terminal, not from the agent session):

```bash
bun run examples/dummy-chat/serve.ts &
bun packages/cli/src/bin.ts auth login --provider ./examples/dummy-chat/provider.ts
bun packages/cli/src/bin.ts --provider ./examples/dummy-chat/provider.ts
```

Expected: header `chatbridge · dummy-chat`, type `hi`, Enter → spinner → `Echo: hi`; Ctrl+J inserts a newline; Ctrl+C restores the terminal and exits 0. If the user is not available to run this, note it in the issue comment as unverified.

- [ ] **Step 8: Commit and sync**

```bash
git add packages/cli/src
git commit -m "feat(cli): interactive mode on bare invocation with runtime and TTY gates (Refs #7)"
gh issue comment 7 --body "Committed: runInteractive (Ctrl+C, bounded close), supportsInteractive version gate, createCli bare-invocation branch with lazy TUI import, help text. Next: docs and roadmap split (Task 8)."
```

---

### Task 8: Documentation and roadmap

**Files:**
- Modify: `README.md:7-17,36-55`
- Modify: `packages/cli/README.md`
- Modify: `docs/ROADMAP.md:37-43`
- Modify: `CLAUDE.md` (spec/plan pointers under "Current state" and "Development process")

- [ ] **Step 1: README**

In `README.md`:

Replace the `## Status` paragraph with:

```markdown
Milestones 1 (one-shot), 2 (hardening + publishability), and 3a (interactive TUI) are implemented. The first npm release is still pending. Streaming display (milestone 3b) is not built yet.
```

In `## Planned features` change the first bullet to `- Interactive TUI, in the style of Claude Code (non-streaming; streaming display is planned)`.

In `## Quick start` append after the `-p "hello"` command:

```bash
bun packages/cli/src/bin.ts \
  --provider ./examples/dummy-chat/provider.ts  # interactive chat
```

Add a new section after `## Install (npm)`:

```markdown
## Interactive mode

Run the CLI with no `-p` to open a chat in the terminal. The browser stays
open for the whole conversation, so follow-up messages continue the same
chat.

- **Enter** sends. **Shift+Enter** inserts a newline on terminals that speak
  the kitty keyboard protocol (iTerm2, kitty, WezTerm, Ghostty); **Ctrl+J**
  inserts a newline everywhere. **Ctrl+C** quits.
- A response timeout is shown in the history and you can keep chatting.
  Any other failure closes the chat with exit code 1.
- Interactive mode needs **Bun >= 1.3 or Node >= 26.4** (the TUI library's
  requirement). One-shot mode and `auth` keep working on Node >= 20.
- A terminal is required; in pipes and scripts use `-p`.
```

- [ ] **Step 2: CLI package README**

Append to `packages/cli/README.md`:

```markdown

## Modes

- `chatbridge -p "<prompt>"` — one-shot, response on stdout. Node >= 20 or Bun.
- `chatbridge` — interactive chat in the terminal. Bun >= 1.3 or Node >= 26.4.
- `chatbridge auth login|logout|status` — manage the saved browser auth state.
```

- [ ] **Step 3: Roadmap**

In `docs/ROADMAP.md` replace the milestone 3 heading and body with:

```markdown
### 3a. Interactive TUI (OpenTUI), non-streaming — in progress (issue #7)

Claude Code–style chat UI: history, multi-line input, send, loading state,
error and status display. Core gains `ChatSession` (browser stays open across
turns); the Provider contract documents multi-turn semantics without new
methods. OpenTUI proven under Bun 1.4 (spike in the spec).

### 3b. Streaming display

Streaming response capture in the Provider contract and incremental display
in the TUI. Also deferred here: Markdown rendering, cross-process conversation
resume (chat handle), history persistence, and detecting auth expiry
mid-conversation. Shaped after milestone 4 exposes a real service's DOM.
```

- [ ] **Step 4: CLAUDE.md pointers**

In `CLAUDE.md` change the spec line under "Current state" to
`Spec for the current milestone: docs/superpowers/specs/2026-09-07-interactive-tui-design.md` and the plan line under "Development process" to
`Current milestone plan: docs/superpowers/plans/2026-09-07-interactive-tui.md`. Add one bullet to the commands list:

```markdown
- Interactive mode (`chatbridge` with no `-p`) needs Bun >= 1.3 or Node >= 26.4; `@opentui/core` is loaded lazily and lives only in `packages/cli/src/tui/`
```

- [ ] **Step 5: Check and commit**

```bash
bun run check
git add README.md packages/cli/README.md docs/ROADMAP.md CLAUDE.md
git commit -m "docs: interactive mode, runtime requirement, roadmap 3a/3b split (Refs #7)"
gh issue comment 7 --body "Committed: README interactive-mode section, cli README modes, roadmap split into 3a/3b, CLAUDE.md pointers. Next: whole-branch review and PR (Task 9)."
```

---

### Task 9: Whole-branch review and PR

- [ ] **Step 1: Final verification**

```bash
git checkout issue-7 && git pull
bun install --frozen-lockfile
bun run check
node packages/cli/dist/bin.js --help      # Node 20 must still print help (no OpenTUI evaluated)
gh run list --branch issue-7 --limit 1    # last CI run must be success
```

- [ ] **Step 2: Whole-branch review**

Dispatch the final review per CLAUDE.md model policy (Fable) with `superpowers:requesting-code-review` over `git diff main...issue-7`, checking specifically: no `@opentui/core` import outside `packages/cli/src/tui/`; `runOneShot` behaviour and progress messages unchanged; no auth content in logs; exit-code table matches the spec table; every document in English.

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base main --head issue-7 --title "Milestone 3a: interactive TUI on OpenTUI" --body "$(cat <<'EOF'
Closes #7 (milestone 3a; 3b streaming stays on the roadmap).

- core: `ChatSession` (open/send/close) keeps the browser open across turns; `runOneShot` is one turn over it; `InvalidStateError`
- provider: doc comments state multi-turn semantics (no API change)
- cli: interactive mode on bare invocation — `ChatModel` / `ChatView` / `runInteractive` in `src/tui/`, lazy-loaded; Enter sends, Shift+Enter or Ctrl+J newline, Ctrl+C quits; timeout is recoverable
- runtime gate: Bun >= 1.3 or Node >= 26.4 for interactive mode; one-shot stays on Node 20
- tests: ChatSession unit + Chromium E2E (two turns, timeout recovery), ChatModel unit, ChatView on the OpenTUI test renderer, CLI gates
- docs: README interactive section, roadmap 3a/3b split

Spec: docs/superpowers/specs/2026-09-07-interactive-tui-design.md
Plan: docs/superpowers/plans/2026-09-07-interactive-tui.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Q7b7Rr7gCDgHpZzedM4NBD
EOF
)"
gh issue comment 7 --body "PR opened. What's next: merge after CI, then mark milestone 3a done in docs/ROADMAP.md on main."
```
