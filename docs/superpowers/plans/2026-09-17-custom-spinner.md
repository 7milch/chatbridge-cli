# Customizable Busy Spinner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a vendor CLI pass `createCli({ spinner })` to replace the busy-status frames, interval, label(s) and the colours of frame and label; one label is picked at random per turn.

**Architecture:** A new `packages/cli/src/tui/spinner.ts` (modelled on `banner.ts`) turns the optional `SpinnerOptions` into a `ResolvedSpinner` with defaults filled in. `ChatView` reads the resolved spinner from its options instead of module constants. `createCli` → `runInteractive` → `ChatView` carries the option the same way `banner` does. Core, runtime and provider are untouched.

**Tech Stack:** TypeScript, Bun (workspaces, `bun test`), OpenTUI (`@opentui/core`, only inside `packages/cli/src/tui/`), Biome.

**Spec:** `docs/superpowers/specs/2026-09-17-custom-spinner-design.md`

## Global Constraints

- Every document, comment and commit message pushed to the remote is in English.
- `bun run check` (Biome lint + `tsc --build` + `bun test`) must pass before every commit.
- Dependency direction `cli → core → runtime → provider`; the Provider gets no spinner field. `@opentui/core` is imported only under `packages/cli/src/tui/`.
- No validation of frames, interval or labels (user decision). Docs state that all frames must share a display width.
- `Opening browser...`, `Reopening browser...`, the elapsed / budget counter and the queue suffix are unchanged.
- Branch: `issue-49`. After every commit: `gh issue comment 49 --body "<what was committed> + what's next"`.
- Defaults (copied from the spec): frames `["●○○", "○●○", "○○●", "○●○"]`, interval `120`, label `"Thinking…"` (the ellipsis is the single character U+2026), no colours (terminal foreground).
- Colour values: `SpinnerColor = string | number`; a string goes to `RGBA.fromHex`, a number to `RGBA.fromIndex`. Not validated. The counter and queue suffix stay uncoloured.

---

## File structure

- Create `packages/cli/src/tui/spinner.ts` — `SpinnerOptions`, `SpinnerColor` (public, plain data), `ResolvedSpinner`, `DEFAULT_SPINNER`, `resolveSpinner()`. No OpenTUI import.
- Create `packages/cli/src/tui/spinner.test.ts`.
- Modify `packages/cli/src/tui/theme.ts` — `colored(color)` styler; `theme.test.ts`.
- Modify `packages/cli/src/tui/chat-view.ts` — drop `FRAMES` / `FRAME_INTERVAL_MS` / the `Thinking…` literal; add `spinner: ResolvedSpinner` to `ChatViewOptions`; pick a label in `startSpinner`.
- Modify `packages/cli/src/tui/chat-view.test.ts` — `setup()` takes `spinner?`; new tests.
- Modify `packages/cli/src/tui/run-interactive.ts` — `spinner?: SpinnerOptions` option, resolved and passed to the view.
- Modify `packages/cli/src/tui/run-interactive.test.ts` — vendor spinner reaches the frame.
- Modify `packages/cli/src/create-cli.ts` — `spinner?: SpinnerOptions` on `CreateCliOptions`, forwarded to `runInteractive`.
- Modify `packages/cli/src/index.ts` — export `SpinnerOptions`, `SpinnerColor`.
- Modify `README.md`, `docs/ROADMAP.md`.

---

### Task 1: `resolveSpinner`

**Files:**
- Create: `packages/cli/src/tui/spinner.ts`
- Test: `packages/cli/src/tui/spinner.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type SpinnerColor = string | number
  export interface SpinnerOptions { frames?: string[]; intervalMs?: number; label?: string | string[]; frameColor?: SpinnerColor; labelColor?: SpinnerColor }
  export interface ResolvedSpinner { frames: string[]; intervalMs: number; labels: string[]; frameColor?: SpinnerColor; labelColor?: SpinnerColor }
  export const DEFAULT_SPINNER: ResolvedSpinner
  export function resolveSpinner(input?: SpinnerOptions): ResolvedSpinner
  ```

