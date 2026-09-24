import {
  RGBA,
  StyledText,
  SyntaxStyle,
  TextAttributes,
  type TextChunk,
} from "@opentui/core";
import type { SpinnerColor } from "./spinner.js";

/** One place for every style the TUI uses. Colours are ANSI indexed so the
 * terminal palette applies in light and dark themes; OpenTUI's `blue()`
 * helpers emit fixed truecolour values and are deliberately not used.
 * A chunk without a colour takes its renderable's `fg`, which OpenTUI
 * defaults to fixed white, so every renderable is built with `DEFAULT_FG`
 * (see `text.ts`). */
export type Styler = (text: string) => TextChunk;

const ANSI = {
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  brightBlack: 8,
  brightWhite: 15,
} as const;

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

/** The terminal's own foreground. OpenTUI (0.5.10) otherwise draws unstyled
 * text in truecolour white, which is invisible on a light background. */
export const DEFAULT_FG: RGBA = RGBA.defaultForeground();

/** A mouse selection. OpenTUI's default swaps fg and bg, which draws nothing
 * once fg is the terminal default, so both are named: blue is dark and
 * bright white is light in every common palette. */
export const SELECTION_BG: RGBA = RGBA.fromIndex(ANSI.blue);
export const SELECTION_FG: RGBA = RGBA.fromIndex(ANSI.brightWhite);

/** The input cursor until the terminal reports its foreground (see
 * `adoptTerminalCursor`): the cursor colour is sent to the terminal as RGB,
 * so it cannot be an indexed or default colour. Mid-grey shows on both. */
export const CURSOR_FALLBACK = "#808080";

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

/** Styles for MarkdownRenderable, from the same ANSI indices as `theme`, so
 * a reply looks like the rest of the history in any terminal palette. The
 * lookup falls back only to the first dot segment, so every multi-segment
 * scope that needs a style is registered exactly.
 *
 * Markup scopes are the captures the bundled tree-sitter markdown query
 * emits (0.5.10): headings per level, `markup.raw.block` for code the
 * markdown grammar highlights itself (indented code, blockquote content),
 * `markup.heading` for pipe-table header cells and `markup.raw` for inline
 * code.
 *
 * A fenced block is not markup: MarkdownRenderable turns it into its own
 * CodeRenderable whose filetype is the info string, so the JavaScript and
 * TypeScript grammars bundled with OpenTUI, and the Python, Ruby, JSON, Bash
 * and Go grammars this package ships (see `grammars.ts`), emit the code
 * scopes below. A block with no language, or one whose language has no
 * grammar, is not highlighted at all and the frame `text.ts` adds sets it
 * apart. Scopes not listed (`property`, `variable`, `operator`,
 * `punctuation.*`) stay on the terminal foreground.
 *
 * A style it does not find falls back to `default`, set here to the terminal
 * foreground. The caller owns the returned handle and must `destroy()` it. */
export function markdownSyntaxStyle(): SyntaxStyle {
  const heading = { fg: RGBA.fromIndex(ANSI.green), bold: true };
  const raw = { fg: RGBA.fromIndex(ANSI.yellow) };
  const keyword = { fg: RGBA.fromIndex(ANSI.magenta) };
  const string = { fg: RGBA.fromIndex(ANSI.green) };
  const comment = { fg: MUTED_COLOR, italic: true };
  const fn = { fg: RGBA.fromIndex(ANSI.blue) };
  const literal = { fg: RGBA.fromIndex(ANSI.yellow) };
  const type = { fg: RGBA.fromIndex(ANSI.cyan) };
  return SyntaxStyle.fromStyles({
    default: { fg: DEFAULT_FG },
    "markup.heading": heading,
    "markup.heading.1": heading,
    "markup.heading.2": heading,
    "markup.heading.3": heading,
    "markup.heading.4": heading,
    "markup.heading.5": heading,
    "markup.heading.6": heading,
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.raw": raw,
    "markup.raw.block": raw,
    "markup.link": { fg: RGBA.fromIndex(ANSI.blue), underline: true },
    "markup.list": { fg: MUTED_COLOR },
    "markup.quote": { fg: MUTED_COLOR, italic: true },
    keyword,
    string,
    "string.special": string,
    comment,
    function: fn,
    "function.method": fn,
    "function.builtin": fn,
    constructor: fn,
    number: literal,
    constant: literal,
    "constant.builtin": literal,
    // From the grammars shipped in packages/cli/assets: an escape sequence
    // inside a string, and a JSON object key.
    escape: string,
    "string.special.key": { fg: RGBA.fromIndex(ANSI.blue) },
    type,
    "variable.builtin": type,
  });
}

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
