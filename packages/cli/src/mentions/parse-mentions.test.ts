import { describe, expect, test } from "bun:test";
import { mentionAtCursor, parseMentions } from "./parse-mentions.js";

describe("parseMentions", () => {
  test("mention at line start", () => {
    expect(parseMentions("@src/a.ts explain")).toEqual([
      { path: "src/a.ts", start: 0, end: 9 },
    ]);
  });

  test("mention after whitespace, including newline and tab", () => {
    expect(parseMentions("see @a.ts\n@b.ts\t@c.ts")).toEqual([
      { path: "a.ts", start: 4, end: 9 },
      { path: "b.ts", start: 10, end: 15 },
      { path: "c.ts", start: 16, end: 21 },
    ]);
  });

  test("an email address is not a mention", () => {
    expect(parseMentions("mail foo@example.com now")).toEqual([]);
  });

  test("a bare @ yields nothing", () => {
    expect(parseMentions("hello @ world @")).toEqual([]);
  });

  test("duplicates are kept in order of appearance", () => {
    expect(parseMentions("@a.ts and @a.ts").map((m) => m.path)).toEqual([
      "a.ts",
      "a.ts",
    ]);
  });

  test("path runs to the next whitespace", () => {
    expect(parseMentions("@dir/with-dash_and.dots/x.ts, ok")).toEqual([
      { path: "dir/with-dash_and.dots/x.ts,", start: 0, end: 29 },
    ]);
  });
});

describe("mentionAtCursor", () => {
  test("cursor right after a bare @ yields an empty path", () => {
    expect(mentionAtCursor("hi @", 4)).toEqual({ path: "", start: 3, end: 4 });
  });

  test("cursor at the end of the path", () => {
    expect(mentionAtCursor("hi @src/a", 9)).toEqual({
      path: "src/a",
      start: 3,
      end: 9,
    });
  });

  test("cursor inside the path", () => {
    expect(mentionAtCursor("hi @src/a rest", 6)).toEqual({
      path: "src/a",
      start: 3,
      end: 9,
    });
  });

  test("cursor before the @ or after the trailing space is not a mention", () => {
    expect(mentionAtCursor("hi @src/a ", 3)).toBeUndefined();
    expect(mentionAtCursor("hi @src/a ", 10)).toBeUndefined();
  });

  test("email is not a mention at the cursor", () => {
    expect(mentionAtCursor("foo@example.com", 15)).toBeUndefined();
  });
});
