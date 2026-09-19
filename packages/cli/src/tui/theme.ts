import {
  RGBA,
  StyledText,
  TextAttributes,
  type TextChunk,
} from "@opentui/core";
import type { SpinnerColor } from "./spinner.js";

/** One place for every style the TUI uses. Colours are ANSI indexed so the
 * terminal palette applies in light and dark themes; OpenTUI's `blue()`
 * helpers emit fixed truecolour values and are deliberately not used. */
export type Styler = (text: string) => TextChunk;

const ANSI = { red: 1, green: 2, yellow: 3, blue: 4, brightBlack: 8 } as const;

// `__isChunk: true` is OpenTUI's runtime discriminator for TextChunk
// (0.5.10). A rename would not be caught by the type-check, so re-check
// this when bumping past that version.
function chunk(text: string, attributes: number, fg?: RGBA): TextChunk {
  const c: TextChunk = { __isChunk: true, text, attributes };
  if (fg) c.fg = fg;
  return c;
}

const make =
  (attributes: number, fg?: number): Styler =>
  (text) =>
    chunk(text, attributes, fg === undefined ? undefined : RGBA.fromIndex(fg));

/** Border and placeholder colour (those take an RGBA, not a chunk style). */
export const MUTED_COLOR: RGBA = RGBA.fromIndex(ANSI.brightBlack);

export const theme = {
  badge: make(TextAttributes.BOLD | TextAttributes.INVERSE),
  title: make(TextAttributes.BOLD),
  muted: make(TextAttributes.DIM),
  user: make(TextAttributes.BOLD, ANSI.blue),
  assistant: make(TextAttributes.BOLD, ANSI.green),
  error: make(TextAttributes.BOLD, ANSI.red),
  /** Shell-mode prompt, the `shell` role label and its command line. */
  shell: make(TextAttributes.BOLD, ANSI.yellow),
  errorText: make(TextAttributes.NONE, ANSI.red),
  selected: make(TextAttributes.INVERSE),
};

/** Plain text in a vendor-chosen colour: a number is an ANSI palette index
 * (follows the terminal palette), a string is "#rrggbb". */
export function colored(color: SpinnerColor): Styler {
  const fg =
    typeof color === "number" ? RGBA.fromIndex(color) : RGBA.fromHex(color);
  return (text) => chunk(text, TextAttributes.NONE, fg);
}

/** Builds a StyledText from chunks and plain strings. */
export function styled(...parts: Array<TextChunk | string>): StyledText {
  return new StyledText(
    parts.map((p) =>
      typeof p === "string" ? chunk(p, TextAttributes.NONE) : p,
    ),
  );
}

/** Linear mix of two "#rrggbb" colours; t = 0 gives `a`, 1 gives `b`. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = Number.parseInt(a.slice(1), 16);
  const pb = Number.parseInt(b.slice(1), 16);
  const ch = (shift: number) => {
    const x = (pa >> shift) & 0xff;
    const y = (pb >> shift) & 0xff;
    return Math.round(x + (y - x) * t);
  };
  const v = (ch(16) << 16) | (ch(8) << 8) | ch(0);
  return `#${v.toString(16).padStart(6, "0")}`;
}
