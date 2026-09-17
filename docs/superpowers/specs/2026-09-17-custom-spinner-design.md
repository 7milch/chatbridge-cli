# Customizable busy spinner in the TUI (milestone 10)

Issue: #49 (backlog entry: #44).

## Goal

Let a vendor CLI built on `createCli` replace the spinner shown in the
status row while a turn is in flight: the animation frames, their interval,
the label, and the colours of the frame and of the label. The label may be a
list, from which one entry is picked at random for each turn.

## Scope

- Layers: built-in default → `createCli({ spinner })`. That is all. The
  Provider carries no presentation data (boundary 1: the UI is not the core)
  and there is no `config.json` layer.
- Only the busy status row is affected. `Opening browser...`,
  `Reopening browser...`, the elapsed / budget counter, the queue count,
  one-shot mode, core, runtime and provider are unchanged.
- No validation. Frames are used as given; the API docs state that every
  frame must have the same display width so the row does not shift.

## Public API

`packages/cli/src/create-cli.ts`:

```ts
export interface SpinnerOptions {
  /** Cycled in order while a turn is in flight. Every frame must have the
   * same display width. Default: ["●○○", "○●○", "○○●", "○●○"]. */
  frames?: string[];
  /** Milliseconds between frames. Default: 120. */
  intervalMs?: number;
  /** Text after the frame. An array picks one entry at random when a turn
   * starts; it stays for that turn. Default: "Thinking…". */
  label?: string | string[];
  /** Colour of the frame: "#rrggbb" or an ANSI palette index 0–255.
   * Unset: the terminal's foreground. */
  frameColor?: SpinnerColor;
  /** Colour of the label, same values. Unset: the terminal's foreground. */
  labelColor?: SpinnerColor;
}

/** A hex string ("#rrggbb") or an ANSI palette index (0–255). Indexed
 * colours follow the terminal palette, as the rest of the theme does. */
export type SpinnerColor = string | number;

export interface CreateCliOptions {
  // ...
  /** Busy-status spinner, in the style of `banner`; fields not set keep
   * their default. */
  spinner?: SpinnerOptions;
}
```

Example:

```ts
createCli({
  name: "acme-ai",
  spinner: {
    frames: ["⠋", "⠙", "⠹", "⠸"],
    intervalMs: 80,
    label: ["Thinking…", "Pondering…", "Consulting the oracle…"],
    frameColor: 4,
    labelColor: "#8a8a8a",
  },
});
```

The elapsed / budget counter and the queue suffix stay uncoloured.
Colour values are not validated; an unparsable hex string behaves as
OpenTUI's `RGBA.fromHex` does.

## Resolution

New `packages/cli/src/tui/spinner.ts`, modelled on `banner.ts`:

```ts
export interface ResolvedSpinner {
  frames: string[];
  intervalMs: number;
  labels: string[];
  frameColor?: SpinnerColor;
  labelColor?: SpinnerColor;
}
export function resolveSpinner(input?: SpinnerOptions): ResolvedSpinner;
```

Each field falls back to its default independently. `label` is normalised
to `labels: string[]` (a string becomes a one-element array). An empty
`labels` array is passed through; the view then shows an empty label. The
colours are carried as given; converting them to OpenTUI's `RGBA` happens in
the view (`theme.ts` gains a `colored(color)` styler that maps a string to
`RGBA.fromHex` and a number to `RGBA.fromIndex`), so `spinner.ts` stays free
of OpenTUI.

## Wiring

`createCli` → `runInteractive({ spinner })` → `ChatViewOptions.spinner`,
the same path `banner` takes. `chat-view.ts` drops the `FRAMES`,
`FRAME_INTERVAL_MS` and `Thinking…` constants and reads the resolved
spinner from its options:

- `startSpinner` picks the label with `Math.random` once per turn and uses
  `intervalMs` for the interval.
- `paintBusyStatus` renders `<frame> <label>  <elapsed>s / <budget>s` plus
  the queue suffix, unchanged in shape, as a `StyledText` whose frame and
  label chunks carry the configured colours (plain chunks when unset).

The label is chosen when the spinner starts, not per frame, so the row is
readable during a turn and changes only between turns.

## Testing

- `spinner.test.ts`: defaults, partial override, full override, string and
  array labels, colours passed through.
- `theme.test.ts`: `colored("#ff0000")` and `colored(4)` produce chunks
  with the expected `fg`.
- `chat-view.test.ts`: custom frames and label appear in the busy row; a
  custom interval advances to the next frame; with `Math.random` stubbed the
  expected label index is picked; the label does not change across frames
  within a turn; a coloured spinner still renders the same text.
- `run-interactive.test.ts` / `create-cli.test.ts`: `spinner` reaches the
  view.

## Documentation

- README vendor section: `spinner` next to `banner`.
- `docs/ROADMAP.md`: move the backlog entry to milestone 10, done.
