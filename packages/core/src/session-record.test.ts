import { describe, expect, test } from "bun:test";
import {
  NO_PROMPT_TITLE,
  type SessionRecord,
  TITLE_MAX,
  formatSessionTime,
  isSessionId,
  parseSessionRecord,
  summarize,
} from "./session-record.js";

const ID = "3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b";

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1,
    id: ID,
    provider: "dummy-chat",
    createdAt: "2026-09-26T05:00:00.000Z",
    updatedAt: "2026-09-26T05:32:00.000Z",
    messages: [
      { role: "user", text: "hello" },
      { role: "assistant", text: "Echo: hello", format: "markdown" },
    ],
    ...over,
  };
}

describe("isSessionId", () => {
  test("accepts a lowercase UUID", () => {
    expect(isSessionId(ID)).toBe(true);
  });

  test.each(["", "../x", "abc", `${ID}.json`, ID.toUpperCase(), `a/${ID}`])(
    "rejects %p",
    (id) => {
      expect(isSessionId(id)).toBe(false);
    },
  );
});

describe("parseSessionRecord", () => {
  test("round-trips a full record through JSON", () => {
    const full = record({
      conversation: "https://example.test/chat/c/abcd1234",
      messages: [
        {
          role: "user",
          text: "look",
          attachments: [{ path: "src/a.ts", bytes: 12 }],
        },
        { role: "assistant", text: "half", incomplete: true },
        { role: "error", text: "Timed out" },
        { role: "separator", text: "reopened" },
        {
          role: "shell",
          text: "ls",
          failed: true,
          shell: {
            command: "ls",
            output: "a\n",
            exitCode: null,
            interrupted: true,
            droppedBytes: 0,
            durationMs: 5,
            signal: "SIGTERM",
          },
        },
      ],
    });
    expect(parseSessionRecord(JSON.parse(JSON.stringify(full)))).toEqual(full);
  });

  test("drops fields it does not know", () => {
    const parsed = parseSessionRecord({
      ...record(),
      extra: 1,
      messages: [{ role: "user", text: "hi", held: true }],
    });
    expect(parsed).toEqual(
      record({ messages: [{ role: "user", text: "hi" }] }),
    );
  });

  test.each([
    ["not an object", "text"],
    ["an array", []],
    ["null", null],
    ["another version", { ...record(), version: 2 }],
    ["no version", { ...record(), version: undefined }],
    ["a bad id", { ...record(), id: "../escape" }],
    ["an empty provider", { ...record(), provider: "" }],
    ["a bad createdAt", { ...record(), createdAt: "yesterday" }],
    ["a numeric updatedAt", { ...record(), updatedAt: 5 }],
    ["an empty conversation", { ...record(), conversation: "" }],
    ["a numeric conversation", { ...record(), conversation: 7 }],
    ["messages that are not a list", { ...record(), messages: {} }],
    [
      "an unknown role",
      { ...record(), messages: [{ role: "help", text: "" }] },
    ],
    ["a message without text", { ...record(), messages: [{ role: "user" }] }],
    [
      "a bad attachment",
      {
        ...record(),
        messages: [{ role: "user", text: "", attachments: [{ path: 1 }] }],
      },
    ],
    [
      "a bad format",
      { ...record(), messages: [{ role: "assistant", text: "", format: "x" }] },
    ],
    [
      "incomplete: false",
      {
        ...record(),
        messages: [{ role: "assistant", text: "", incomplete: false }],
      },
    ],
    [
      "a shell result without a command",
      {
        ...record(),
        messages: [{ role: "shell", text: "ls", shell: { output: "" } }],
      },
    ],
  ])("returns undefined for %s", (_name, value) => {
    expect(parseSessionRecord(value)).toBeUndefined();
  });
});

describe("summarize", () => {
  test("takes the first line of the first user message and counts turns", () => {
    const s = summarize(
      record({
        messages: [
          { role: "separator", text: "reopened" },
          { role: "user", text: "\n  first line  \nsecond line" },
          { role: "assistant", text: "a" },
          { role: "user", text: "again" },
        ],
      }),
    );
    expect(s).toEqual({
      id: ID,
      updatedAt: "2026-09-26T05:32:00.000Z",
      title: "first line",
      turns: 2,
    });
  });

  test("truncates a long title with an ellipsis", () => {
    const s = summarize(
      record({ messages: [{ role: "user", text: "x".repeat(200) }] }),
    );
    expect(Array.from(s.title)).toHaveLength(TITLE_MAX);
    expect(s.title.endsWith("…")).toBe(true);
  });

  test("does not split a surrogate pair when truncating", () => {
    const s = summarize(
      record({ messages: [{ role: "user", text: "😀".repeat(200) }] }),
    );
    expect(s.title).toBe(`${"😀".repeat(TITLE_MAX - 1)}…`);
  });

  test("falls back to the first shell command", () => {
    const s = summarize(
      record({
        messages: [
          { role: "shell", text: "git status" },
          { role: "assistant", text: "clean" },
        ],
      }),
    );
    expect(s.title).toBe("! git status");
    expect(s.turns).toBe(0);
  });

  test("has a placeholder when nothing was typed", () => {
    expect(summarize(record({ messages: [] })).title).toBe(NO_PROMPT_TITLE);
  });

  // Review Focus 1.
  test("replaces control characters in the title", () => {
    const s = summarize(
      record({
        messages: [{ role: "user", text: "a\u001b[31mb\u0007c\td\u007f" }],
      }),
    );
    expect(s.title).toBe("a [31mb c d");
  });

  test("replaces C1 and bidi controls in the title", () => {
    const s = summarize(
      record({
        messages: [
          {
            role: "user",
            text: "a\u0085b\u009bc\u200ed\u200fe\u202af\u202eg\u2066h\u2069i",
          },
        ],
      }),
    );
    expect(s.title).toBe("a b c d e f g h i");
    // Neighbours of the ranges stay: a no-break space and the joiners.
    const kept = summarize(
      record({
        messages: [{ role: "user", text: "x\u00a0y\u200dz\u2070" }],
      }),
    );
    expect(kept.title).toBe("x\u00a0y\u200dz\u2070");
  });
});

describe("formatSessionTime", () => {
  test("formats in local time as MM-DD HH:mm", () => {
    // Built from local components, so the assertion holds in any zone.
    const local = new Date(2026, 8, 6, 4, 7);
    expect(formatSessionTime(local.toISOString())).toBe("09-06 04:07");
  });
});
