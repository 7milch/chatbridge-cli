# Message Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Enter` while a turn is in flight queues the message, the queue is listed above the input box and drained one entry per turn, and `Up` from the first line of the input takes the queue back for editing.

**Architecture:** The queue and its draining are state in `ChatModel` (no OpenTUI dependency) so the state machine is unit-tested with a fake session. `ChatView` renders `model.queue` as a bounded list between the history and the input box and intercepts `Up` for take-back. Core, runtime and provider are untouched.

**Tech Stack:** TypeScript, Bun test runner, OpenTUI (`@opentui/core`, `@opentui/core/testing` for the view tests).

**Spec:** `docs/superpowers/specs/2026-09-17-message-queue-design.md`

## Global Constraints

- Everything lives in `packages/cli/src/tui/`; never import OpenTUI into `chat-model.ts`.
- All docs, comments and commit messages in English (CLAUDE.md language policy).
- `bun run check` (Biome lint + `tsc --build` + `bun test`) must pass before every commit.
- Branch `issue-46`; after every commit post a progress comment to issue #46 with `gh issue comment 46 --body "..."` in English, ending with "What's next".
- Commit messages end with the attribution lines the session provides.
- `GUIDE` keeps its exact current text (a test pins it and its width ≤ 80 cells).
- The queue holds the trimmed typed text verbatim; `@` expansion happens only when an entry is sent.

---

### Task 1: ChatModel queues while not idle, `takeBack`

**Files:**
- Modify: `packages/cli/src/tui/chat-model.ts`
- Test: `packages/cli/src/tui/chat-model.test.ts`

**Interfaces:**
- Produces: `ChatModel.queue: readonly string[]` (arrival order), `ChatModel.takeBack(): string[]`. `submit(text)` now resolves `true` after queuing while `busy` / `resetting` / `dead`.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block at the end of `packages/cli/src/tui/chat-model.test.ts` (the helpers `fakeSession`, `noReopen`, `harness`, `tick` are defined at the top of that file):

```ts
describe("ChatModel queue", () => {
  test("submit while busy queues the text and resolves true", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session, noReopen);
    const changes: string[] = [];
    model.onChange = () => changes.push(`${model.status}:${model.queue.length}`);
    const p = model.submit("one");
    await tick();
    expect(await model.submit("  two  ")).toBe(true);
    expect(model.queue).toEqual(["two"]);
    expect(calls).toEqual(["one"]);
    expect(changes.at(-1)).toBe("busy:1");
    replies[0]?.resolve("ok");
    await p;
  });

  test("blank input is still ignored while busy", async () => {
    const { session, replies } = fakeSession();
    const model = new ChatModel(session, noReopen);
    const p = model.submit("one");
    await tick();
    expect(await model.submit("   ")).toBe(false);
    expect(model.queue).toEqual([]);
    replies[0]?.resolve("ok");
    await p;
  });

  test("submit while dead queues; nothing is sent", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session, noReopen);
    const p = model.submit("one");
    await tick();
    replies[0]?.reject(new Error("boom"));
    await p;
    expect(model.status).toBe("dead");
    expect(await model.submit("later")).toBe(true);
    expect(model.queue).toEqual(["later"]);
    expect(calls).toEqual(["one"]);
  });

  test("takeBack returns the entries in order and empties the queue", async () => {
    const { session, replies } = fakeSession();
    const model = new ChatModel(session, noReopen);
    const p = model.submit("one");
    await tick();
    await model.submit("two");
    await model.submit("three");
    let changes = 0;
    model.onChange = () => changes++;
    expect(model.takeBack()).toEqual(["two", "three"]);
    expect(model.queue).toEqual([]);
    expect(changes).toBe(1);
    expect(model.takeBack()).toEqual([]);
    expect(changes).toBe(1);
    replies[0]?.resolve("ok");
    await p;
  });
});
```

Also update the existing test `"ignores input while busy"` (around line 105): rename it to `"queues input while busy instead of sending it"` and change its assertions to

