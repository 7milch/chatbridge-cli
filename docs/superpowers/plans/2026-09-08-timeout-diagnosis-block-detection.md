# Timeout Diagnosis, Block Detection, Activity Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Diagnose a mid-conversation response timeout as an expired login, let a provider report a bot challenge as "blocked, not logged out" (exit 6, suggests `--headful`), and replace the TUI spinner with an elapsed-time activity indicator.

**Architecture:** One optional `detectBlock` method joins the `Provider` contract. `ChatSession` gains a private `assertLoggedIn` helper used at `open` and after a `send` timeout; it throws the new `BlockedError` or the existing `AuthExpiredError`. The CLI maps `BLOCKED` to exit 6. The TUI change is confined to `ChatView`'s status line. The dummy chat gets a togglable challenge page so the block path is covered end to end.

**Tech Stack:** TypeScript, Bun workspaces + `bun test`, Playwright (Chromium), OpenTUI (`@opentui/core` + `@opentui/core/testing`), Biome.

**Spec:** `docs/superpowers/specs/2026-09-08-timeout-diagnosis-block-detection-design.md`

## Global Constraints

- Branch `issue-25`; every commit message ends with `(Refs #25)` before the trailer, and `gh issue comment 25` (English) follows every commit with what landed and what is next.
- `bun run check` (Biome lint + `tsc --build` + `bun test`) must pass before every commit. Tests import cross-package code from `dist/`, so `bun run build` after editing another package.
- Dependency direction `cli → core → runtime → provider`; never import in reverse. Core and provider never import OpenTUI.
- Every document, comment, and commit message is in English.
- The five existing `Provider` methods and the `isLoggedIn` boolean are unchanged.
- One-shot output stays batch: `-p` prints the finished response only.
- Exit codes 1–5 keep their meaning; `BLOCKED` is exit 6.
- `BlockedError` message format, verbatim: `Blocked by "<provider.name>": <description>. Try --headful.`
- Activity indicator: frames `●○○`, `○●○`, `○○●`, `○●○` at 120 ms; line `<frame> Thinking…  <elapsed>s / <budget>s` (two spaces before the elapsed part; `…` is U+2026).
- No bot-protection evasion of any kind; `detectBlock` only reports.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `packages/provider/src/index.ts` | modify | add optional `detectBlock` to `Provider` |
| `packages/provider/src/index.test.ts` | modify | `defineProvider` accepts `detectBlock` |
| `packages/provider/README.md` | modify | document `detectBlock` |
| `packages/core/src/errors.ts` | modify | add `BlockedError` |
| `packages/core/src/errors.test.ts` | modify | `BlockedError` code |
| `packages/core/src/chat-session.ts` | modify | `assertLoggedIn`; use it in `open` and after a `send` timeout |
| `packages/core/src/chat-session.test.ts` | modify | block at open; timeout diagnosis branches |
| `examples/dummy-chat/server.ts` | modify | `setBlocked()` hook + challenge page |
| `examples/dummy-chat/provider.ts` | modify | `detectBlock` |
| `examples/dummy-chat/server.test.ts` | modify | challenge page served while blocked |
| `packages/core/src/session.e2e.test.ts` | modify | `open` rejects with `BlockedError` on the blocked dummy chat |
| `packages/cli/src/create-cli.ts` | modify | `BLOCKED: 6`; help text |
| `packages/cli/src/cli.e2e.test.ts` | modify | exit 6 + `Try --headful` on stderr |
| `packages/cli/src/tui/chat-view.ts` | modify | activity indicator; `timeoutMs` option |
| `packages/cli/src/tui/chat-view.test.ts` | modify | indicator text and rotation |
| `packages/cli/src/tui/run-interactive.ts` | modify | pass `timeoutMs` to `ChatView` |
| `packages/cli/src/tui/run-interactive.test.ts` | modify | `ChatView` construction gains `timeoutMs` |
| `README.md` | modify | exit code 6; interactive-mode indicator |
| `.claude/skills/creating-provider-repo/SKILL.md` | modify | trap row points at `detectBlock` |
| `docs/ROADMAP.md` | modify | mark 3b done at the end |

---

