import { describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { MUTED_COLOR, styled, theme } from "./theme.js";

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

  test("styled joins chunks and strings into one StyledText", () => {
    const s = styled(theme.badge(" a "), " ", theme.muted("b"));
    expect(s.chunks.map((c) => c.text)).toEqual([" a ", " ", "b"]);
    expect(s.chunks[1]?.attributes ?? 0).toBe(TextAttributes.NONE);
  });
});
