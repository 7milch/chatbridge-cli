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
    const model = new ChatModel(session);
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
    const model = new ChatModel(session);
    const p = model.submit("one");
    await tick();
    await model.submit("two");
    expect(calls).toEqual(["one"]);
    replies[0]?.resolve("ok");
    await p;
  });

  test("timeout becomes an error message; model stays usable", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session);
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
    const model = new ChatModel(session);
    const boom = new Error("page closed");
    const p = model.submit("one");
    await tick();
    replies[0]?.reject(boom);
    await p;
    expect(model.fatal).toBe(boom);
    expect(model.messages[1]).toEqual({ role: "error", text: "page closed" });
    await model.submit("two");
    expect(calls).toEqual(["one"]);
  });

  test("resolves true when accepted and false when ignored", async () => {
    const { session, replies } = fakeSession();
    const model = new ChatModel(session);
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
    const model = new ChatModel(session);
    const p = model.submit("hello");
    await tick();
    replies[0]?.resolve("ok");
    await p;
    expect(model.messages[0]).toEqual({ role: "user", text: "hello" });
  });

  test("a MentionError shows the problems, sends nothing, stays idle and not fatal", async () => {
    const { session, calls } = fakeSession();
    const model = new ChatModel(session, {
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