- [ ] **Step 1: Write the failing test**

`packages/cli/src/tui/spinner.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_SPINNER, resolveSpinner } from "./spinner.js";

describe("resolveSpinner", () => {
  test("no input yields the built-in default", () => {
    expect(resolveSpinner()).toEqual({
      frames: ["●○○", "○●○", "○○●", "○●○"],
      intervalMs: 120,
      labels: ["Thinking…"],
    });
    expect(resolveSpinner(undefined)).toEqual(DEFAULT_SPINNER);
  });

  test("each field overrides independently", () => {
    expect(resolveSpinner({ intervalMs: 80 })).toEqual({
      ...DEFAULT_SPINNER,
      intervalMs: 80,
    });
    expect(resolveSpinner({ frames: ["-", "\\", "|", "/"] })).toEqual({
      ...DEFAULT_SPINNER,
      frames: ["-", "\\", "|", "/"],
    });
  });

  test("a string label becomes a one-element list", () => {
    expect(resolveSpinner({ label: "Working…" }).labels).toEqual(["Working…"]);
  });

  test("an array label is kept as given, including an empty one", () => {
    expect(resolveSpinner({ label: ["A", "B"] }).labels).toEqual(["A", "B"]);
    expect(resolveSpinner({ label: [] }).labels).toEqual([]);
  });

  test("colours pass through and are absent by default", () => {
    expect(resolveSpinner().frameColor).toBeUndefined();
    expect(resolveSpinner().labelColor).toBeUndefined();
    const r = resolveSpinner({ frameColor: 4, labelColor: "#8a8a8a" });
    expect(r.frameColor).toBe(4);
    expect(r.labelColor).toBe("#8a8a8a");
  });

  test("the result does not alias the caller's arrays", () => {
    const frames = ["x", "y"];
    const resolved = resolveSpinner({ frames });
    frames.push("z");
    expect(resolved.frames).toEqual(["x", "y"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/cli/src/tui/spinner.test.ts`
Expected: FAIL, cannot resolve `./spinner.js`.

- [ ] **Step 3: Implement**

`packages/cli/src/tui/spinner.ts`:

```ts
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
```

- [ ] **Step 4: Run the test**

Run: `bun test packages/cli/src/tui/spinner.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Check and commit**

```bash
bun run check
git add packages/cli/src/tui/spinner.ts packages/cli/src/tui/spinner.test.ts
git commit -m "feat(tui): resolveSpinner with layered defaults (Refs #49)"
gh issue comment 49 --body "Added resolveSpinner (packages/cli/src/tui/spinner.ts) with tests. What's next: ChatView reads the resolved spinner instead of its constants."
```

---

### Task 2: `theme.colored` and `ChatView` reads the resolved spinner

**Files:**
- Modify: `packages/cli/src/tui/theme.ts` (after `theme` object ~line 31–40)
- Test: `packages/cli/src/tui/theme.test.ts`
- Modify: `packages/cli/src/tui/chat-view.ts` (constants near line 26–28; `ChatViewOptions` ~line 37; constructor ~line 82; `startSpinner` / `paintBusyStatus` ~line 506–525)
- Test: `packages/cli/src/tui/chat-view.test.ts` (`setup()` ~line 49; spinner tests near "shows elapsed time against the timeout budget while busy" ~line 302)

**Interfaces:**
- Consumes: `ResolvedSpinner`, `SpinnerColor`, `resolveSpinner` from `./spinner.js` (Task 1).
- Produces: `colored(color: SpinnerColor): Styler` in `theme.ts`; `ChatViewOptions.spinner: ResolvedSpinner` (required). Busy row text unchanged: `` `${frame} ${label}  ${elapsed}s / ${budget}s${queued}` ``, now a `StyledText`.

- [ ] **Step 0a: Write the failing theme test**

Append inside `describe("theme", ...)` in `packages/cli/src/tui/theme.test.ts`:

```ts
  test("colored: a number is an ANSI index, a string a hex colour", () => {
    const idx = colored(4)("x");
    expect(idx.text).toBe("x");
    expect(idx.attributes).toBe(TextAttributes.NONE);
    expect(idx.fg?.intent).toBe("indexed");
    expect(idx.fg?.slot).toBe(4);
    const hex = colored("#ff0000")("x");
    expect(hex.fg?.r).toBeCloseTo(1);
    expect(hex.fg?.g).toBeCloseTo(0);
    expect(hex.fg?.b).toBeCloseTo(0);
  });
