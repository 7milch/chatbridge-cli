import { describe, expect, test } from "bun:test";
import {
  AuthExpiredError,
  AuthRequiredError,
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

describe("SessionController", () => {
  test("starts closed with an empty history", () => {
    const h = harness();
    expect(h.controller.getState()).toEqual({
      status: "closed",
      messages: [],
      pendingAttachments: [],
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

  test("send while busy is rejected without touching the session", async () => {
    const h = harness();
    const p = h.controller.send("a");
    await settle();
    expect(await h.controller.send("b")).toEqual({
      ok: false,
      code: "INVALID_STATE",
      message: "A send is already in progress.",
    });
    h.replies[0].resolve("1");
    await p;
    expect(h.sent).toEqual(["a"]);
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
    await h.controller.newChat();
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
