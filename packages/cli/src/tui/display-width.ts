/** Terminal cell widths. A Japanese character or an emoji takes two cells,
 * so `length` and `padEnd` misalign and overflow anything drawn from them. */

const ELLIPSIS = "…";

/** East Asian Wide and Fullwidth blocks, and the emoji planes, as inclusive
 * code point ranges. Close enough for titles and paths; Bun measures
 * exactly and is used when present. */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26f2, 0x26f5],
  [0x26fa, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x2753, 0x2755],
  [0x2795, 0x2797],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

/** Marks drawn on the cell before them: combining marks, zero-width
 * spaces and joiners, variation selectors. */
const ZERO: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xe0100, 0xe01ef],
];

function within(
  code: number,
  ranges: ReadonlyArray<readonly [number, number]>,
): boolean {
  for (const [lo, hi] of ranges) {
    if (code < lo) return false;
    if (code <= hi) return true;
  }
  return false;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** The width without Bun: a grapheme is as wide as its first code point,
 * so an emoji sequence joined with ZWJ counts once. */
export function fallbackWidth(text: string): number {
  let width = 0;
  for (const g of graphemes(text)) {
    const code = g.codePointAt(0) ?? 0;
    if (within(code, ZERO)) continue;
    width += within(code, WIDE) ? 2 : 1;
  }
  return width;
}

/** Interactive mode also runs under Node >= 26.4, which has no Bun global. */
const bunWidth = (
  globalThis as { Bun?: { stringWidth?: (text: string) => number } }
).Bun?.stringWidth;

/** Terminal cells `text` takes. */
export function displayWidth(text: string): number {
  return bunWidth ? bunWidth(text) : fallbackWidth(text);
}

/** The longest prefix of whole graphemes that fits in `cells`. */
function prefix(text: string, cells: number): string {
  let out = "";
  let width = 0;
  for (const g of graphemes(text)) {
    const w = displayWidth(g);
    if (width + w > cells) break;
    out += g;
    width += w;
  }
  return out;
}

/** `text` cut to `cells`, whole graphemes only. For rows a draw would
 * otherwise overflow. */
export function clipToWidth(text: string, cells: number): string {
  return displayWidth(text) <= cells ? text : prefix(text, cells);
}

/** `text` shortened to `cells`, ending with `…` when it was shortened. */
export function fitToWidth(text: string, cells: number): string {
  if (displayWidth(text) <= cells) return text;
  return `${prefix(text, Math.max(0, cells - 1))}${ELLIPSIS}`;
}

/** `text` padded with spaces to `cells`; wider text is left as it is. */
export function padToWidth(text: string, cells: number): string {
  return text + " ".repeat(Math.max(0, cells - displayWidth(text)));
}