### Task 1: `Provider.detectBlock`

**Files:**
- Modify: `packages/provider/src/index.ts`
- Modify: `packages/provider/src/index.test.ts`
- Modify: `packages/provider/README.md`

**Interfaces:**
- Produces: `Provider.detectBlock?(page: Page): Promise<string | undefined>` — later tasks call it only after `isLoggedIn` returned false.

- [ ] **Step 1: Write the failing test**

Append to `packages/provider/src/index.test.ts` inside the `describe("defineProvider")` block:

```typescript
  test("accepts the optional detectBlock method", () => {
    const p: Provider = {
      name: "test",
      chatUrl: "http://localhost:1/chat",
      navigateToLogin: async () => {},
      isLoggedIn: async () => false,
      startNewChat: async () => {},
      sendMessage: async () => {},
      waitForResponse: async () => "reply",
      detectBlock: async () => "challenge page",
    };
    expect(defineProvider(p).detectBlock).toBe(p.detectBlock);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/provider`
Expected: type error / FAIL — `detectBlock` does not exist in type `Provider` (`tsc --build` in `bun run build` reports it; `bun test` alone may pass because Bun strips types — treat the build error as the failure).

- [ ] **Step 3: Add the method to the contract**

In `packages/provider/src/index.ts`, after `waitForResponse`:

```typescript
  /** Optional. When the page shows a block that logging in again would not
   * clear (a bot challenge interstitial, an IdP refusing the automated
   * browser), return a short description of it; otherwise undefined. The
   * core calls this only after `isLoggedIn` returned false. Must not throw
   * on an ordinary logged-out page. */
  detectBlock?(page: Page): Promise<string | undefined>;
```

- [ ] **Step 4: Document it**

Replace the body of `packages/provider/README.md` with:

```markdown
# @chatbridge/provider

The provider contract for [chatbridge](https://github.com/7milch/chatbridge-cli): the interface service-specific browser behaviour implements.

## Optional: `detectBlock`

`detectBlock(page)` lets a provider tell a bot challenge or an IdP refusing
the automated browser apart from an expired login. The core calls it only
after `isLoggedIn` returned `false`. Return a short description to raise
`BlockedError` (CLI exit 6, message suggests `--headful`); return
`undefined` for an ordinary logged-out page. Example for a Cloudflare
interstitial:

```typescript
async detectBlock(page) {
  return (await page.title()) === "Just a moment..." ? "challenge page" : undefined;
}
```

Detecting a block is all the framework does; evading it is out of scope.
```

- [ ] **Step 5: Run check and commit**

Run: `bun run check`
Expected: PASS (108 + 1 tests).

```bash
git add packages/provider
git commit -m "feat(provider): optional detectBlock on the Provider contract (Refs #25)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 25 --body "Task 1 done: \`Provider.detectBlock?\` added and documented. Next: BlockedError + assertLoggedIn in ChatSession.open (Task 2)."
```

---

### Task 2: `BlockedError` and block detection at `open`

**Files:**
- Modify: `packages/core/src/errors.ts`
- Modify: `packages/core/src/errors.test.ts`
- Modify: `packages/core/src/chat-session.ts`
- Modify: `packages/core/src/chat-session.test.ts`

**Interfaces:**
- Consumes: `Provider.detectBlock?` from Task 1.
- Produces: `BlockedError` (code `"BLOCKED"`) exported from `@chatbridge/core` via `export * from "./errors.js"`; private `ChatSession.assertLoggedIn()` reused in Task 3.

- [ ] **Step 1: Write the failing error test**

Append to `packages/core/src/errors.test.ts` (inside its existing `describe`, following the pattern of the neighbouring tests; import `BlockedError` from `./errors.js`):

```typescript
  test("BlockedError has code BLOCKED", () => {
    const err = new BlockedError("blocked");
    expect(err.code).toBe("BLOCKED");
    expect(err.name).toBe("BlockedError");
    expect(err).toBeInstanceOf(ChatBridgeError);
  });
```

- [ ] **Step 2: Write the failing session tests**

In `packages/core/src/chat-session.test.ts`:

Add `BlockedError` to the import from `./errors.js`.

