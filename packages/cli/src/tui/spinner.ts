/** Vendor-facing spinner knob, passed through `createCli({ spinner })`.
 * Plain data: no OpenTUI types, so `create-cli.ts` can import it eagerly. */
export interface SpinnerOptions {
  /** Cycled in order while a turn is in flight. Every frame must have the
   * same display width, or the status row shifts between frames. Not
   * validated. Default: `["●○○", "○●○", "○○●", "○●○"]`. */
  frames?: string[];
  /** Milliseconds between frames. Default: 120. */
  intervalMs?: number;
  /** Text after the frame. An array picks one entry at random when a turn
   * starts; it stays for that turn. Default: `"Thinking…"`. */
  label?: string | string[];
  /** Colour of the frame. Unset: the terminal's foreground. */
  frameColor?: SpinnerColor;
  /** Colour of the label. Unset: the terminal's foreground. */
  labelColor?: SpinnerColor;
}

/** A hex string ("#rrggbb") or an ANSI palette index (0–255). Indexed
 * colours follow the terminal palette, as the rest of the theme does. Not
 * validated. */
export type SpinnerColor = string | number;

/** What the view consumes: every field present, labels always a list. */
export interface ResolvedSpinner {
  frames: string[];
  intervalMs: number;
  labels: string[];
  frameColor?: SpinnerColor;
  labelColor?: SpinnerColor;
}

/** Three fixed cells so legacy terminals keep the line aligned. */
export const DEFAULT_SPINNER: ResolvedSpinner = {
  frames: ["●○○", "○●○", "○○●", "○●○"],
  intervalMs: 120,
  labels: ["Thinking…"],
};

/** Fills unset fields from DEFAULT_SPINNER; copies arrays so later mutation
 * by the caller cannot reach the view. Nothing is validated. */
export function resolveSpinner(input?: SpinnerOptions): ResolvedSpinner {
  const label = input?.label;
  const resolved: ResolvedSpinner = {
    frames: [...(input?.frames ?? DEFAULT_SPINNER.frames)],
    intervalMs: input?.intervalMs ?? DEFAULT_SPINNER.intervalMs,
    labels:
      label === undefined
        ? [...DEFAULT_SPINNER.labels]
        : typeof label === "string"
          ? [label]
          : [...label],
  };
  // Assigned only when set so `toEqual` against DEFAULT_SPINNER holds.
  if (input?.frameColor !== undefined) resolved.frameColor = input.frameColor;
  if (input?.labelColor !== undefined) resolved.labelColor = input.labelColor;
  return resolved;
}
