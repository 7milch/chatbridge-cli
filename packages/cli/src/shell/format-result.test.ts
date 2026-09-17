import { describe, expect, test } from "bun:test";
import {
  formatShellPrompt,
  formatShellSection,
  truncatedNote,
} from "./format-result.js";
import type { ShellResult } from "./run-command.js";

function result(over: Partial<ShellResult> = {}): ShellResult {
  return {
    command: "npm test",
    output: "ok\n",
    droppedBytes: 0,
    exitCode: 0,
    interrupted: false,
    durationMs: 5,
    ...over,
  };
}

describe("truncatedNote", () => {
  test("rounds the dropped bytes up to whole KB", () => {
    expect(truncatedNote(1)).toBe("… (truncated: first 1 KB dropped)");
    expect(truncatedNote(2048)).toBe("… (truncated: first 2 KB dropped)");
    expect(truncatedNote(2049)).toBe("… (truncated: first 3 KB dropped)");
  });
});

describe("formatShellSection", () => {
  test("success: heading, fence, output, fence — nothing else", () => {
    expect(formatShellSection(result())).toBe("### $ npm test\n```\nok\n```");
  });

  test("adds the missing trailing newline; empty output stays empty", () => {
    expect(formatShellSection(result({ output: "no newline" }))).toBe(
      "### $ npm test\n```\nno newline\n```",
    );
    expect(formatShellSection(result({ output: "" }))).toBe(
      "### $ npm test\n```\n```",
    );
  });

  test("non-zero exit code is appended; zero is not", () => {
    expect(formatShellSection(result({ exitCode: 1 }))).toBe(
      "### $ npm test\n```\nok\n```\nexit code: 1",
    );
  });

  test("interrupted replaces the exit code", () => {
    expect(
      formatShellSection(result({ exitCode: undefined, interrupted: true })),
    ).toBe("### $ npm test\n```\nok\n```\ninterrupted");
  });

  test("truncation note goes before the fence, in whole KB rounded up", () => {
    expect(
      formatShellSection(
        result({ droppedBytes: 312 * 1024 + 1, interrupted: true }),
      ),
    ).toBe(
      "### $ npm test\n… (truncated: first 313 KB dropped)\n```\nok\n```\ninterrupted",
    );
  });

  test("the fence grows past backtick runs in the output", () => {
    expect(formatShellSection(result({ output: "```\nx\n" }))).toBe(
      "### $ npm test\n````\n```\nx\n````",
    );
  });

  test("a signal death is named instead of an exit code", () => {
    expect(
      formatShellSection(result({ exitCode: undefined, signal: "SIGKILL" })),
    ).toBe("### $ npm test\n```\nok\n```\nkilled by SIGKILL");
  });

  test("a multi-line command is shown on one heading line", () => {
    expect(
      formatShellSection(result({ command: "echo a\necho b" })),
    ).toStartWith("### $ echo a ⏎ echo b\n");
  });
});

describe("formatShellPrompt", () => {
  test("lead-in, blank line, section", () => {
    expect(formatShellPrompt("Check this.", result({ exitCode: 2 }))).toBe(
      "Check this.\n\n### $ npm test\n```\nok\n```\nexit code: 2",
    );
  });
});
