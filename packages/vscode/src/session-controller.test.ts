import { describe, expect, test } from "bun:test";
import {
  AuthExpiredError,
  AuthRequiredError,
  BlockedError,
  BrowserUnavailableError,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  type ProviderCommandResult,
  ResponseTimeoutError,
  UrlHookError,
} from "@chatbridge/core";
import {
  type ChatSessionLike,
  IDLE_CLOSED_SEPARATOR,
  REOPENED_SEPARATOR,
  SessionController,
  type SessionControllerOptions,
} from "./session-controller.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  controller: SessionController;
  sent: string[];
  replies: Array<ReturnType<typeof deferred<string>>>;
  opens: number;
  closed: number;
  killed: number;
  openError?: Error;
  closeHangs: boolean;
  states: string[];
  commands: Array<{ name: string; args: string }>;
  commandResults: Array<ReturnType<typeof deferred<ProviderCommandResult>>>;
}

/** The fake ChatSession every harness hands out, wired to the counters.
 * close/kill are idempotent, like the real ChatSession's. */
function sessionOf(h: Harness): ChatSessionLike {
  let done = false;
  return {
    async send(prompt) {
      h.sent.push(prompt);
      const d = deferred<string>();
      h.replies.push(d);
      return d.promise;
    },
    async runCommand(name, args) {
      h.commands.push({ name, args });
      const d = deferred<ProviderCommandResult>();
      h.commandResults.push(d);
      return d.promise;
    },
    close: () =>
      h.closeHangs
        ? new Promise<void>(() => {})
        : Promise.resolve().then(() => {
            if (done) return;
            done = true;
            h.closed++;
          }),
    async kill() {
      if (done) return;
      done = true;
      h.killed++;
    },
  };
}

function harness(opts: Partial<SessionControllerOptions> = {}): Harness {
  const h = {
    sent: [],
    replies: [],
    opens: 0,
    closed: 0,
    killed: 0,
    closeHangs: false,
    states: [],
    commands: [],
    commandResults: [],
  } as unknown as Harness;
  const session = sessionOf(h);
  h.controller = new SessionController({
    openSession: async () => {
      h.opens++;
      if (h.openError) throw h.openError;
      return session;
    },
    closeTimeoutMs: 20,
    onChange: (s) => h.states.push(s.status),
    ...opts,
  });
  return h;
}

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
}

/** Waits until `cond` holds, so a test observes a real state change instead
 * of a fixed number of turns of the event loop. */
async function waitFor(cond: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await settle();
  }
  throw new Error("waitFor: condition never became true");
}

