import { describe, expect, test } from "bun:test";
import {
  SLASH_COMMANDS,
  commandInfoOf,
  commandNamesOf,
  commandWordAt,
  helpText,
  matchCommands,
  parseSlashCommand,
  slashPrefixAt,
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
  test("/copy is a built-in and takes no arguments", () => {
    expect(parseSlashCommand("/copy", new Set())).toEqual({ command: "copy" });
    expect(parseSlashCommand("/copy 2", new Set())).toEqual({
      error: "/copy takes no arguments.",
    });
  });
  test("a built-in still wins over a same-named custom entry", () => {
    expect(parseSlashCommand("/help", new Set(["help"]))).toEqual({
      command: "help",
    });
  });
});

describe("helpText", () => {
  test("lists /copy, just before /help", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names.at(-2)).toBe("copy");
    expect(names.at(-1)).toBe("help");
    expect(helpText([])).toContain("/copy");
  });
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
    expect(lines.at(-2)).toBe("/model      Show the model");
    expect(lines.at(-1)).toBe("/summarize  Summarize");
    expect(lines[0]).toMatch(/^\/login {6}/);
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

describe("slashPrefixAt", () => {
  test("a lone slash yields the empty prefix", () => {
    expect(slashPrefixAt("/", 1)).toBe("");
  });
  test("the prefix runs from the slash to the cursor", () => {
    expect(slashPrefixAt("/help", 5)).toBe("help");
    expect(slashPrefixAt("/help", 3)).toBe("he");
    expect(slashPrefixAt("/help", 1)).toBe("");
  });
  test("a cursor before the slash does not count", () => {
    expect(slashPrefixAt("/help", 0)).toBeUndefined();
  });
  test("past the first word it no longer applies", () => {
    expect(slashPrefixAt("/new ", 5)).toBeUndefined();
    expect(slashPrefixAt("/translate hello", 16)).toBeUndefined();
    // Still inside the word while the cursor is at its end.
    expect(slashPrefixAt("/translate hello", 10)).toBe("translate");
  });
  test("the slash must start the text", () => {
    expect(slashPrefixAt(" /help", 6)).toBeUndefined();
    expect(slashPrefixAt("see /help", 9)).toBeUndefined();
    expect(slashPrefixAt("", 0)).toBeUndefined();
  });
  test("a newline ends the word like any whitespace", () => {
    expect(slashPrefixAt("/help\nmore", 5)).toBe("help");
    expect(slashPrefixAt("/help\nmore", 9)).toBeUndefined();
  });
});

describe("commandWordAt", () => {
  test("the whole word and the offset after it", () => {
    expect(commandWordAt("/help", 3)).toEqual({ word: "help", end: 5 });
    expect(commandWordAt("/", 1)).toEqual({ word: "", end: 1 });
    expect(commandWordAt("/translate hi", 4)).toEqual({
      word: "translate",
      end: 10,
    });
  });
  test("undefined wherever slashPrefixAt is undefined", () => {
    expect(commandWordAt("/new ", 5)).toBeUndefined();
    expect(commandWordAt("see /help", 9)).toBeUndefined();
    expect(commandWordAt("/help", 0)).toBeUndefined();
  });
});

describe("matchCommands", () => {
  const custom = [
    { name: "model", description: "Show the model" },
    { name: "logs", description: "Show the logs" },
  ];
  test("the empty prefix lists the built-ins, then the provider's", () => {
    expect(matchCommands("", custom).map((c) => c.name)).toEqual([
      ...SLASH_COMMANDS.map((c) => c.name),
      "model",
      "logs",
    ]);
  });
  test("filters by prefix, keeping each group's order", () => {
    expect(matchCommands("lo", custom).map((c) => c.name)).toEqual([
      "login",
      "logout",
      "logs",
    ]);
  });
  test("is case-insensitive", () => {
    expect(matchCommands("LOG", custom).map((c) => c.name)).toEqual([
      "login",
      "logout",
      "logs",
    ]);
  });
  test("no match is an empty list", () => {
    expect(matchCommands("zz", custom)).toEqual([]);
  });
  test("custom is optional and descriptions come along", () => {
    expect(matchCommands("new")).toEqual([
      { name: "new", description: "Start a new chat" },
    ]);
  });
});
