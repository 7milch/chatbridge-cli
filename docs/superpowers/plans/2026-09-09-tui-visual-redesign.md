# Interactive TUI Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the interactive TUI to mock 5 (badge header, coloured role labels, centred startup banner, hairline input that grows to five rows, inline `@` popup) and add `createCli({ version, banner })` plus `--version`.

**Architecture:** All changes live in `packages/cli`. A new `tui/theme.ts` is the single source of styles (ANSI indexed colours through OpenTUI styled-text); `tui/banner.ts` resolves the banner lines as a pure function; `ChatView` is rebuilt around a column layout of header / body (banner or history) / hairline input / inline popup / status. `ChatModel`, `mentions/*`, core, runtime and provider are untouched.

**Tech Stack:** TypeScript, Bun test runner, `@opentui/core` 0.5.10 (`createTestRenderer` from `@opentui/core/testing` for frame tests).

**Spec:** `docs/superpowers/specs/2026-09-09-tui-visual-redesign-design.md`

## Global Constraints

- Branch `issue-28`; `bun run check` (Biome lint + tsc build + bun test) must pass before every commit.
- After every commit: `gh issue comment 28 --body "<what was committed> + What's next: <remaining tasks>"` in English.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FL7oi5x6nSwWZDU6zx471L
  ```
- OpenTUI stays at 0.5.10. No new dependencies.
- Dependency direction `cli → core → runtime → provider`; nothing outside `packages/cli` changes.
- All prose pushed to the remote is English.
- Colours are ANSI indexed (`RGBA.fromIndex(n)`), never truecolour: OpenTUI's `blue()` etc. produce rgb intent and must not be used.
- `TextRenderable.content` accepts `string | StyledText`, not a bare `TextChunk`; wrap chunks with the `t` tag or `new StyledText([...])`.
- Run tests for one package with `bun test packages/cli`; a single file with `bun test packages/cli/src/tui/theme.test.ts`.

## Verified OpenTUI facts (probed 2026-09-09)

- `fg(RGBA.fromIndex(4))("x").fg.intent === "indexed"`, `.slot === 4`.
- `TextAttributes`: NONE 0, BOLD 1, DIM 2, INVERSE 32.
- `BoxRenderable({ border: ["top", "bottom"], borderColor: RGBA })` draws two hairlines.
- A `BoxRenderable` with `visible: false` takes no layout space.
- Setting `textarea.height = n` at runtime grows the surrounding box; `textarea.lineCount` is the logical line count (available right after the keypress), `virtualLineCount` only updates after layout.
- `TextRenderable({ wrapMode: "none" })` truncates on the right; the default wraps.
- `justifyContent: "center"` + `alignItems: "center"` on a `flexGrow: 1` box centres its children and re-centres on resize.

---

### Task 1: Theme tokens

**Files:**
- Create: `packages/cli/src/tui/theme.ts`
- Test: `packages/cli/src/tui/theme.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Styler = (text: string) => TextChunk;
  export const theme: {
    badge: Styler;      // bold + inverse
    title: Styler;      // bold (banner first line)
    muted: Styler;      // dim
    user: Styler;       // bold + ANSI blue (4)
    assistant: Styler;  // bold + ANSI green (2)
    error: Styler;      // bold + ANSI red (1)
    errorText: Styler;  // ANSI red (1)
    selected: Styler;   // inverse
  };
  export const MUTED_COLOR: RGBA; // ANSI bright black (8), for borders and placeholders
  export function styled(...chunks: Array<TextChunk | string>): StyledText;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/tui/theme.test.ts
import { describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { MUTED_COLOR, styled, theme } from "./theme.js";

describe("theme", () => {
  test("badge is bold and inverse without a colour", () => {
    const c = theme.badge("x");
    expect(c.text).toBe("x");
    expect(c.attributes).toBe(TextAttributes.BOLD | TextAttributes.INVERSE);
    expect(c.fg).toBeUndefined();
  });

  test("title is bold only", () => {
    expect(theme.title("x").attributes).toBe(TextAttributes.BOLD);
    expect(theme.title("x").fg).toBeUndefined();
  });

  test("muted is dim only", () => {
    expect(theme.muted("x").attributes).toBe(TextAttributes.DIM);
    expect(theme.muted("x").fg).toBeUndefined();
  });

  test.each([
    ["user", 4],
    ["assistant", 2],
    ["error", 1],
  ] as const)("%s label is bold with ANSI index %i", (name, index) => {
    const c = theme[name]("x");
    expect(c.attributes).toBe(TextAttributes.BOLD);
    expect(c.fg?.intent).toBe("indexed");
    expect(c.fg?.slot).toBe(index);
  });

  test("errorText is plain red", () => {
    const c = theme.errorText("x");
    expect(c.attributes ?? 0).toBe(TextAttributes.NONE);
    expect(c.fg?.slot).toBe(1);
  });

  test("selected is inverse", () => {
    expect(theme.selected("x").attributes).toBe(TextAttributes.INVERSE);
  });

  test("MUTED_COLOR is ANSI bright black", () => {
    expect(MUTED_COLOR.intent).toBe("indexed");
    expect(MUTED_COLOR.slot).toBe(8);
  });

  test("styled joins chunks and strings into one StyledText", () => {
    const s = styled(theme.badge(" a "), " ", theme.muted("b"));
    expect(s.chunks.map((c) => c.text)).toEqual([" a ", " ", "b"]);
    expect(s.chunks[1]?.attributes ?? 0).toBe(TextAttributes.NONE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/tui/theme.test.ts`
Expected: FAIL — cannot resolve `./theme.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/cli/src/tui/theme.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/tui/theme.test.ts`
Expected: PASS (9 tests). If `TextChunk` construction fails type-checking under `bun run check` because `__isChunk` is not exported as a literal, use `fg(RGBA.fromIndex(n))(text)` / `bold(text)` / `dim(text)` / `reverse(text)` from `@opentui/core` to build chunks and merge attributes with `|` — the tests above stay the same.

- [ ] **Step 5: Run the full check and commit**

Run: `bun run check`
Expected: PASS.

```bash
git add packages/cli/src/tui/theme.ts packages/cli/src/tui/theme.test.ts
git commit -m "feat(tui): theme tokens with ANSI indexed colours (Refs #28)"
gh issue comment 28 --body "Committed tui/theme.ts: fixed style tokens (badge, muted, user, assistant, error, errorText, selected) using ANSI indexed colours. What's next: banner resolver, createCli version/banner options, inline popup, ChatView restyle."
```

---

### Task 2: Banner resolver

**Files:**
- Create: `packages/cli/src/tui/banner.ts`
- Test: `packages/cli/src/tui/banner.test.ts`

**Interfaces:**
- Consumes: `theme`, `styled` from Task 1.
- Produces:
  ```ts
  export interface BannerInput {
    name: string;
    version?: string;
    providerName: string;
    banner?: string[];
  }
  export function resolveBanner(input: BannerInput): StyledText[];
  export const BANNER_HINT = "Type a message, or @ to attach a file.";
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/tui/banner.test.ts
import { describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { resolveBanner } from "./banner.js";

const text = (lines: ReturnType<typeof resolveBanner>) =>
  lines.map((l) => l.chunks.map((c) => c.text).join(""));

describe("resolveBanner", () => {
  test("default banner: bold name, muted version, muted hint", () => {
    const lines = resolveBanner({
      name: "chatbridge",
      version: "0.3.0",
      providerName: "dummy-chat",
    });
    expect(text(lines)).toEqual([
      "chatbridge v0.3.0",
      "Connected to dummy-chat. Type a message, or @ to attach a file.",
    ]);
    const [title, hint] = lines;
    expect(title?.chunks[0]?.attributes).toBe(TextAttributes.BOLD);
    expect(title?.chunks[1]?.attributes).toBe(TextAttributes.DIM);
    expect(hint?.chunks[0]?.attributes).toBe(TextAttributes.DIM);
  });

  test("default banner without a version shows the name alone", () => {
    const lines = resolveBanner({ name: "acme", providerName: "p" });
    expect(text(lines)[0]).toBe("acme");
    expect(lines[0]?.chunks).toHaveLength(1);
  });

  test("vendor banner is used verbatim, every line muted", () => {
    const lines = resolveBanner({
      name: "acme",
      version: "9.9.9",
      providerName: "p",
      banner: ["  __ __", "Acme internal assistant", ""],
    });
    expect(text(lines)).toEqual(["  __ __", "Acme internal assistant", ""]);
    for (const l of lines) {
      expect(l.chunks[0]?.attributes).toBe(TextAttributes.DIM);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/tui/banner.test.ts`
Expected: FAIL — cannot resolve `./banner.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/cli/src/tui/banner.ts
import type { StyledText } from "@opentui/core";
import { styled, theme } from "./theme.js";

export interface BannerInput {
  name: string;
  version?: string;
  providerName: string;
  /** Vendor-supplied lines; replaces the default banner when set. */
  banner?: string[];
}

export const BANNER_HINT = "Type a message, or @ to attach a file.";

/** Lines shown centred in the empty history until the first message.
 * A vendor banner is passed through verbatim (all muted); the default is
 * the CLI name (bold), its version (muted) and a one-line hint. */
export function resolveBanner(input: BannerInput): StyledText[] {
  if (input.banner) {
    return input.banner.map((line) => styled(theme.muted(line)));
  }
  const title =
    input.version === undefined
      ? styled(theme.title(input.name))
      : styled(theme.title(input.name), theme.muted(` v${input.version}`));
  return [
    title,
    styled(theme.muted(`Connected to ${input.providerName}. ${BANNER_HINT}`)),
  ];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/src/tui/banner.test.ts packages/cli/src/tui/theme.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full check and commit**

```bash
bun run check
git add packages/cli/src/tui/banner.ts packages/cli/src/tui/banner.test.ts
git commit -m "feat(tui): resolveBanner for default and vendor banners (Refs #28)"
gh issue comment 28 --body "Committed tui/banner.ts: resolveBanner builds the default (name, version, hint) or passes a vendor string[] through. What's next: createCli version/banner options and --version, inline popup, ChatView restyle."
```

---

### Task 3: `createCli({ version, banner })` and `--version`

**Files:**
- Modify: `packages/cli/src/create-cli.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/tui/run-interactive.ts:11-18` (options only; the view wiring is Task 8)
- Test: `packages/cli/src/create-cli.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CreateCliOptions {
    name: string;
    version?: string;
    banner?: string[];
    provider?: Provider; configDir?: string; baseDir?: string; isTerminal?: boolean; // unchanged
  }
  // run-interactive.ts
  export interface InteractiveOptions extends ChatSessionOptions {
    title: string;
    banner: string[];   // resolved lines? NO — see below: raw vendor banner or undefined
    ...
  }
  ```
  Decision: `InteractiveOptions` gets `version?: string` and `banner?: string[]` (raw), and Task 8 calls `resolveBanner` inside `runInteractive` where `provider.name` is known. `createCli` forwards `opts.version` and `opts.banner` unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/create-cli.test.ts`:

```ts
describe("--version", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  function captureLog() {
    logs.length = 0;
    console.log = ((...args: unknown[]) => {
      logs.push(args.join(" "));
    }) as typeof console.log;
  }
  afterEach(() => {
    console.log = originalLog;
  });

  test("prints name and version and exits 0", async () => {
    captureLog();
    const cli = createCli({
      name: "test-cli",
      version: "1.2.3",
      provider: stubProvider(),
    });
    expect(await cli.run(["bun", "cli", "--version"])).toBe(0);
    expect(logs.join("\n")).toBe("test-cli v1.2.3");
  });

  test("-V without a version prints the name alone", async () => {
    captureLog();
    const cli = createCli({ name: "test-cli", provider: stubProvider() });
    expect(await cli.run(["bun", "cli", "-V"])).toBe(0);
    expect(logs.join("\n")).toBe("test-cli");
  });

  test("help lists --version", async () => {
    captureLog();
    const cli = createCli({ name: "test-cli", provider: stubProvider() });
    await cli.run(["bun", "cli", "--help"]);
    expect(logs.join("\n")).toContain("--version");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/src/create-cli.test.ts -t "--version"`
Expected: FAIL — `--version` is an unknown option (exit 1) and help lacks it.

- [ ] **Step 3: Implement in `create-cli.ts`**

Change `CreateCliOptions`:

```ts
export interface CreateCliOptions {
  /** CLI name shown in help and errors, e.g. "chatbridge" or "company-ai-cli". */
  name: string;
  /** Shown by --version and in the interactive startup banner. */
  version?: string;
  /** Interactive startup banner, one element per row; replaces the default
   * (name, version and a one-line hint). Used verbatim. */
  banner?: string[];
  /** Pinned provider. When set, --provider is rejected and config is not read. */
  provider?: Provider;
  /** Config directory name under ~/.config; defaults to `name`. */
  configDir?: string;
  /** Test-only: overrides the config/auth-store base directory. */
  baseDir?: string;
  /** Test-only: overrides "stdin and stdout are a TTY". */
  isTerminal?: boolean;
}
```

In `help()`, add after the `auth status` line:

```ts
      `  ${opts.name} --version`,
```

In `parseArgs` options, add:

```ts
          version: { type: "boolean", short: "V", default: false },
```

Right after the `if (values.help)` block:

```ts
      if (values.version) {
        console.log(
          opts.version === undefined
            ? opts.name
            : `${opts.name} v${opts.version}`,
        );
        return 0;
      }
```

In the `runInteractive({...})` call add two properties:

```ts
          version: opts.version,
          banner: opts.banner,
```

In `run-interactive.ts`, extend `InteractiveOptions`:

```ts
export interface InteractiveOptions extends ChatSessionOptions {
  /** Shown in the header, e.g. the CLI name. */
  title: string;
  /** Shown in the default startup banner. */
  version?: string;
  /** Vendor startup banner; replaces the default when set. */
  banner?: string[];
  /** Test-only: replaces createCliRenderer. */
  createRenderer?: () => Promise<CliRenderer>;
  /** Test-only: replaces the working-directory index. */
  index?: FileIndex;
}
```

(The fields are unused in `runInteractive` until Task 8; TypeScript allows that.)

In `bin.ts`:

```ts
#!/usr/bin/env node
import { createRequire } from "node:module";
import { createCli } from "./create-cli.js";

// Works from src/ (bun) and dist/ (node): both sit one level under the package.
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

// Set exitCode instead of calling process.exit(): on a pipe, stdout writes are
// asynchronous and process.exit() would drop pending output.
process.exitCode = await createCli({ name: "chatbridge", version }).run(
  process.argv,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/src/create-cli.test.ts`
Expected: PASS. Then `bun packages/cli/src/bin.ts --version` prints `chatbridge v0.3.0`.

- [ ] **Step 5: Run the full check and commit**

```bash
bun run check
git add packages/cli/src/create-cli.ts packages/cli/src/create-cli.test.ts packages/cli/src/bin.ts packages/cli/src/tui/run-interactive.ts
git commit -m "feat(cli): createCli version/banner options and --version (Refs #28)"
gh issue comment 28 --body "Committed createCli({ version, banner }) and --version / -V; bin.ts passes the package version. What's next: inline mention popup, ChatView restyle (header, labels, banner, hairline input), wiring banner into runInteractive, README."
```

---

### Task 4: Inline mention popup

**Files:**
- Modify: `packages/cli/src/tui/mention-popup.ts`
- Test: `packages/cli/src/tui/mention-popup.test.ts` (rewrite)

**Interfaces:**
- Consumes: `theme`, `styled` from Task 1.
- Produces:
  ```ts
  export const MAX_ROWS = 8;
  export const POPUP_HINT = "↕ select · Tab/Enter accept · Esc close";
  export class MentionPopup {
    constructor(renderer: CliRenderer, parent: BoxRenderable); // appended to parent as its last child at construction time
    get visible(): boolean;
    get selected(): string | undefined;
    show(candidates: string[]): void;
    hide(): void;
    move(delta: 1 | -1): void;
    destroy(): void;
  }
  ```
  The `bottom` option is gone. Placement is by insertion order: `ChatView` constructs the popup after the input box and before the status row.

- [ ] **Step 1: Rewrite the test file**

```ts
// packages/cli/src/tui/mention-popup.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { MAX_ROWS, MentionPopup, POPUP_HINT } from "./mention-popup.js";

let teardown: (() => void) | undefined;
afterEach(() => {
  teardown?.();
  teardown = undefined;
});

/** Root: history (grows) / input / popup / status — the ChatView order. */
async function setup() {
  const t = await createTestRenderer({ width: 40, height: 14 });
  const root = new BoxRenderable(t.renderer, {
    id: "root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });
  const history = new BoxRenderable(t.renderer, { id: "history", flexGrow: 1 });
  history.add(new TextRenderable(t.renderer, { content: "HISTORY LINE" }));
  root.add(history);
  root.add(new TextRenderable(t.renderer, { id: "input", content: "INPUT" }));
  const popup = new MentionPopup(t.renderer, root);
  root.add(new TextRenderable(t.renderer, { id: "status", content: "STATUS" }));
  t.renderer.root.add(root);
  teardown = () => {
    popup.destroy();
    t.renderer.destroy();
  };
  await t.renderOnce();
  const rows = () => t.captureCharFrame().split("\n");
  return { ...t, popup, rows };
}

describe("MentionPopup", () => {
  test("starts hidden and takes no rows", async () => {
    const t = await setup();
    expect(t.popup.visible).toBe(false);
    expect(t.popup.selected).toBeUndefined();
    const rows = t.rows();
    const input = rows.findIndex((r) => r.startsWith("INPUT"));
    expect(rows[input + 1]).toStartWith("STATUS");
    expect(t.captureCharFrame()).not.toContain(POPUP_HINT);
  });

  test("show lists candidates between the input and the status row", async () => {
    const t = await setup();
    t.popup.show(["src/a.ts", "src/b.ts"]);
    await t.renderOnce();
    expect(t.popup.visible).toBe(true);
    expect(t.popup.selected).toBe("src/a.ts");
    const rows = t.rows();
    const input = rows.findIndex((r) => r.startsWith("INPUT"));
    expect(rows[input + 1]).toBe("  src/a.ts".padEnd(40));
    expect(rows[input + 2]).toBe("  src/b.ts".padEnd(40));
    expect(rows[input + 3]).toContain(POPUP_HINT);
    expect(rows[input + 4]).toStartWith("STATUS");
    expect(t.captureCharFrame()).toContain("HISTORY LINE");
  });

  test("move wraps in both directions", async () => {
    const t = await setup();
    t.popup.show(["a", "b", "c"]);
    t.popup.move(1);
    expect(t.popup.selected).toBe("b");
    t.popup.move(1);
    t.popup.move(1);
    expect(t.popup.selected).toBe("a");
    t.popup.move(-1);
    expect(t.popup.selected).toBe("c");
  });

  test("show resets the selection and hides on an empty list", async () => {
    const t = await setup();
    t.popup.show(["a", "b"]);
    t.popup.move(1);
    t.popup.show(["x", "y"]);
    expect(t.popup.selected).toBe("x");
    t.popup.show([]);
    expect(t.popup.visible).toBe(false);
    expect(t.popup.selected).toBeUndefined();
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("x");
  });

  test("hide removes the rows and the hint", async () => {
    const t = await setup();
    t.popup.show(["src/a.ts"]);
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("src/a.ts");
    t.popup.hide();
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("src/a.ts");
    expect(t.captureCharFrame()).not.toContain(POPUP_HINT);
  });

  test("shows at most MAX_ROWS candidates", async () => {
    const t = await setup();
    const many = Array.from({ length: 12 }, (_, i) => `file-${i}.ts`);
    t.popup.show(many);
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(MAX_ROWS).toBe(8);
    expect(frame).toContain("file-7.ts");
    expect(frame).not.toContain("file-8.ts");
  });

  test("long candidates are truncated to the terminal width", async () => {
    const t = await setup();
    t.popup.show(["x".repeat(100)]);
    await t.renderOnce();
    for (const row of t.captureCharFrame().split("\n")) {
      expect(row.length).toBeLessThanOrEqual(40);
    }
    expect(t.captureCharFrame()).toContain(`  ${"x".repeat(38)}`);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/src/tui/mention-popup.test.ts`
Expected: FAIL — constructor signature / `POPUP_HINT` missing.

- [ ] **Step 3: Rewrite `mention-popup.ts`**

```ts
// packages/cli/src/tui/mention-popup.ts
import {
  BoxRenderable,
  type CliRenderer,
  TextRenderable,
} from "@opentui/core";
import { styled, theme } from "./theme.js";

/** Rows shown at once; the search already caps candidates to this. */
export const MAX_ROWS = 8;
export const POPUP_HINT = "↕ select · Tab/Enter accept · Esc close";
const INDENT = "  ";

/** Candidate list for an `@` mention, drawn inline below the input (the
 * parent's next child after the input, before the status row). Hidden it
 * takes no rows. Purely presentational: the view decides what the keys do.
 * Rows are created once and re-labelled, so show/hide never churns
 * renderables. */
export class MentionPopup {
  private readonly box: BoxRenderable;
  private readonly rows: TextRenderable[] = [];
  private candidates: string[] = [];
  private index = 0;

  constructor(
    private readonly renderer: CliRenderer,
    parent: BoxRenderable,
  ) {
    this.box = new BoxRenderable(renderer, {
      id: "mention-popup",
      flexDirection: "column",
      flexShrink: 0,
      visible: false,
    });
    for (let i = 0; i < MAX_ROWS; i++) {
      const row = new TextRenderable(renderer, {
        content: "",
        visible: false,
        wrapMode: "none",
      });
      this.rows.push(row);
      this.box.add(row);
    }
    this.box.add(
      new TextRenderable(renderer, {
        content: styled(theme.muted(`${INDENT}${POPUP_HINT}`)),
        wrapMode: "none",
      }),
    );
    parent.add(this.box);
  }

  get visible(): boolean {
    return this.box.visible;
  }

  get selected(): string | undefined {
    return this.candidates[this.index];
  }

  /** Replaces the list and selects the first row. Empty list hides. */
  show(candidates: string[]): void {
    this.candidates = candidates.slice(0, MAX_ROWS);
    this.index = 0;
    if (this.candidates.length === 0) {
      this.hide();
      return;
    }
    this.box.visible = true;
    this.paint();
  }

  hide(): void {
    this.candidates = [];
    this.index = 0;
    this.box.visible = false;
  }

  /** Moves the selection, wrapping at both ends. */
  move(delta: 1 | -1): void {
    const n = this.candidates.length;
    if (n === 0) return;
    this.index = (this.index + delta + n) % n;
    this.paint();
  }

  destroy(): void {
    this.box.visible = false;
  }

  private paint(): void {
    const width = Math.max(1, this.renderer.terminalWidth - INDENT.length);
    this.rows.forEach((row, i) => {
      const label = this.candidates[i];
      if (label === undefined) {
        row.visible = false;
        return;
      }
      row.visible = true;
      const text = label.slice(0, width);
      if (i === this.index) {
        row.content = styled(theme.selected(`${INDENT}${text}`));
        return;
      }
      const slash = text.lastIndexOf("/");
      row.content =
        slash === -1
          ? styled(`${INDENT}${text}`)
          : styled(
              INDENT,
              theme.muted(text.slice(0, slash + 1)),
              text.slice(slash + 1),
            );
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/src/tui/mention-popup.test.ts`
Expected: PASS. (`chat-view.ts` no longer compiles because it passes `{ bottom }`; that is fixed in the next step, before the check.)

- [ ] **Step 5: Minimal ChatView fix-up so the build passes**

In `packages/cli/src/tui/chat-view.ts` replace

```ts
    this.popup = new MentionPopup(renderer, root, {
      bottom: INPUT_BOX_HEIGHT + STATUS_HEIGHT,
    });
```

with, placed **between** `root.add(inputBox);` and the creation of `this.status`:

```ts
    this.popup = new MentionPopup(renderer, root);
```

(Move the line up; the status `TextRenderable` must be added to `root` after the popup.) Then run `bun test packages/cli/src/tui/chat-view.test.ts`: expected PASS — the popup tests only check content, not placement.

- [ ] **Step 6: Run the full check and commit**

```bash
bun run check
git add packages/cli/src/tui/mention-popup.ts packages/cli/src/tui/mention-popup.test.ts packages/cli/src/tui/chat-view.ts
git commit -m "feat(tui): mention popup drawn inline below the input (Refs #28)"
gh issue comment 28 --body "Committed inline MentionPopup (no absolute positioning, hint row, muted directory part). What's next: ChatView header/labels/status restyle, banner, hairline input, runInteractive wiring, README."
```

---

### Task 5: ChatView header, role labels, status styling

**Files:**
- Modify: `packages/cli/src/tui/chat-view.ts`
- Test: `packages/cli/src/tui/chat-view.test.ts`

**Interfaces:**
- Produces: `ChatViewOptions` gains `headless: boolean`. Labels become `user` / `assistant` / `error` (lower-case). `GUIDE` text unchanged.

- [ ] **Step 1: Update the tests**

In `chat-view.test.ts` `setup()`, add `headless: true,` to the `ChatView` options (and in the two inline `new ChatView(...)` calls in the file, and in `run-interactive.test.ts`'s `waitForQuit` test). Replace every `frameWith("You")` with `frameWith("user")`, `toContain("You")` with `toContain("user")`, `toContain("Assistant")` with `toContain("assistant")`, `toContain("Error")` with `toContain("error")`. Rename the test `"error messages are labelled Error"` to `"error messages are labelled error"`. Replace the first test with:

```ts
  test("shows the badge header and the guide when idle", async () => {
    const t = await setup();
    const frame = t.captureCharFrame();
    expect(frame.split("\n")[0]).toBe(
      " test-cli  dummy-chat · headless · 2s budget".padEnd(80),
    );
    expect(frame).toContain(GUIDE);
  });

  test("header says headful when not headless", async () => {
    const t = await setup({ headless: false });
    expect(t.captureCharFrame()).toContain("dummy-chat · headful · 2s budget");
  });
```

Add `headless?: boolean` to the `setup` options type and pass `headless: opts.headless ?? true`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: FAIL on header and label assertions.

- [ ] **Step 3: Implement**

In `chat-view.ts`:

```ts
import { MUTED_COLOR, styled, theme } from "./theme.js";
```

Replace `LABELS` with:

```ts
const LABELS: Record<Role, () => StyledText> = {
  user: () => styled(theme.user("user")),
  assistant: () => styled(theme.assistant("assistant")),
  error: () => styled(theme.error("error")),
};
```

(import `type StyledText` from `@opentui/core`). Add to `ChatViewOptions`:

```ts
  /** Shown in the header as "headless" or "headful". */
  headless: boolean;
```

Replace the header renderable:

```ts
    root.add(
      new TextRenderable(renderer, {
        id: "header",
        content: styled(
          theme.badge(` ${opts.title} `),
          " ",
          theme.muted(
            `${opts.providerName} · ${opts.headless ? "headless" : "headful"} · ${this.budgetSec}s budget`,
          ),
        ),
        wrapMode: "none",
        marginBottom: 1,
      }),
    );
```

(`this.budgetSec` is assigned before `root` is built; keep that order.)

In `messageBox`:

```ts
    box.add(new TextRenderable(this.renderer, { content: LABELS[message.role]() }));
    box.add(
      new TextRenderable(this.renderer, {
        content:
          message.role === "error"
            ? styled(theme.errorText(message.text))
            : message.text,
        wrapMode: "word",
      }),
    );
    for (const a of message.attachments ?? []) {
      box.add(
        new TextRenderable(this.renderer, {
          content: styled(theme.muted(`📎 ${a.path} (${formatSize(a.bytes)})`)),
        }),
      );
    }
```

Status: initial `content: styled(theme.muted(GUIDE))`; in `update()` idle branch `this.status.content = styled(theme.muted(GUIDE));`. The spinner tick keeps a plain string. `setStatus` keeps a plain string.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/src/tui/chat-view.test.ts packages/cli/src/tui/run-interactive.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full check and commit**

```bash
bun run check
git add packages/cli/src/tui/chat-view.ts packages/cli/src/tui/chat-view.test.ts packages/cli/src/tui/run-interactive.test.ts
git commit -m "feat(tui): badge header, coloured role labels, muted status (Refs #28)"
gh issue comment 28 --body "Committed ChatView header badge (name · provider · mode · budget), lower-case coloured role labels, muted guide/attachments. What's next: startup banner, hairline input growth, runInteractive wiring, README."
```

---

### Task 6: Startup banner in the empty history

**Files:**
- Modify: `packages/cli/src/tui/chat-view.ts`
- Test: `packages/cli/src/tui/chat-view.test.ts`

**Interfaces:**
- Consumes: `resolveBanner` output type `StyledText[]` (Task 2).
- Produces: `ChatViewOptions.banner: StyledText[]`.

- [ ] **Step 1: Write the failing tests**

In `setup()` accept `banner?: StyledText[]` and pass `banner: opts.banner ?? resolveBanner({ name: "test-cli", version: "0.0.1", providerName: "dummy-chat" })` (import `resolveBanner` from `./banner.js` and `styled`, `theme` from `./theme.js`). Add to the two inline `new ChatView` calls and to `run-interactive.test.ts` the option `banner: []`. Add tests:

```ts
  test("the banner is centred in the empty history", async () => {
    const t = await setup();
    const rows = t.captureCharFrame().split("\n");
    const title = rows.findIndex((r) => r.includes("test-cli v0.0.1"));
    expect(title).toBeGreaterThan(2);
    expect(rows[title + 1]).toContain(
      "Connected to dummy-chat. Type a message, or @ to attach a file.",
    );
    // Centred: roughly as much blank space left as right.
    const line = rows[title] ?? "";
    const left = line.length - line.trimStart().length;
    const right = line.length - line.trimEnd().length;
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
    // Vertically centred between the header (2 rows) and the input.
    const inputTop = rows.findIndex((r) => r.startsWith("─"));
    expect(Math.abs(title - 2 - (inputTop - title - 2))).toBeLessThanOrEqual(2);
  });

  test("a vendor banner is drawn line by line and over-wide lines are cut", async () => {
    const t = await setup({
      banner: ["ACME", "x".repeat(120)].map((l) => styled(theme.muted(l))),
    });
    const frame = t.captureCharFrame();
    expect(frame).toContain("ACME");
    expect(frame).toContain("x".repeat(80));
    expect(frame).not.toContain("x".repeat(81));
    for (const row of frame.split("\n")) expect(row.length).toBeLessThanOrEqual(80);
  });

  test("the banner disappears with the first message and never returns", async () => {
    const t = await setup();
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    const frame = await t.frameWith("Echo: hello");
    expect(frame).not.toContain("test-cli v0.0.1");
  });
```

The vertical-centring assertion in the first test depends on the input box hairlines from Task 7; until then use `rows.findIndex((r) => r.includes("┌"))` for `inputTop`, and switch to `startsWith("─")` in Task 7.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: FAIL — `banner` unknown, no banner text in frame.

- [ ] **Step 3: Implement**

In `ChatViewOptions` add:

```ts
  /** Startup banner lines, shown centred until the first message. */
  banner: StyledText[];
```

In the constructor replace the history creation with a body slot:

```ts
    this.body = new BoxRenderable(renderer, {
      id: "body",
      flexGrow: 1,
      flexDirection: "column",
    });
    root.add(this.body);
    this.banner = new BoxRenderable(renderer, {
      id: "banner",
      flexGrow: 1,
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
    });
    for (const line of opts.banner) {
      this.banner.add(
        new TextRenderable(renderer, { content: line, wrapMode: "none" }),
      );
    }
    this.history = new ScrollBoxRenderable(renderer, {
      id: "history",
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    this.body.add(this.banner);
```

Add fields `private readonly body: BoxRenderable; private readonly banner: BoxRenderable; private bannerShown = true;`.

In `update()`, before the message loop:

```ts
    if (this.bannerShown && this.model.messages.length > 0) {
      this.bannerShown = false;
      this.body.remove(this.banner);
      this.body.add(this.history);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/src/tui/chat-view.test.ts packages/cli/src/tui/run-interactive.test.ts`
Expected: PASS. If `body.remove(this.banner)` leaves the banner painted, use `this.banner.visible = false` in addition; if `remove` throws for a `ScrollBoxRenderable` never added, add the history first with `visible: false` and toggle `visible` instead of `remove`/`add` (the tests are unchanged either way).

- [ ] **Step 5: Run the full check and commit**

```bash
bun run check
git add packages/cli/src/tui/chat-view.ts packages/cli/src/tui/chat-view.test.ts packages/cli/src/tui/run-interactive.test.ts
git commit -m "feat(tui): centred startup banner until the first message (Refs #28)"
gh issue comment 28 --body "Committed the startup banner: centred in the empty history, replaced by the history on the first message, over-wide lines truncated. What's next: hairline input that grows to five rows, runInteractive wiring, README."
```

---

### Task 7: Hairline input that grows to five rows

**Files:**
- Modify: `packages/cli/src/tui/chat-view.ts`
- Test: `packages/cli/src/tui/chat-view.test.ts`

**Interfaces:**
- Produces: `export const MAX_INPUT_ROWS = 5;` in `chat-view.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
  test("the input is a bare > between two hairlines, one row when empty", async () => {
    const t = await setup();
    const rows = t.captureCharFrame().split("\n");
    const top = rows.findIndex((r) => r.startsWith("─"));
    expect(top).toBeGreaterThan(0);
    expect(rows[top]).toBe("─".repeat(80));
    expect(rows[top + 1]).toStartWith("> Type a message");
    expect(rows[top + 2]).toBe("─".repeat(80));
    expect(rows[top + 3]).toContain(GUIDE);
    expect(t.captureCharFrame()).not.toContain("┌");
  });

  test("the input grows one row per newline up to five, then scrolls", async () => {
    const t = await setup({ kittyKeyboard: true });
    const hairlines = () => {
      const rows = t.captureCharFrame().split("\n");
      const top = rows.findIndex((r) => r.startsWith("─"));
      const bottom = rows.findIndex((r, i) => i > top && r.startsWith("─"));
      return { rows, top, bottom, inner: bottom - top - 1 };
    };
    for (let i = 1; i <= 7; i++) {
      await t.mockInput.typeText(`line${i}`);
      await t.renderOnce();
      expect(hairlines().inner).toBe(Math.min(i, MAX_INPUT_ROWS));
      t.mockInput.pressEnter({ shift: true });
    }
    const { rows, top } = hairlines();
    // Seven lines typed (plus a trailing empty one), five visible: the
    // oldest scrolled out, the cursor line still in view.
    expect(rows[top + 1]).not.toContain("line1");
    const shown = rows.slice(top + 1, top + 1 + MAX_INPUT_ROWS).join("\n");
    expect(shown).toContain("line7");
    expect(t.captureCharFrame()).toContain(GUIDE);
  });

  test("the history shrinks to make room for the input", async () => {
    const t = await setup({ delayMs: 10, kittyKeyboard: true });
    await t.mockInput.typeText("first");
    t.mockInput.pressEnter();
    await t.frameWith("Echo: first");
    const before = t.captureCharFrame().split("\n").findIndex((r) => r.startsWith("─"));
    await t.mockInput.typeText("a");
    t.mockInput.pressEnter({ shift: true });
    await t.mockInput.typeText("b");
    t.mockInput.pressEnter({ shift: true });
    await t.mockInput.typeText("c");
    await t.renderOnce();
    const after = t.captureCharFrame().split("\n").findIndex((r) => r.startsWith("─"));
    expect(after).toBe(before - 2);
    expect(t.captureCharFrame()).toContain("Echo: first");
  });
```

Update the Task 6 banner test's `inputTop` to `rows.findIndex((r) => r.startsWith("─"))`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: FAIL — the frame has `┌` borders and a fixed 4-row textarea.

- [ ] **Step 3: Implement**

Remove `INPUT_BOX_HEIGHT` and `STATUS_HEIGHT`. Add:

```ts
export const MAX_INPUT_ROWS = 5;
```

Replace the input box construction:

```ts
    const inputBox = new BoxRenderable(renderer, {
      id: "input-box",
      flexDirection: "row",
      flexShrink: 0,
      border: ["top", "bottom"],
      borderColor: MUTED_COLOR,
    });
    inputBox.add(
      new TextRenderable(renderer, {
        id: "prompt",
        content: styled(theme.muted("> ")),
        flexShrink: 0,
      }),
    );
    this.input = new TextareaRenderable(renderer, {
      id: "input",
      flexGrow: 1,
      height: 1,
      wrapMode: "word",
      placeholder: "Type a message",
      placeholderColor: MUTED_COLOR,
      keyBindings: [
        // unchanged bindings
      ],
    });
    inputBox.add(this.input);
    root.add(inputBox);
```

Keep the status renderable as `height: 1, flexShrink: 0`. Add a method and call it from the existing `onContentChange` hook:

```ts
    this.input.onContentChange = () => {
      this.fitInput();
      this.refreshPopup();
    };
```

```ts
  /** One row when empty, one more per line up to MAX_INPUT_ROWS; beyond
   * that the textarea scrolls internally and the history gives up rows. */
  private fitInput(): void {
    this.input.height = Math.min(
      MAX_INPUT_ROWS,
      Math.max(1, this.input.lineCount),
    );
  }
```

Also call `this.fitInput()` after `this.input.clear()` in `onSubmit` and after `this.input.insertText(text)` in the refill branch (the content-change hook may or may not fire for programmatic edits; calling it explicitly is harmless).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: PASS. If the "then scrolls" assertion fails because the cursor line is not kept in view, check `EditBufferRenderable` for a scroll-to-cursor option; the growth assertions must pass regardless.

- [ ] **Step 5: Run the full check and commit**

```bash
bun run check
git add packages/cli/src/tui/chat-view.ts packages/cli/src/tui/chat-view.test.ts
git commit -m "feat(tui): hairline input growing to five rows (Refs #28)"
gh issue comment 28 --body "Committed the hairline input: bare > between two rules, 1 row empty, grows to 5 with newlines, scrolls beyond; history shrinks. What's next: popup placement test, runInteractive wiring of banner/headless, README, screenshots."
```

---

### Task 8: Popup placement in ChatView and `runInteractive` wiring

**Files:**
- Modify: `packages/cli/src/tui/chat-view.ts` (comment + placement test only)
- Modify: `packages/cli/src/tui/run-interactive.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/src/tui/chat-view.test.ts`, `packages/cli/src/tui/run-interactive.test.ts`

**Interfaces:**
- Consumes: `resolveBanner` (Task 2), `InteractiveOptions.version/banner` (Task 3), `ChatViewOptions.headless/banner` (Tasks 5–6).

- [ ] **Step 1: Write the failing tests**

`chat-view.test.ts`:

```ts
  test("the popup sits between the input and the status row", async () => {
    const t = await setup({ paths: ["src/a.ts"] });
    await t.mockInput.typeText("@");
    await t.renderOnce();
    const rows = t.captureCharFrame().split("\n");
    const bottomRule = rows.map((r) => r.startsWith("─")).lastIndexOf(true);
    expect(rows[bottomRule + 1]).toContain("src/a.ts");
    expect(rows[bottomRule + 2]).toContain(POPUP_HINT);
    expect(rows[bottomRule + 3]).toContain(GUIDE);
  });
```

(import `POPUP_HINT` from `./mention-popup.js`.)

`run-interactive.test.ts`: add a test that the banner reaches the view. `runInteractive` builds the view internally, so test through the renderer: use `createRenderer` returning a test renderer, resolve quit by destroying it after the first frame.

```ts
  test("shows the default banner with the provider name, then quits on destroy", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    let frame = "";
    const run = runInteractive({
      ...sessionOpts(() => {}),
      version: "1.2.3",
      createRenderer: async () => t.renderer,
      index: FileIndex.fromPaths([]),
    });
    for (let i = 0; i < 50 && !frame.includes("test-cli v1.2.3"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await t.renderOnce();
      frame = t.captureCharFrame();
    }
    expect(frame).toContain("test-cli v1.2.3");
    expect(frame).toContain("Connected to fake.");
    expect(frame).toContain("fake · headless · 1s budget");
    t.renderer.destroy();
    expect(await run).toEqual({});
  });

  test("a vendor banner replaces the default", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    let frame = "";
    const run = runInteractive({
      ...sessionOpts(() => {}),
      banner: ["ACME BANNER"],
      createRenderer: async () => t.renderer,
      index: FileIndex.fromPaths([]),
    });
    for (let i = 0; i < 50 && !frame.includes("ACME BANNER"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await t.renderOnce();
      frame = t.captureCharFrame();
    }
    expect(frame).toContain("ACME BANNER");
    expect(frame).not.toContain("Connected to");
    t.renderer.destroy();
    await run;
  });
```

If `renderer.start()` inside `runInteractive` conflicts with `renderOnce` on a test renderer, wrap `renderer.start` in the test: `createRenderer: async () => { t.renderer.start = () => {}; return t.renderer; }`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/src/tui`
Expected: FAIL — banner/headless not forwarded (`ChatView` options missing → type error at build, or frame lacks the banner).

- [ ] **Step 3: Implement**

`run-interactive.ts`: import `resolveBanner` and build the view with

```ts
    view = new ChatView(renderer, model, {
      title: opts.title,
      providerName: opts.provider.name,
      headless: opts.headless ?? true,
      timeoutMs: opts.timeoutMs,
      index,
      banner: resolveBanner({
        name: opts.title,
        version: opts.version,
        providerName: opts.provider.name,
        banner: opts.banner,
      }),
    });
```

(Check `ChatSessionOptions.headless` in `packages/core` for its optionality and default; mirror it.)

`chat-view.ts`: update the class doc comment to the new layout:

```ts
/** Builds the OpenTUI tree for one ChatModel and mirrors its state.
 * Layout, top to bottom: badge header / banner-or-history / hairline input
 * (1–5 rows) / inline mention popup (hidden unless the cursor is in an `@`
 * mention) / status line. */
```

`index.ts`: no change needed if `CreateCliOptions` is already exported (it is); confirm `banner`/`version` appear in `dist/create-cli.d.ts` after `bun run build`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli`
Expected: PASS (including `cli.e2e.test.ts`).

- [ ] **Step 5: Run the full check and commit**

```bash
bun run check
git add packages/cli/src/tui/chat-view.ts packages/cli/src/tui/chat-view.test.ts packages/cli/src/tui/run-interactive.ts packages/cli/src/tui/run-interactive.test.ts
git commit -m "feat(tui): wire banner and mode into the interactive view (Refs #28)"
gh issue comment 28 --body "Committed runInteractive wiring: default/vendor banner resolved with the provider name, headless/headful in the header, popup placement covered by a test. What's next: README, roadmap, manual light/dark screenshots, whole-branch review, PR."
```

---

### Task 9: Docs, roadmap, manual check

**Files:**
- Modify: `README.md` (Install section and Interactive mode section)
- Modify: `docs/ROADMAP.md` (milestone 7 heading)

- [ ] **Step 1: README**

After the `defaultProvider` paragraph in "Install (npm)", add:

```markdown
A derived CLI passes its own identity to `createCli`:

```ts
createCli({
  name: "acme-ai",
  version: "2.4.0",            // shown by --version and in the startup banner
  banner: ["Acme internal assistant", "Conversations are not stored."], // optional
  provider,
});
```

`--version` (`-V`) prints `name vX.Y.Z`.
```

In "Interactive mode", add a bullet after the first one:

```markdown
- The screen is a header (CLI name, provider, headless/headful, timeout
  budget), the conversation with `user` / `assistant` / `error` labels, and
  a `>` input between two rules that grows to five rows as you add
  newlines. Until the first message the history shows a startup banner
  (the CLI name and version by default; a derived CLI can pass its own
  `banner` lines to `createCli`).
```

- [ ] **Step 2: Roadmap**

Change `### 7. Interactive TUI visual redesign — in progress (issue #28)` to `### 7. Interactive TUI visual redesign — done (issue #28, 2026-09-09)` and append one sentence to that section: `Shipped with \`createCli({ version, banner })\` and \`--version\`; spec: \`docs/superpowers/specs/2026-09-09-tui-visual-redesign-design.md\`.`

- [ ] **Step 3: Manual check (ask the user)**

The implementer cannot open a real terminal. Post to the issue a request for the user to run

```bash
bun run examples/dummy-chat/serve.ts &
bun packages/cli/src/bin.ts --provider ./examples/dummy-chat/provider.ts
```

in a light and a dark terminal theme and attach screenshots to issue #28. Record in the PR description that this was requested.

- [ ] **Step 4: Run the full check and commit**

```bash
bun run check
git add README.md docs/ROADMAP.md
git commit -m "docs: README and roadmap for the TUI visual redesign (Refs #28)"
gh issue comment 28 --body "Committed README (createCli version/banner, --version, new layout) and roadmap. What's next: manual light/dark screenshots by the user, whole-branch review (Fable), PR."
```

---

## Self-review

- **Spec coverage:** header (T5), history labels/error body/attachments (T5), banner incl. truncation and swap (T2, T6), hairline input growth and history shrink (T7), inline popup with hint and status kept (T4, T8), status row (T5), resize left to flex (no task, by design), theme tokens (T1), `createCli` options and `--version` (T3), `bin.ts` version (T3), `InteractiveOptions` (T3, T8), README/roadmap/manual (T9). Vendor banner test in `create-cli.test.ts` is covered instead through `banner.test.ts` (pure function) and `run-interactive.test.ts` (end-to-end).
- **Placeholder scan:** none.
- **Type consistency:** `Styler`, `styled`, `theme.*`, `MUTED_COLOR` (T1) used in T2, T4–T7; `resolveBanner(BannerInput): StyledText[]` (T2) used in T6 tests and T8; `ChatViewOptions { title, providerName, headless, timeoutMs, index, banner }` complete by T6; `InteractiveOptions.version/banner` (T3) consumed in T8; `MentionPopup(renderer, parent)` (T4) used in T4 step 5 and T8; `MAX_INPUT_ROWS` (T7) used in T7 tests; `POPUP_HINT` (T4) used in T8 tests.