describe("SessionController", () => {
  test("starts closed with an empty history", () => {
    const h = harness();
    expect(h.controller.getState()).toEqual({
      status: "closed",
      messages: [],
      pendingAttachments: [],
      queue: [],
    });
    expect(h.opens).toBe(0);
  });

  test("first send opens lazily, records user and assistant messages", async () => {
    const h = harness();
    const p = h.controller.send("hello");
    await settle();
    expect(h.opens).toBe(1);
    expect(h.controller.getState().status).toBe("busy");
    h.replies[0].resolve("Echo: hello");
    expect(await p).toEqual({ ok: true });
    const s = h.controller.getState();
    expect(s.status).toBe("idle");
    expect(s.messages).toEqual([
      { role: "user", text: "hello", attachments: [] },
      { role: "assistant", text: "Echo: hello" },
    ]);
    // The user entry is pushed (emit while still closed) before opening.
    expect(h.states).toEqual(["closed", "opening", "busy", "idle"]);
  });

  test("second send reuses the session", async () => {
    const h = harness();
    const p1 = h.controller.send("a");
    await settle();
    h.replies[0].resolve("1");
    await p1;
    const p2 = h.controller.send("b");
    await settle();
    h.replies[1].resolve("2");
    await p2;
    expect(h.opens).toBe(1);
    expect(h.sent).toEqual(["a", "b"]);
  });

  test("send while busy is queued, not sent to the session", async () => {
    const h = harness();
    const p = h.controller.send("a");
    await settle();
    expect(await h.controller.send("b")).toEqual({ ok: true, queued: true });
    expect(h.sent).toEqual(["a"]);
    h.replies[0].resolve("1");
    await p;
    await settle();
    expect(h.sent).toEqual(["a", "b"]);
  });

  test("attachments are appended in the CLI format and cleared after send", async () => {
    const h = harness();
    expect(
      h.controller.addAttachment({
        path: "src/a.ts",
        bytes: 3,
        content: "x=1",
      }),
    ).toEqual({ ok: true });
    const p = h.controller.send("look");
    await settle();
    expect(h.sent[0]).toBe("look\n\n### src/a.ts\n```ts\nx=1\n```");
    expect(h.controller.getState().pendingAttachments).toEqual([]);
    expect(h.controller.getState().messages[0]).toEqual({
      role: "user",
      text: "look",
      attachments: [{ path: "src/a.ts", bytes: 3 }],
    });
    h.replies[0].resolve("ok");
    await p;
  });

  test("attachment-only send has no leading blank lines", async () => {
    const h = harness();
    h.controller.addAttachment({ path: "a.md", bytes: 2, content: "hi" });
    const p = h.controller.send("");
    await settle();
    expect(h.sent[0]).toBe("### a.md\n```md\nhi\n```");
    h.replies[0].resolve("ok");
    await p;
  });

  test("empty send with no attachments is a no-op", async () => {
    const h = harness();
    expect(await h.controller.send("   ")).toEqual({
      ok: false,
      code: "EMPTY",
      message: "Nothing to send.",
    });
    expect(h.opens).toBe(0);
  });

  test("addAttachment enforces per-file and total limits", () => {
    const h = harness();
    const big = "x".repeat(200 * 1024 + 1);
    expect(
      h.controller.addAttachment({
        path: "big",
        bytes: big.length,
        content: big,
      }),
    ).toEqual({ ok: false, reason: "big: 201 KB exceeds 200 KB" });
    const chunk = "y".repeat(200 * 1024);
    for (let i = 0; i < 5; i++) {
      h.controller.addAttachment({
        path: `c${i}`,
        bytes: chunk.length,
        content: chunk,
      });
    }
    // 5 × 200 KiB fits under 1 MiB; a sixth (1.2 MB) does not.
    expect(
      h.controller.addAttachment({
        path: "c5",
        bytes: chunk.length,
        content: chunk,
      }),
    ).toEqual({ ok: false, reason: "attachments total 1.2 MB exceeds 1 MB" });
    expect(h.controller.getState().pendingAttachments).toHaveLength(5);
  });

  test("removeAttachment drops one entry; out-of-range is ignored", () => {
    const h = harness();
    h.controller.addAttachment({ path: "a", bytes: 1, content: "a" });
    h.controller.addAttachment({ path: "b", bytes: 1, content: "b" });
    h.controller.removeAttachment(0);
    h.controller.removeAttachment(7);
    expect(h.controller.getState().pendingAttachments).toEqual([
      { path: "b", bytes: 1 },
    ]);
  });

  test("a response timeout records an error and keeps the session", async () => {
    const h = harness();
    const p = h.controller.send("slow");
    await settle();
    h.replies[0].reject(
      new ResponseTimeoutError("Timed out during waitForResponse after 1 ms."),
    );
    expect(await p).toEqual({
      ok: false,
      code: "RESPONSE_TIMEOUT",
      message: "Timed out during waitForResponse after 1 ms.",
    });
    const s = h.controller.getState();
    expect(s.status).toBe("idle");
    expect(s.lastError).toBeUndefined();
    expect(s.messages[1]).toEqual({
      role: "error",
      text: "Timed out during waitForResponse after 1 ms.",
    });
    expect(h.closed).toBe(0);
  });

  test("auth expired during a turn closes the session and goes dead", async () => {
    const h = harness();
    const p = h.controller.send("x");
    await settle();
    h.replies[0].reject(new AuthExpiredError("Session expired."));
    expect(await p).toEqual({
      ok: false,
      code: "AUTH_EXPIRED",
      message: "Session expired.",
    });
    const s = h.controller.getState();
    expect(s.status).toBe("dead");
    expect(s.lastError).toBe("AUTH_EXPIRED");
    expect(h.closed).toBe(1);
  });

  test("open failure goes dead without a session to close", async () => {
    const h = harness();
    h.openError = new AuthRequiredError("Not logged in.");
    expect(await h.controller.send("x")).toEqual({
      ok: false,
      code: "AUTH_REQUIRED",
      message: "Not logged in.",
    });
    expect(h.controller.getState().status).toBe("dead");
    expect(h.controller.getState().messages).toEqual([
      { role: "user", text: "x", attachments: [] },
      { role: "error", text: "Not logged in." },
    ]);
    expect(h.closed).toBe(0);
  });

  test("a non-framework error is reported with code UNKNOWN", async () => {
    const h = harness();
    h.openError = new Error("boom");
    expect(await h.controller.send("x")).toEqual({
      ok: false,
      code: "UNKNOWN",
      message: "boom",
    });
    expect(h.controller.getState().lastError).toBe("UNKNOWN");
  });

  test("retryLast after a dead open re-sends the same prompt without a new user entry", async () => {
    const h = harness();
    h.openError = new BrowserUnavailableError(
      "Chromium is not installed (expected at /x).",
    );
    h.controller.addAttachment({ path: "a", bytes: 1, content: "a" });
    await h.controller.send("again");
    h.openError = undefined;
    const p = h.controller.retryLast();
    await settle();
    expect(h.sent).toEqual(["again\n\n### a\n```\na\n```"]);
    h.replies[0].resolve("done");
    expect(await p).toEqual({ ok: true });
    const texts = h.controller
      .getState()
      .messages.map((m) => `${m.role}:${m.text}`);
    expect(texts).toEqual(["user:again", "assistant:done"]);
    expect(h.controller.getState().lastError).toBeUndefined();
  });

  test("retryLast with nothing to retry is EMPTY", async () => {
    const h = harness();
    expect(await h.controller.retryLast()).toEqual({
      ok: false,
      code: "EMPTY",
      message: "Nothing to send.",
    });
  });

  test("newChat closes the session, adds a separator and reopens on the next send", async () => {
    const h = harness();
    const p = h.controller.send("a");
    await settle();
    h.replies[0].resolve("1");
    await p;
    await h.controller.newChat();
    expect(h.closed).toBe(1);
    const s = h.controller.getState();
    expect(s.status).toBe("closed");
    expect(s.messages.at(-1)).toEqual({ role: "separator", text: "New chat" });
    const p2 = h.controller.send("b");
    await settle();
    expect(h.opens).toBe(2);
    h.replies[1].resolve("2");
    await p2;
  });

  test("newChat kills a session whose close hangs", async () => {
    const h = harness();
    const p = h.controller.send("a");
    await settle();
    h.replies[0].resolve("1");
    await p;
    h.closeHangs = true;
    await h.controller.newChat();
    expect(h.killed).toBe(1);
    expect(h.closed).toBe(0);
    expect(h.controller.getState().status).toBe("closed");
  });

  test("newChat from dead clears lastError; newChat while closed only adds the separator", async () => {
    const h = harness();
    h.openError = new AuthRequiredError("no");
    await h.controller.send("x");
    await h.controller.newChat();
    expect(h.controller.getState().lastError).toBeUndefined();
    expect(h.controller.getState().status).toBe("closed");
    expect(h.closed).toBe(0);
  });

  test("newChat while busy is refused", async () => {
    const h = harness();
    const p = h.controller.send("a");
    await settle();
    const before = h.controller.getState().messages.length;
    expect(await h.controller.newChat()).toBe(false);
    expect(h.controller.getState().status).toBe("busy");
    expect(h.closed).toBe(0);
    // No separator was appended.
    expect(h.controller.getState().messages).toHaveLength(before);
    h.replies[0].resolve("1");
    await p;
  });

  test("markLoggedIn from dead returns to closed with a separator", async () => {
    const h = harness();
    h.openError = new AuthRequiredError("no");
    await h.controller.send("x");
    h.controller.markLoggedIn();
    const s = h.controller.getState();
    expect(s.status).toBe("closed");
    expect(s.lastError).toBeUndefined();
    expect(s.messages.at(-1)).toEqual({ role: "separator", text: "Logged in" });
  });

  test("discard closes the session and adds the given separator", async () => {
    const h = harness();
    const p = h.controller.send("a");
    await settle();
    h.replies[0].resolve("1");
    await p;
    await h.controller.discard("Logged out");
    expect(h.closed).toBe(1);
    expect(h.controller.getState().status).toBe("closed");
    expect(h.controller.getState().messages.at(-1)).toEqual({
      role: "separator",
      text: "Logged out",
    });
  });

  test("discard returns false while a turn is in flight, true otherwise", async () => {
    const h = harness();
    const p = h.controller.send("a");
    await settle();
    expect(await h.controller.discard("Logged out")).toBe(false);
    expect(h.closed).toBe(0);
    h.replies[0].resolve("1");
    await p;
    expect(await h.controller.discard("Logged out")).toBe(true);
    expect(h.closed).toBe(1);
  });

  test("a hint for the error code is appended to the history entry", async () => {
    const h = harness();
    const controller = new SessionController({
      openSession: async () => {
        throw h.openError as Error;
      },
      closeTimeoutMs: 20,
      hints: { BLOCKED: 'Set the "acme.headless" setting to false.' },
    });
    h.openError = new BlockedError('Blocked by "acme": challenge.');
    await controller.send("x");
    expect(controller.getState().messages.at(-1)).toEqual({
      role: "error",
      text: 'Blocked by "acme": challenge.\nSet the "acme.headless" setting to false.',
    });
    h.openError = new AuthRequiredError("no auth");
    await controller.retryLast();
    expect(controller.getState().messages.at(-1)).toEqual({
      role: "error",
      text: "no auth",
    });
  });

  test("a successful send after a dead open clears lastError", async () => {
    const h = harness();
    h.openError = new AuthRequiredError("no");
    await h.controller.send("x");
    expect(h.controller.getState().lastError).toBe("AUTH_REQUIRED");
    h.openError = undefined;
    const p = h.controller.send("y");
    await settle();
    h.replies[0].resolve("hi");
    expect(await p).toEqual({ ok: true });
    const s = h.controller.getState();
    expect(s.status).toBe("idle");
    expect(s.lastError).toBeUndefined();
    expect(s.messages.at(-1)).toEqual({ role: "assistant", text: "hi" });
  });

  test("retryLast after newChat is EMPTY: a break drops the last prompt", async () => {
    const h = harness();
    const p = h.controller.send("a");
    await settle();
    h.replies[0].resolve("1");
    await p;
    await h.controller.newChat();
    expect(await h.controller.retryLast()).toEqual({
      ok: false,
      code: "EMPTY",
      message: "Nothing to send.",
    });
    expect(h.sent).toEqual(["a"]);
  });

  test("getState copies the attachments array of a user entry", async () => {
    const h = harness();
    h.controller.addAttachment({ path: "a", bytes: 1, content: "a" });
    const p = h.controller.send("look");
    await settle();
    const first = h.controller.getState().messages[0];
    first.attachments?.push({ path: "sneaky", bytes: 9 });
    expect(h.controller.getState().messages[0].attachments).toEqual([
      { path: "a", bytes: 1 },
    ]);
    h.replies[0].resolve("ok");
    await p;
  });

  test("close closes an open session and leaves the history alone", async () => {
    const h = harness();
    const p = h.controller.send("a");
    await settle();
    h.replies[0].resolve("1");
    await p;
    const before = h.controller.getState().messages.length;
    await h.controller.close();
    expect(h.closed).toBe(1);
    expect(h.controller.getState().messages).toHaveLength(before);
    await h.controller.close();
    expect(h.closed).toBe(1);
  });

  test("close during a reopen closes the browser the reopen opens", async () => {
    const open = deferred<ChatSessionLike>();
    let closedLate = 0;
    let lateDone = false;
    // Idempotent, like the real ChatSession: dropSession and the reopen's
    // own generation check may both close it.
    const late: ChatSessionLike = {
      send: async () => "x",
      close: async () => {
        if (lateDone) return;
        lateDone = true;
        closedLate++;
      },
      kill: async () => {
        if (lateDone) return;
        lateDone = true;
        closedLate++;
      },
    };
    const controller = new SessionController({
      openSession: () => open.promise,
      closeTimeoutMs: 20,
    });
    const reopen = controller.reopen();
    await settle();
    // close() waits for the open in flight rather than orphaning it.
    const close = controller.close();
    await settle();
    open.resolve(late);
    await Promise.all([reopen, close]);
    expect(controller.getState().status).toBe("closed");
    expect(closedLate).toBe(1);
    const state = controller.getState();
    expect(state.status).toBe("closed");
    expect(state.messages).toEqual([]);
  });
});