```

and add `colored` to the import from `./theme.js`.

Run: `bun test packages/cli/src/tui/theme.test.ts` — Expected: FAIL, `colored` is not exported.

- [ ] **Step 0b: Implement `colored` in `theme.ts`**

Add the import and the export after the `theme` object:

```ts
import type { SpinnerColor } from "./spinner.js";

/** Plain text in a vendor-chosen colour: a number is an ANSI palette index
 * (follows the terminal palette), a string is "#rrggbb". */
export function colored(color: SpinnerColor): Styler {
  const fg =
    typeof color === "number" ? RGBA.fromIndex(color) : RGBA.fromHex(color);
  return (text) => chunk(text, TextAttributes.NONE, fg);
}
```

Run: `bun test packages/cli/src/tui/theme.test.ts` — Expected: PASS.

- [ ] **Step 1: Extend the test harness**

In `packages/cli/src/tui/chat-view.test.ts`, add the import and the option:

```ts
import { type ResolvedSpinner, resolveSpinner } from "./spinner.js";
```

In `setup()`'s `opts` type add `spinner?: ResolvedSpinner;` and in the `new ChatView(...)` options add, after `banner`:

```ts
    spinner: opts.spinner ?? resolveSpinner(),
```

- [ ] **Step 2: Write the failing tests**

Add after the test "the indicator animates":

```ts
  test("a vendor spinner replaces frames and label", async () => {
    const t = await setup({
      delayMs: 400,
      spinner: { frames: ["<>", "><"], intervalMs: 120, labels: ["Working…"] },
    });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    const busy = await t.frameWith("Working…");
    expect(busy).toMatch(/(<>|><) Working… {2}\ds \/ 2s/);
    expect(busy).not.toContain("Thinking…");
  });

  test("a vendor interval drives the frame rate", async () => {
    const t = await setup({
      delayMs: 600,
      spinner: { frames: ["A1", "B2"], intervalMs: 30, labels: ["Go"] },
    });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    await t.frameWith("Go");
    const seen = new Set<string>();
    for (let i = 0; i < 10 && seen.size < 2; i++) {
      await sleep(20);
      await t.renderOnce();
      const m = t.captureCharFrame().match(/(A1|B2) Go/)?.[1];
      if (m) seen.add(m);
    }
    expect(seen.size).toBe(2);
  });

  test("one label is picked per turn and kept across frames", async () => {
    const random = Math.random;
    Math.random = () => 0.99;
    try {
      const t = await setup({
        delayMs: 400,
        spinner: {
          frames: ["●○○", "○●○"],
          intervalMs: 30,
          labels: ["First…", "Second…", "Third…"],
        },
      });
      await t.mockInput.typeText("hello");
      t.mockInput.pressEnter();
      await t.frameWith("Third…");
      Math.random = () => 0;
      for (let i = 0; i < 5; i++) {
        await sleep(30);
        await t.renderOnce();
        expect(t.captureCharFrame()).toContain("Third…");
      }
      await t.frameWith("Echo: hello");
      await t.mockInput.typeText("again");
      t.mockInput.pressEnter();
      expect(await t.frameWith("First…")).not.toContain("Third…");
    } finally {
      Math.random = random;
    }
  });

  test("a coloured spinner renders the same text", async () => {
    const t = await setup({
      delayMs: 400,
      spinner: {
        frames: ["**"],
        intervalMs: 120,
        labels: ["Tinted…"],
        frameColor: 4,
        labelColor: "#8a8a8a",
      },
    });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    const busy = await t.frameWith("Tinted…");
    expect(busy).toMatch(/\*\* Tinted… {2}\ds \/ 2s/);
  });

  test("an empty label list shows the frame alone", async () => {
    const t = await setup({
      delayMs: 400,
      spinner: { frames: ["##"], intervalMs: 120, labels: [] },
    });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    const busy = await t.frameWith("## ");
    expect(busy).toMatch(/##  {2}\ds \/ 2s/);
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: type error on `spinner` in `ChatViewOptions` / the new tests fail because the view still uses the constants.

- [ ] **Step 4: Implement in `chat-view.ts`**

Remove these lines:

```ts
/** Three fixed cells so legacy terminals keep the line aligned. */
const FRAMES = ["●○○", "○●○", "○○●", "○●○"];
const FRAME_INTERVAL_MS = 120;
```

Add the import:

```ts
import type { ResolvedSpinner } from "./spinner.js";
```

and add `colored` to the existing import from `./theme.js`:

```ts
import { MUTED_COLOR, colored, styled, theme } from "./theme.js";
```

In `ChatViewOptions`, after `banner`:

```ts
  /** Busy-status spinner; see resolveSpinner(). */
  spinner: ResolvedSpinner;
```

Add fields next to `private frame = 0;`:

```ts
  private readonly spinnerSpec: ResolvedSpinner;
  private label = "";
```

In the constructor, right after `this.index = opts.index;`:

```ts
    this.spinnerSpec = opts.spinner;
```

Replace `startSpinner` and `paintBusyStatus`:

```ts
  private startSpinner(): void {
    if (this.spinner) return;
    this.startedAt = Date.now();
    this.label = this.pickLabel();
    const tick = () => {
      // The renderer can be destroyed from under a running turn (SIGINT);
      // the interval outlives it until teardown reaches this view.
      if (this.torn) return this.stopSpinner();
      this.frame = (this.frame + 1) % this.spinnerSpec.frames.length;
      this.paintBusyStatus();
    };
    tick();
    this.spinner = setInterval(tick, this.spinnerSpec.intervalMs);
  }

  /** One label per turn, chosen when the spinner starts so the row does not
   * flicker between frames. Empty list: no label. */
  private pickLabel(): string {
    const { labels } = this.spinnerSpec;
    if (labels.length === 0) return "";
    return labels[Math.floor(Math.random() * labels.length)] ?? "";
  }

  /** Draws the current spinner frame, elapsed time and queue count. The
   * frame and label take the vendor colours; the counter never does. */
  private paintBusyStatus(): void {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const queued = this.queued > 0 ? `  · ${this.queued} queued` : "";
    const { frames, frameColor, labelColor } = this.spinnerSpec;
    const frame = frames[this.frame] ?? "";
    this.status.content = styled(
      frameColor === undefined ? frame : colored(frameColor)(frame),
      " ",
      labelColor === undefined ? this.label : colored(labelColor)(this.label),
      `  ${elapsed}s / ${this.budgetSec}s${queued}`,
    );
  }
```

`styled` is already imported in `chat-view.ts`; `setStatus`/other callers that assign a plain string to `status.content` are unaffected (`content` accepts both).

Note: `% this.spinnerSpec.frames.length` with an empty `frames` yields `NaN`; the `?? ""` on the lookup keeps that from throwing (no validation by decision).

- [ ] **Step 5: Run the tests**

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: PASS, including the pre-existing spinner tests (default still `[●○]{3} Thinking…`).

- [ ] **Step 6: Check and commit**

```bash
bun run check
git add packages/cli/src/tui/theme.ts packages/cli/src/tui/theme.test.ts packages/cli/src/tui/chat-view.ts packages/cli/src/tui/chat-view.test.ts
git commit -m "feat(tui): ChatView takes its spinner from options, one random label per turn, coloured frame and label (Refs #49)"
gh issue comment 49 --body "ChatView now reads frames, interval, labels and colours from ChatViewOptions.spinner; a label is picked once per turn; theme.colored maps hex/ANSI to RGBA. What's next: wire createCli({ spinner }) through runInteractive."
```

---

### Task 3: Wire `createCli({ spinner })` through `runInteractive`

**Files:**
- Modify: `packages/cli/src/tui/run-interactive.ts` (options ~line 16–19; `new ChatView` ~line 129)
- Modify: `packages/cli/src/create-cli.ts` (`CreateCliOptions` ~line 14; `runInteractive` call ~line 233)
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/src/tui/run-interactive.test.ts` (the `new ChatView` calls at ~lines 29, 61, 99 and the test "a vendor banner replaces the default" ~line 208)

**Interfaces:**
- Consumes: `SpinnerOptions`, `resolveSpinner` (Task 1); `ChatViewOptions.spinner` (Task 2).
- Produces: `RunInteractiveOptions.spinner?: SpinnerOptions`; `CreateCliOptions.spinner?: SpinnerOptions`; `SpinnerOptions` and `SpinnerColor` exported from `@chatbridge/cli`.

- [ ] **Step 1: Fix the existing `run-interactive.test.ts` `ChatView` constructions**

Each `new ChatView(t.renderer, model, { ... banner: [], index: ... })` in that file gains `spinner: resolveSpinner(),` after `banner: []`. Add the import:

```ts
import { resolveSpinner } from "./spinner.js";
```

- [ ] **Step 2: Write the failing test**

Add after "a vendor banner replaces the default":

```ts
  test("a vendor spinner replaces the default", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    let frame = "";
    const run = runInteractive({
      ...sessionOpts().opts,
      spinner: { frames: ["@@"], label: "Crunching…", labelColor: 2 },
      createRenderer: async () => t.renderer,
      index: FileIndex.fromPaths([]),
    });
    try {
      for (let i = 0; i < 50 && !frame.includes("Type a message"); i++) {
        await new Promise((r) => setTimeout(r, 20));
        await t.renderOnce();
        frame = t.captureCharFrame();
      }
      await t.mockInput.typeText("hi");
      t.mockInput.pressEnter();
      for (let i = 0; i < 50 && !frame.includes("Crunching…"); i++) {
        await new Promise((r) => setTimeout(r, 20));
        await t.renderOnce();
        frame = t.captureCharFrame();
      }
      expect(frame).toContain("@@ Crunching…");
      expect(frame).not.toContain("Thinking…");
    } finally {
      t.renderer.destroy();
    }
    await run;
  });
```

If `sessionOpts()` in this file replies instantly so the busy row never renders, look at how the existing "a vendor banner replaces the default" test's session is built and give this test's session a `send` that waits ~300 ms before resolving (copy the session literal from `sessionOpts()` and wrap its `send` with `await new Promise((r) => setTimeout(r, 300))`).

- [ ] **Step 3: Run to verify it fails**

Run: `bun test packages/cli/src/tui/run-interactive.test.ts`
Expected: type error, `spinner` is not in `RunInteractiveOptions`.

- [ ] **Step 4: Implement**

`packages/cli/src/tui/run-interactive.ts`: add the import

```ts
import { resolveSpinner, type SpinnerOptions } from "./spinner.js";
```

In the options interface, after `banner?: string[];`:

```ts
  /** Vendor busy spinner; unset fields keep the default. */
  spinner?: SpinnerOptions;
```

In the `new ChatView(...)` call, after the `banner: resolveBanner({...}),` entry:

```ts
      spinner: resolveSpinner(opts.spinner),
```

`packages/cli/src/create-cli.ts`: add the import

```ts
import type { SpinnerOptions } from "./tui/spinner.js";
```

In `CreateCliOptions`, after `banner?: string[];`:

```ts
  /** Busy-status spinner shown while a turn is in flight, in the style of
   * `banner`; fields not set keep their default. Frames must share a
   * display width. */
  spinner?: SpinnerOptions;
```

In the `runInteractive({...})` call, after `banner: opts.banner,`:

```ts
          spinner: opts.spinner,
```

`packages/cli/src/index.ts`, add:

```ts
export type { SpinnerColor, SpinnerOptions } from "./tui/spinner.js";
```

- [ ] **Step 5: Run the tests**

Run: `bun test packages/cli`
Expected: PASS.

- [ ] **Step 6: Check and commit**

```bash
bun run check
git add packages/cli/src/tui/run-interactive.ts packages/cli/src/tui/run-interactive.test.ts packages/cli/src/create-cli.ts packages/cli/src/index.ts
git commit -m "feat(cli): createCli({ spinner }) reaches the interactive view (Refs #49)"
gh issue comment 49 --body "createCli({ spinner }) is forwarded through runInteractive to ChatView; SpinnerOptions is exported from @chatbridge/cli. What's next: README and ROADMAP."
```

---

### Task 4: README and ROADMAP

**Files:**
- Modify: `README.md` (the `createCli` example ~line 71–79 and the interactive-mode paragraph ~line 113–115)
- Modify: `docs/ROADMAP.md` (milestone list after "### 9." ~line 123; the backlog entry "Customizable busy spinner in the TUI" ~line 198–209)

- [ ] **Step 1: README example**

Replace the `createCli` example block with:

```ts
createCli({
  name: "acme-ai",
  version: "2.4.0",            // shown by --version and in the startup banner
  banner: ["Acme internal assistant", "Conversations are not stored."], // optional
  spinner: {                   // optional; unset fields keep the default
    frames: ["⠋", "⠙", "⠹", "⠸"],          // same display width each
    intervalMs: 80,
    label: ["Thinking…", "Pondering…"],     // one is picked per turn
    frameColor: 4,                          // ANSI index or "#rrggbb"
    labelColor: "#8a8a8a",
  },
  provider,
});
```

Then, in the interactive-mode paragraph that mentions the `banner` lines, add one sentence:

```
While a turn is in flight the status row shows a spinner and the elapsed
time against the budget; `spinner` on `createCli` replaces its frames,
interval, label (a list of labels picks one at random per turn) and the
colours of frame and label (`"#rrggbb"` or an ANSI palette index).
```

- [ ] **Step 2: ROADMAP**

After the "### 9." milestone section (before "### 5. Company adoption"), add:

```markdown
### 10. Customizable busy spinner — done (issue #49, 2026-09-17)

`createCli({ spinner: { frames, intervalMs, label, frameColor, labelColor } })`
replaces the three-dot spinner and the `Thinking…` label of the busy status
row and colours them (`"#rrggbb"` or an ANSI index); `label` may be a list,
one entry picked at random per turn. Built-in default →
`createCli` only: the provider carries no presentation data and there is no
`config.json` layer. Frames are not validated; they must share a display
width. Spec: `docs/superpowers/specs/2026-09-17-custom-spinner-design.md`.
```

Delete the backlog bullet "**Customizable busy spinner in the TUI.** …" (the whole bullet, up to "are recorded in issue #44.").

- [ ] **Step 3: Check and commit**

```bash
bun run check
git add README.md docs/ROADMAP.md
git commit -m "docs: spinner option in README, milestone 10 in ROADMAP (Refs #49)"
gh issue comment 49 --body "README documents createCli({ spinner }); ROADMAP lists milestone 10 and drops the backlog entry. What's next: open the PR."
```

- [ ] **Step 4: Open the PR**

```bash
git push -u origin issue-49
gh pr create --title "feat(cli): customizable busy spinner via createCli({ spinner }) (milestone 10)" --body "Closes #49. Spec: docs/superpowers/specs/2026-09-17-custom-spinner-design.md"
```
