import { describe, expect, test } from "bun:test";
import {
  clipToWidth,
  displayWidth,
  fallbackWidth,
  fitToWidth,
  padToWidth,
} from "./display-width.js";

describe("displayWidth", () => {
  test("counts a Japanese character as two cells", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth("aあ")).toBe(3);
  });

  test("counts an emoji as two cells", () => {
    expect(displayWidth("😀")).toBe(2);
  });
});

describe("fallbackWidth", () => {
  // What interactive mode measures with under Node, where Bun.stringWidth
  // does not exist.
  test("treats East Asian wide and fullwidth code points as two cells", () => {
    expect(fallbackWidth("abc")).toBe(3);
    expect(fallbackWidth("日本語")).toBe(6);
    expect(fallbackWidth("ｶﾀｶﾅ")).toBe(4);
    expect(fallbackWidth("ＡＢ")).toBe(4);
    expect(fallbackWidth("한글")).toBe(4);
    expect(fallbackWidth("😀")).toBe(2);
  });

  test("gives combining marks no cell of their own", () => {
    expect(fallbackWidth("é")).toBe(1);
  });

  test("agrees with Bun.stringWidth on the titles the picker draws", () => {
    for (const s of ["short", "日本語のタイトル", "mixed 日本 text", "😀 go"]) {
      expect(fallbackWidth(s)).toBe(displayWidth(s));
    }
  });
});

describe("fitToWidth", () => {
  test("keeps text that fits", () => {
    expect(fitToWidth("abc", 3)).toBe("abc");
    expect(fitToWidth("日本", 4)).toBe("日本");
  });

  test("shortens to the budget and ends with an ellipsis", () => {
    expect(fitToWidth("abcdef", 4)).toBe("abc…");
    expect(displayWidth(fitToWidth("日本語のタイトル", 7))).toBeLessThanOrEqual(
      7,
    );
    expect(fitToWidth("日本語のタイトル", 7)).toBe("日本語…");
  });

  test("never splits an emoji", () => {
    const fitted = fitToWidth("😀😀😀", 4);
    expect(fitted).toBe("😀…");
    expect(fitted.isWellFormed()).toBe(true);
  });

  test("never splits a grapheme made of several code points", () => {
    const family = "👨‍👩‍👧";
    const fitted = fitToWidth(`${family}${family}`, 3);
    expect(fitted).toBe(`${family}…`);
  });
});

describe("padToWidth", () => {
  test("pads by cells, not code units", () => {
    expect(padToWidth("ab", 4)).toBe("ab  ");
    expect(padToWidth("日本", 6)).toBe("日本  ");
    expect(padToWidth("日本", 3)).toBe("日本");
  });
});

describe("clipToWidth", () => {
  test("cuts at the budget without an ellipsis", () => {
    expect(clipToWidth("x".repeat(10), 4)).toBe("xxxx");
    expect(clipToWidth("日本語", 5)).toBe("日本");
  });
});
