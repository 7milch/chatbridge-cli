import { describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import {
  DEFAULT_FG,
  MUTED_COLOR,
  colored,
  markdownSyntaxStyle,
  mixHex,
  styled,
  theme,
} from "./theme.js";

describe("theme", () => {
  test("badge is bold and inverse without a colour", () => {
    const c = theme.badge("x");
    expect(c.text).toBe("x");
    expect(c.attributes).toBe(TextAttributes.BOLD | TextAttributes.INVERSE);
    expect(c.fg).toBeUndefined();
  });

  test("title is bold only", () => {
    expect(theme.title("x").attributes).toBe(TextAttributes.BOLD);
    expect(theme.title("x").fg).toBeUndefined();
  });

  test("muted is dim only", () => {
    expect(theme.muted("x").attributes).toBe(TextAttributes.DIM);
    expect(theme.muted("x").fg).toBeUndefined();
  });

  test.each([
    ["user", 4],
    ["assistant", 2],
    ["error", 1],
    ["shell", 3],
  ] as const)("%s label is bold with ANSI index %i", (name, index) => {
    const c = theme[name]("x");
    expect(c.attributes).toBe(TextAttributes.BOLD);
    expect(c.fg?.intent).toBe("indexed");
    expect(c.fg?.slot).toBe(index);
  });

  test("errorText is plain red", () => {
    const c = theme.errorText("x");
    expect(c.attributes ?? 0).toBe(TextAttributes.NONE);
    expect(c.fg?.slot).toBe(1);
  });

  test("selected is inverse", () => {
    expect(theme.selected("x").attributes).toBe(TextAttributes.INVERSE);
  });

  test("MUTED_COLOR is ANSI bright black", () => {
    expect(MUTED_COLOR.intent).toBe("indexed");
    expect(MUTED_COLOR.slot).toBe(8);
  });

  test("DEFAULT_FG is the terminal foreground, not a fixed colour", () => {
    expect(DEFAULT_FG.intent).toBe("default");
  });

  test("styled joins chunks and strings into one StyledText", () => {
    const s = styled(theme.badge(" a "), " ", theme.muted("b"));
    expect(s.chunks.map((c) => c.text)).toEqual([" a ", " ", "b"]);
    expect(s.chunks[1]?.attributes ?? 0).toBe(TextAttributes.NONE);
  });

  test("colored: a number is an ANSI index, a string a hex colour", () => {
    const idx = colored(4)("x");
    expect(idx.text).toBe("x");
    expect(idx.attributes).toBe(TextAttributes.NONE);
    expect(idx.fg?.intent).toBe("indexed");
    expect(idx.fg?.slot).toBe(4);
    const hex = colored("#ff0000")("x");
    expect(hex.fg?.r).toBeCloseTo(1);
    expect(hex.fg?.g).toBeCloseTo(0);
    expect(hex.fg?.b).toBeCloseTo(0);
  });
});

describe("markdownSyntaxStyle", () => {
  // These are the capture names @opentui/core's bundled tree-sitter query
  // (assets/markdown/highlights.scm, plus markdown_inline) emits, not the
  // names the theme happens to define. The style lookup only falls back to
  // the first dot segment, so a missing exact key renders as plain text.
  // The list is the scopes the theme styles, not every capture the grammar
  // has: link URLs, task markers and strikethrough fall back to `default` on
  // purpose. `markup.raw.block` covers code the markdown grammar highlights
  // itself (indented code, blockquote content); a fenced block is its own
  // CodeRenderable highlighted by the language grammar, see the code scopes
  // below.
  test("registers the markup scopes the bundled grammar emits for the styled constructs", () => {
    const style = markdownSyntaxStyle();
    try {
      for (const scope of [
        "markup.heading.1",
        "markup.heading.2",
        "markup.heading.3",
        "markup.heading.4",
        "markup.heading.5",
        "markup.heading.6",
        "markup.heading",
        "markup.strong",
        "markup.italic",
        "markup.raw",
        "markup.raw.block",
        "markup.link",
        "markup.list",
        "markup.quote",
      ]) {
        expect(style.getStyle(scope)).toBeDefined();
      }
    } finally {
      style.destroy();
    }
  });

  // The capture names assets/javascript/highlights.scm and
  // assets/typescript/highlights.scm emit for a fenced block whose info
  // string names a bundled grammar. Scopes left out (`property`, `variable`,
  // `operator`, `punctuation.*`, `embedded`) fall to `default` on purpose.
  test("registers the code scopes the bundled JS and TS grammars emit", () => {
    const style = markdownSyntaxStyle();
    try {
      for (const scope of [
        "keyword",
        "string",
        "string.special",
        "comment",
        "function",
        "function.method",
        "function.builtin",
        "constructor",
        "number",
        "constant",
        "constant.builtin",
        "type",
        "variable.builtin",
      ]) {
        expect(style.getStyle(scope)).toBeDefined();
      }
    } finally {
      style.destroy();
    }
  });

  // Captures the five grammars shipped in packages/cli/assets emit that
  // neither the theme nor the first-segment fallback would style: `escape`
  // has no base, and `string.special.key` (a JSON key) should not read as
  // an ordinary string.
  test("registers the scopes the shipped grammars add", () => {
    const style = markdownSyntaxStyle();
    try {
      expect(style.getStyle("escape")?.fg?.intent).toBe("indexed");
      expect(style.getStyle("escape")?.fg?.slot).toBe(2);
      expect(style.getStyle("string.special.key")?.fg?.intent).toBe("indexed");
      expect(style.getStyle("string.special.key")?.fg?.slot).toBe(4);
    } finally {
      style.destroy();
    }
  });

  test("code scope colours come from the ANSI palette", () => {
    const style = markdownSyntaxStyle();
    try {
      const slot = (scope: string) => {
        const s = style.getStyle(scope);
        expect(s?.fg?.intent).toBe("indexed");
        return s?.fg?.slot;
      };
      expect(slot("keyword")).toBe(5);
      expect(slot("string")).toBe(2);
      expect(slot("string.special")).toBe(2);
      expect(slot("comment")).toBe(8);
      expect(style.getStyle("comment")?.italic).toBe(true);
      expect(slot("function")).toBe(4);
      expect(slot("function.method")).toBe(4);
      expect(slot("function.builtin")).toBe(4);
      expect(slot("constructor")).toBe(4);
      expect(slot("number")).toBe(3);
      expect(slot("constant")).toBe(3);
      expect(slot("constant.builtin")).toBe(3);
      expect(slot("type")).toBe(6);
      expect(slot("variable.builtin")).toBe(6);
      // Left to the terminal foreground on purpose.
      expect(style.getStyle("property")).toBeUndefined();
      expect(style.getStyle("operator")).toBeUndefined();
    } finally {
      style.destroy();
    }
  });

  test("colours come from the ANSI palette, not fixed truecolour", () => {
    const style = markdownSyntaxStyle();
    try {
      const heading = style.getStyle("markup.heading");
      expect(heading?.bold).toBe(true);
      expect(heading?.fg?.intent).toBe("indexed");
      expect(heading?.fg?.slot).toBe(2);
      expect(style.getStyle("markup.raw")?.fg?.slot).toBe(3);
      expect(style.getStyle("markup.heading.1")?.bold).toBe(true);
      expect(style.getStyle("markup.heading.1")?.fg?.slot).toBe(2);
      expect(style.getStyle("markup.raw.block")?.fg?.slot).toBe(3);
      const link = style.getStyle("markup.link");
      expect(link?.fg?.slot).toBe(4);
      expect(link?.underline).toBe(true);
      expect(style.getStyle("markup.italic")?.italic).toBe(true);
      expect(style.getStyle("markup.list")?.fg?.slot).toBe(MUTED_COLOR.slot);
    } finally {
      style.destroy();
    }
  });
});

describe("markdownSyntaxStyle default scope", () => {
  test("is the terminal foreground", () => {
    const style = markdownSyntaxStyle();
    try {
      expect(style.getStyle("default")?.fg?.intent).toBe("default");
    } finally {
      style.destroy();
    }
  });
});

describe("mixHex", () => {
  test("endpoints and midpoint", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#ff0000", "#0000ff", 0.25)).toBe("#bf0040");
  });
});
