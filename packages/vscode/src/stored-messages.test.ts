import { describe, expect, test } from "bun:test";
import type { StoredMessage } from "@chatbridge/core";
import type { Message } from "./protocol.js";
import { type Origins, fromStored, toStored } from "./stored-messages.js";

const origins = (): Origins => new WeakMap();

describe("toStored", () => {
  test("maps the entries VSCode produces", () => {
    const messages: Message[] = [
      { role: "user", text: "look", attachments: [{ path: "a.ts", bytes: 3 }] },
      { role: "user", text: "plain", attachments: [] },
      { role: "assistant", text: "**hi**", format: "markdown" },
      { role: "assistant", text: "plain text", format: "text" },
      { role: "assistant", text: "half", incomplete: true },
      { role: "error", text: "Timed out" },
      { role: "separator", text: "reopened" },
      { role: "help", text: "/help …" },
    ];
    expect(toStored(messages, origins())).toEqual([
      { role: "user", text: "look", attachments: [{ path: "a.ts", bytes: 3 }] },
      { role: "user", text: "plain" },
      { role: "assistant", text: "**hi**", format: "markdown" },
      { role: "assistant", text: "plain text" },
      { role: "assistant", text: "half", incomplete: true },
      { role: "error", text: "Timed out" },
      { role: "separator", text: "reopened" },
    ]);
  });
});

describe("fromStored", () => {
  test("maps the entries back", () => {
    const stored: StoredMessage[] = [
      { role: "user", text: "look", attachments: [{ path: "a.ts", bytes: 3 }] },
      { role: "user", text: "plain" },
      { role: "assistant", text: "**hi**", format: "markdown" },
      { role: "assistant", text: "half", incomplete: true },
      { role: "error", text: "Timed out" },
      { role: "separator", text: "reopened" },
    ];
    expect(fromStored(stored, origins())).toEqual([
      { role: "user", text: "look", attachments: [{ path: "a.ts", bytes: 3 }] },
      { role: "user", text: "plain", attachments: [] },
      { role: "assistant", text: "**hi**", format: "markdown" },
      { role: "assistant", text: "half", incomplete: true },
      { role: "error", text: "Timed out" },
      { role: "separator", text: "reopened" },
    ]);
  });

  test("shows a TUI shell entry as plain text", () => {
    const shell: StoredMessage = {
      role: "shell",
      text: "ls",
      shell: {
        command: "ls",
        output: "a\nb\n",
        exitCode: 0,
        interrupted: false,
        droppedBytes: 0,
        durationMs: 3,
      },
    };
    expect(fromStored([shell], origins())).toEqual([
      { role: "user", text: "$ ls\na\nb\n", attachments: [] },
    ]);
  });

  test("a shell entry without output is the command alone", () => {
    expect(fromStored([{ role: "shell", text: "true" }], origins())).toEqual([
      { role: "user", text: "$ true", attachments: [] },
    ]);
  });

  test("a shell entry survives the round trip unchanged", () => {
    const shell: StoredMessage = {
      role: "shell",
      text: "ls",
      failed: true,
      shell: {
        command: "ls",
        output: "a\n",
        exitCode: null,
        interrupted: true,
        droppedBytes: 9,
        durationMs: 3,
        signal: "SIGTERM",
      },
    };
    const o = origins();
    const shown = fromStored([shell, { role: "user", text: "next" }], o);
    expect(toStored(shown, o)).toEqual([shell, { role: "user", text: "next" }]);
  });

  test("a copy of a shown shell entry is an ordinary message", () => {
    // getState() hands out copies; only the controller's own objects carry
    // an origin.
    const o = origins();
    const [shown] = fromStored([{ role: "shell", text: "ls" }], o);
    expect(toStored([{ ...(shown as Message) }], o)).toEqual([
      { role: "user", text: "$ ls" },
    ]);
  });
});