```ts
    await model.submit("two");
    expect(calls).toEqual(["one"]);
    expect(model.queue).toEqual(["two"]);
    replies[0]?.resolve("ok");
    await p;
    // Draining is Task 2; here the turn just ends with the entry waiting.
```

and leave a note that Task 2 rewrites this test. Likewise the existing test `"resolves true when accepted and false when ignored"` (line 153): keep the blank case, and change any "busy → false" expectation to `true`. The test `"submit is ignored while resetting"` (line 381): change its expectation to `true` and `expect(h.model.queue).toEqual([...])` with the submitted text. The test `"any other error is shown and stored as fatal; further input ignored"` (line 138): change the "further input ignored" part to assert the text lands in `model.queue` and `calls` is unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/tui/chat-model.test.ts`
Expected: FAIL — `model.queue` is undefined, `takeBack` is not a function.

- [ ] **Step 3: Implement the queue and takeBack**

In `packages/cli/src/tui/chat-model.ts`, add to the class after `fatal`:

```ts
  /** Messages typed while a turn was in flight (or the model was resetting
   * or dead), trimmed, in arrival order. Drained one entry per turn. */
  readonly queue: string[] = [];
```

Replace the top of `submit()`:

```ts
  /** Sends one turn, or queues the text when the model is not idle. Resolves
   * true when the message was taken (sent or queued: the view clears the
   * textarea), false when it was ignored — blank input — or blocked by a
   * mention problem, which is shown as an error entry without sending. */
  async submit(text: string): Promise<boolean> {
    const prompt = text.trim();
    if (!prompt) {
      return false;
    }
    if (this.status !== "idle") {
      this.queue.push(prompt);
      this.onChange();
      return true;
    }
    // Claim the turn before awaiting, ...
```

(the rest of the method is unchanged in this task). Add after `submit()`:

```ts
  /** Removes every queued entry and returns them in order, for the view to
   * put back into the input box. */
  takeBack(): string[] {
    if (this.queue.length === 0) return [];
    const entries = this.queue.splice(0);
    this.onChange();
    return entries;
  }
```

Update the `Status` doc comment: `busy: a turn is in flight; input is queued.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/tui/chat-model.test.ts`
Expected: PASS. `bun test packages/cli/src/tui/chat-view.test.ts` still passes unchanged: the view's `onSubmit` still refuses input while busy, so the model's new branch is not reached from the UI until Task 3.

- [ ] **Step 5: Check and commit**

```bash
bun run check
git add packages/cli/src/tui/chat-model.ts packages/cli/src/tui/chat-model.test.ts
git commit -m "feat(tui): queue messages submitted while the model is not idle (Refs #46)"
gh issue comment 46 --body "..."
```

---

### Task 2: Drain the queue one entry per turn

**Files:**
- Modify: `packages/cli/src/tui/chat-model.ts`
- Test: `packages/cli/src/tui/chat-model.test.ts`

**Interfaces:**
- Consumes: `queue`, `takeBack` from Task 1.
- Produces: no new public API. Behaviour: after a turn ends `idle` (reply or `ResponseTimeoutError`) and after a successful `reset()`, the oldest entry is sent automatically. A dequeued entry hitting `MentionError` returns to the front and draining pauses until the next turn end or reset.

- [ ] **Step 1: Write the failing tests**

Add to the `"ChatModel queue"` describe block:

```ts
  test("turn end sends the oldest entry; the next waits for the next end", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session, noReopen);
    const statuses: string[] = [];
    model.onChange = () => statuses.push(model.status);
    const p = model.submit("one");
    await tick();
    await model.submit("two");
    await model.submit("three");
    replies[0]?.resolve("r1");
    await p;
    await tick();
    expect(calls).toEqual(["one", "two"]);
    expect(model.queue).toEqual(["three"]);
    expect(model.status).toBe("busy");
    // Never idle with a queue waiting: busy stays busy across the boundary.
    expect(statuses).not.toContain("idle");
    replies[1]?.resolve("r2");
    await tick();
    await tick();
    expect(calls).toEqual(["one", "two", "three"]);
    expect(model.queue).toEqual([]);
    replies[2]?.resolve("r3");
    await tick();
    await tick();
    expect(model.status).toBe("idle");
    expect(model.messages.map((m) => m.text)).toEqual([
      "one", "r1", "two", "r2", "three", "r3",
    ]);
  });

  test("a timeout still drains the queue", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session, noReopen);
    const p = model.submit("one");
    await tick();
    await model.submit("two");
    replies[0]?.reject(new ResponseTimeoutError("slow"));
    await p;
    await tick();
    expect(calls).toEqual(["one", "two"]);
    expect(model.status).toBe("busy");
    replies[1]?.resolve("ok");
  });

  test("a mention error on a dequeued entry puts it back in front and pauses", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session, {
      ...noReopen,
      expand: async (text) => {
        if (text === "bad") throw new MentionError(["no such file"]);
        return { prompt: text, attachments: [] };
      },
    });
    const p = model.submit("one");
    await tick();
    await model.submit("bad");
    await model.submit("good");
    replies[0]?.resolve("r1");
    await p;
    await tick();
    await tick();
    expect(model.status).toBe("idle");
    expect(model.queue).toEqual(["bad", "good"]);
    expect(calls).toEqual(["one"]);
    expect(model.messages.at(-1)?.role).toBe("error");
    // The user sends something by hand; when that turn ends draining resumes
    // and hits the same entry again (once per turn end, never a loop).
    const q = model.submit("manual");
    await tick();
    replies[1]?.resolve("r2");
    await q;
    await tick();
    await tick();
    expect(calls).toEqual(["one", "manual"]);
    expect(model.queue).toEqual(["bad", "good"]);
    expect(model.messages.filter((m) => m.role === "error")).toHaveLength(2);
  });

  test("a fatal error keeps the queue and sends nothing", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session, noReopen);
    const p = model.submit("one");
    await tick();
    await model.submit("two");
    replies[0]?.reject(new Error("boom"));
    await p;
    await tick();
    expect(model.status).toBe("dead");
    expect(model.queue).toEqual(["two"]);
    expect(calls).toEqual(["one"]);
  });

  test("a successful reset drains the queue into the new session", async () => {
    const h = harness();
    const b = fakeSession("b");
    h.next.push(b);
    const p = h.model.submit("hang");
    await tick();
    await h.model.submit("queued");
    await h.model.reset();
    await tick();
    expect(h.model.status).toBe("busy");
    expect(b.calls).toEqual(["b:queued"]);
    expect(h.model.queue).toEqual([]);
    // The stale turn settles late and changes nothing.
    h.first.replies[0]?.resolve("late");
    await p;
    expect(h.model.messages.map((m) => m.role)).toEqual([
      "user", "separator", "user",
    ]);
    b.replies[0]?.resolve("ok");
  });

  test("a failed reset keeps the queue", async () => {
    const h = harness();
    h.next.push(new Error("cannot open"));
    const p = h.model.submit("hang");
    await tick();
    await h.model.submit("queued");
    await h.model.reset();
    expect(h.model.status).toBe("dead");
    expect(h.model.queue).toEqual(["queued"]);
    h.first.replies[0]?.resolve("late");
    await p;
  });
