import type { SpinnerColor } from "./spinner.js";

/** How `BannerOptions.colors` is spread over the banner grid. */
export type BannerMode = "per-line" | "per-char" | "gradient";

/** Axis of a gradient banner. Only read when mode is "gradient". */
export type BannerDirection = "vertical" | "horizontal" | "diagonal";
const DIRECTIONS: readonly BannerDirection[] = [
  "vertical",
  "horizontal",
  "diagonal",
];

/** Vendor-facing banner knob, passed through `createCli({ banner })`.
 * Plain data: no OpenTUI types, so `create-cli.ts` can import it eagerly. */
export interface BannerOptions {
  /** One string per row, shown centred until the first message. */
  lines: string[];
  /** ANSI palette index (0–255) or "#rrggbb". Omitted: every row dim. */
  colors?: SpinnerColor[];
  /** per-line: row r takes colors[r % n]. per-char: cell (r, c) takes
   * colors[(r + c) % n], a diagonal flow. gradient: cell (r, c) takes
   * the linear mix of the (hex-only) colours at its position along
   * `direction`. Default "per-line". per-char colours by code point, so
   * combining marks and wide characters skew the diagonal: it is meant
   * for ASCII art. */
  mode?: BannerMode;
  /** gradient only: vertical (default) runs down the rows, horizontal
   * along the columns of the centred grid, diagonal along row + col. */
  direction?: BannerDirection;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Throws an Error naming the option when `banner` cannot be rendered. Run
 * at createCli time so a vendor sees the mistake at startup, not in the
 * TUI. */
export function validateBanner(
  banner: string[] | BannerOptions | undefined,
): void {
  if (
    banner === undefined ||
    Array.isArray(banner) ||
    banner.colors === undefined
  ) {
    return;
  }
  const mode = banner.mode ?? "per-line";
  const n = banner.colors.length;
  if (
    banner.direction !== undefined &&
    !DIRECTIONS.includes(banner.direction)
  ) {
    throw new Error(
      `banner.direction: expected "vertical" | "horizontal" | "diagonal", got ${JSON.stringify(banner.direction)}`,
    );
  }
  if (mode === "gradient") {
    if (n < 2) {
      throw new Error("banner.colors: gradient needs at least two colours");
    }
  } else if (n < 1) {
    throw new Error(`banner.colors: ${mode} needs at least one colour`);
  }
  for (const c of banner.colors) {
    if (typeof c === "string") {
      // Caught here rather than in RGBA.fromHex at render time.
      if (!HEX.test(c)) {
        throw new Error(
          `banner.colors: not a "#rrggbb" colour: ${JSON.stringify(c)}`,
        );
      }
    } else if (mode === "gradient") {
      throw new Error(
        `banner.colors: gradient takes hex colours only, got ${JSON.stringify(c)}`,
      );
    }
  }
}
