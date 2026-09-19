import { describe, expect, test } from "bun:test";
import { RGBA, TextAttributes } from "@opentui/core";
import { bannerColorAt, resolveBanner, validateBanner } from "./banner.js";

const text = (lines: ReturnType<typeof resolveBanner>) =>
  lines.map((l) => l.chunks.map((c) => c.text).join(""));

/** The fg colour covering `cellIndex` code points into `line`'s chunks. */
const fgOf = (
  line: ReturnType<typeof resolveBanner>[number],
  cellIndex: number,
) => {
  let i = 0;
  for (const chunk of line.chunks) {
    i += [...chunk.text].length;
    if (cellIndex < i) return chunk.fg;
  }
  return undefined;
};

describe("resolveBanner", () => {
  test("default banner: bold name, muted version, muted connection line and hint", () => {
    const lines = resolveBanner({
      name: "chatbridge",
      version: "0.3.0",
      providerName: "dummy-chat",
    });
    expect(text(lines)).toEqual([
      "chatbridge v0.3.0",
      "Connected to dummy-chat.",
      "Type a message, @ to attach a file, ! to run a command.",
    ]);
    const [title, connected, hint] = lines;
    expect(title?.chunks[0]?.attributes).toBe(TextAttributes.BOLD);
    expect(title?.chunks[1]?.attributes).toBe(TextAttributes.DIM);
    expect(connected?.chunks[0]?.attributes).toBe(TextAttributes.DIM);
    expect(hint?.chunks[0]?.attributes).toBe(TextAttributes.DIM);
  });

  test("a long provider name never pushes the hint past 80 cells", () => {
    const lines = text(
      resolveBanner({ name: "acme", providerName: "a".repeat(40) }),
    );
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(lines[2]).toBe(
      "Type a message, @ to attach a file, ! to run a command.",
    );
  });

  test("default banner without a version shows the name alone", () => {
    const lines = resolveBanner({ name: "acme", providerName: "p" });
    expect(text(lines)[0]).toBe("acme");
    expect(lines[0]?.chunks).toHaveLength(1);
  });

  test("vendor banner is used verbatim, every line muted", () => {
    const lines = resolveBanner({
      name: "acme",
      version: "9.9.9",
      providerName: "p",
      banner: ["  __ __", "Acme internal assistant", ""],
    });
    expect(text(lines)).toEqual(["  __ __", "Acme internal assistant", ""]);
    for (const l of lines) {
      expect(l.chunks[0]?.attributes).toBe(TextAttributes.DIM);
    }
  });
});

describe("bannerColorAt", () => {
  test("per-line cycles by row", () => {
    const spec = { rows: 3, colors: [1, 2], mode: "per-line" as const };
    expect([0, 1, 2].map((r) => bannerColorAt(r, 5, spec))).toEqual([1, 2, 1]);
  });
  test("per-char cycles diagonally", () => {
    const spec = {
      rows: 2,
      colors: ["#a", "#b", "#c"],
      mode: "per-char" as const,
    };
    expect(bannerColorAt(0, 0, spec)).toBe("#a");
    expect(bannerColorAt(0, 1, spec)).toBe("#b");
    expect(bannerColorAt(1, 0, spec)).toBe("#b");
    expect(bannerColorAt(1, 2, spec)).toBe("#a");
  });
  test("gradient interpolates down the rows", () => {
    const spec = {
      rows: 3,
      colors: ["#000000", "#ffffff"],
      mode: "gradient" as const,
    };
    expect(bannerColorAt(0, 0, spec)).toBe("#000000");
    expect(bannerColorAt(1, 9, spec)).toBe("#808080");
    expect(bannerColorAt(2, 0, spec)).toBe("#ffffff");
  });
  test("gradient over three stops and a single row", () => {
    const spec = {
      rows: 5,
      colors: ["#000000", "#ffffff", "#000000"],
      mode: "gradient" as const,
    };
    expect(bannerColorAt(2, 0, spec)).toBe("#ffffff");
    expect(bannerColorAt(0, 0, { ...spec, rows: 1 })).toBe("#000000");
  });
  test("horizontal gradient runs along the columns", () => {
    const spec = {
      rows: 2,
      maxWidth: 3,
      colors: ["#000000", "#ffffff"],
      mode: "gradient" as const,
      direction: "horizontal" as const,
    };
    expect(bannerColorAt(0, 0, spec)).toBe("#000000");
    expect(bannerColorAt(1, 1, spec)).toBe("#808080");
    expect(bannerColorAt(0, 2, spec)).toBe("#ffffff");
  });
  test("diagonal gradient uses row + col", () => {
    const spec = {
      rows: 2,
      maxWidth: 2,
      colors: ["#000000", "#ffffff"],
      mode: "gradient" as const,
      direction: "diagonal" as const,
    };
    expect(bannerColorAt(0, 0, spec)).toBe("#000000");
    expect(bannerColorAt(0, 1, spec)).toBe("#808080");
    expect(bannerColorAt(1, 0, spec)).toBe("#808080");
    expect(bannerColorAt(1, 1, spec)).toBe("#ffffff");
  });
  test("a cell landing exactly on a stop keeps the vendor's exact string", () => {
    const single = {
      rows: 1,
      colors: ["#FF0000", "#0000FF"],
      mode: "gradient" as const,
    };
    expect(bannerColorAt(0, 0, single)).toBe("#FF0000");
    const three = {
      rows: 3,
      colors: ["#FF0000", "#0000FF"],
      mode: "gradient" as const,
    };
    expect(bannerColorAt(2, 0, three)).toBe("#0000FF");
    expect(bannerColorAt(1, 0, three)).toBe("#800080");
  });
  test("a zero denominator yields the first stop", () => {
    const spec = {
      rows: 1,
      maxWidth: 1,
      colors: ["#000000", "#ffffff"],
      mode: "gradient" as const,
      direction: "horizontal" as const,
    };
    expect(bannerColorAt(0, 0, spec)).toBe("#000000");
  });
  test("horizontal columns are measured on the centred grid", () => {
    const [wide, narrow] = resolveBanner({
      name: "x",
      providerName: "p",
      banner: {
        lines: ["abcde", "c"],
        colors: ["#000000", "#ffffff"],
        mode: "gradient",
        direction: "horizontal",
      },
    });
    // "c" sits at column 2 of a 5-wide grid: the same colour as wide[2].
    expect(narrow).toBeDefined();
    expect(wide).toBeDefined();
    expect(fgOf(narrow as NonNullable<typeof narrow>, 0)).toEqual(
      fgOf(wide as NonNullable<typeof wide>, 2),
    );
  });
});