```

Rewrite the Task 1 version of `"queues input while busy instead of sending it"` so it resolves the first reply and asserts `calls` becomes `["one", "two"]` after two ticks (the draining now sends it).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/tui/chat-model.test.ts`
Expected: FAIL — `calls` stays `["one"]`, status is `idle` with a queue.

- [ ] **Step 3: Implement draining**

Restructure `chat-model.ts`: `submit()` becomes a thin guard and the turn moves into a private `runTurn(prompt, fromQueue)`. Replace `submit()` with:

```ts
  async submit(text: string): Promise<boolean> {
    const prompt = text.trim();
    if (!prompt) {
      return false;
    }
    if (this.status !== "idle") {
      this.queue.push(prompt);
      this.onChange();
      return true;
    }
    return this.runTurn(prompt, false);
  }

  /** Sends the oldest queued entry as the next turn, if any. Called at every
   * transition to idle that may continue the conversation. */
  private drain(): void {
    const next = this.queue.shift();
    if (next === undefined) return;
    void this.runTurn(next, true);
  }

  /** One turn. `fromQueue` selects what a MentionError does with the text:
   * a typed message is refilled by the view (submit resolves false), a
   * dequeued entry goes back to the front of the queue and draining pauses
   * so the same failure is not retried until the next turn end. */
  private async runTurn(prompt: string, fromQueue: boolean): Promise<boolean> {
    // Claim the turn before awaiting, so a second Enter in the same tick is
    // queued by the guard in submit() instead of racing through expansion.
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
        if (fromQueue) this.queue.unshift(prompt);
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
    // Claim the next turn before the view sees this one end, so it never
    // draws an idle frame with entries still waiting.
    if (this.status === "idle") this.drain();
    this.onChange();
    return true;
  }
```

