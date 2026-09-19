import type { StyledText, TextChunk } from "@opentui/core";
import type { BannerMode, BannerOptions } from "./banner-options.js";
import type { SpinnerColor } from "./spinner.js";
import { colored, mixHex, styled, theme } from "./theme.js";

export type { BannerMode, BannerOptions } from "./banner-options.js";
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
}

/** The colour of cell (row, col). Pure; `spec.colors` is already validated. */
export function bannerColorAt(
  row: number,
  col: number,
  spec: BannerColorSpec,
): SpinnerColor {
  const { colors, mode, rows } = spec;
  const n = colors.length;
  if (mode === "per-line") return colors[row % n] as SpinnerColor;
  if (mode === "per-char") return colors[(row + col) % n] as SpinnerColor;
  // gradient: position along the whole stop list.
  if (rows <= 1) return colors[0] as SpinnerColor;
  const pos = (row / (rows - 1)) * (n - 1);
  const i = Math.min(Math.floor(pos), n - 2);
  return mixHex(colors[i] as string, colors[i + 1] as string, pos - i);
}

/** One StyledText per row; adjacent cells of one colour share a chunk. */
function colourLine(
  line: string,
  row: number,
  spec: BannerColorSpec,
): StyledText {
  if (line === "") return styled(colored(bannerColorAt(row, 0, spec))(""));
  const chunks: TextChunk[] = [];
  let start = 0;
  let current = bannerColorAt(row, 0, spec);
  const cells = [...line];
  for (let col = 1; col <= cells.length; col++) {
    const next = col < cells.length ? bannerColorAt(row, col, spec) : undefined;
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
      colors: b.colors,
      mode: b.mode ?? "per-line",
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
