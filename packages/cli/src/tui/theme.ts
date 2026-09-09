import {
  RGBA,
  StyledText,
  TextAttributes,
  type TextChunk,
} from "@opentui/core";

/** One place for every style the TUI uses. Colours are ANSI indexed so the
 * terminal palette applies in light and dark themes; OpenTUI's `blue()`
 * helpers emit fixed truecolour values and are deliberately not used. */
export type Styler = (text: string) => TextChunk;

const ANSI = { red: 1, green: 2, blue: 4, brightBlack: 8 } as const;

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
  errorText: make(TextAttributes.NONE, ANSI.red),
  selected: make(TextAttributes.INVERSE),
};

/** Builds a StyledText from chunks and plain strings. */
export function styled(...parts: Array<TextChunk | string>): StyledText {
  return new StyledText(
    parts.map((p) =>
      typeof p === "string" ? chunk(p, TextAttributes.NONE) : p,
    ),
  );
}