Extend `Harness` with a block hook. In the `Harness` interface add:

```typescript
  /** When set, the provider gains detectBlock returning this value. */
  block: string | undefined;
  hasDetectBlock: boolean;
```

In `harness()` initialise `block: undefined, hasDetectBlock: false,` in the object literal, and after `h.provider = {...}` add:

```typescript
  Object.defineProperty(h.provider, "detectBlock", {
    get() {
      return h.hasDetectBlock ? async () => h.block : undefined;
    },
  });
```

(A getter, so a test can flip `hasDetectBlock` after the harness is built and the session still sees a provider with or without the method.)

Append to `describe("ChatSession.open")`:

```typescript
  test("throws BlockedError with the documented message when detectBlock reports a block", async () => {
    const h = harness();
    h.loggedIn = false;
    h.hasDetectBlock = true;
    h.block = "challenge page";
    const err = await ChatSession.open(opts(h)).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err.message).toBe(
      'Blocked by "fake": challenge page. Try --headful.',
    );
    expect(h.closed).toBe(1);
  });

  test("throws AuthExpiredError when detectBlock returns undefined", async () => {
    const h = harness();
    h.loggedIn = false;
    h.hasDetectBlock = true;
    h.block = undefined;
    await expect(ChatSession.open(opts(h))).rejects.toBeInstanceOf(
      AuthExpiredError,
    );
    expect(h.closed).toBe(1);
  });

  test("does not call detectBlock while logged in", async () => {
    const h = harness();
    h.hasDetectBlock = true;
    h.block = "challenge page";
    const session = await ChatSession.open(opts(h));
    await session.close();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/core/src/errors.test.ts packages/core/src/chat-session.test.ts`
Expected: FAIL — `BlockedError` is not exported; the first new open test gets `AuthExpiredError` instead of `BlockedError`.

- [ ] **Step 4: Add `BlockedError`**

Append to `packages/core/src/errors.ts`:

```typescript
/** The service blocked the automated browser (bot challenge, IdP refusing
 * automation); logging in again would not help. The message suggests
 * --headful. */
export class BlockedError extends ChatBridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super("BLOCKED", message, options);
  }
}
```

- [ ] **Step 5: Add `assertLoggedIn` and use it in `open`**

In `packages/core/src/chat-session.ts`:

Add `BlockedError` to the import from `./errors.js`.

Replace the `isLoggedIn` block inside `open` (the `const loggedIn = ...` through the `throw new AuthExpiredError(...)` closing brace) with:

```typescript
      await ChatSession.assertLoggedIn(provider, rt.page, timeoutMs);
```

Add this static method to the class (above `open`):

```typescript
  /** isLoggedIn → true: return. false: ask detectBlock (when the provider
   * has it); a description means BlockedError, otherwise AuthExpiredError.
   * Both provider calls run under runStep so a hang maps to a timeout. */
  private static async assertLoggedIn(
    provider: Provider,
    page: Page,
    timeoutMs: number,
  ): Promise<void> {
    const loggedIn = await runStep("isLoggedIn", timeoutMs, () =>
      provider.isLoggedIn(page),
    );
    if (loggedIn) return;
    const block = provider.detectBlock
      ? await runStep("detectBlock", timeoutMs, () =>
          provider.detectBlock?.(page),
        )
      : undefined;
    if (block !== undefined) {
      throw new BlockedError(
        `Blocked by "${provider.name}": ${block}. Try --headful.`,
      );
    }
    throw new AuthExpiredError(
      `Auth state for "${provider.name}" is no longer valid. Run \`auth login\` again.`,
    );
  }
```

(Static because `open` runs before the instance exists; Task 3 calls it from the instance with `this.provider`, `this.rt.page`, `this.timeoutMs`.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run build && bun test packages/core`
Expected: PASS, including the unchanged `closes the browser and throws AuthExpiredError when not logged in` and `does not save when open fails`.

- [ ] **Step 7: Check and commit**

Run: `bun run check`
Expected: PASS.

```bash
git add packages/core
git commit -m "feat(core): BlockedError; ChatSession.open distinguishes a block from an expired login (Refs #25)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 25 --body "Task 2 done: BlockedError (code BLOCKED) and assertLoggedIn in ChatSession.open. Next: diagnose a send timeout with the same helper (Task 3)."
```

