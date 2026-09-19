import { describe, expect, test } from "bun:test";
import {
  SLASH_COMMANDS,
  commandInfoOf,
  commandNamesOf,
  helpText,
  parseSlashCommand,
  unknownCommandMessage,
} from "./slash-commands.js";

const custom = new Set(["model", "translate"]);

describe("parseSlashCommand", () => {
  test("bare command, with surrounding whitespace", () => {
    expect(parseSlashCommand("/login")).toEqual({ command: "login" });
    expect(parseSlashCommand("  /help \n")).toEqual({ command: "help" });
  });
  test("every table entry parses", () => {
    for (const c of SLASH_COMMANDS) {
      expect(parseSlashCommand(`/${c.name}`)).toEqual({ command: c.name });
    }
  });
  test("unknown word", () => {
    expect(parseSlashCommand("/frobnicate")).toEqual({ unknown: "frobnicate" });
  });
  test("not a command: plain text, lone slash, path, second line without a space", () => {
    expect(parseSlashCommand("login")).toBeUndefined();
    expect(parseSlashCommand("/")).toBeUndefined();
    expect(parseSlashCommand("/usr/bin/env")).toBeUndefined();
  });
  test("a built-in with arguments is an error, not a message", () => {
    expect(parseSlashCommand("/login now")).toEqual({
      error: "/login takes no arguments.",
    });
    expect(parseSlashCommand("/login\nmore")).toEqual({
      error: "/login takes no arguments.",
    });
  });
  test("custom command with and without arguments", () => {
    expect(parseSlashCommand("/model", custom)).toEqual({
      custom: "model",
      args: "",
    });
    expect(parseSlashCommand("/translate  hello world ", custom)).toEqual({
      custom: "translate",
      args: "hello world",
    });
    expect(parseSlashCommand("/translate\nline one\nline two", custom)).toEqual(
      { custom: "translate", args: "line one\nline two" },
    );
  });
  test("a custom name is unknown without the set", () => {
    expect(parseSlashCommand("/model")).toEqual({ unknown: "model" });
    expect(parseSlashCommand("/model x")).toEqual({ unknown: "model" });
  });
  test("a built-in still wins over a same-named custom entry", () => {
    expect(parseSlashCommand("/help", new Set(["help"]))).toEqual({
      command: "help",
    });
  });
});

describe("helpText", () => {
  test("lists every built-in with its description", () => {
    const text = helpText();
    for (const c of SLASH_COMMANDS) {
      expect(text).toContain(`/${c.name}`);
      expect(text).toContain(c.description);
    }
  });
  test("appends custom commands after the built-ins, aligned to the longest", () => {
    const text = helpText([
      { name: "model", description: "Show the model" },
      { name: "summarize", description: "Summarize" },
    ]);
    const lines = text.split("\n");
    expect(lines).toHaveLength(SLASH_COMMANDS.length + 2);
    expect(lines.at(-2)).toBe("/model     Show the model");
    expect(lines.at(-1)).toBe("/summarize Summarize");
    expect(lines[0]).toMatch(/^\/login {5}/);
  });
});

test("unknownCommandMessage", () => {
  expect(unknownCommandMessage("x")).toBe("Unknown command: /x. Type /help.");
});

test("a capitalised /Login is plain text", () => {
  expect(parseSlashCommand("/Login")).toBeUndefined();
});

test("commandNamesOf / commandInfoOf", () => {
  expect(commandNamesOf({})).toEqual(new Set());
  const p = {
    commands: [{ name: "model", description: "d" }],
  };
  expect(commandNamesOf(p)).toEqual(new Set(["model"]));
  expect(commandInfoOf(p)).toEqual([{ name: "model", description: "d" }]);
  expect(commandInfoOf({})).toEqual([]);
});
