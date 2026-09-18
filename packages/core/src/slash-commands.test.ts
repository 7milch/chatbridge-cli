import { describe, expect, test } from "bun:test";
import {
  SLASH_COMMANDS,
  helpText,
  parseSlashCommand,
  unknownCommandMessage,
} from "./slash-commands.js";

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
  test("not a command: arguments, extra lines, plain text, lone slash", () => {
    expect(parseSlashCommand("/login now")).toBeUndefined();
    expect(parseSlashCommand("/login\nmore")).toBeUndefined();
    expect(parseSlashCommand("login")).toBeUndefined();
    expect(parseSlashCommand("/")).toBeUndefined();
    expect(parseSlashCommand("/usr/bin/env")).toBeUndefined();
  });
});

test("helpText lists every command with its description", () => {
  const text = helpText();
  for (const c of SLASH_COMMANDS) {
    expect(text).toContain(`/${c.name}`);
    expect(text).toContain(c.description);
  }
});

test("unknownCommandMessage", () => {
  expect(unknownCommandMessage("x")).toBe("Unknown command: /x. Type /help.");
});
