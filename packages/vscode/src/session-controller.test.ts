import { describe, expect, test } from "bun:test";
import {
  AuthExpiredError,
  AuthRequiredError,
  BlockedError,
  BrowserUnavailableError,
  ResponseTimeoutError,
} from "@chatbridge/core";
import {
  type ChatSessionLike,
  SessionController,
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
}

function harness(): Harness {
  const h = {
    sent: [],
    replies: [],
    opens: 0,
    closed: 0,
    killed: 0,
    closeHangs: false,
    states: [],
  } as unknown as Harness;
  const session: ChatSessionLike = {
    async send(prompt) {
      h.sent.push(prompt);
      const d = deferred<string>();
      h.replies.push(d);
      return d.promise;
    },
    close: () =>
      h.closeHangs
        ? new Promise<void>(() => {})
        : Promise.resolve().then(() => {
            h.closed++;
          }),
    async kill() {
      h.killed++;
    },
  };
  h.controller = new SessionController({
    openSession: async () => {
      h.opens++;
      if (h.openError) throw h.openError;
      return session;
    },
    closeTimeoutMs: 20,
    onChange: (s) => h.states.push(s.status),
  });
  return h;
}

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
}

/** Same as settle(), under the name the queue/reopen tests use. */
function tick() {
  return new Promise<void>((r) => setTimeout(r, 0));
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
    h.openError = new BlockedError(
      'Blocked by "acme": challenge. Try --headful.',
    );
    await controller.send("x");
    expect(controller.getState().messages.at(-1)).toEqual({
      role: "error",
      text: 'Blocked by "acme": challenge. Try --headful.\nSet the "acme.headless" setting to false.',
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
});

describe("queue", () => {
  test("send while busy queues and drains in order after the reply", async () => {
    const h = harness();
    const first = h.controller.send("one");
    await tick();
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
    await tick();
    // The next turn was claimed before the idle frame.
    expect(h.controller.getState().status).toBe("busy");
    expect(h.controller.getState().queue.map((e) => e.text)).toEqual(["three"]);
    expect(h.sent).toEqual(["one", "two"]);
    h.replies[1]?.resolve("r2");
    await tick();
    h.replies[2]?.resolve("r3");
    await tick();
    expect(h.sent).toEqual(["one", "two", "three"]);
    expect(h.controller.getState().status).toBe("idle");
    expect(h.controller.getState().queue).toEqual([]);
  });

  test("a queued entry carries the pending attachments", async () => {
    const h = harness();
    const first = h.controller.send("one");
    await tick();
    h.controller.addAttachment({ path: "a.ts", bytes: 3, content: "abc" });
    await h.controller.send("two");
    const s = h.controller.getState();
    expect(s.pendingAttachments).toEqual([]);
    expect(s.queue[0]?.attachments).toEqual([{ path: "a.ts", bytes: 3 }]);
    h.replies[0]?.resolve("r1");
    await first;
    await tick();
    expect(h.sent[1]).toContain("abc");
    const user = h.controller.getState().messages.find((m) => m.text === "two");
    expect(user?.attachments).toEqual([{ path: "a.ts", bytes: 3 }]);
  });

  test("blank text with no attachments is EMPTY even while busy", async () => {
    const h = harness();
    void h.controller.send("one");
    await tick();
    expect((await h.controller.send("  ")).ok).toBe(false);
    expect(h.controller.getState().queue).toEqual([]);
  });

  test("a fatal error stops draining; the queue survives newChat and drains after it", async () => {
    const h = harness();
    const first = h.controller.send("one");
    await tick();
    await h.controller.send("two");
    h.replies[0]?.reject(new Error("page closed"));
    await first;
    expect(h.controller.getState().status).toBe("dead");
    expect(h.controller.getState().queue.map((e) => e.text)).toEqual(["two"]);
    expect(h.sent).toEqual(["one"]);
    await h.controller.newChat();
    await tick();
    expect(h.sent).toEqual(["one", "two"]);
  });

  test("takeBack returns the entries with attachments restored as pending", async () => {
    const h = harness();
    void h.controller.send("one");
    await tick();
    h.controller.addAttachment({ path: "a.ts", bytes: 3, content: "abc" });
    await h.controller.send("two");
    await h.controller.send("three");
    const entries = h.controller.takeBack();
    expect(entries.map((e) => e.text)).toEqual(["two", "three"]);
    const s = h.controller.getState();
    expect(s.queue).toEqual([]);
    expect(s.pendingAttachments).toEqual([{ path: "a.ts", bytes: 3 }]);
    expect(h.controller.takeBack()).toEqual([]);
  });

  test("removeQueued drops one entry and ignores bad indexes", async () => {
    const h = harness();
    void h.controller.send("one");
    await tick();
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
    await tick();
    await h.controller.send("two");
    const reopen = h.controller.reopen();
    expect(h.controller.getState().status).toBe("reopening");
    await reopen;
    // The abandoned send settles late; nothing from it is recorded.
    h.replies[0]?.resolve("stale");
    expect(await first).toEqual({ ok: true });
    await tick();
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
    await tick();
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
    await tick();
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