describe("queue", () => {
  test("send while busy queues and drains in order after the reply", async () => {
    const h = harness();
    const first = h.controller.send("one");
    await settle();
    expect(h.controller.getState().status).toBe("busy");
    expect(await h.controller.send("two")).toEqual({ ok: true, queued: true });
    expect(await h.controller.send("three")).toEqual({
      ok: true,
      queued: true,
    });
    expect(h.controller.getState().queue.map((e) => e.text)).toEqual([
      "two",
      "three",
    ]);
    h.replies[0]?.resolve("r1");
    expect(await first).toEqual({ ok: true });
    await settle();
    // The next turn was claimed before the idle frame.
    expect(h.controller.getState().status).toBe("busy");
    expect(h.controller.getState().queue.map((e) => e.text)).toEqual(["three"]);
    expect(h.sent).toEqual(["one", "two"]);
    h.replies[1]?.resolve("r2");
    await settle();
    h.replies[2]?.resolve("r3");
    await settle();
    expect(h.sent).toEqual(["one", "two", "three"]);
    expect(h.controller.getState().status).toBe("idle");
    expect(h.controller.getState().queue).toEqual([]);
  });

  test("a queued entry carries the pending attachments", async () => {
    const h = harness();
    const first = h.controller.send("one");
    await settle();
    h.controller.addAttachment({ path: "a.ts", bytes: 3, content: "abc" });
    await h.controller.send("two");
    const s = h.controller.getState();
    expect(s.pendingAttachments).toEqual([]);
    expect(s.queue[0]?.attachments).toEqual([{ path: "a.ts", bytes: 3 }]);
    h.replies[0]?.resolve("r1");
    await first;
    await settle();
    expect(h.sent[1]).toContain("abc");
    const user = h.controller.getState().messages.find((m) => m.text === "two");
    expect(user?.attachments).toEqual([{ path: "a.ts", bytes: 3 }]);
  });

  test("blank text with no attachments is EMPTY even while busy", async () => {
    const h = harness();
    void h.controller.send("one");
    await settle();
    expect((await h.controller.send("  ")).ok).toBe(false);
    expect(h.controller.getState().queue).toEqual([]);
  });

  test("a fatal error stops draining; the queue survives newChat and drains after it", async () => {
    const h = harness();
    const first = h.controller.send("one");
    await settle();
    await h.controller.send("two");
    h.replies[0]?.reject(new Error("page closed"));
    await first;
    expect(h.controller.getState().status).toBe("dead");
    expect(h.controller.getState().queue.map((e) => e.text)).toEqual(["two"]);
    expect(h.sent).toEqual(["one"]);
    await h.controller.newChat();
    await settle();
    expect(h.sent).toEqual(["one", "two"]);
  });

  test("takeBack returns the entries with attachments restored as pending", async () => {
    const h = harness();
    void h.controller.send("one");
    await settle();
    h.controller.addAttachment({ path: "a.ts", bytes: 3, content: "abc" });
    await h.controller.send("two");
    await h.controller.send("three");
    const { entries } = h.controller.takeBack();
    expect(entries.map((e) => e.text)).toEqual(["two", "three"]);
    const s = h.controller.getState();
    expect(s.queue).toEqual([]);
    expect(s.pendingAttachments).toEqual([{ path: "a.ts", bytes: 3 }]);
    expect(h.controller.takeBack()).toEqual({
      entries: [],
      droppedAttachments: 0,
    });
  });

  test("close() during opening waits for the open and closes that session", async () => {
    const h = harness();
    const gate = deferred<void>();
    h.controller = new SessionController({
      openSession: async () => {
        await gate.promise;
        h.opens++;
        return sessionOf(h);
      },
      closeTimeoutMs: 20,
    });
    const send = h.controller.send("hi");
    await settle();
    const close = h.controller.close();
    gate.resolve();
    // close() alone must not resolve before the browser it waited for is
    // shut down, or deactivate would leave one running.
    await close;
    expect(h.opens).toBe(1);
    expect(h.closed).toBe(1);
    expect(h.controller.getState().status).toBe("closed");
    await send;
    expect(h.closed + h.killed).toBe(1);
  });

  test("a drained send that hits a missing browser shows the install hint", async () => {
    const h = harness({
      hints: { BROWSER_UNAVAILABLE: "Run Install Browser." },
    });
    h.openError = new BrowserUnavailableError("no chromium");
    await h.controller.send("hi");
    await settle();
    const last = h.controller.getState().messages.at(-1);
    expect(last?.role).toBe("error");
    expect(last?.text).toBe("no chromium\nRun Install Browser.");
  });

  test("takeBack drops attachments that would exceed the total cap", async () => {
    const h = harness();
    void h.controller.send("first"); // busy; never settles
    await settle();
    // Five max-size files fit under the total cap on their own...
    for (let i = 0; i < 5; i++) {
      expect(
        h.controller.addAttachment({
          path: `a${i}`,
          bytes: MAX_FILE_BYTES,
          content: "x",
        }).ok,
      ).toBe(true);
    }
    await h.controller.send("queued-with-big"); // queued, takes all five
    // ...but not on top of a sixth already in the composer.
    expect(
      h.controller.addAttachment({
        path: "b",
        bytes: MAX_FILE_BYTES,
        content: "y",
      }).ok,
    ).toBe(true);
    const r = h.controller.takeBack();
    expect(r.entries.map((e) => e.text)).toEqual(["queued-with-big"]);
    expect(r.droppedAttachments).toBe(1);
    expect(
      h.controller.getState().pendingAttachments.map((a) => a.path),
    ).toEqual(["b", "a0", "a1", "a2", "a3"]);
    expect(MAX_FILE_BYTES * 6).toBeGreaterThan(MAX_TOTAL_BYTES);
  });

  test("removeQueued(-1) is ignored", async () => {
    const h = harness();
    void h.controller.send("first"); // busy; never settles
    await settle();
    await h.controller.send("second");
    h.controller.removeQueued(-1);
    expect(h.controller.getState().queue).toHaveLength(1);
  });

  test("takeBack while dead returns the queue and stays dead", async () => {
    const h = harness();
    h.openError = new AuthRequiredError("login");
    await h.controller.send("a");
    await settle();
    expect(h.controller.getState().status).toBe("dead");
    // A dead controller can still start a turn, so this send runs (and
    // fails) rather than queueing.
    await h.controller.send("b");
    await settle();
    // Both failed; the queue is empty; takeBack is a no-op that keeps `dead`.
    expect(h.controller.takeBack()).toEqual({
      entries: [],
      droppedAttachments: 0,
    });
    expect(h.controller.getState().status).toBe("dead");
  });

  test("reopen with an empty queue while idle just marks the break", async () => {
    const h = harness();
    const first = h.controller.send("hi");
    await settle();
    h.replies[0]?.resolve("ok");
    await first;
    await h.controller.reopen();
    const roles = h.controller.getState().messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "separator"]);
    expect(h.controller.getState().status).toBe("idle");
    expect(h.opens).toBe(2);
  });

  test("markLoggedIn while busy does not start a second turn", async () => {
    const h = harness();
    const first = h.controller.send("one");
    await settle();
    await h.controller.send("two");
    h.controller.markLoggedIn();
    await settle();
    expect(h.controller.getState().status).toBe("busy");
    expect(h.sent).toEqual(["one"]);
    expect(h.controller.getState().queue.map((e) => e.text)).toEqual(["two"]);
    h.replies[0]?.resolve("r1");
    await first;
    await settle();
    expect(h.sent).toEqual(["one", "two"]);
  });

  test("a direct send while dead queues behind the entries already waiting", async () => {
    const h = harness();
    const first = h.controller.send("one");
    await settle();
    await h.controller.send("two");
    h.replies[0]?.reject(new Error("page closed"));
    await first;
    expect(h.controller.getState().status).toBe("dead");
    expect(await h.controller.send("three")).toEqual({
      ok: true,
      queued: true,
    });
    await settle();
    expect(h.sent).toEqual(["one", "two"]);
    expect(h.controller.getState().queue.map((e) => e.text)).toEqual(["three"]);
  });

  test("removeQueued drops one entry and ignores bad indexes", async () => {
    const h = harness();
    void h.controller.send("one");
    await settle();
    await h.controller.send("two");
    await h.controller.send("three");
    h.controller.removeQueued(5);
    h.controller.removeQueued(0);
    expect(h.controller.getState().queue.map((e) => e.text)).toEqual(["three"]);
  });
});

