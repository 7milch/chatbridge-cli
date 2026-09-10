# Ctrl+R Browser Reopen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ctrl+R in the interactive TUI closes (or kills) the current browser, opens a fresh one with the saved auth state, and keeps the on-screen history; fatal errors enter a `dead` state instead of exiting.

**Architecture:** `BrowserRuntime` and `ChatSession` gain a `kill()` primitive. `ChatModel` owns the session lifecycle through an `openSession` factory, a generation counter, and a `reset()` that closes-or-kills the old session before opening a new one. `ChatView` maps Ctrl+R to `reset()` and renders the new `resetting` / `dead` states; `waitForQuit` no longer resolves on a fatal error.

**Tech Stack:** TypeScript, Bun (workspaces, `bun test`), Playwright (Chromium), OpenTUI 0.5.10 (`@opentui/core`, `@opentui/core/testing`), Biome.

**Spec:** `docs/superpowers/specs/2026-09-10-browser-reopen-design.md`

## Global Constraints

- Branch `issue-34`; every commit message ends with the standard trailer (see any recent commit) and `(Refs #34)`.
- `bun run check` (Biome lint + `tsc --build` + `bun test`) must pass before every commit. Tests import cross-package code from `dist/`, so run `bun run build` after editing another package.
- Dependency direction is one-way: `cli → core → runtime → provider`. Never import in reverse. `packages/cli/src/tui/chat-model.ts` must not import `@opentui/core`.
- Every document, comment, and commit message is in English.
- Auth state is never written to logs; `kill()` never saves it.
- Close cap for the old browser during a reset: `5_000` ms. Separator text: `reopened`, rendered as `── reopened ──`. Dead-state status text: `Ctrl+R reopen · Ctrl+C quit`. Resetting status text: `Reopening browser...`.
- Subagent model policy: Task 1, 2, 6 → Sonnet; Task 3, 4, 5 → Opus.

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/runtime/src/browser-runtime.ts` | add `kill()` | 1 |
| `packages/runtime/src/browser-runtime.e2e.test.ts` | E2E for `kill()` | 1 |
| `packages/core/src/chat-session.ts` | `RuntimeLike.kill`, `ChatSession.kill()` | 2 |
| `packages/core/src/chat-session.test.ts` | unit tests for `kill()` | 2 |
| `packages/cli/src/tui/close-session.ts` (new) | `closeWithTimeout` (moved) and `closeOrKill` — no OpenTUI import | 3 |
| `packages/cli/src/tui/close-session.test.ts` (new) | tests for both helpers | 3 |
| `packages/cli/src/tui/chat-model.ts` | statuses, `separator` role, `openSession`, generation, `reset()` | 3 |
| `packages/cli/src/tui/chat-model.test.ts` | reset tests | 3 |
| `packages/cli/src/tui/chat-view.ts` | Ctrl+R, status per state, separator rendering | 4 |
| `packages/cli/src/tui/chat-view.test.ts` | view tests | 4 |
| `packages/cli/src/tui/run-interactive.ts` | `waitForQuit` semantics, `openSession` wiring, current-session teardown | 5 |
| `packages/cli/src/tui/run-interactive.test.ts` | updated tests | 3, 5 |
| `README.md`, `docs/ROADMAP.md` | key guide, milestone entry | 6 |

---

### Task 1: `BrowserRuntime.kill()`

**Files:**
- Modify: `packages/runtime/src/browser-runtime.ts`
- Test: `packages/runtime/src/browser-runtime.e2e.test.ts`

**Interfaces:**
- Produces: `BrowserRuntime.kill(): Promise<void>` — sends SIGKILL to the Chromium process and disconnects; no-op when the process is already gone; idempotent.

- [ ] **Step 1: Write the failing E2E test**

Append inside the existing `describe("BrowserRuntime (headless Chromium on Bun)", ...)` block in `packages/runtime/src/browser-runtime.e2e.test.ts`:

```ts
  test("kill() ends the browser process and is idempotent", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    const store = tempStore(provider.name);

    const rt = await BrowserRuntime.launch({
      headless: true,
      provider,
      authStore: store,
    });
    await rt.page.goto(provider.chatUrl);
    expect(rt.page.isClosed()).toBe(false);

    await rt.kill();
    // The page belongs to a browser that is gone; Playwright reports it closed
    // once the disconnect has propagated.
    for (let i = 0; i < 100 && !rt.page.isClosed(); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(rt.page.isClosed()).toBe(true);

    // A second kill (process already gone) must not throw.
    await rt.kill();
    // close() after kill() must not throw either: teardown paths call it.
    await rt.close();
  }, 60_000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/runtime --test-name-pattern "kill"`
Expected: FAIL with `rt.kill is not a function`.

- [ ] **Step 3: Implement `kill()`**

In `packages/runtime/src/browser-runtime.ts`, add after `close()`:

```ts
  /** Force-ends the browser process (SIGKILL) and drops the connection.
   * For a wedged browser that `close()` cannot finish; nothing is saved.
   * No-op when the process is already gone. Never throws. */
  async kill(): Promise<void> {
    const proc = this.browser.process();
    if (proc && proc.exitCode === null && !proc.killed) {
      proc.kill("SIGKILL");
    }
    // Let Playwright tear down its side; a disconnect race here is expected
    // and not an error for the caller.
    await this.browser.close().catch(() => {});
  }
```

Also make `close()` tolerate a browser that was killed:

```ts
  async close(): Promise<void> {
    await this.browser.close();
  }
```

stays as is — `browser.close()` on an already-disconnected browser resolves in Playwright; the test in Step 1 verifies this. If the test shows it rejects, change `close()` to `await this.browser.close().catch(() => {});` and note it in the commit message.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/runtime --test-name-pattern "kill"`
Expected: PASS.

- [ ] **Step 5: Run the full check and commit**

```bash
bun run check
git add packages/runtime/src/browser-runtime.ts packages/runtime/src/browser-runtime.e2e.test.ts
git commit -m "feat(runtime): BrowserRuntime.kill() force-ends a wedged Chromium (Refs #34)"
```

---

### Task 2: `ChatSession.kill()`

**Files:**
- Modify: `packages/core/src/chat-session.ts`
- Test: `packages/core/src/chat-session.test.ts`

**Interfaces:**
- Consumes: `BrowserRuntime.kill()` from Task 1.
- Produces: `RuntimeLike.kill(): Promise<void>`; `ChatSession.kill(): Promise<void>` — marks the session closed, calls `rt.kill()`, never saves auth state, idempotent.

- [ ] **Step 1: Extend the test harness and write the failing tests**

In `packages/core/src/chat-session.test.ts`, add `killed: number` to the `Harness` interface and initialise it to `0` in `harness()`. Extend the fake runtime returned by `h.launch`:

```ts
  h.launch = async () => ({
    page: fakePage(),
    saveAuthState: async () => {
      if (h.saveShouldFail) throw new Error("disk full");
      h.saved++;
    },
    close: async () => {
      h.closed++;
    },
    kill: async () => {
      h.killed++;
    },
  });
```

Add a new describe block at the end of the file:

```ts
describe("ChatSession.kill", () => {
  test("kills the runtime without saving auth state", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    await session.kill();
    expect(h.killed).toBe(1);
    expect(h.saved).toBe(0);
    expect(h.closed).toBe(0);
  });

  test("is idempotent and blocks close() afterwards", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    await session.kill();
    await session.kill();
    await session.close();
    expect(h.killed).toBe(1);
    expect(h.closed).toBe(0);
  });

  test("send() after kill() throws InvalidStateError", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    await session.kill();
    await expect(session.send("x")).rejects.toBeInstanceOf(InvalidStateError);
  });

  test("kill() during a pending send makes that send reject", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    const p = session.send("one");
    const reply = await replyOf(h, 0);
    await session.kill();
    reply.reject(new Error("Target page, context or browser has been closed"));
    await expect(p).rejects.toThrow("has been closed");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core --test-name-pattern "ChatSession.kill"`
Expected: FAIL with `session.kill is not a function`.

- [ ] **Step 3: Implement**

In `packages/core/src/chat-session.ts`, extend `RuntimeLike`:

```ts
export interface RuntimeLike {
  readonly page: Page;
  saveAuthState(): Promise<void>;
  close(): Promise<void>;
  kill(): Promise<void>;
}
```

Add after `close()`:

```ts
  /** Force-ends the browser without saving the auth state: the page is
   * presumed hung, so `isLoggedIn` cannot be trusted. Idempotent with
   * `close()` — whichever runs first wins. */
  async kill(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.rt.kill();
  }
```

- [ ] **Step 4: Fix other fake runtimes**

`grep -rn "saveAuthState: async" packages/core/src packages/cli/src` — every fake `RuntimeLike` object literal in tests gets a `kill: async () => {}` member so the shape matches (tests are excluded from `tsc`, but keep the fakes honest). Known sites: `packages/core/src/session.e2e.test.ts` if it builds a fake, `packages/cli/src/tui/run-interactive.test.ts` `sessionOpts()` (`launch: async () => ({ page, close: async () => onClose(), kill: async () => {} })`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run build && bun test packages/core`
Expected: PASS.

- [ ] **Step 6: Run the full check and commit**

```bash
bun run check
git add packages/core packages/cli/src/tui/run-interactive.test.ts
git commit -m "feat(core): ChatSession.kill() force-ends the browser without saving auth (Refs #34)"
```

---

### Task 3: `ChatModel` lifecycle — `resetting` / `dead`, `openSession`, `reset()`

**Files:**
- Create: `packages/cli/src/tui/close-session.ts`
- Create: `packages/cli/src/tui/close-session.test.ts`
- Modify: `packages/cli/src/tui/chat-model.ts`
- Modify: `packages/cli/src/tui/chat-model.test.ts`
- Modify: `packages/cli/src/tui/run-interactive.ts` (import move only)
- Modify: `packages/cli/src/tui/run-interactive.test.ts` (import move; `closeWithTimeout` tests move to the new test file)

**Interfaces:**
- Consumes: `ChatSession.kill()` shape from Task 2.
- Produces:
  - `close-session.ts`: `interface ClosableSession { close(): Promise<void> }`, `interface KillableSession extends ClosableSession { kill(): Promise<void> }`, `closeWithTimeout(session: ClosableSession, ms: number): Promise<boolean>` (moved verbatim), `closeOrKill(session: KillableSession, ms: number): Promise<void>`.
  - `chat-model.ts`: `type Status = "idle" | "busy" | "resetting" | "dead"`, `type Role = "user" | "assistant" | "error" | "separator"`, `ChatSessionLike` gains `kill(): Promise<void>`, `ChatModelOptions.openSession: () => Promise<ChatSessionLike>` (required), `ChatModelOptions.closeTimeoutMs?: number` (default `5_000`, tests pass a small value), `ChatModel.session` getter (current session), `ChatModel.reset(): Promise<void>`, constant `RESET_CLOSE_TIMEOUT_MS = 5_000` exported.

- [ ] **Step 1: Create `close-session.ts` with `closeWithTimeout` moved and a failing `closeOrKill` test**

Create `packages/cli/src/tui/close-session.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { closeOrKill, closeWithTimeout } from "./close-session.js";

describe("closeWithTimeout", () => {
  test("returns true when the session closes in time", async () => {
    expect(await closeWithTimeout({ close: async () => {} }, 1000)).toBe(true);
  });

  test("returns false when the close never settles", async () => {
    const started = Date.now();
    const stuck = { close: () => new Promise<void>(() => {}) };
    expect(await closeWithTimeout(stuck, 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("swallows a rejecting close", async () => {
    const failing = {
      close: async () => {
        throw new Error("browser already gone");
      },
    };
    expect(await closeWithTimeout(failing, 1000)).toBe(true);
  });
});

describe("closeOrKill", () => {
  test("does not kill when close finishes in time", async () => {
    let killed = 0;
    await closeOrKill(
      { close: async () => {}, kill: async () => { killed++; } },
      1000,
    );
    expect(killed).toBe(0);
  });

  test("kills when close exceeds the cap", async () => {
    let killed = 0;
    await closeOrKill(
      {
        close: () => new Promise<void>(() => {}),
        kill: async () => { killed++; },
      },
      50,
    );
    expect(killed).toBe(1);
  });

  test("swallows a rejecting kill", async () => {
    await closeOrKill(
      {
        close: () => new Promise<void>(() => {}),
        kill: async () => {
          throw new Error("no process");
        },
      },
      50,
    );
  });
});
```

Create `packages/cli/src/tui/close-session.ts`. Move `ClosableSession` and `closeWithTimeout` from `run-interactive.ts` verbatim (including their comments) and add:

```ts
export interface KillableSession extends ClosableSession {
  kill(): Promise<void>;
}

/** Closes the session, and kills it when the close has not finished within
 * `ms`: the reset path exists for a wedged browser, so a close that hangs is
 * the expected case, not an error. Never throws. */
export async function closeOrKill(
  session: KillableSession,
  ms: number,
): Promise<void> {
  const closed = await closeWithTimeout(session, ms);
  if (!closed) await session.kill().catch(() => {});
}
```

In `run-interactive.ts`, delete the moved code and add `import { type ClosableSession, closeWithTimeout } from "./close-session.js";` (keep `ClosableSession` exported from `run-interactive.ts` via `export type { ClosableSession }` only if something imports it from there — `grep -rn "ClosableSession" packages/` — otherwise drop it). In `run-interactive.test.ts`, delete the `closeWithTimeout` describe block and its import.

- [ ] **Step 2: Run the new tests**

Run: `bun test packages/cli/src/tui/close-session.test.ts packages/cli/src/tui/run-interactive.test.ts`
Expected: PASS (the `closeOrKill` tests pass immediately because the implementation shipped with the move; that is fine — the tests still pin the behaviour).

- [ ] **Step 3: Commit the move**

```bash
bun run check
git add packages/cli/src/tui/close-session.ts packages/cli/src/tui/close-session.test.ts packages/cli/src/tui/run-interactive.ts packages/cli/src/tui/run-interactive.test.ts
git commit -m "refactor(cli): move closeWithTimeout to close-session.ts and add closeOrKill (Refs #34)"
```

- [ ] **Step 4: Update the model test harness and write failing reset tests**

In `packages/cli/src/tui/chat-model.test.ts`, replace `fakeSession()` and add a `harness()`:

```ts
function fakeSession(label = "s") {
  const calls: string[] = [];
  const replies: Array<ReturnType<typeof deferred<string>>> = [];
  const state = { closed: 0, killed: 0, closeHangs: false };
  const session: ChatSessionLike = {
    async send(prompt) {
      calls.push(`${label}:${prompt}`);
      const d = deferred<string>();
      replies.push(d);
      return d.promise;
    },
    close() {
      state.closed++;
      return state.closeHangs ? new Promise<void>(() => {}) : Promise.resolve();
    },
    async kill() {
      state.killed++;
    },
  };
  return { session, calls, replies, state };
}

/** A model over a first session plus a queue of sessions for reopens. */
function harness(opts: { closeTimeoutMs?: number } = {}) {
  const first = fakeSession("a");
  const next: Array<ReturnType<typeof fakeSession> | Error> = [];
  const opened: number[] = [];
  const model = new ChatModel(first.session, {
    closeTimeoutMs: opts.closeTimeoutMs ?? 20,
    openSession: async () => {
      opened.push(Date.now());
      const n = next.shift();
      if (n === undefined) throw new Error("no next session queued");
      if (n instanceof Error) throw n;
      return n.session;
    },
  });
  return { model, first, next, opened };
}
```

Every existing `new ChatModel(session)` / `new ChatModel(session, { expand })` call in this file must now pass `openSession`. Add a tiny helper at the top and use it:

```ts
const noReopen = { openSession: async (): Promise<ChatSessionLike> => {
  throw new Error("not expected");
} };
```

so `new ChatModel(session)` becomes `new ChatModel(session, noReopen)` and `new ChatModel(session, { expand })` becomes `new ChatModel(session, { ...noReopen, expand })`.

Update the existing fatal test "any other error is shown and stored as fatal; further input ignored" to also assert `expect(model.status).toBe("dead");`.

Add a new describe block:

```ts
describe("ChatModel.reset", () => {
  test("idle: closes the old session, opens a new one, adds a separator", async () => {
    const h = harness();
    const b = fakeSession("b");
    h.next.push(b);
    const changes: string[] = [];
    h.model.onChange = () => changes.push(h.model.status);

    await h.model.reset();

    expect(h.first.state.closed).toBe(1);
    expect(h.first.state.killed).toBe(0);
    expect(h.model.session).toBe(b.session);
    expect(h.model.status).toBe("idle");
    expect(h.model.fatal).toBeUndefined();
    expect(h.model.messages).toEqual([{ role: "separator", text: "reopened" }]);
    expect(changes).toEqual(["resetting", "idle"]);

    const p = h.model.submit("after");
    await tick();
    b.replies[0]?.resolve("ok");
    await p;
    expect(b.calls).toEqual(["b:after"]);
    expect(h.first.calls).toEqual([]);
  });

  test("busy: the stale send's result is dropped after the reset", async () => {
    const h = harness();
    const b = fakeSession("b");
    h.next.push(b);
    const p = h.model.submit("hang");
    await tick();
    expect(h.model.status).toBe("busy");

    await h.model.reset();
    expect(h.model.status).toBe("idle");
    expect(h.model.messages.map((m) => m.role)).toEqual(["user", "separator"]);

    // The old turn settles late: nothing must change.
    h.first.replies[0]?.resolve("late reply");
    await p;
    expect(h.model.status).toBe("idle");
    expect(h.model.messages.map((m) => m.role)).toEqual(["user", "separator"]);
  });

  test("busy: a stale send's error is dropped and does not mark dead", async () => {
    const h = harness();
    h.next.push(fakeSession("b"));
    const p = h.model.submit("hang");
    await tick();
    await h.model.reset();
    h.first.replies[0]?.reject(new Error("Target page has been closed"));
    await p;
    expect(h.model.status).toBe("idle");
    expect(h.model.fatal).toBeUndefined();
    expect(h.model.messages.map((m) => m.role)).toEqual(["user", "separator"]);
  });

  test("kills the old session when close exceeds the cap", async () => {
    const h = harness({ closeTimeoutMs: 20 });
    h.first.state.closeHangs = true;
    h.next.push(fakeSession("b"));
    await h.model.reset();
    expect(h.first.state.closed).toBe(1);
    expect(h.first.state.killed).toBe(1);
    expect(h.model.status).toBe("idle");
  });

  test("dead: reset recovers and clears fatal", async () => {
    const h = harness();
    const boom = new Error("page closed");
    const p = h.model.submit("one");
    await tick();
    h.first.replies[0]?.reject(boom);
    await p;
    expect(h.model.status).toBe("dead");
    expect(h.model.fatal).toBe(boom);

    h.next.push(fakeSession("b"));
    await h.model.reset();
    expect(h.model.status).toBe("idle");
    expect(h.model.fatal).toBeUndefined();
    expect(h.model.messages.map((m) => m.role)).toEqual([
      "user",
      "error",
      "separator",
    ]);
  });

  test("a failing reopen shows the error and returns to dead", async () => {
    const h = harness();
    const boom = new Error("Auth state is no longer valid");
    h.next.push(boom);
    const changes: string[] = [];
    h.model.onChange = () => changes.push(h.model.status);
    await h.model.reset();
    expect(h.model.status).toBe("dead");
    expect(h.model.fatal).toBe(boom);
    expect(h.model.messages).toEqual([
      { role: "error", text: "Auth state is no longer valid" },
    ]);
    expect(changes).toEqual(["resetting", "dead"]);
    // The old session is still closed; nothing is left dangling.
    expect(h.first.state.closed).toBe(1);
    expect(await h.model.submit("x")).toBe(false);
  });

  test("reset while resetting is ignored", async () => {
    const h = harness();
    const gate = deferred<void>();
    const b = fakeSession("b");
    const model = new ChatModel(h.first.session, {
      closeTimeoutMs: 20,
      openSession: async () => {
        await gate.promise;
        return b.session;
      },
    });
    const r1 = model.reset();
    await tick();
    expect(model.status).toBe("resetting");
    const r2 = model.reset();
    gate.resolve();
    await Promise.all([r1, r2]);
    expect(h.first.state.closed).toBe(1);
    expect(model.messages).toEqual([{ role: "separator", text: "reopened" }]);
  });

  test("submit is ignored while resetting", async () => {
    const h = harness();
    const gate = deferred<void>();
    const b = fakeSession("b");
    const model = new ChatModel(h.first.session, {
      closeTimeoutMs: 20,
      openSession: async () => {
        await gate.promise;
        return b.session;
      },
    });
    const r = model.reset();
    await tick();
    expect(await model.submit("x")).toBe(false);
    gate.resolve();
    await r;
    expect(b.calls).toEqual([]);
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `bun test packages/cli/src/tui/chat-model.test.ts`
Expected: FAIL — `h.model.reset is not a function`, and the fatal test fails on `status` being `"idle"` instead of `"dead"`.

- [ ] **Step 6: Implement the model**

Replace `packages/cli/src/tui/chat-model.ts` with:

```ts
import { ResponseTimeoutError } from "@chatbridge/core";
import {
  type Attachment,
  type Expansion,
  MentionError,
  expandMentions,
} from "../mentions/expand-mentions.js";
import { closeOrKill } from "./close-session.js";

/** What the model needs from a ChatSession; lets tests inject a fake. */
export interface ChatSessionLike {
  send(prompt: string): Promise<string>;
  close(): Promise<void>;
  kill(): Promise<void>;
}

export type Role = "user" | "assistant" | "error" | "separator";
export interface Message {
  role: Role;
  text: string;
  /** Files appended to the prompt; the history shows one line per entry. */
  attachments?: Attachment[];
}
/** idle: accepting input. busy: a turn is in flight. resetting: the
 * browser is being replaced. dead: a fatal error happened; only Ctrl+R
 * (reset) or Ctrl+C (quit) make sense. */
export type Status = "idle" | "busy" | "resetting" | "dead";

/** How long a reset waits for the old browser to close before killing it. */
export const RESET_CLOSE_TIMEOUT_MS = 5_000;
export const SEPARATOR_TEXT = "reopened";

export interface ChatModelOptions {
  /** Opens a replacement session for reset(). The first session is opened
   * by the caller before any UI exists so startup errors surface plainly. */
  openSession: () => Promise<ChatSessionLike>;
  /** Turns the typed text into the prompt to send. Default: expandMentions
   * against process.cwd(). Tests inject a fake. */
  expand?: (text: string) => Promise<Expansion>;
  /** Close cap before a reset kills the old browser. Tests shorten it. */
  closeTimeoutMs?: number;
}

/** Conversation state for the interactive UI. No OpenTUI dependency. */
export class ChatModel {
  readonly messages: Message[] = [];
  status: Status = "idle";
  /** The last fatal error; the reason the model is `dead`. Cleared by a
   * successful reset. Reported by the app when the user quits. */
  fatal: unknown = undefined;
  /** Called after every state change. */
  onChange: () => void = () => {};
  private current: ChatSessionLike;
  /** Bumped by every reset; a send from an older generation is stale and
   * its outcome is dropped. */
  private generation = 0;
  private readonly openSession: () => Promise<ChatSessionLike>;
  private readonly expand: (text: string) => Promise<Expansion>;
  private readonly closeTimeoutMs: number;

  constructor(session: ChatSessionLike, opts: ChatModelOptions) {
    this.current = session;
    this.openSession = opts.openSession;
    this.expand =
      opts.expand ?? ((text) => expandMentions(text, process.cwd()));
    this.closeTimeoutMs = opts.closeTimeoutMs ?? RESET_CLOSE_TIMEOUT_MS;
  }

  /** The session in use right now; teardown closes this one. */
  get session(): ChatSessionLike {
    return this.current;
  }

  /** Sends one turn. Resolves true when the message was accepted (the view
   * clears the textarea), false when it was ignored — blank input, input
   * while not idle — or blocked by a mention problem, which is shown as an
   * error entry without sending anything. */
  async submit(text: string): Promise<boolean> {
    const prompt = text.trim();
    if (!prompt || this.status !== "idle") {
      return false;
    }
    // Claim the turn before awaiting, so a second Enter in the same tick is
    // rejected by the guard above instead of racing through expansion.
    // No onChange yet: nothing observable has changed for the view.
    this.status = "busy";
    let expansion: Expansion;
    try {
      expansion = await this.expand(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({ role: "error", text: message });
      // A mention problem is the user's to fix; anything else is a bug.
      if (err instanceof MentionError) {
        this.status = "idle";
      } else {
        this.fatal = err;
        this.status = "dead";
      }
      this.onChange();
      return false;
    }
    const message: Message = { role: "user", text: prompt };
    if (expansion.attachments.length > 0) {
      message.attachments = expansion.attachments;
    }
    this.messages.push(message);
    this.onChange();
    const session = this.current;
    const generation = this.generation;
    try {
      const reply = await session.send(expansion.prompt);
      if (generation !== this.generation) return true; // stale: reset ran
      this.messages.push({ role: "assistant", text: reply });
      this.status = "idle";
    } catch (err) {
      if (generation !== this.generation) return true; // stale: reset ran
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({ role: "error", text: message });
      // A timeout leaves the browser usable; anything else ends the session.
      if (err instanceof ResponseTimeoutError) {
        this.status = "idle";
      } else {
        this.fatal = err;
        this.status = "dead";
      }
    }
    this.onChange();
    return true;
  }

  /** Replaces the browser: close-or-kill the current session, open a new
   * one, mark the history. Works in every state — the main use is a hung
   * page mid-turn. Ignored while a reset is already running. On failure the
   * model is `dead` with the reopen error as `fatal`. */
  async reset(): Promise<void> {
    if (this.status === "resetting") return;
    this.status = "resetting";
    this.generation++;
    this.onChange();
    const old = this.current;
    await closeOrKill(old, this.closeTimeoutMs);
    try {
      this.current = await this.openSession();
      this.messages.push({ role: "separator", text: SEPARATOR_TEXT });
      this.fatal = undefined;
      this.status = "idle";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({ role: "error", text: message });
      this.fatal = err;
      this.status = "dead";
    }
    this.onChange();
  }
}
```

Note the `submit` change: the `finally` that unconditionally set `status = "idle"` is gone, because a stale turn must not touch status. Every non-stale path sets status explicitly before the single `onChange()`.

- [ ] **Step 7: Fix compile errors in callers**

`run-interactive.ts` constructs `new ChatModel(session)`. Give it a placeholder for now so the build passes (Task 5 wires the real factory):

```ts
    const model = new ChatModel(session, {
      openSession: () => ChatSession.open(opts),
    });
```

That is already the final wiring; leave it. `run-interactive.test.ts` and `chat-view.test.ts` construct models too — add `kill: async () => {}` to their fake sessions and pass `{ openSession: async () => { throw new Error("not expected"); } }` where no reopen is expected. `chat-view.test.ts` `setup()` builds a `ChatModel` with `{ expand }`; add the same `openSession` there (Task 4 will replace it with a real fake).

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test packages/cli`
Expected: PASS.

- [ ] **Step 9: Run the full check and commit**

```bash
bun run check
git add packages/cli/src/tui
git commit -m "feat(cli): ChatModel owns the session lifecycle; reset() reopens the browser, fatal errors enter dead (Refs #34)"
```

---

### Task 4: `ChatView` — Ctrl+R, status per state, separator rendering

**Files:**
- Modify: `packages/cli/src/tui/chat-view.ts`
- Modify: `packages/cli/src/tui/chat-view.test.ts`
- Modify: `packages/cli/src/tui/theme.ts` (only if a new style is needed; `theme.muted` and `theme.error` suffice)

**Interfaces:**
- Consumes: `ChatModel.reset()`, `Status` values, `Role` `"separator"`, `SEPARATOR_TEXT` from Task 3.
- Produces: `GUIDE` now reads `Enter send · Shift+Enter (or Ctrl+J) newline · @ file · Ctrl+R reopen · Ctrl+C quit`; exported `DEAD_GUIDE = "Ctrl+R reopen · Ctrl+C quit"`; exported `RESETTING_STATUS = "Reopening browser..."`.

- [ ] **Step 1: Update the view test harness and write failing tests**

In `packages/cli/src/tui/chat-view.test.ts`:

Update `echoSession` to include `kill`:

```ts
function echoSession(delayMs: number): ChatSessionLike {
  return {
    async send(prompt) {
      await sleep(delayMs);
      return `Echo: ${prompt}`;
    },
    async close() {},
    async kill() {},
  };
}
```

Extend `setup()`'s options with `openSession?: () => Promise<ChatSessionLike>` and pass it through:

```ts
  const model = new ChatModel(
    opts.session ?? echoSession(opts.delayMs ?? 100),
    {
      openSession:
        opts.openSession ?? (async () => echoSession(opts.delayMs ?? 100)),
      closeTimeoutMs: 50,
      expand:
        opts.expand ?? (async (text) => ({ prompt: text, attachments: [] })),
    },
  );
```

Add `kill: async () => {}` to the inline fake sessions in "error messages are labelled error" and "Enter after a fatal error keeps the typed text", and give those two `ChatModel` constructions an `openSession` that throws `new Error("not expected")`. Import `DEAD_GUIDE`, `RESETTING_STATUS` alongside `GUIDE`.

Add tests inside `describe("ChatView", ...)`:

```ts
  test("the guide mentions Ctrl+R reopen", async () => {
    const t = await setup();
    expect(t.captureCharFrame()).toContain("Ctrl+R reopen");
  });

  test("Ctrl+R resets the model and draws a separator", async () => {
    const t = await setup();
    t.mockInput.pressKey("r", { ctrl: true });
    const frame = await t.frameWith("── reopened ──");
    expect(t.model.status).toBe("idle");
    expect(frame).toContain(GUIDE);
    expect(t.model.messages).toEqual([{ role: "separator", text: "reopened" }]);
  });

  test("Ctrl+R while busy replaces the spinner with the resetting status", async () => {
    const gate = deferred<ChatSessionLike>();
    const t = await setup({
      delayMs: 5_000,
      openSession: () => gate.promise,
    });
    await t.mockInput.typeText("hang");
    t.mockInput.pressEnter();
    await t.frameWith("Thinking…");
    t.mockInput.pressKey("r", { ctrl: true });
    const resetting = await t.frameWith(RESETTING_STATUS);
    expect(resetting).not.toContain("Thinking…");
    gate.resolve(echoSession(10));
    const done = await t.frameWith("── reopened ──");
    expect(done).toContain(GUIDE);
    expect(done).toContain("hang"); // history kept
  });

  test("a fatal error shows the dead guide and Ctrl+R recovers", async () => {
    const t = await setup({
      session: {
        async send() {
          throw new Error("page closed");
        },
        async close() {},
        async kill() {},
      },
    });
    await t.mockInput.typeText("x");
    t.mockInput.pressEnter();
    const dead = await t.frameWith(DEAD_GUIDE);
    expect(dead).toContain("page closed");
    expect(dead).not.toContain(GUIDE);
    t.mockInput.pressKey("r", { ctrl: true });
    const back = await t.frameWith("── reopened ──");
    expect(back).toContain(GUIDE);
    expect(t.model.fatal).toBeUndefined();
  });

  test("a failed reopen keeps the dead guide and shows the error", async () => {
    const t = await setup({
      openSession: async () => {
        throw new Error("auth gone");
      },
    });
    t.mockInput.pressKey("r", { ctrl: true });
    const frame = await t.frameWith("auth gone");
    expect(frame).toContain(DEAD_GUIDE);
    expect(t.model.status).toBe("dead");
  });

  test("Ctrl+R works with the mention popup open", async () => {
    const t = await setup();
    await t.mockInput.typeText("see @chat");
    await t.frameWith("src/chat-view.ts");
    t.mockInput.pressKey("r", { ctrl: true });
    await t.frameWith("── reopened ──");
    expect(t.model.status).toBe("idle");
  });

  test("the separator has no role label", async () => {
    const t = await setup();
    await t.model.reset();
    const frame = await t.frameWith("── reopened ──");
    expect(frame).not.toContain("separator");
  });
```

`deferred` is not defined in this file yet; add the same helper used in `chat-model.test.ts`:

```ts
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
```

Update the existing test "the guide mentions @ file" only if it asserts the full guide string; `GUIDE` is imported, so it keeps passing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: FAIL — no `DEAD_GUIDE` export; Ctrl+R has no effect; separator renders with a `separator` label because `LABELS` lacks the role (TypeScript error on `Record<Role, ...>` at build, and a runtime `undefined is not a function` in the test).

- [ ] **Step 3: Implement**

In `packages/cli/src/tui/chat-view.ts`:

Constants:

```ts
export const GUIDE =
  "Enter send · Shift+Enter (or Ctrl+J) newline · @ file · Ctrl+R reopen · Ctrl+C quit";
export const DEAD_GUIDE = "Ctrl+R reopen · Ctrl+C quit";
export const RESETTING_STATUS = "Reopening browser...";
```

Change `LABELS` to cover only labelled roles (the separator text comes from the message itself, so no new import is needed):

```ts
const LABELS: Record<Exclude<Role, "separator">, () => StyledText> = {
  user: () => styled(theme.user("user")),
  assistant: () => styled(theme.assistant("assistant")),
  error: () => styled(theme.error("error")),
};
```

In `update()`, replace the status branch:

```ts
    if (this.statusPinned) return;
    switch (this.model.status) {
      case "busy":
        this.startSpinner();
        break;
      case "resetting":
        this.stopSpinner();
        this.status.content = styled(theme.muted(RESETTING_STATUS));
        break;
      case "dead":
        this.stopSpinner();
        this.status.content = styled(theme.errorText(DEAD_GUIDE));
        break;
      default:
        this.stopSpinner();
        this.status.content = styled(theme.muted(GUIDE));
    }
```

In the `onSubmit` guard, replace the two model checks with `this.model.status !== "idle"`:

```ts
      if (!text.trim() || this.model.status !== "idle") {
        return;
      }
```

Rename `handlePopupKey` to `handleKey` and handle Ctrl+R before the popup check:

```ts
  /** Ctrl+R reopens the browser in every state. While the popup is open,
   * navigation and accept keys belong to it and never reach the textarea.
   * Everything else falls through and the content/cursor hooks re-run the
   * search. */
  private handleKey(key: KeyEvent): void {
    if (this.torn) return;
    if (key.ctrl && key.name === "r") {
      key.preventDefault();
      void this.model.reset();
      return;
    }
    if (!this.popup.visible) return;
    switch (key.name) {
      // ... unchanged cases ...
    }
    key.preventDefault();
  }
```

and update the constructor assignment `this.onKeypress = (key) => this.handleKey(key);`.

In `messageBox`, render the separator as a single dim line:

```ts
  private messageBox(message: Message): BoxRenderable {
    const box = new BoxRenderable(this.renderer, {
      flexDirection: "column",
      marginBottom: 1,
    });
    if (message.role === "separator") {
      box.add(
        new TextRenderable(this.renderer, {
          content: styled(theme.muted(`── ${message.text} ──`)),
          wrapMode: "none",
        }),
      );
      return box;
    }
    box.add(
      new TextRenderable(this.renderer, { content: LABELS[message.role]() }),
    );
    // ... rest unchanged ...
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: PASS. If `pressKey("r", { ctrl: true })` does not arrive as `ctrl + "r"` on the legacy (non-kitty) parser, check what the parser emits for byte `0x12` (`grep -rn "0x12\|ctrl.*r" node_modules/.bun/@opentui+core*/node_modules/@opentui/core/lib/parse.keypress*`) and match that in `handleKey`; add a `kittyKeyboard: true` variant of the Ctrl+R test so both paths are pinned.

- [ ] **Step 5: Run the full check and commit**

```bash
bun run check
git add packages/cli/src/tui/chat-view.ts packages/cli/src/tui/chat-view.test.ts
git commit -m "feat(cli): Ctrl+R reopens the browser; dead and resetting status rows; separator entries (Refs #34)"
```

---

### Task 5: `runInteractive` — quit semantics and current-session teardown

**Files:**
- Modify: `packages/cli/src/tui/run-interactive.ts`
- Modify: `packages/cli/src/tui/run-interactive.test.ts`

**Interfaces:**
- Consumes: `ChatModel.session`, `ChatModel.fatal`, `ChatModelOptions.openSession` from Task 3.
- Produces: `waitForQuit(renderer, model): Promise<unknown>` resolves only on Ctrl+C or renderer destroy, with `model.fatal` as the value; `runInteractive` unchanged in signature.

- [ ] **Step 1: Write failing tests**

In `packages/cli/src/tui/run-interactive.test.ts`, the existing `waitForQuit` test constructs a `ChatModel` — update it to `new ChatModel({ async send() { return ""; }, async close() {}, async kill() {} }, { openSession: async () => { throw new Error("not expected"); } })`.

Add to `describe("waitForQuit", ...)`:

```ts
  test("does not resolve on a fatal error; Ctrl+C then returns it", async () => {
    const t = await createTestRenderer({ width: 40, height: 12 });
    const boom = new Error("page closed");
    const model = new ChatModel(
      {
        async send() {
          throw boom;
        },
        async close() {},
        async kill() {},
      },
      {
        openSession: async () => {
          throw new Error("not expected");
        },
        expand: async (text) => ({ prompt: text, attachments: [] }),
      },
    );
    const view = new ChatView(t.renderer, model, {
      title: "test-cli",
      providerName: "dummy-chat",
      timeoutMs: 1_000,
      headless: true,
      banner: [],
      index: FileIndex.fromPaths([]),
    });
    const quit = waitForQuit(t.renderer, model);
    await model.submit("x");
    expect(model.status).toBe("dead");
    const raced = await Promise.race([
      quit.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("pending"), 50)),
    ]);
    expect(raced).toBe("pending");
    t.mockInput.pressKey("c", { ctrl: true });
    expect(await quit).toBe(boom);
    view.destroy();
    t.renderer.destroy();
  });

  test("Ctrl+C from a healthy model resolves undefined", async () => {
    const t = await createTestRenderer({ width: 40, height: 12 });
    const model = new ChatModel(
      { async send() { return ""; }, async close() {}, async kill() {} },
      { openSession: async () => { throw new Error("not expected"); } },
    );
    const view = new ChatView(t.renderer, model, {
      title: "test-cli",
      providerName: "dummy-chat",
      timeoutMs: 1_000,
      headless: true,
      banner: [],
      index: FileIndex.fromPaths([]),
    });
    const quit = waitForQuit(t.renderer, model);
    t.mockInput.pressKey("c", { ctrl: true });
    expect(await quit).toBeUndefined();
    view.destroy();
    t.renderer.destroy();
  });
```

Add to `describe("runInteractive", ...)`. `sessionOpts` needs to count launches and closes per launch, so replace it:

```ts
/** Minimal ChatSession dependencies: a provider that never needs a browser.
 * `launches` grows by one runtime record per BrowserRuntime.launch call. */
function sessionOpts() {
  const provider: Provider = {
    name: "fake",
    chatUrl: "http://127.0.0.1:1/chat",
    async navigateToLogin() {},
    async isLoggedIn() {
      return true;
    },
    async startNewChat() {},
    async sendMessage() {},
    async waitForResponse() {
      return "";
    },
  };
  const page = {
    setDefaultTimeout() {},
    goto: async () => null,
  } as unknown as Page;
  const launches: Array<{ closed: number; killed: number }> = [];
  return {
    launches,
    opts: {
      title: "test-cli",
      provider,
      authStore: { has: () => true } as unknown as AuthStore,
      headless: true,
      timeoutMs: 1000,
      launch: async () => {
        const rec = { closed: 0, killed: 0 };
        launches.push(rec);
        return {
          page,
          saveAuthState: async () => {},
          close: async () => {
            rec.closed++;
          },
          kill: async () => {
            rec.killed++;
          },
        };
      },
    },
  };
}
```

and update the three existing `runInteractive` tests to use `const s = sessionOpts(); ... runInteractive({ ...s.opts, ... })` and assert with `s.launches[0]?.closed`. Then add:

```ts
  test("teardown closes the session that is current after a reset", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    const s = sessionOpts();
    const run = runInteractive({
      ...s.opts,
      createRenderer: async () => t.renderer,
      index: FileIndex.fromPaths([]),
    });
    let frame = "";
    for (let i = 0; i < 50 && !frame.includes("Ctrl+R reopen"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await t.renderOnce();
      frame = t.captureCharFrame();
    }
    t.mockInput.pressKey("r", { ctrl: true });
    for (let i = 0; i < 50 && !frame.includes("── reopened ──"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await t.renderOnce();
      frame = t.captureCharFrame();
    }
    try {
      expect(frame).toContain("── reopened ──");
      expect(s.launches).toHaveLength(2);
      expect(s.launches[0]?.closed).toBe(1);
      expect(s.launches[1]?.closed).toBe(0);
    } finally {
      t.mockInput.pressKey("c", { ctrl: true });
    }
    expect(await run).toEqual({});
    expect(s.launches[1]?.closed).toBe(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/tui/run-interactive.test.ts`
Expected: FAIL — `waitForQuit` resolves on fatal (`raced` is `"resolved"`); the teardown test fails on `launches[1].closed` because the finally block closes the original `session` variable.

- [ ] **Step 3: Implement**

In `packages/cli/src/tui/run-interactive.ts`:

Rewrite `waitForQuit`:

```ts
/**
 * Resolves when the user asks to quit: Ctrl+C, or the renderer being
 * destroyed from outside — OpenTUI installs its own SIGINT/SIGTERM/SIGHUP
 * handlers that destroy the renderer without exiting the process, so
 * without this the caller's promise would stay pending and the browser
 * would keep the process alive. A fatal model error does not quit (the
 * model goes `dead` and Ctrl+R can recover); the resolved value is the
 * model's `fatal` at quit time so a quit from `dead` reports the error.
 */
export function waitForQuit(
  renderer: CliRenderer,
  model: ChatModel,
): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    (renderer.keyInput as unknown as KeypressSource).on("keypress", (key) => {
      if (key.ctrl && key.name === "c") resolve(model.fatal);
    });
    (renderer as unknown as DestroySource).on("destroy", () =>
      resolve(model.fatal),
    );
  });
}
```

(The old chaining onto `model.onChange` is removed, together with the "must be called after the ChatView is built" note.)

In `runInteractive`, the model construction from Task 3 stays:

```ts
    const model = new ChatModel(session, {
      openSession: () => ChatSession.open(opts),
    });
```

Hoist `model` so `finally` can see it, and close the current session:

```ts
  let view: ChatView | undefined;
  let model: ChatModel | undefined;
  try {
    model = new ChatModel(session, {
      openSession: () => ChatSession.open(opts),
    });
    view = new ChatView(renderer, model, { /* unchanged */ });
    const quit = waitForQuit(renderer, model);
    renderer.start();
    const fatal = await quit;
    return fatal === undefined ? {} : { fatal };
  } finally {
    view?.setStatus(CLOSING_STATUS);
    // After a reset the original `session` is already closed; close whichever
    // one the model holds now. During a reset that is still the old one and
    // the reopen is abandoned with the process.
    const closed = await closeWithTimeout(
      model?.session ?? session,
      CLOSE_TIMEOUT_MS,
    );
    view?.destroy();
    renderer.destroy();
    if (!closed) {
      process.stderr.write("browser did not close within 5 s; exiting\n");
      process.exit(1);
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli`
Expected: PASS.

- [ ] **Step 5: Manual smoke test against the dummy chat**

```bash
bun run build
bun run examples/dummy-chat/serve.ts &          # dummy service on :8735
bun packages/cli/src/bin.ts auth login \
  --provider ./examples/dummy-chat/provider.ts  # once; click "Log in"
bun packages/cli/src/bin.ts \
  --provider ./examples/dummy-chat/provider.ts  # interactive chat
```

Send a message, press Ctrl+R while the spinner is up, confirm `Reopening browser...` then `── reopened ──`, send again, then Ctrl+C. This needs a real terminal; if the session cannot run one, say so in the task report instead of claiming it passed.

- [ ] **Step 6: Run the full check and commit**

```bash
bun run check
git add packages/cli/src/tui/run-interactive.ts packages/cli/src/tui/run-interactive.test.ts
git commit -m "feat(cli): fatal errors no longer quit the TUI; teardown closes the current session (Refs #34)"
```

---

### Task 6: Docs — README key guide and roadmap

**Files:**
- Modify: `README.md` (Interactive mode section)
- Modify: `docs/ROADMAP.md` (milestone 8 entry)

- [ ] **Step 1: README**

In the "Interactive mode" bullet list of `README.md`, change the first bullet's last sentence and add one bullet:

```markdown
- **Enter** sends. **Shift+Enter** (or **Ctrl+J**) inserts a newline;
  Shift+Enter needs a terminal that speaks the kitty keyboard protocol
  (iTerm2, kitty, WezTerm, Ghostty), Ctrl+J works everywhere. **Ctrl+R**
  reopens the browser. **Ctrl+C** quits.
- **Ctrl+R** closes the browser (killing it after 5 s if it will not close),
  opens a fresh one with the saved auth state, and starts a new chat. The
  transcript stays on screen with a `── reopened ──` line; the service does
  not remember the earlier turns, so re-send what you need. Use it when a
  response hangs. If a fatal error happens mid-conversation the status row
  shows `Ctrl+R reopen · Ctrl+C quit`; quitting then exits with that error.
```

- [ ] **Step 2: ROADMAP**

Replace the body of `### 8. Ctrl+R: reopen the browser from the TUI — in progress (issue #34)` in `docs/ROADMAP.md` with:

```markdown
Ctrl+R closes the browser (5 s cap, then SIGKILL via the new
`BrowserRuntime.kill()` / `ChatSession.kill()`), opens a fresh one with the
saved auth state, and marks the kept history with `── reopened ──`. It works
mid-turn — the main use is a hung page. Fatal errors no longer quit the TUI:
the model enters `dead`, the status row offers `Ctrl+R reopen · Ctrl+C quit`,
and quitting reports the error. Core stays UI-free; the state machine and
the close cap live in `@chatbridge/cli`.
Spec: `docs/superpowers/specs/2026-09-10-browser-reopen-design.md`.
```

(The `— in progress` suffix becomes `— done (issue #34, <date>)` when the PR merges.)

- [ ] **Step 3: Check and commit**

```bash
bun run check
git add README.md docs/ROADMAP.md
git commit -m "docs: Ctrl+R browser reopen in README and roadmap (Refs #34)"
```

- [ ] **Step 4: Sync the issue**

```bash
gh issue comment 34 --body "All six plan tasks committed on issue-34 (runtime kill, core kill, model reset, view Ctrl+R, quit semantics, docs). Next: whole-branch review, then PR."
```
