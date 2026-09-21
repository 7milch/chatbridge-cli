import { describe, expect, test } from "bun:test";
import type { Message } from "../protocol.js";
import {
  commonPrefix,
  messageKey,
  nextRenderDelay,
  onPartial,
  onState,
} from "./stream-state.js";

const user = (text: string): Message => ({ role: "user", text });

describe("messageKey", () => {
  test("equal messages share a key", () => {
    expect(messageKey(user("a"))).toBe(messageKey(user("a")));
  });
  test.each<[string, Message, Message]>([
    ["text", user("a"), user("b")],
    ["role", user("a"), { role: "assistant", text: "a" }],
    [
      "format",
      { role: "assistant", text: "a" },
      { role: "assistant", text: "a", format: "markdown" },
    ],
    [
      "incomplete",
      { role: "assistant", text: "a" },
      { role: "assistant", text: "a", incomplete: true },
    ],
    [
      "attachments",
      user("a"),
      { role: "user", text: "a", attachments: [{ path: "f", bytes: 1 }] },
    ],
  ])("%s changes the key", (_n, a, b) => {
    expect(messageKey(a)).not.toBe(messageKey(b));
  });
});

describe("commonPrefix", () => {
  test("append keeps everything", () => {
    expect(commonPrefix(["a", "b"], ["a", "b", "c"])).toBe(2);
  });
  test("a popped tail keeps the rest", () => {
    expect(commonPrefix(["a", "b", "c"], ["a", "b"])).toBe(2);
  });
  test("a replaced entry cuts there", () => {
    expect(commonPrefix(["a", "x", "c"], ["a", "y", "c"])).toBe(1);
  });
  test("empty", () => {
    expect(commonPrefix([], ["a"])).toBe(0);
  });
});

describe("partial lifecycle", () => {
  test("a partial remembers where it started", () => {
    expect(onPartial(undefined, "he", "markdown", 3)).toEqual({
      text: "he",
      format: "markdown",
      at: 3,
    });
  });
  test("later partials keep the first position", () => {
    const first = onPartial(undefined, "he", "markdown", 3);
    expect(onPartial(first, "hello", "markdown", 3).at).toBe(3);
  });
  test("a busy state frame with the same history keeps it (a queue change)", () => {
    const s = onPartial(undefined, "he", "text", 3);
    expect(onState(s, "busy", 3)).toBe(s);
  });
  test("the settled reply ends it", () => {
    const s = onPartial(undefined, "he", "text", 3);
    expect(onState(s, "idle", 4)).toBeUndefined();
  });
  test("busy again with a longer history is the next turn: the old partial is gone", () => {
    const s = onPartial(undefined, "he", "text", 3);
    expect(onState(s, "busy", 5)).toBeUndefined();
  });
  test.each(["closed", "opening", "reopening", "dead", "idle"] as const)(
    "%s ends it",
    (status) => {
      const s = onPartial(undefined, "he", "text", 3);
      expect(onState(s, status, 3)).toBeUndefined();
    },
  );
  test("nothing in, nothing out", () => {
    expect(onState(undefined, "busy", 1)).toBeUndefined();
  });
});

describe("nextRenderDelay", () => {
  test("a cheap render waits for nothing but the next frame", () => {
    expect(nextRenderDelay(0)).toBe(0);
  });
  test("a render that cost nothing measurable does not stall the stream", () => {
    expect(nextRenderDelay(Number.NaN)).toBe(0);
    expect(nextRenderDelay(-1)).toBe(0);
  });
  test("the wait is four times the last render's cost", () => {
    expect(nextRenderDelay(5)).toBe(20);
    expect(nextRenderDelay(50)).toBe(200);
  });
  test("a very long reply still redraws about once a second", () => {
    expect(nextRenderDelay(400)).toBe(1000);
    expect(nextRenderDelay(5000)).toBe(1000);
  });
});