---

### Task 3: Diagnose a `send` timeout

**Files:**
- Modify: `packages/core/src/chat-session.ts`
- Modify: `packages/core/src/chat-session.test.ts`

**Interfaces:**
- Consumes: `ChatSession.assertLoggedIn` from Task 2; `ResponseTimeoutError` from `./errors.js`.
- Produces: `send` rejects with `AuthExpiredError` / `BlockedError` when a timeout coincides with a lost login; otherwise the original `ResponseTimeoutError`.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/chat-session.test.ts` add `ResponseTimeoutError` to the import from `./errors.js`, then add a new describe block after `describe("ChatSession.send")`:

```typescript
describe("ChatSession.send timeout diagnosis", () => {
  const timeout = () => new ResponseTimeoutError("Timed out during waitForResponse after 1000 ms.");

  test("rethrows the timeout and stays usable while still logged in", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    const first = session.send("one");
    (await replyOf(h, 0)).reject(timeout());
    await expect(first).rejects.toBeInstanceOf(ResponseTimeoutError);
    const second = session.send("two");
    (await replyOf(h, 1)).resolve("Echo: two");
    expect(await second).toBe("Echo: two");
    await session.close();
  });

  test("turns the timeout into AuthExpiredError when the page is logged out", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    const first = session.send("one");
    h.loggedIn = false;
    (await replyOf(h, 0)).reject(timeout());
    await expect(first).rejects.toBeInstanceOf(AuthExpiredError);
    await session.close();
  });

  test("turns the timeout into BlockedError when detectBlock reports a block", async () => {
    const h = harness();
    h.hasDetectBlock = true;
    const session = await ChatSession.open(opts(h));
    const first = session.send("one");
    h.loggedIn = false;
    h.block = "challenge page";
    (await replyOf(h, 0)).reject(timeout());
    const err = await first.catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err.message).toBe(
      'Blocked by "fake": challenge page. Try --headful.',
    );
    await session.close();
  });

  test("keeps the original timeout when the diagnosis itself fails", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    const first = session.send("one");
    h.provider.isLoggedIn = async () => {
      throw new Error("page closed");
    };
    const original = timeout();
    (await replyOf(h, 0)).reject(original);
    const err = await first.catch((e) => e);
    expect(err).toBe(original);
    // close() still runs isLoggedIn; let it fail softly.
    await session.close();
  });

  test("a non-timeout error is not diagnosed", async () => {
    const h = harness();
    let checks = 0;
    const session = await ChatSession.open(opts(h));
    h.provider.isLoggedIn = async () => {
      checks++;
      return true;
    };
    const first = session.send("one");
    (await replyOf(h, 0)).reject(new Error("boom"));
    await expect(first).rejects.toThrow("boom");
    expect(checks).toBe(0);
    await session.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/src/chat-session.test.ts`
Expected: FAIL — the second and third tests receive `ResponseTimeoutError` instead of `AuthExpiredError` / `BlockedError`.

- [ ] **Step 3: Implement the diagnosis in `send`**

In `packages/core/src/chat-session.ts` add `ResponseTimeoutError` to the import from `./errors.js`, and replace the body of `send` from `this.pending = true;` to the end of the method with:

```typescript
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
    } catch (err) {
      if (err instanceof ResponseTimeoutError) await this.diagnoseTimeout();
      throw err;
    } finally {
      this.pending = false;
    }
  }

  /** A timeout may really be a lost login. Throws AuthExpiredError or
   * BlockedError when the page is no longer logged in; returns when it
   * still is, or when the check itself fails (the caller then rethrows the
   * original timeout, which stays the primary failure). */
  private async diagnoseTimeout(): Promise<void> {
    try {
      await ChatSession.assertLoggedIn(
        this.provider,
        this.rt.page,
        this.timeoutMs,
      );
    } catch (err) {
      if (err instanceof AuthExpiredError || err instanceof BlockedError) {
        throw err;
      }
      // Anything else (page gone, a second timeout): swallow; the caller
      // rethrows the original ResponseTimeoutError.
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run build && bun test packages/core`
Expected: PASS, including the pre-existing `a failed send leaves the session usable`.

- [ ] **Step 5: Check and commit**

Run: `bun run check`
Expected: PASS.

```bash
git add packages/core
git commit -m "feat(core): diagnose a send timeout as expired login or block (Refs #25)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 25 --body "Task 3 done: ChatSession.send re-checks isLoggedIn after a ResponseTimeoutError and raises AuthExpiredError / BlockedError; the original timeout wins if the check itself fails. Next: dummy chat challenge page + core E2E (Task 4)."
```

---

### Task 4: Dummy chat challenge page and core E2E

**Files:**
- Modify: `examples/dummy-chat/server.ts`
- Modify: `examples/dummy-chat/server.test.ts`
- Modify: `examples/dummy-chat/provider.ts`
- Modify: `packages/core/src/session.e2e.test.ts`

**Interfaces:**
- Consumes: `Provider.detectBlock?` (Task 1), `BlockedError` (Task 2).
- Produces: `DummyChat.setBlocked(blocked: boolean): void`; while blocked, `GET /chat` returns a page titled `Just a moment...` with no `#message-input`; the dummy provider's `detectBlock` returns `"challenge page"` on that title.

- [ ] **Step 1: Write the failing server test**

Open `examples/dummy-chat/server.test.ts` and add, following its existing style (it starts a server on port 0 and fetches paths):

```typescript
  test("serves the challenge page on /chat while blocked", async () => {
    const server = await startDummyChat(0);
    try {
      server.setBlocked(true);
      const res = await fetch(`${server.url}/chat`, {
        headers: { cookie: "session=ok" },
      });
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("<title>Just a moment...</title>");
      expect(html).not.toContain("message-input");
      server.setBlocked(false);
      const back = await fetch(`${server.url}/chat`, {
        headers: { cookie: "session=ok" },
      });
      expect(await back.text()).toContain("message-input");
    } finally {
      server.stop();
    }
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test examples/dummy-chat`
Expected: FAIL — `server.setBlocked is not a function`.

- [ ] **Step 3: Add the block hook and page**

In `examples/dummy-chat/server.ts`:

Add after `LOGIN_HTML`:

```typescript
/** Stand-in for a bot-protection interstitial: same title Cloudflare uses,
 * no chat controls, served regardless of session. */
const CHALLENGE_HTML = `<!doctype html>
<title>Just a moment...</title>
<h1>Checking your browser</h1>`;
```

Extend the header comment's test-hook list with `setBlocked() (serves a challenge page instead of the chat)`.

In `DummyChat` add:

```typescript
  /** While true, /chat serves a challenge page instead of the chat. */
  setBlocked(blocked: boolean): void;
```

In `startDummyChat` declare `let blocked = false;` next to `replyDelayMs`, and change the `/chat` branch to check the block before the session:

```typescript
      if (pathname === "/chat") {
        if (blocked) {
          return new Response(CHALLENGE_HTML, {
            headers: { "content-type": "text/html" },
          });
        }
        if (!hasSession(req)) {
```

Add to the returned object:

```typescript
    setBlocked: (value: boolean) => {
      blocked = value;
    },
```

- [ ] **Step 4: Implement `detectBlock` in the dummy provider**

In `examples/dummy-chat/provider.ts`, after `waitForResponse`:

```typescript
    async detectBlock(page) {
      // The challenge page has no chat controls, so isLoggedIn is false;
      // the title tells the two apart.
      return (await page.title()) === "Just a moment..."
        ? "challenge page"
        : undefined;
    },
```

- [ ] **Step 5: Run the server test to verify it passes**

Run: `bun test examples/dummy-chat`
Expected: PASS.

- [ ] **Step 6: Write the failing core E2E test**

In `packages/core/src/session.e2e.test.ts` add `BlockedError` to the import from `./errors.js`, and append inside `describe("ChatSession")`:

```typescript
  test("open reports a challenge page as BlockedError, not an expired login", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    const store = tempStore(provider.name);
    await prepareAuth(provider, store);

    server.setBlocked(true);
    const err = await ChatSession.open({
      provider,
      authStore: store,
      headless: true,
      timeoutMs: 30_000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err.message).toBe(
      'Blocked by "dummy-chat": challenge page. Try --headful.',
    );
  }, 60_000);
```

- [ ] **Step 7: Run the E2E to verify it fails, then passes after a build**

Run: `bun test packages/core/src/session.e2e.test.ts`
Expected: FAIL first only if `dist/` is stale (`setBlocked` missing); then run `bun run build && bun test packages/core/src/session.e2e.test.ts` and expect PASS.

- [ ] **Step 8: Check and commit**

Run: `bun run check`
Expected: PASS.

```bash
git add examples/dummy-chat packages/core/src/session.e2e.test.ts
git commit -m "test: dummy chat challenge page; core E2E for BlockedError at open (Refs #25)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 25 --body "Task 4 done: dummy chat gains setBlocked() and a 'Just a moment...' page; the dummy provider implements detectBlock; core E2E proves BlockedError at open on real Chromium. Next: CLI exit code 6 (Task 5)."
```

---

### Task 5: CLI exit code 6

**Files:**
- Modify: `packages/cli/src/create-cli.ts`
- Modify: `packages/cli/src/cli.e2e.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `BlockedError` code `"BLOCKED"` (Task 2); `DummyChat.setBlocked` (Task 4).
- Produces: `EXIT_CODES.BLOCKED === 6`.

- [ ] **Step 1: Write the failing E2E test**

Append inside `describe("createCli")` in `packages/cli/src/cli.e2e.test.ts`:

```typescript
  test("challenge page exits 6 and suggests --headful", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const provider = await prepareAuth(baseDir, server.url);
    server.setBlocked(true);
    const cli = createCli({ name: "test-cli", provider, baseDir });

    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    cleanups.push(() => {
      process.stderr.write = original;
    });

    const code = await cli.run(["bun", "cli", "-p", "hello"]);
    expect(code).toBe(6);
    expect(chunks.join("")).toContain(
      'Blocked by "dummy-chat": challenge page. Try --headful.',
    );
  }, 60_000);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run build && bun test packages/cli/src/cli.e2e.test.ts`
Expected: FAIL — exit code is 1 (`EXIT_CODES["BLOCKED"]` undefined falls back to 1).

- [ ] **Step 3: Map the code and mention it in help**

In `packages/cli/src/create-cli.ts` add to `EXIT_CODES`:

```typescript
  BLOCKED: 6,
```

In `help()`, after the line `"One-shot mode prints the AI response to stdout.",` add:

```typescript
      "Exit codes: 1 usage/config, 2 not logged in, 3 auth expired, 4 timeout, 5 provider load, 6 blocked by the service (try --headful).",
```

- [ ] **Step 4: Update the README exit-code line**

In `README.md` replace:

```
Exit codes: 1 invalid argument or config, 2 not logged in, 3 auth expired,
4 response timeout, 5 provider could not be loaded. Set `CHATBRIDGE_DEBUG=1`
to print the underlying error.
```

with:

```
Exit codes: 1 invalid argument or config, 2 not logged in, 3 auth expired,
4 response timeout, 5 provider could not be loaded, 6 blocked by the
service (a bot challenge or an IdP refusing the automated browser; try
`--headful`). A timeout that coincides with a lost login is reported as 3
or 6 rather than 4. Set `CHATBRIDGE_DEBUG=1` to print the underlying error.
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/cli/src/cli.e2e.test.ts`
Expected: PASS.

- [ ] **Step 6: Check and commit**

Run: `bun run check`
Expected: PASS.

```bash
git add packages/cli/src/create-cli.ts packages/cli/src/cli.e2e.test.ts README.md
git commit -m "feat(cli): exit 6 for BlockedError; document exit codes (Refs #25)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 25 --body "Task 5 done: BLOCKED maps to exit 6, help and README list it, CLI E2E covers the blocked dummy chat. Next: TUI activity indicator (Task 6)."
```

---

### Task 6: TUI activity indicator

**Files:**
- Modify: `packages/cli/src/tui/chat-view.ts`
- Modify: `packages/cli/src/tui/chat-view.test.ts`
- Modify: `packages/cli/src/tui/run-interactive.ts`
- Modify: `packages/cli/src/tui/run-interactive.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: `ChatViewOptions.timeoutMs: number` (required); status line while busy `<frame> Thinking…  <elapsed>s / <budget>s`.

- [ ] **Step 1: Update existing tests for the new option and text**

In `packages/cli/src/tui/chat-view.test.ts`:

- In `setup()`, change the `ChatView` construction to:

  ```typescript
  const view = new ChatView(t.renderer, model, {
    title: "test-cli",
    providerName: "dummy-chat",
    timeoutMs: 2_000,
  });
  ```

- In the `error messages are labelled Error` test, add `timeoutMs: 2_000,` to its `ChatView` options as well.
- Replace every `t.frameWith("Waiting for response...")` with `t.frameWith("Thinking…")` (two occurrences).

In `packages/cli/src/tui/run-interactive.test.ts`, add `timeoutMs: 1_000,` to the `ChatView` options in the `waitForQuit` test.

- [ ] **Step 2: Write the failing indicator tests**

Append inside `describe("ChatView")` in `chat-view.test.ts`:

```typescript
  test("shows elapsed time against the timeout budget while busy", async () => {
    const t = await setup({ delayMs: 400 });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    const busy = await t.frameWith("Thinking…");
    expect(busy).toMatch(/[●○]{3} Thinking…  \ds \/ 2s/);
    await t.frameWith("Echo: hello");
    expect(t.captureCharFrame()).toContain(GUIDE);
  });

  test("the indicator animates", async () => {
    const t = await setup({ delayMs: 600 });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    const first = (await t.frameWith("Thinking…")).match(/[●○]{3}/)?.[0];
    const seen = new Set<string>([first ?? ""]);
    for (let i = 0; i < 10 && seen.size < 2; i++) {
      await sleep(60);
      await t.renderOnce();
      const frame = t.captureCharFrame().match(/[●○]{3}/)?.[0];
      if (frame) seen.add(frame);
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
    await t.frameWith("Echo: hello");
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: FAIL — `timeoutMs` is not in `ChatViewOptions` (build) and no frame contains `Thinking…`.

- [ ] **Step 4: Implement the indicator**

In `packages/cli/src/tui/chat-view.ts`:

Replace the `SPINNER` / `SPINNER_INTERVAL_MS` constants with:

```typescript
/** Three fixed cells so legacy terminals keep the line aligned. */
const FRAMES = ["●○○", "○●○", "○○●", "○●○"];
const FRAME_INTERVAL_MS = 120;
```

Extend `ChatViewOptions`:

```typescript
export interface ChatViewOptions {
  title: string;
  providerName: string;
  /** Response timeout budget shown next to the elapsed time. */
  timeoutMs: number;
}
```

Add two private fields next to `frame`:

```typescript
  private readonly budgetSec: number;
  private startedAt = 0;
```

and in the constructor, before building the tree: `this.budgetSec = Math.round(opts.timeoutMs / 1000);`

Replace `startSpinner` with:

```typescript
  private startSpinner(): void {
    if (this.spinner) return;
    this.startedAt = Date.now();
    const tick = () => {
      this.frame = (this.frame + 1) % FRAMES.length;
      const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
      this.status.content = `${FRAMES[this.frame]} Thinking…  ${elapsed}s / ${this.budgetSec}s`;
    };
    tick();
    this.spinner = setInterval(tick, FRAME_INTERVAL_MS);
  }
```

`stopSpinner`, `setStatus`, and `destroy` stay as they are. Update the class doc comment line `Layout: header / scrolling history / 4-line textarea / status line.` to add `Status line while busy: activity indicator with elapsed time against the timeout budget.`

In `packages/cli/src/tui/run-interactive.ts`, pass the budget:

```typescript
    view = new ChatView(renderer, model, {
      title: opts.title,
      providerName: opts.provider.name,
      timeoutMs: opts.timeoutMs,
    });
```

- [ ] **Step 5: Run the TUI tests to verify they pass**

Run: `bun test packages/cli/src/tui`
Expected: PASS.

- [ ] **Step 6: README**

In `README.md`, Interactive mode section, add a bullet after the Enter/Ctrl+C bullet:

```
- While a reply is pending the status line shows an activity indicator
  with the elapsed time against the `--timeout` budget, e.g.
  `○●○ Thinking…  12s / 120s`.
```

and replace the bullet `A response timeout is shown in the history and you can keep chatting. Any other failure closes the chat with exit code 1.` with:

```
- A response timeout is shown in the history and you can keep chatting.
  If the timeout turns out to be a lost login or a block, the chat closes
  with exit code 3 or 6; any other failure closes it with exit code 1.
```

- [ ] **Step 7: Check and commit**

Run: `bun run check`
Expected: PASS.

```bash
git add packages/cli/src/tui README.md
git commit -m "feat(tui): activity indicator with elapsed time against the timeout budget (Refs #25)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 25 --body "Task 6 done: status line shows '○●○ Thinking…  12s / 120s' while busy; ChatView takes timeoutMs. Next: skill trap row and roadmap wrap-up (Task 7)."
```

---

### Task 7: Skill trap row and roadmap wrap-up

**Files:**
- Modify: `.claude/skills/creating-provider-repo/SKILL.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Point the headless-challenge trap at `detectBlock`**

In `.claude/skills/creating-provider-repo/SKILL.md`, in the "Traps seen in the wild" table, replace the row starting `| Page title "Just a moment..." and \`isLoggedIn\` false; CLI says auth expired |` with:

```
| Page title "Just a moment..." and `isLoggedIn` false; CLI says auth expired | Cloudflare challenge in headless Chromium (both headless modes) | Implement `detectBlock` (framework ≥ 0.3.0): return `"challenge page"` when `document.title === "Just a moment..."`, so the CLI exits 6 and says `Try --headful`. Bot-protection evasion is out of scope (`CLAUDE.md`); record it and move on |
```

In the "Provider method contract" table add a row after `waitForResponse`:

```
| `detectBlock` (optional) | Called only after `isLoggedIn` returned false. Return a short description when the page is a bot challenge or an IdP refusal (title, a known interstitial element); return `undefined` for a normal logged-out page. Must not throw. |
```

- [ ] **Step 2: Mark the milestone done**

In `docs/ROADMAP.md` change the 3b heading from
`### 3b. Timeout diagnosis, block detection, activity indicator — in progress (issue #25)` to
`### 3b. Timeout diagnosis, block detection, activity indicator — done (issue #25, 2026-09-08)`.

- [ ] **Step 3: Check and commit**

Run: `bun run check`
Expected: PASS.

```bash
git add .claude/skills/creating-provider-repo/SKILL.md docs/ROADMAP.md
git commit -m "docs: detectBlock in the provider-repo skill; mark milestone 3b done (Refs #25)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 25 --body "Task 7 done: skill trap table and contract table mention detectBlock; ROADMAP marks 3b done. Next: whole-branch review, then PR."
```

---

## Self-review

- **Spec coverage.** §1 contract → Task 1 (+ dummy provider in Task 4). §2 errors, `assertLoggedIn`, `open` → Task 2; `send` diagnosis and the "diagnosis failure keeps the timeout" rule → Task 3; `close` untouched. Dummy chat block page → Task 4. §3 exit code 6, help → Task 5; `ChatModel` unchanged; `timeoutMs` option and indicator → Task 6. §4 table → covered by Tasks 3/5/6 tests. §5 tests: provider unit (T1), core unit open/send (T2/T3), core E2E (T4), CLI E2E (T5), view (T6). §6 README (T5/T6), skill (T7), ROADMAP done (T7). The spec's `POST /admin/block` wording is implemented as the in-process `setBlocked()` hook to match the dummy chat's existing hooks; the spec is amended in the same commit as this plan.
- **Placeholders.** None; every code step is complete.
- **Type consistency.** `assertLoggedIn(provider, page, timeoutMs)` static in T2, called the same way in T3. `BlockedError` message string identical in T2, T3, T4, T5 tests. `ChatViewOptions.timeoutMs` used in T6 tests, view, and runner. `DummyChat.setBlocked(boolean)` in T4 server, T4 E2E, T5 E2E.