In `runReset()`, after `this.status = "idle";` inside the `try`, add `this.drain();` (before `this.onChange()` runs at the end). The failure branch is unchanged: the queue survives in `dead`.

Note the mention-error `submit` on a dequeued entry with a typed-message race: the view's refill only triggers on a `false` from the *typed* `submit`, and `runTurn` for a queued entry is never awaited by the view, so no double refill.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/tui/chat-model.test.ts`
Expected: PASS. Run `bun test packages/cli` too; view tests must still pass.

- [ ] **Step 5: Check and commit**

```bash
bun run check
git add packages/cli/src/tui/chat-model.ts packages/cli/src/tui/chat-model.test.ts
git commit -m "feat(tui): drain the message queue one entry per turn (Refs #46)"
gh issue comment 46 --body "..."
```

---

### Task 3: ChatView lists the queue and counts it in the status row

**Files:**
- Modify: `packages/cli/src/tui/chat-view.ts`
- Test: `packages/cli/src/tui/chat-view.test.ts`

**Interfaces:**
- Consumes: `model.queue` (Task 1), draining (Task 2).
- Produces: exported `MAX_QUEUE_ROWS = 5` and `QUEUE_GUIDE = "Up take back · Ctrl+R reopen · Ctrl+C quit"`, the guide shown while the queue is not empty in both `idle` and `dead`. `onSubmit` clears the box and submits in every status.

- [ ] **Step 1: Write the failing tests**

In `chat-view.test.ts`, import `MAX_QUEUE_ROWS` and `QUEUE_GUIDE` from `./chat-view.js`, and add a describe block:

