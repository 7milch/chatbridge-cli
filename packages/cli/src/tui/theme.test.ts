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
  test("registers every markup scope the bundled grammar emits", () => {
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
