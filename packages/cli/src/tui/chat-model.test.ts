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