```ts
describe("ChatView queue", () => {
  /** Starts a turn that stays busy until `release` is called. */
  async function busySetup() {
    const reply = deferred<string>();
    const t = await setup({
      session: {
        async send() {
          return reply.promise;
        },
        async close() {},
        async kill() {},
      },
    });
    await t.mockInput.typeText("first");
    t.mockInput.pressEnter();
    await t.frameWith("Thinking…");
    return { ...t, release: () => reply.resolve("done") };
  }

  test("Enter while busy queues the text, clears the box and lists it above the input", async () => {
    const t = await busySetup();
    await t.mockInput.typeText("second line one\nmore");
    t.mockInput.pressEnter();
    const frame = await t.frameWith("▹ second line one");
    expect(t.model.queue).toEqual(["second line one\nmore"]);
    expect(frame).not.toContain("more");
    const rows = frame.split("\n");
    const list = rows.findIndex((r) => r.includes("▹ second line one"));
    const topRule = rows.findIndex((r, i) => i > list && r.startsWith("─"));
    expect(topRule).toBe(list + 1);
    expect(frame).toContain("· 1 queued");
    t.release();
    await t.frameWith("done");
  });

  test("shows at most MAX_QUEUE_ROWS rows, the last one a +N more line", async () => {
    const t = await busySetup();
    for (let i = 1; i <= MAX_QUEUE_ROWS + 2; i++) {
      await t.mockInput.typeText(`q${i}`);
      t.mockInput.pressEnter();
    }
    const frame = await t.frameWith("… +3 more");
    for (let i = 1; i < MAX_QUEUE_ROWS; i++) expect(frame).toContain(`▹ q${i}`);
    expect(frame).not.toContain(`▹ q${MAX_QUEUE_ROWS}`);
    expect(frame).toContain(`· ${MAX_QUEUE_ROWS + 2} queued`);
    t.release();
  });

  test("the list disappears once the queue drains", async () => {
    const t = await busySetup();
    await t.mockInput.typeText("second");
    t.mockInput.pressEnter();
    await t.frameWith("▹ second");
    t.release();
    // The fake session resolves every send with the same settled promise,
    // so the drained turn also replies "done": two replies on screen.
    let frame = "";
    for (let i = 0; i < 100; i++) {
      frame = await t.frameWith("done");
      if (frame.split("done").length - 1 >= 2) break;
    }
    expect(frame.split("done").length - 1).toBe(2);
    expect(frame).not.toContain("▹");
    expect(frame).toContain(GUIDE);
  });

  test("a dead model with a queue shows the take-back guide", async () => {
    const reply = deferred<string>();
    const t = await setup({
      session: {
        async send() {
          return reply.promise;
        },
        async close() {},
        async kill() {},
      },
    });
    await t.mockInput.typeText("first");
    t.mockInput.pressEnter();
    await t.frameWith("Thinking…");
    await t.mockInput.typeText("second");
    t.mockInput.pressEnter();
    await t.frameWith("▹ second");
    reply.reject(new Error("boom"));
    const frame = await t.frameWith("boom");
    expect(frame).toContain(QUEUE_GUIDE);
    expect(frame).not.toContain(DEAD_GUIDE);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: FAIL — `MAX_QUEUE_ROWS` not exported; no `▹` in any frame.

- [ ] **Step 3: Implement the list, the status count and the guide**

In `chat-view.ts`:

Add exports next to `DEAD_GUIDE`:

```ts
/** Idle or dead guide while queued entries are waiting. */
export const QUEUE_GUIDE = "Up take back · Ctrl+R reopen · Ctrl+C quit";
/** Rows the queue list may take; a longer queue ends with a "+N more" row. */
export const MAX_QUEUE_ROWS = 5;
```

Add a field `private readonly queueList: BoxRenderable;`. In the constructor, after `root.add(this.body);` and the banner/history setup but **before** `const inputBox = ...`, create it:

```ts
    this.queueList = new BoxRenderable(renderer, {
      id: "queue",
      flexDirection: "column",
      flexShrink: 0,
      visible: false,
    });
    root.add(this.queueList);
```

Add a method:

```ts
  /** Rebuilds the queue rows from the model; the list is at most
   * MAX_QUEUE_ROWS tall, so rebuilding beats diffing. */
  private renderQueue(): void {
    for (const child of [...this.queueList.getChildren()]) {
      this.queueList.remove(child.id);
    }
    const entries = this.model.queue;
    this.queueList.visible = entries.length > 0;
    if (entries.length === 0) return;
    const overflow = entries.length > MAX_QUEUE_ROWS;
    const shown = overflow ? MAX_QUEUE_ROWS - 1 : entries.length;
    for (const entry of entries.slice(0, shown)) {
      const firstLine = entry.split("\n")[0] ?? "";
      this.queueList.add(
        new TextRenderable(this.renderer, {
          content: styled(theme.muted(`▹ ${firstLine}`)),
          wrapMode: "none",
        }),
      );
    }
    if (overflow) {
      this.queueList.add(
        new TextRenderable(this.renderer, {
          content: styled(theme.muted(`… +${entries.length - shown} more`)),
          wrapMode: "none",
        }),
      );
    }
  }
```

Check the actual OpenTUI child-enumeration API before relying on `getChildren()` / `remove(id)`: run `grep -n "getChildren\|remove(" node_modules/@opentui/core/dist/Renderable.d.ts` from `packages/cli` and use whatever removes a child by id or reference. `MentionPopup` in `mention-popup.ts` already rebuilds rows; mirror its approach.

In `update()`, call `this.renderQueue();` right after the message loop and before `if (this.statusPinned) return;`. Change the `switch`:

```ts
      case "dead":
        this.stopSpinner();
        this.status.content = styled(
          theme.errorText(this.model.queue.length > 0 ? QUEUE_GUIDE : DEAD_GUIDE),
        );
        break;
      default:
        this.stopSpinner();
        this.status.content = styled(
          theme.muted(this.model.queue.length > 0 ? QUEUE_GUIDE : GUIDE),
        );