describe("validateBanner", () => {
  test("plain lines and a colourless object pass", () => {
    expect(() => validateBanner(["a"])).not.toThrow();
    expect(() => validateBanner({ lines: ["a"] })).not.toThrow();
    expect(() => validateBanner(undefined)).not.toThrow();
  });
  test("gradient needs two or more hex colours", () => {
    expect(() =>
      validateBanner({ lines: ["a"], colors: ["#000000"], mode: "gradient" }),
    ).toThrow(/banner.colors/);
    expect(() =>
      validateBanner({
        lines: ["a"],
        colors: ["#000000", 4],
        mode: "gradient",
      }),
    ).toThrow(/hex/);
  });
  test("per-line rejects a malformed hex colour", () => {
    expect(() => validateBanner({ lines: ["a"], colors: ["#a"] })).toThrow(
      /banner.colors/,
    );
    expect(() =>
      validateBanner({ lines: ["a"], colors: [1, "#ff0000"] }),
    ).not.toThrow();
  });
  test("per-line and per-char need at least one colour", () => {
    expect(() =>
      validateBanner({ lines: ["a"], colors: [], mode: "per-char" }),
    ).toThrow(/banner.colors/);
  });
  test("rejects an unknown direction", () => {
    expect(() =>
      validateBanner({
        lines: ["a"],
        colors: ["#000000", "#ffffff"],
        mode: "gradient",
        direction: "sideways" as never,
      }),
    ).toThrow(
      'banner.direction: expected "vertical" | "horizontal" | "diagonal"',
    );
  });
});

describe("resolveBanner with colours", () => {
  test("per-line: one chunk per line in the row's colour", () => {
    const lines = resolveBanner({
      name: "x",
      providerName: "p",
      banner: { lines: ["ab", "cd"], colors: ["#ff0000", "#00ff00"] },
    });
    expect(text(lines)).toEqual(["ab", "cd"]);
    expect(lines[0]?.chunks).toHaveLength(1);
    expect(lines[0]?.chunks[0]?.fg).toEqual(RGBA.fromHex("#ff0000"));
    expect(lines[1]?.chunks[0]?.fg).toEqual(RGBA.fromHex("#00ff00"));
  });
  test("per-char: adjacent cells of one colour share a chunk", () => {
    const lines = resolveBanner({
      name: "x",
      providerName: "p",
      banner: { lines: ["abc"], colors: [1, 2], mode: "per-char" },
    });
    expect(lines[0]?.chunks.map((c) => c.text)).toEqual(["a", "b", "c"]);
    const wide = resolveBanner({
      name: "x",
      providerName: "p",
      banner: { lines: ["abcd"], colors: [1], mode: "per-char" },
    });
    expect(wide[0]?.chunks).toHaveLength(1);
  });
  test("an empty line yields one empty chunk", () => {
    const lines = resolveBanner({
      name: "x",
      providerName: "p",
      banner: { lines: [""], colors: [1], mode: "per-char" },
    });
    expect(text(lines)).toEqual([""]);
  });
});