describe("reopen", () => {
  test("mid-turn: the old result is dropped, history marked, queue drained", async () => {
    const h = harness();
    const first = h.controller.send("one");
    await settle();
    await h.controller.send("two");
    const reopen = h.controller.reopen();
    expect(h.controller.getState().status).toBe("reopening");
    await reopen;
    // The abandoned send settles late; nothing from it is recorded.
    h.replies[0]?.resolve("stale");
    expect(await first).toEqual({ ok: true });
    await settle();
    const s = h.controller.getState();
    expect(s.messages.some((m) => m.text === "stale")).toBe(false);
    expect(
      s.messages.some((m) => m.role === "separator" && m.text === "reopened"),
    ).toBe(true);
    expect(h.opens).toBe(2);
    expect(h.killed + h.closed).toBeGreaterThan(0);
    expect(h.sent).toEqual(["one", "two"]);
    expect(s.status).toBe("busy");
  });

  test("from dead: clears lastError and drops the error banner state", async () => {
    const h = harness();
    const first = h.controller.send("one");
    await settle();
    h.replies[0]?.reject(new Error("page closed"));
    await first;
    expect(h.controller.getState().lastError).toBe("UNKNOWN");
    await h.controller.reopen();
    const s = h.controller.getState();
    expect(s.status).toBe("idle");
    expect(s.lastError).toBeUndefined();
  });

  test("failure: error entry, dead, queue kept", async () => {
    const h = harness();
    void h.controller.send("one");
    await settle();
    await h.controller.send("two");
    h.openError = new Error("launch failed");
    await h.controller.reopen();
    const s = h.controller.getState();
    expect(s.status).toBe("dead");
    expect(s.messages.at(-1)).toEqual({ role: "error", text: "launch failed" });
    expect(s.queue.map((e) => e.text)).toEqual(["two"]);
  });

  test("a second reopen while one runs is ignored", async () => {
    const h = harness();
    const a = h.controller.reopen();
    const b = h.controller.reopen();
    await Promise.all([a, b]);
    expect(h.opens).toBe(1);
  });
});

