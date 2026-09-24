import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { BUNDLED_LANGUAGES, bundledGrammars } from "./grammars.js";

// The four filetypes OpenTUI 0.5.10 bundles itself; an alias on one of
// them would silently replace the built-in grammar.
const OPENTUI_BUNDLED = ["javascript", "typescript", "markdown", "zig"];

describe("bundledGrammars", () => {
  test("describes exactly the five languages, in order", () => {
    expect(bundledGrammars().map((g) => g.filetype)).toEqual([
      ...BUNDLED_LANGUAGES,
    ]);
    expect([...BUNDLED_LANGUAGES]).toEqual([
      "python",
      "ruby",
      "json",
      "bash",
      "go",
    ]);
  });

  test.each(bundledGrammars().map((g) => [g.filetype, g] as const))(
    "%s: absolute paths to an existing wasm and a non-empty query",
    (_name, g) => {
      expect(isAbsolute(g.wasm)).toBe(true);
      expect(existsSync(g.wasm)).toBe(true);
      const magic = readFileSync(g.wasm).subarray(0, 4);
      expect([...magic]).toEqual([0x00, 0x61, 0x73, 0x6d]);
      expect(g.queries.highlights).toHaveLength(1);
      const query = g.queries.highlights[0] ?? "";
      expect(isAbsolute(query)).toBe(true);
      expect(readFileSync(query, "utf8").trim().length).toBeGreaterThan(0);
    },
  );

  test("aliases match the spec", () => {
    const aliases = Object.fromEntries(
      bundledGrammars().map((g) => [g.filetype, g.aliases]),
    );
    expect(aliases).toEqual({
      python: ["py", "python3"],
      ruby: ["rb"],
      json: ["jsonc", "json5"],
      bash: ["sh", "shell", "zsh", "console"],
      go: ["golang"],
    });
  });

  test("filetypes and aliases are unique and never an OpenTUI built-in", () => {
    const all = bundledGrammars().flatMap((g) => [
      g.filetype,
      ...(g.aliases ?? []),
    ]);
    expect(new Set(all).size).toBe(all.length);
    for (const reserved of OPENTUI_BUNDLED) expect(all).not.toContain(reserved);
  });
});
