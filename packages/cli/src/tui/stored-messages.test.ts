import { describe, expect, test } from "bun:test";
import type { StoredMessage } from "@chatbridge/core";
import type { Message } from "./chat-model.js";
import { fromStored, toStored } from "./stored-messages.js";

const shellResult = {
  command: "ls",
  output: "a\n",
  droppedBytes: 3,
  exitCode: 0,
  interrupted: false,
  durationMs: 12,
};

describe("toStored", () => {
  test("keeps user, assistant, error and separator entries", () => {
    const messages: Message[] = [
      {
        role: "user",
        text: "look",
        attachments: [{ path: "src/a.ts", bytes: 12 }],
      },
      { role: "assistant", text: "**hi**", format: "markdown" },
      { role: "assistant", text: "half", incomplete: true },
      { role: "error", text: "Timed out" },
      { role: "separator", text: "reopened" },
    ];
    expect(toStored(messages)).toEqual([
      {
        role: "user",
        text: "look",
        attachments: [{ path: "src/a.ts", bytes: 12 }],
      },
      { role: "assistant", text: "**hi**", format: "markdown" },
      { role: "assistant", text: "half", incomplete: true },
      { role: "error", text: "Timed out" },
      { role: "separator", text: "reopened" },
    ]);
  });

  test("drops help entries", () => {
    expect(
      toStored([
        { role: "help", text: "/help …" },
        { role: "user", text: "hi" },
      ]),
    ).toEqual([{ role: "user", text: "hi" }]);
  });

  test("stores a shell result, with null for a missing exit code", () => {
    expect(
      toStored([
        {
          role: "shell",
          text: "sleep 9",
          held: true,
          result: {
            ...shellResult,
            command: "sleep 9",
            exitCode: undefined,
            interrupted: true,
            signal: "SIGTERM",
          },
        },
      ]),
    ).toEqual([
      {
        role: "shell",
        text: "sleep 9",
        shell: {
          command: "sleep 9",
          output: "a\n",
          droppedBytes: 3,
          exitCode: null,
          interrupted: true,
          durationMs: 12,
          signal: "SIGTERM",
        },
      },
    ]);
  });

  test("keeps failed, never held", () => {
    expect(
      toStored([{ role: "shell", text: "x", failed: true, held: false }]),
    ).toEqual([{ role: "shell", text: "x", failed: true }]);
  });

  test("copies attachments: the stored list is not the model's", () => {
    const attachments = [{ path: "a", bytes: 1 }];
    const [stored] = toStored([{ role: "user", text: "", attachments }]);
    expect(stored?.attachments).not.toBe(attachments);
  });

  test("an empty attachment list is left out", () => {
    expect(toStored([{ role: "user", text: "hi", attachments: [] }])).toEqual([
      { role: "user", text: "hi" },
    ]);
  });
});

describe("fromStored", () => {
  test("is the inverse of toStored for everything toStored keeps", () => {
    const messages: Message[] = [
      {
        role: "user",
        text: "look",
        attachments: [{ path: "src/a.ts", bytes: 12 }],
      },
      { role: "assistant", text: "**hi**", format: "markdown" },
      { role: "assistant", text: "half", incomplete: true },
      { role: "error", text: "Timed out" },
      { role: "separator", text: "reopened" },
      { role: "shell", text: "ls", result: shellResult },
      {
        role: "shell",
        text: "sleep 9",
        failed: true,
        result: {
          ...shellResult,
          exitCode: undefined,
          interrupted: true,
          signal: "SIGTERM",
        },
      },
    ];
    expect(fromStored(toStored(messages))).toEqual(messages);
  });

  test("a stored shell entry without a result has none", () => {
    const stored: StoredMessage[] = [{ role: "shell", text: "ls" }];
    expect(fromStored(stored)).toEqual([{ role: "shell", text: "ls" }]);
  });
});