describe("SessionController.runCommand", () => {
  test("opens lazily, pushes the typed line, show → help entry, idle", async () => {
    const h = harness();
    const p = h.controller.runCommand("model", "", "/model");
    await settle();
    expect(h.opens).toBe(1);
    expect(h.controller.getState().status).toBe("busy");
    expect(h.commands).toEqual([{ name: "model", args: "" }]);
    h.commandResults[0]?.resolve({ kind: "show", text: "gpt-x" });
    expect(await p).toEqual({ ok: true });
    const s = h.controller.getState();
    expect(s.status).toBe("idle");
    expect(s.messages).toEqual([
      { role: "user", text: "/model", attachments: [] },
      { role: "help", text: "gpt-x" },
    ]);
    expect(h.sent).toEqual([]);
  });

  test("send → the prompt is sent, the typed line stays, the reply lands", async () => {
    const h = harness();
    const p = h.controller.runCommand("summarize", "x", "/summarize x");
    await settle();
    h.commandResults[0]?.resolve({ kind: "send", prompt: "Summarize: x" });
    await settle();
    expect(h.sent).toEqual(["Summarize: x"]);
    h.replies[0]?.resolve("ok");
    expect(await p).toEqual({ ok: true });
    expect(h.controller.getState().messages).toEqual([
      { role: "user", text: "/summarize x", attachments: [] },
      { role: "assistant", text: "ok" },
    ]);
  });

  test("queued behind a turn and dispatched on drain", async () => {
    const h = harness();
    const first = h.controller.send("hello");
    await settle();
    expect(await h.controller.runCommand("model", "", "/model")).toEqual({
      ok: true,
      queued: true,
    });
    expect(h.controller.getState().queue).toEqual([
      { text: "/model", attachments: [] },
    ]);
    h.replies[0]?.resolve("hi");
    await first;
    await settle();
    expect(h.commands).toEqual([{ name: "model", args: "" }]);
  });

  test("a failed show command clears lastPrompt: retryLast sends nothing", async () => {
    const h = harness();
    const p1 = h.controller.send("earlier");
    await settle();
    h.replies[0]?.resolve("ok");
    await p1;
    const p2 = h.controller.runCommand("model", "", "/model");
    await settle();
    h.commandResults[0]?.reject(new BrowserUnavailableError("gone"));
    expect((await p2).ok).toBe(false);
    expect(h.controller.getState().status).toBe("dead");
    // The previous turn's prompt must not be resent in place of the command.
    expect(await h.controller.retryLast()).toEqual({
      ok: false,
      code: "EMPTY",
      message: "Nothing to send.",
    });
    expect(h.sent).toEqual(["earlier"]);
  });

  test("timeout → idle with an error entry; other errors → dead", async () => {
    const h = harness();
    let p = h.controller.runCommand("model", "", "/model");
    await settle();
    h.commandResults[0]?.reject(new ResponseTimeoutError("slow"));
    expect((await p).ok).toBe(false);
    expect(h.controller.getState().status).toBe("idle");
    p = h.controller.runCommand("model", "", "/model");
    await settle();
    h.commandResults[1]?.reject(new Error("gone"));
    expect((await p).ok).toBe(false);
    expect(h.controller.getState().status).toBe("dead");
  });

  test("a session without runCommand refuses without killing the controller", async () => {
    const h = harness();
    // A session that cannot run commands at all, as an older or partial
    // ChatSession implementation would be.
    const plain: ChatSessionLike = {
      async send() {
        return "reply";
      },
      async close() {},
      async kill() {},
    };
    h.controller = new SessionController({
      openSession: async () => {
        h.opens++;
        return plain;
      },
      closeTimeoutMs: 20,
      onChange: (s) => h.states.push(s.status),
    });
    const r = await h.controller.runCommand("model", "", "/model");
    expect(r).toEqual({
      ok: false,
      code: "COMMAND_UNAVAILABLE",
      message: "/model is not available in this session.",
    });
    const s = h.controller.getState();
    expect(s.status).toBe("idle");
    expect(s.lastError).toBeUndefined();
    expect(s.messages).toEqual([
      { role: "user", text: "/model", attachments: [] },
      { role: "error", text: "/model is not available in this session." },
    ]);
    // The browser is still usable: an ordinary send goes through.
    expect(await h.controller.send("hi")).toEqual({ ok: true });
    expect(h.opens).toBe(1);
  });

  test("a queued turn still drains after an unavailable command", async () => {
    const h = harness();
    const plain: ChatSessionLike = {
      async send(prompt) {
        h.sent.push(prompt);
        return "reply";
      },
      async close() {},
      async kill() {},
    };
    h.controller = new SessionController({
      openSession: async () => {
        h.opens++;
        return plain;
      },
      closeTimeoutMs: 20,
      onChange: (s) => h.states.push(s.status),
    });
    const running = h.controller.runCommand("model", "", "/model");
    expect(await h.controller.send("after")).toEqual({
      ok: true,
      queued: true,
    });
    await running;
    // The drained turn is asynchronous: wait for its reply to land, not for
    // a fixed number of microtasks.
    await waitFor(() =>
      h.controller
        .getState()
        .messages.some((m) => m.role === "assistant" && m.text === "reply"),
    );
    expect(h.sent).toEqual(["after"]);
    const after = h.controller.getState();
    expect(after.status).toBe("idle");
    expect(after.queue).toEqual([]);
  });
});

