import type { StyledText, TextChunk } from "@opentui/core";
import type {
  BannerDirection,
  BannerMode,
  BannerOptions,
} from "./banner-options.js";
import type { SpinnerColor } from "./spinner.js";
import { colored, mixHex, styled, theme } from "./theme.js";

export type {
  BannerDirection,
  BannerMode,
  BannerOptions,
} from "./banner-options.js";
export { validateBanner } from "./banner-options.js";

export interface BannerInput {
  name: string;
  version?: string;
  providerName: string;
  /** Vendor-supplied banner; replaces the default when set. */
  banner?: string[] | BannerOptions;
}

export interface BannerColorSpec {
  rows: number;
  colors: SpinnerColor[];
  mode: BannerMode;
  /** gradient only; default "vertical". */
  direction?: BannerDirection;
  /** Widest line in code points; needed by horizontal and diagonal. */
  maxWidth?: number;
}

/** Position 0..1 of cell (row, col) along the gradient axis. A degenerate
 * grid (one row, one column) is position 0. */
export function gradientPosition(
  row: number,
  col: number,
  spec: BannerColorSpec,
): number {
  const rows = spec.rows;
  const width = spec.maxWidth ?? 0;
  const direction = spec.direction ?? "vertical";
  let num: number;
  let den: number;
  if (direction === "horizontal") {
    num = col;
    den = width - 1;
  } else if (direction === "diagonal") {
    num = row + col;
    den = rows + width - 2;
  } else {
    num = row;
    den = rows - 1;
  }
  if (den <= 0) return 0;
  return Math.min(1, Math.max(0, num / den));
}

/** The colour of cell (row, col). Pure; `spec.colors` is already validated. */
export function bannerColorAt(
  row: number,
  col: number,
  spec: BannerColorSpec,
): SpinnerColor {
  const { colors, mode } = spec;
  const n = colors.length;
  if (mode === "per-line") return colors[row % n] as SpinnerColor;
  if (mode === "per-char") return colors[(row + col) % n] as SpinnerColor;
  // gradient: position along the whole stop list.
  const t = gradientPosition(row, col, spec);
  const pos = t * (n - 1);
  const i = Math.min(Math.floor(pos), n - 2);
  return mixHex(colors[i] as string, colors[i + 1] as string, pos - i);
}

/** One StyledText per row; adjacent cells of one colour share a chunk. */
function colourLine(
  line: string,
  row: number,
  spec: BannerColorSpec,
): StyledText {
  const cells = [...line];
  const offset = Math.floor(
    ((spec.maxWidth ?? cells.length) - cells.length) / 2,
  );
  if (line === "") return styled(colored(bannerColorAt(row, offset, spec))(""));
  const chunks: TextChunk[] = [];
  let start = 0;
  let current = bannerColorAt(row, offset, spec);
  for (let col = 1; col <= cells.length; col++) {
    const next =
      col < cells.length ? bannerColorAt(row, col + offset, spec) : undefined;
    if (next === current) continue;
    chunks.push(colored(current)(cells.slice(start, col).join("")));
    start = col;
    if (next !== undefined) current = next;
  }
  return styled(...chunks);
}

/** The one-line hint under the connection line: 55 cells, so it always
 * fits an 80-column terminal on its own. */
export const BANNER_HINT =
  "Type a message, @ to attach a file, ! to run a command.";

/** Lines shown centred in the empty history until the first message. A
 * vendor banner is passed through verbatim: all muted for a plain
 * `string[]` or an object without `colors`, otherwise coloured per
 * `mode`. The default is the CLI name (bold), its version (muted), the
 * provider it is connected to, and a one-line hint. */
export function resolveBanner(input: BannerInput): StyledText[] {
  const b = input.banner;
  if (Array.isArray(b)) return b.map((line) => styled(theme.muted(line)));
  if (b !== undefined) {
    if (b.colors === undefined) {
      return b.lines.map((line) => styled(theme.muted(line)));
    }
    const spec: BannerColorSpec = {
      rows: b.lines.length,
      maxWidth: Math.max(0, ...b.lines.map((l) => [...l].length)),
      colors: b.colors,
      mode: b.mode ?? "per-line",
      direction: b.direction,
    };
    return b.lines.map((line, row) => colourLine(line, row, spec));
  }
  const title =
    input.version === undefined
      ? styled(theme.title(input.name))
      : styled(theme.title(input.name), theme.muted(` v${input.version}`));
  return [
    title,
    // Banner lines do not wrap and the provider name has no length budget,
    // so the fixed-width hint gets its own line.
    styled(theme.muted(`Connected to ${input.providerName}.`)),
    styled(theme.muted(BANNER_HINT)),
  ];
}