```

In `startSpinner()`'s `tick`, append the count:

```ts
      const queued =
        this.model.queue.length > 0 ? `  · ${this.model.queue.length} queued` : "";
      this.status.content = `${FRAMES[this.frame]} Thinking…  ${elapsed}s / ${this.budgetSec}s${queued}`;
```

Since the spinner only redraws on its interval, `update()` also needs the count to refresh when an entry is queued while busy: in the `"busy"` case call `this.startSpinner()` as today (it is a no-op when running); the next interval tick (120 ms) picks up the new count, which is fine.

Change `onSubmit` so only blank input is refused:

```ts
    this.input.onSubmit = () => {
      const text = this.input.plainText;
      // Blank input is the one case ChatModel.submit drops synchronously;
      // anything else is sent or queued, so the box is cleared.
      if (!text.trim()) {
        return;
      }
      this.input.clear();
      this.fitInput();
      // A mention problem on a typed message is only known after expansion,
      // and the box is empty by then; put the text back so the user can fix
      // it. A queued entry that fails goes back to the queue instead.
      void this.model.submit(text).then((accepted) => {
        // Trade-off: anything typed during expansion wins over the refill.
        if (!accepted && !this.torn && !this.input.plainText) {
          this.input.insertText(text);
          this.fitInput();
        }
      });
    };
```

Rewrite the existing test `"Enter while busy keeps the typed text"` as `"Enter while busy queues the text"`: after pressing Enter on "second", assert `t.model.queue` equals `["second"]` and that the frame after `Echo: first` contains `Echo: second`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: PASS, including the existing layout tests (`the popup sits between the input and the status row`, banner tests): the hidden queue box must take no rows. If a hidden `BoxRenderable` still takes a row, use `height: 0` while empty or remove it from `root` and re-add it before `inputBox` (keep a reference to `root` and use `root.insertBefore`, checking the API as above).

- [ ] **Step 5: Check and commit**

```bash
bun run check
git add packages/cli/src/tui/chat-view.ts packages/cli/src/tui/chat-view.test.ts
git commit -m "feat(tui): list queued messages above the input and count them in the status row (Refs #46)"
gh issue comment 46 --body "..."
```

---

### Task 4: `Up` take-back, README

**Files:**
- Modify: `packages/cli/src/tui/chat-view.ts` (`handleKey`)
- Modify: `README.md:94-103` (interactive-mode key list)
- Test: `packages/cli/src/tui/chat-view.test.ts`

**Interfaces:**
- Consumes: `model.takeBack()` (Task 1), the queue list (Task 3).

- [ ] **Step 1: Write the failing tests**

Add to the `"ChatView queue"` describe block (uses `busySetup` from Task 3):

```ts
  test("Up on the first line takes the queue back ahead of the typed text", async () => {
    const t = await busySetup();
    await t.mockInput.typeText("second");
    t.mockInput.pressEnter();
    await t.mockInput.typeText("third");
    t.mockInput.pressEnter();
    await t.frameWith("▹ third");
    await t.mockInput.typeText("typed");
    t.mockInput.pressArrow("up");
    await t.renderOnce();
    expect(t.model.queue).toEqual([]);
    expect(t.view.inputText).toBe("second\nthird\ntyped");
    const frame = t.captureCharFrame();
    expect(frame).not.toContain("▹");
    // Enter re-queues the whole box as one entry.
    t.mockInput.pressEnter();
    await t.frameWith("▹ second");
    expect(t.model.queue).toEqual(["second\nthird\ntyped"]);
    t.release();
  });

  test("Up with an empty box takes the queue back without a trailing newline", async () => {
    const t = await busySetup();
    await t.mockInput.typeText("second");
    t.mockInput.pressEnter();
    await t.frameWith("▹ second");
    t.mockInput.pressArrow("up");
    await t.renderOnce();
    expect(t.view.inputText).toBe("second");
    t.release();
  });

  test("Up on the second line does not take the queue back", async () => {
    const t = await busySetup();
    await t.mockInput.typeText("second");
    t.mockInput.pressEnter();
    await t.frameWith("▹ second");
    await t.mockInput.typeText("a");
    t.mockInput.pressKey("LINEFEED");
    await t.mockInput.typeText("b");
    t.mockInput.pressArrow("up");
    await t.renderOnce();
    expect(t.model.queue).toEqual(["second"]);
    expect(t.view.inputText).toBe("a\nb");
    t.release();
  });

  test("Up with an empty queue reaches the textarea", async () => {
    const t = await setup();
    await t.mockInput.typeText("a");
    t.mockInput.pressKey("LINEFEED");
    await t.mockInput.typeText("b");
    t.mockInput.pressArrow("up");
    await t.mockInput.typeText("X");
    await t.renderOnce();
    expect(t.view.inputText).toBe("aX\nb");
  });