describe("URL hooks", () => {
  test("resolved URLs join the turn after the pending attachments", async () => {
    const h = harness({
      expandUrls: async (text) =>
        text.includes("https://w/x")
          ? [{ label: "Wiki: X", bytes: 4, content: "body" }]
          : [],
    });
    h.controller.addAttachment({ path: "a.txt", bytes: 1, content: "a" });
    const p = h.controller.send("see https://w/x");
    await settle();
    expect(h.sent[0]).toBe(
      "see https://w/x\n\n### a.txt\n```\na\n```\n\n### Wiki: X\n```\nbody\n```",
    );
    expect(h.controller.getState().messages[0]).toEqual({
      role: "user",
      text: "see https://w/x",
      attachments: [
        { path: "a.txt", bytes: 1 },
        { path: "Wiki: X", bytes: 4 },
      ],
    });
    h.replies[0]?.resolve("ok");
    await p;
  });

  test("a send during URL expansion queues instead of racing the turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      expandUrls: async () => {
        await gate;
        return [];
      },
    });
    const first = h.controller.send("a");
    expect(await h.controller.send("b")).toEqual({ ok: true, queued: true });
    release();
    await settle();
    expect(h.sent).toEqual(["a"]);
    h.replies[0]?.resolve("1");
    await first;
    await settle();
    expect(h.sent).toEqual(["a", "b"]);
  });

  test("a UrlHookError refuses the send: error entry, nothing sent, not dead", async () => {
    const h = harness({
      expandUrls: async () => {
        throw new UrlHookError(["https://w/x: 403"]);
      },
    });
    h.controller.addAttachment({ path: "a.txt", bytes: 1, content: "a" });
    const r = await h.controller.send("https://w/x");
    expect(r).toEqual({
      ok: false,
      code: "URL_HOOK",
      message: "https://w/x: 403",
    });
    const s = h.controller.getState();
    expect(s.messages).toEqual([{ role: "error", text: "https://w/x: 403" }]);
    expect(s.pendingAttachments).toEqual([{ path: "a.txt", bytes: 1 }]);
    expect(s.status).toBe("closed");
    expect(h.opens).toBe(0);
    expect(h.sent).toEqual([]);
  });

  test("restoring attachments after a refusal respects the total limit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      expandUrls: async () => {
        await gate;
        throw new UrlHookError(["https://w/x: 403"]);
      },
    });
    expect(
      h.controller.addAttachment({
        path: "big.txt",
        bytes: MAX_FILE_BYTES,
        content: "b",
      }),
    ).toEqual({ ok: true });
    const p = h.controller.send("https://w/x");
    // `send` empties the composer synchronously, so these are the files the
    // user dropped in while the hooks were still resolving. Five max-size
    // files fit on their own, but not beside `big.txt`.
    for (let i = 0; i < 5; i++) {
      expect(
        h.controller.addAttachment({
          path: `n${i}.txt`,
          bytes: MAX_FILE_BYTES,
          content: "n",
        }),
      ).toEqual({ ok: true });
    }
    release();
    expect((await p).ok).toBe(false);
    const s = h.controller.getState();
    // `big.txt` no longer fits; it is reported, not forced in.
    expect(s.pendingAttachments.map((a) => a.path)).toEqual([
      "n0.txt",
      "n1.txt",
      "n2.txt",
      "n3.txt",
      "n4.txt",
    ]);
    expect(s.messages).toEqual([
      {
        role: "error",
        text: "https://w/x: 403\n1 attachment(s) left out: total size limit.",
      },
    ]);
    // The composer is usable again: it is under the limit.
    expect(
      h.controller.addAttachment({ path: "ok.txt", bytes: 5, content: "o" }),
    ).toEqual({ ok: true });
  });

  test("a refusal with room to spare restores everything and says nothing extra", async () => {
    const h = harness({
      expandUrls: async () => {
        throw new UrlHookError(["https://w/x: 403"]);
      },
    });
    h.controller.addAttachment({ path: "a.txt", bytes: 1, content: "a" });
    await h.controller.send("https://w/x");
    const s = h.controller.getState();
    expect(s.pendingAttachments).toEqual([{ path: "a.txt", bytes: 1 }]);
    expect(s.messages).toEqual([{ role: "error", text: "https://w/x: 403" }]);
  });

  test("a reopen during URL expansion recovers the turn instead of opening a second browser", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      expandUrls: async () => {
        await gate;
        return [];
      },
    });
    h.controller.addAttachment({ path: "a.txt", bytes: 1, content: "a" });
    const p = h.controller.send("a");
    // Queued behind the turn whose expansion is still in flight.
    expect(await h.controller.send("b")).toEqual({ ok: true, queued: true });
    await settle();
    await h.controller.reopen();
    expect(h.opens).toBe(1);
    release();
    // Refused like a hook refusal, so the extension refills the composer
    // rather than leaving the text only in the history.
    expect(await p).toEqual({
      ok: false,
      code: "REOPENED",
      message: "Reopened while resolving URLs; message not sent.",
    });
    await settle();
    expect(h.opens).toBe(1);
    // The stale turn is not sent, but the one queued behind it is.
    expect(h.sent).toEqual(["b"]);
    const s = h.controller.getState();
    expect(s.status).toBe("busy");
    // Its attachments come back to the composer and the refusal above hands
    // the text back, so nothing the user typed is lost.
    expect(s.pendingAttachments).toEqual([{ path: "a.txt", bytes: 1 }]);
    expect(s.messages).toEqual([
      { role: "separator", text: REOPENED_SEPARATOR },
      {
        role: "error",
        text: "Reopened while resolving URLs; message not sent.",
      },
      { role: "user", text: "b", attachments: [] },
    ]);
    h.replies[0]?.resolve("ok");
    await settle();
  });

  test("a stale turn whose attachments no longer fit says how many were left out", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      expandUrls: async () => {
        await gate;
        return [];
      },
    });
    expect(
      h.controller.addAttachment({
        path: "big.txt",
        bytes: MAX_FILE_BYTES,
        content: "b",
      }),
    ).toEqual({ ok: true });
    const p = h.controller.send("a");
    // `send` emptied the composer, so these are files dropped in while the
    // hooks were still resolving. Five max-size files fit on their own, but
    // not beside `big.txt`.
    expect(MAX_FILE_BYTES * 6).toBeGreaterThan(MAX_TOTAL_BYTES);
    for (let i = 0; i < 5; i++) {
      expect(
        h.controller.addAttachment({
          path: `n${i}.txt`,
          bytes: MAX_FILE_BYTES,
          content: "n",
        }),
      ).toEqual({ ok: true });
    }
    await h.controller.reopen();
    release();
    expect(await p).toEqual({
      ok: false,
      code: "REOPENED",
      message: "Reopened while resolving URLs; message not sent.",
    });
    await waitFor(() => h.controller.getState().messages.length === 2);
    const s = h.controller.getState();
    // `big.txt` no longer fits; it is reported, not forced in.
    expect(s.pendingAttachments.map((a) => a.path)).toEqual([
      "n0.txt",
      "n1.txt",
      "n2.txt",
      "n3.txt",
      "n4.txt",
    ]);
    expect(s.messages).toEqual([
      { role: "separator", text: REOPENED_SEPARATOR },
      {
        role: "error",
        text: "Reopened while resolving URLs; message not sent.\n1 attachment(s) left out: total size limit.",
      },
    ]);
  });
});

