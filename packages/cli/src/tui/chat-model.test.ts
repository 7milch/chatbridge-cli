import { describe, expect, test } from "bun:test";
import { ResponseTimeoutError } from "@chatbridge/core";
import { MentionError } from "../mentions/expand-mentions.js";
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

/** Lets the awaited mention expansion inside submit() settle, so that
 * session.send has been called and its deferred reply is available. */
function tick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** A fake session. `label`, when given, prefixes recorded calls so a test
 * over two sessions can tell which one was sent to. */
function fakeSession(label = "") {
  const calls: string[] = [];
  const replies: Array<ReturnType<typeof deferred<string>>> = [];
  const state = { closed: 0, killed: 0, closeHangs: false };
  const session: ChatSessionLike = {
    async send(prompt) {
      calls.push(label ? `${label}:${prompt}` : prompt);
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

/** For models that must never reopen: a reset would be a test bug. */
const noReopen = {
  openSession: async (): Promise<ChatSessionLike> => {
    throw new Error("not expected");
  },
};

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

describe("ChatModel.submit", () => {
  test("user message, busy, then assistant message and idle", async () => {
    const { session, replies } = fakeSession();
    const model = new ChatModel(session, noReopen);
    const changes: string[] = [];
    model.onChange = () => changes.push(model.status);

    const p = model.submit("hello");
    await tick();
    expect(model.status).toBe("busy");
    expect(model.messages).toEqual([{ role: "user", text: "hello" }]);
    replies[0]?.resolve("Echo: hello");
    await p;
    expect(model.status).toBe("idle");
    expect(model.messages[1]).toEqual({
      role: "assistant",
      text: "Echo: hello",
    });
    expect(changes).toEqual(["busy", "idle"]);
  });

  test("trims the prompt and ignores blank input", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session, noReopen);
    await model.submit("   \n  ");
    expect(calls).toEqual([]);
    expect(model.messages).toEqual([]);
    const p = model.submit("  hi \n");
    await tick();
    replies[0]?.resolve("ok");
    await p;
    expect(calls).toEqual(["hi"]);
  });

  test("ignores input while busy", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session, noReopen);
    const p = model.submit("one");
    await tick();
    await model.submit("two");
    expect(calls).toEqual(["one"]);
    replies[0]?.resolve("ok");
    await p;
  });

  test("timeout becomes an error message; model stays usable", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session, noReopen);
    const p = model.submit("one");
    await tick();
    replies[0]?.reject(
      new ResponseTimeoutError("Timed out during waitForResponse after 10 ms."),
    );
    await p;
    expect(model.status).toBe("idle");
    expect(model.fatal).toBeUndefined();
    expect(model.messages[1]).toEqual({
      role: "error",
      text: "Timed out during waitForResponse after 10 ms.",
    });
    const q = model.submit("two");
    await tick();
    replies[1]?.resolve("Echo: two");
    await q;
    expect(calls).toEqual(["one", "two"]);
  });

  test("any other error is shown and stored as fatal; further input ignored", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session, noReopen);
    const boom = new Error("page closed");
    const p = model.submit("one");
    await tick();
    replies[0]?.reject(boom);
    await p;
    expect(model.fatal).toBe(boom);
    expect(model.status).toBe("dead");
    expect(model.messages[1]).toEqual({ role: "error", text: "page closed" });
    await model.submit("two");
    expect(calls).toEqual(["one"]);
  });

  test("resolves true when accepted and false when ignored", async () => {
    const { session, replies } = fakeSession();
    const model = new ChatModel(session, noReopen);
    expect(await model.submit("   ")).toBe(false);
    const p = model.submit("one");
    await tick();
    expect(await model.submit("two")).toBe(false); // busy
    replies[0]?.resolve("ok");
    expect(await p).toBe(true);
  });

  test("sends the expanded prompt and records attachments on the user message", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session, {
      ...noReopen,
      expand: async (text) => ({
        prompt: `${text}\n\n### a.ts\n\`\`\`ts\nx\n\`\`\``,
        attachments: [{ path: "a.ts", bytes: 2 }],
      }),
    });
    const p = model.submit("look @a.ts");
    await tick();
    replies[0]?.resolve("ok");
    expect(await p).toBe(true);
    expect(calls).toEqual(["look @a.ts\n\n### a.ts\n```ts\nx\n```"]);
    expect(model.messages[0]).toEqual({
      role: "user",
      text: "look @a.ts",
      attachments: [{ path: "a.ts", bytes: 2 }],
    });
  });

  test("omits the attachments key when there are none", async () => {
    const { session, replies } = fakeSession();
    const model = new ChatModel(session, noReopen);
    const p = model.submit("hello");
    await tick();
    replies[0]?.resolve("ok");
    await p;
    expect(model.messages[0]).toEqual({ role: "user", text: "hello" });
  });

  test("a MentionError shows the problems, sends nothing, stays idle and not fatal", async () => {
    const { session, calls } = fakeSession();
    const model = new ChatModel(session, {
      ...noReopen,
      expand: async () => {
        throw new MentionError(["@x: not found", "@d: is a directory"]);
      },
    });
    const changes: string[] = [];
    model.onChange = () => changes.push(model.status);
    expect(await model.submit("@x @d")).toBe(false);
    expect(calls).toEqual([]);
    expect(model.messages).toEqual([
      { role: "error", text: "@x: not found\n@d: is a directory" },
    ]);
    expect(model.status).toBe("idle");
    expect(model.fatal).toBeUndefined();
    expect(changes).toEqual(["idle"]);
  });

  test("a non-Mention error from expand is fatal", async () => {
    const { session, calls } = fakeSession();
    const boom = new Error("disk on fire");
    const model = new ChatModel(session, {
      ...noReopen,
      expand: async () => {
        throw boom;
      },
    });
    expect(await model.submit("@x")).toBe(false);
    expect(calls).toEqual([]);
    expect(model.messages).toEqual([{ role: "error", text: "disk on fire" }]);
    expect(model.fatal).toBe(boom);
  });

  test("a second submit issued while mentions expand is rejected", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session, {
      ...noReopen,
      expand: async (text) => {
        await tick();
        return { prompt: text, attachments: [] };
      },
    });
    const first = model.submit("one");
    const second = model.submit("two"); // same tick, expansion still pending
    expect(await second).toBe(false);
    await tick();
    expect(calls).toEqual(["one"]);
    replies[0]?.resolve("ok");
    expect(await first).toBe(true);
    expect(model.messages).toEqual([
      { role: "user", text: "one" },
      { role: "assistant", text: "ok" },
    ]);
  });
});

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