```

These read the textarea through a test-only accessor. Add to `ChatView`:

```ts
  /** Test hook: the textarea's current text. */
  get inputText(): string {
    return this.input.plainText;
  }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: FAIL — `inputText` undefined / queue not taken back.

- [ ] **Step 3: Implement take-back**

In `handleKey`, after the Ctrl+R case and before `if (!this.popup.visible) return;`:

```ts
    if (
      key.name === "up" &&
      !this.popup.visible &&
      this.model.queue.length > 0 &&
      this.onFirstLine()
    ) {
      key.preventDefault();
      this.takeBack();
      return;
    }
```

Add the helpers:

```ts
  /** True when the cursor sits on the first logical line of the textarea. */
  private onFirstLine(): boolean {
    const before = this.input.plainText.slice(0, this.input.cursorOffset);
    return !before.includes("\n");
  }

  /** Moves every queued entry into the input box, one per line, ahead of
   * the typed text. Enter then queues (or sends) the box as one entry. */
  private takeBack(): void {
    const entries = this.model.takeBack();
    if (entries.length === 0) return;
    const typed = this.input.plainText;
    const text = typed ? `${entries.join("\n")}\n${typed}` : entries.join("\n");
    this.input.clear();
    this.input.insertText(text);
    this.fitInput();
  }
```

If `insertText` of a multi-line string does not produce newlines in `plainText` (check with the test), insert line by line using the textarea's newline action or `insertText("\n")` between lines. Because `clear()` + `insertText()` leaves the cursor at the end of the whole text rather than after the entries, that is acceptable per the spec ("the cursor ends up after the inserted text"); do not fight the textarea API for a cursor position.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli`
Expected: PASS.

- [ ] **Step 5: Update README**

In `README.md`, in the interactive-mode list after the **Ctrl+R** bullet, add:

```markdown
- **Enter while a reply is pending** queues the message instead of dropping
  it. Queued messages are listed above the input box and sent one per turn,
  oldest first, once the current reply arrives (also after a Ctrl+R reopen).
  **Up** from the first line of the input takes the whole queue back into the
  box, one message per line, ahead of anything you have typed; Enter then
  queues the box again as one message, and clearing it drops them.
```

- [ ] **Step 6: Check and commit**

```bash
bun run check
git add packages/cli/src/tui/chat-view.ts packages/cli/src/tui/chat-view.test.ts README.md
git commit -m "feat(tui): Up takes the message queue back into the input box (Refs #46)"
gh issue comment 46 --body "..."
```

---

### Task 5: Whole-branch review and PR

- [ ] **Step 1:** Run `bun run check` once more on the branch; run the interactive mode by hand against the dummy provider (`bun run packages/cli/src/bin.ts` or the documented dev command) and verify: queue while busy, list rendering, `+N more`, take-back, re-queue, Ctrl+R with a queue.
- [ ] **Step 2:** Whole-branch review with a Fable subagent per CLAUDE.md model policy; fix findings with small commits.
- [ ] **Step 3:** Mark milestone 9 done in `docs/ROADMAP.md` (`— done (issue #46, PR #N, 2026-09-17)`), commit, open the PR with `gh pr create` (English body, attribution footer), and post the final issue comment.