describe("idle close", () => {
  /** A controller whose opens hand back each session's expiry callback. */
  function idleHarness() {
    const sessions: ChatSessionLike[] = [];
    const expire: Array<() => void> = [];
    const states: string[] = [];
    const sent: string[] = [];
    const replies: Array<ReturnType<typeof deferred<string>>> = [];
    const closed = { count: 0 };
    const controller = new SessionController({
      closeTimeoutMs: 20,
      onChange: (state) => states.push(state.status),
      openSession: async (onIdleExpired) => {
        expire.push(onIdleExpired);
        const session: ChatSessionLike = {
          async send(prompt) {
            sent.push(prompt);
            const d = deferred<string>();
            replies.push(d);
            return d.promise;
          },
          async close() {
            closed.count++;
          },
          async kill() {},
        };
        sessions.push(session);
        return session;
      },
    });
    return { controller, sessions, expire, states, sent, replies, closed };
  }

  /** The nth entry, failing loudly when it was never created. */
  function at<T>(list: readonly T[], i: number): T {
    const entry = list[i];
    if (entry === undefined) throw new Error(`no entry at index ${i}`);
    return entry;
  }

  /** Waits for a real state change rather than a guessed number of ticks. */
  async function waitFor(what: string, cond: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !cond(); i++) await settle();
    if (!cond()) throw new Error(`timed out waiting for ${what}`);
  }

  /** One completed turn: the session is open, idle, and one reply is in. */
  async function firstTurn(h: ReturnType<typeof idleHarness>): Promise<void> {
    void h.controller.send("one");
    await waitFor("the first send", () => h.replies.length === 1);
    at(h.replies, 0).resolve("reply");
    await waitFor(
      "the turn to finish",
      () => h.controller.getState().status === "idle",
    );
  }

  test("expiry: status closed, separator pushed, browser not closed again", async () => {
    const h = idleHarness();
    await firstTurn(h);
    at(h.expire, 0)();
    const state = h.controller.getState();
    expect(state.status).toBe("closed");
    expect(state.messages.at(-1)).toEqual({
      role: "separator",
      text: IDLE_CLOSED_SEPARATOR,
    });
    // Core is closing it; the controller must not close it a second time.
    expect(h.closed.count).toBe(0);
  });

  test("the next send opens lazily and pushes nothing further", async () => {
    const h = idleHarness();
    await firstTurn(h);
    at(h.expire, 0)();
    const before = h.controller.getState().messages.length;
    void h.controller.send("two");
    await waitFor("the lazy reopen", () => h.sessions.length === 2);
    await waitFor("the queued prompt", () => h.sent.length === 2);
    expect(h.sent.at(-1)).toBe("two");
    // user entry only: no extra separator for the lazy reopen.
    expect(h.controller.getState().messages.length).toBe(before + 1);
    at(h.replies, 1).resolve("reply two");
    await settle();
  });

  test("a stale session's expiry is ignored", async () => {
    const h = idleHarness();
    await firstTurn(h);
    await h.controller.reopen();
    const status = h.controller.getState().status;
    at(h.expire, 0)(); // the session the reopen already dropped
    expect(h.controller.getState().status).toBe(status);
    expect(
      h.controller
        .getState()
        .messages.filter((m) => m.text === IDLE_CLOSED_SEPARATOR).length,
    ).toBe(0);
  });

  test("retryLast after an idle close does not resend the old prompt", async () => {
    const h = idleHarness();
    await firstTurn(h);
    at(h.expire, 0)();
    expect(await h.controller.retryLast()).toEqual({
      ok: false,
      code: "EMPTY",
      message: "Nothing to send.",
    });
    expect(h.sent).toEqual(["one"]);
  });

  test("an expiry after close() is ignored", async () => {
    const h = idleHarness();
    await firstTurn(h);
    await h.controller.close();
    const before = h.controller.getState().messages.length;
    at(h.expire, 0)();
    const state = h.controller.getState();
    expect(state.status).toBe("closed");
    expect(state.messages.length).toBe(before);
  });
});
