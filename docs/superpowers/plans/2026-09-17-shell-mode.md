# `!` Shell Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `!` on an empty input switches the interactive TUI into shell mode; Enter runs the command in the start directory, its output streams into the history, and the result is sent to the service under a configurable lead-in (or held back and attached to the next message).

**Architecture:** A new OpenTUI-free `packages/cli/src/shell/` module runs the command (`runCommand`), formats the result (`formatShellSection` / `formatShellPrompt`), and resolves the three configuration layers (`resolveShellConfig`). `ChatModel` gains a `running` status, a `shell` role, `runShell()` / `stopShell()`, and a held-results list; the send path is shared with `submit()`. `ChatView` owns the shell-mode flag (prompt `! `, exit keys, no `@` popup), rewrites the live output entry, and shows the new status texts. `createCli` resolves `shell: { leadIn, autoSend }` from built-in → vendor → `config.json` and passes it through `runInteractive`.

**Tech Stack:** TypeScript, Bun (workspaces, `bun test`), OpenTUI 0.5.10 (`@opentui/core`, `@opentui/core/testing`), Node `child_process`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-17-shell-mode-design.md`

## Global Constraints

- Branch `issue-47`; every commit message ends with `(Refs #47)` and the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run `bun install` once at the start of the branch (`node_modules` may be absent). `bun run check` (Biome lint + `tsc --build` + `bun test`) must pass before every commit.
- Dependency direction is one-way: `cli → core → runtime → provider`. Nothing under `packages/cli/src/shell/` and nothing in `chat-model.ts` may import `@opentui/core`.
- Every document, comment, and commit message is in English.
- Command lines and command output go only into the history: never to `onProgress`, never to stderr, never to logs.
- Linux and macOS only: `stop()` relies on process groups (`detached: true`, `process.kill(-pid)`). CI runs Ubuntu.
- Exact strings: default lead-in `Please check the execution result.`; output cap `200 * 1024` bytes; SIGKILL grace `2_000` ms; output throttle `100` ms; shell placeholder `Run a shell command`; held footer `📎 held, sent with your next message`; running status `Running…  Ns · Ctrl+C stop`.
- Status-row texts must fit 80 columns (the row is one fixed line and clips). Because of that the idle guide drops the Shift+Enter mention (Ctrl+J works on every terminal; README still documents both):
  - `GUIDE` = `Enter send · Ctrl+J newline · @ file · ! shell · Ctrl+R reopen · Ctrl+C quit`
  - `SHELL_GUIDE` = `Enter run · Esc exit shell · Ctrl+R reopen · Ctrl+C quit`
  - `HELD_GUIDE` = `Enter send · @ file · ! shell · Ctrl+R reopen · Ctrl+C quit`, shown as `📎 N held · ` + `HELD_GUIDE` (or + `SHELL_GUIDE` in shell mode) while results are held.
- Subagent model policy: Task 2, 4, 5, 9 → Sonnet; Task 1, 3, 6, 7, 8 → Opus.
- One deviation from the spec, decided while planning: `shell` is optional on `ChatModelOptions` and `InteractiveOptions` (default `DEFAULT_SHELL_CONFIG`) so the existing tests keep constructing models without it. `resolveShellConfig` always starts from the built-in default, so callers pass only the vendor and user layers.

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/cli/src/fence.ts` (new) | `fenceFor` shared by mentions and shell | 2 |
| `packages/cli/src/fence.test.ts` (new) | fence lengthening | 2 |
| `packages/cli/src/mentions/expand-mentions.ts` | import `fenceFor` from `../fence.js` | 2 |
| `packages/cli/src/shell/shell-config.ts` (new) | `ShellConfig`, `DEFAULT_SHELL_CONFIG`, `resolveShellConfig` | 2 |
| `packages/cli/src/shell/shell-config.test.ts` (new) | layer precedence | 2 |
| `packages/cli/src/shell/run-command.ts` (new) | `runCommand`, `ShellResult`, `RunningCommand` | 3 |
| `packages/cli/src/shell/run-command.test.ts` (new) | real `/bin/sh` runs | 3 |
| `packages/cli/src/shell/format-result.ts` (new) | `formatShellSection`, `formatShellPrompt` | 4 |
| `packages/cli/src/shell/format-result.test.ts` (new) | exact prompt text | 4 |
| `packages/cli/src/config.ts` | `shell` section validation | 5 |
| `packages/cli/src/config.test.ts` | `shell` tests | 5 |
| `packages/cli/src/tui/chat-model.ts` | `running`, `shell` role, `runShell` / `stopShell`, held results, shared `sendPrompt` | 6 |
| `packages/cli/src/tui/chat-model.test.ts` | shell tests | 6 |
| `packages/cli/src/tui/theme.ts` | `theme.shell` | 7 |
| `packages/cli/src/tui/banner.ts` | new `BANNER_HINT` | 7 |
| `packages/cli/src/tui/chat-view.ts` | shell mode, live output, status texts | 7 |
| `packages/cli/src/tui/chat-view.test.ts` | view tests | 7 |
| `packages/cli/src/tui/run-interactive.ts` | `shell` option, Ctrl+C routing, teardown `stopShell` | 8 |
| `packages/cli/src/tui/run-interactive.test.ts` | Ctrl+C while running | 8 |
| `packages/cli/src/create-cli.ts` | `shell` option, config always loaded for interactive, help text | 8 |
| `packages/cli/src/create-cli.test.ts` | config `shell` reaches the interactive path | 8 |
| `README.md`, `docs/ROADMAP.md` | docs, milestone 10 entry | 9 |

---

### Task 1: OpenTUI spike — exit keys, paste delivery, placeholder setter

**Files:**
- Create (throwaway, never committed): `packages/cli/src/tui/spike-shell.test.ts`
- Modify: `docs/superpowers/plans/2026-09-17-shell-mode.md` (the "Spike findings" section at the end of this task)

**Interfaces:**
- Produces: facts Task 7 relies on — the mock-input call for Backspace and for a paste, whether `Ctrl+U` / `Backspace` reach a global `keypress` listener before the textarea, whether a paste arrives in `onContentChange` as one change, and whether `TextareaRenderable` has a settable `placeholder`.

- [ ] **Step 1: Install and look up the testing API**

```bash
bun install
grep -n "press\|paste\|typeText" packages/cli/node_modules/@opentui/core/dist/testing/*.d.ts | head -40
grep -n "placeholder" packages/cli/node_modules/@opentui/core/dist/renderables/*.d.ts | head
```

Note the exact method names (`pressBackspace`, `pasteText`, or whatever exists) and whether `placeholder` is a settable property on the textarea.

- [ ] **Step 2: Write the throwaway probe**

`packages/cli/src/tui/spike-shell.test.ts` (adapt the mock-input method names from Step 1):

```ts
import { describe, expect, test } from "bun:test";
import { type KeyEvent, TextareaRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("spike: textarea keys", () => {
  test("ctrl+u, backspace, paste, placeholder", async () => {
    const t = await createTestRenderer({ width: 40, height: 10 });
    const seen: string[] = [];
    const changes: string[] = [];
    const input = new TextareaRenderable(t.renderer, {
      id: "input",
      height: 3,
      placeholder: "before",
    });
    t.renderer.root.add(input);
    input.focus();
    input.onContentChange = () => changes.push(input.plainText);
    (t.renderer.keyInput as unknown as {
      on(e: "keypress", h: (k: KeyEvent) => void): void;
    }).on("keypress", (k) => seen.push(`${k.ctrl ? "ctrl+" : ""}${k.name}`));

    await t.mockInput.typeText("abc");
    t.mockInput.pressKey("u", { ctrl: true });
    await sleep(20);
    console.log("after ctrl+u:", JSON.stringify(input.plainText));

    await t.mockInput.typeText("xy");
    t.mockInput.pressBackspace(); // adjust to the real name from Step 1
    await sleep(20);
    console.log("after backspace:", JSON.stringify(input.plainText));

    changes.length = 0;
    input.clear();
    changes.length = 0;
    t.mockInput.pasteText("!ls -la"); // adjust to the real name from Step 1
    await sleep(50);
    console.log("paste changes:", JSON.stringify(changes));

    input.placeholder = "after"; // compile error here means no setter
    await t.renderOnce();
    console.log("keys seen:", JSON.stringify(seen));
    console.log("frame:", t.captureCharFrame());
    expect(true).toBe(true);
    t.renderer.destroy();
  });
});
```

- [ ] **Step 3: Run it and read the output**

Run: `bun test packages/cli/src/tui/spike-shell.test.ts`

Record: (a) what `Ctrl+U` does by default with text present; (b) the Backspace and paste mock-input method names; (c) whether the paste produced one `onContentChange` with the full text or several; (d) whether `ctrl+u` and `backspace` appear in `seen` (they reach the global listener); (e) whether `placeholder` is settable.

- [ ] **Step 4: Write the findings into this plan**

Replace the "Spike findings" block below with the facts (keep it short, one line per item). If a paste arrives one character at a time, Task 7's `detectShellMode` still works because it keys on "previous content empty and new content starts with `!`" and re-inserts everything after the `!`; note that here so the Task 7 implementer knows. If `placeholder` is not settable, Task 7 keeps the placeholder `Type a message` in shell mode and drops the `SHELL_PLACEHOLDER` test.

**Spike findings (2026-09-17):** measured against `@opentui/core` 0.5.10 under Bun 1.4.2.

- (a) Mock-input names: Backspace is `t.mockInput.pressBackspace(modifiers?)` (sync); a paste is `await t.mockInput.pasteBracketedText(text)` (async). `Ctrl+U` is `t.mockInput.pressKey("u", { ctrl: true })`.
- (b) Both `ctrl+u` and `backspace` reach a global `keypress` listener on `renderer.keyInput`, and that listener runs **before** the focused textarea: `key.preventDefault()` on either left `plainText` unchanged (`"pq"` stayed `"pq"`). Default `Ctrl+U` with text present deletes to line start — `"abc"` became `""`.
- (c) A paste arrives **whole**: `pasteBracketedText("!ls -la")` left `plainText === "!ls -la"` and fired `onContentChange` twice, both times already carrying the full text (`["!ls -la","!ls -la"]`). Task 7 consequence: `detectShellMode` sees the complete `!…` line on the first change, so the `!` and the rest arrive together; the duplicate second event is harmless because by then the previous content is non-empty.
- (d) `TextareaRenderable.placeholder` **is** settable after construction (declared `get`/`set placeholder(StyledText | string | null | undefined)`); assigning `"after"` reads back `"after"` and renders. Keep the `SHELL_PLACEHOLDER` test.
- (e) Calling `input.clear()` then `input.insertText(rest)` from inside `onContentChange` works and does **not** re-enter the hook synchronously (handler depth never exceeded 1; zero nested calls). The mutation does schedule further top-level `onContentChange` calls carrying the post-mutation text: typing `"!"` gave hook texts `["!","",""]` with final `plainText === ""`; pasting `"!echo hi"` gave `["!echo hi","echo hi","echo hi","echo hi"]` with final `plainText === "echo hi"`. Task 7 must therefore key the strip on "previous content empty and new content starts with `!`" so those follow-up events are no-ops.

- [ ] **Step 5: Delete the probe and commit the plan note**

```bash
rm packages/cli/src/tui/spike-shell.test.ts
bun run check
git add docs/superpowers/plans/2026-09-17-shell-mode.md
git commit -m "docs: record the OpenTUI key and paste spike for shell mode (Refs #47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 47 --body "Task 1 (OpenTUI spike) done: findings recorded in the plan. Next: Task 2 (fenceFor + shell-config)."
```

---

### Task 2: Shared `fenceFor` and `shell-config.ts`

**Files:**
- Create: `packages/cli/src/fence.ts`, `packages/cli/src/fence.test.ts`
- Modify: `packages/cli/src/mentions/expand-mentions.ts` (remove the local `fenceFor`, import it)
- Create: `packages/cli/src/shell/shell-config.ts`, `packages/cli/src/shell/shell-config.test.ts`

**Interfaces:**
- Produces: `fenceFor(content: string): string`; `ShellConfig { leadIn: string; autoSend: boolean }`; `DEFAULT_SHELL_CONFIG`; `resolveShellConfig(...layers: (Partial<ShellConfig> | undefined)[]): ShellConfig`.

- [ ] **Step 1: Write the failing fence test**

`packages/cli/src/fence.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { fenceFor } from "./fence.js";

describe("fenceFor", () => {
  test("three backticks when the content has none", () => {
    expect(fenceFor("plain\n")).toBe("```");
  });

  test("one longer than the longest run at a line start", () => {
    expect(fenceFor("a\n```\nb\n")).toBe("````");
    expect(fenceFor("`````x\n")).toBe("``````");
  });

  test("backticks not at a line start do not count", () => {
    expect(fenceFor("say ```hi```\n")).toBe("```");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/cli/src/fence.test.ts`
Expected: FAIL — cannot resolve `./fence.js`.

- [ ] **Step 3: Create `fence.ts` and use it from `expand-mentions.ts`**

`packages/cli/src/fence.ts`:

```ts
/** Three backticks, or one more than the longest backtick run that starts
 * a line in the content, so the fence can never be closed early. */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/^`+/gm)) {
    longest = Math.max(longest, m[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}
```

In `packages/cli/src/mentions/expand-mentions.ts`: delete the local `fenceFor` function (the block starting with the comment `/** Three backticks, or one more ...`) and add `import { fenceFor } from "../fence.js";` after the `node:path` import.

- [ ] **Step 4: Run fence and mention tests**

Run: `bun test packages/cli/src/fence.test.ts packages/cli/src/mentions`
Expected: PASS (the existing `fence lengthening` mention test still passes).

- [ ] **Step 5: Write the failing shell-config test**

`packages/cli/src/shell/shell-config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_SHELL_CONFIG, resolveShellConfig } from "./shell-config.js";

describe("resolveShellConfig", () => {
  test("no layers: the built-in default", () => {
    expect(resolveShellConfig()).toEqual(DEFAULT_SHELL_CONFIG);
    expect(DEFAULT_SHELL_CONFIG).toEqual({
      leadIn: "Please check the execution result.",
      autoSend: true,
    });
  });

  test("later layers override earlier ones key by key", () => {
    expect(
      resolveShellConfig({ leadIn: "vendor" }, { autoSend: false }),
    ).toEqual({ leadIn: "vendor", autoSend: false });
    expect(
      resolveShellConfig({ leadIn: "vendor" }, { leadIn: "user" }),
    ).toEqual({ leadIn: "user", autoSend: true });
  });

  test("undefined layers and undefined keys do not erase earlier values", () => {
    expect(
      resolveShellConfig(undefined, { leadIn: "vendor", autoSend: false }, {
        leadIn: undefined,
      }),
    ).toEqual({ leadIn: "vendor", autoSend: false });
  });

  test("returns a fresh object each time", () => {
    const a = resolveShellConfig();
    a.leadIn = "changed";
    expect(resolveShellConfig().leadIn).toBe(DEFAULT_SHELL_CONFIG.leadIn);
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `bun test packages/cli/src/shell/shell-config.test.ts`
Expected: FAIL — cannot resolve `./shell-config.js`.

- [ ] **Step 7: Create `shell-config.ts`**

```ts
/** Settings for `!` shell mode in the interactive TUI. Resolved from three
 * layers: built-in default → vendor default via createCli({ shell }) → the
 * user's config.json. */
export interface ShellConfig {
  /** First line of the prompt sent after a command finishes. */
  leadIn: string;
  /** false: hold results and attach them to the next message instead. */
  autoSend: boolean;
}

export const DEFAULT_SHELL_CONFIG: ShellConfig = {
  leadIn: "Please check the execution result.",
  autoSend: true,
};

/** Starts from the built-in default; each later layer overrides the earlier
 * ones key by key. Undefined layers and undefined keys are ignored. */
export function resolveShellConfig(
  ...layers: (Partial<ShellConfig> | undefined)[]
): ShellConfig {
  const out: ShellConfig = { ...DEFAULT_SHELL_CONFIG };
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.leadIn !== undefined) out.leadIn = layer.leadIn;
    if (layer.autoSend !== undefined) out.autoSend = layer.autoSend;
  }
  return out;
}
```

- [ ] **Step 8: Run, check, commit**

```bash
bun test packages/cli/src/shell/shell-config.test.ts
bun run check
git add packages/cli/src/fence.ts packages/cli/src/fence.test.ts packages/cli/src/mentions/expand-mentions.ts packages/cli/src/shell/shell-config.ts packages/cli/src/shell/shell-config.test.ts
git commit -m "feat(cli): shared fenceFor and shell-mode config resolution (Refs #47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 47 --body "Task 2 done: fenceFor moved to packages/cli/src/fence.ts (shared with mentions); shell/shell-config.ts with DEFAULT_SHELL_CONFIG and resolveShellConfig. Next: Task 3 (runCommand)."
```

---

### Task 3: `runCommand` — spawn, merged output, cap, stop

**Files:**
- Create: `packages/cli/src/shell/run-command.ts`, `packages/cli/src/shell/run-command.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RunOptions { cwd: string; maxBytes?: number; onOutput?: (text: string) => void; shell?: string; }
  export interface ShellResult { command: string; output: string; droppedBytes: number; exitCode: number | undefined; interrupted: boolean; durationMs: number; }
  export interface RunningCommand { readonly done: Promise<ShellResult>; stop(): void; }
  export const MAX_OUTPUT_BYTES: number; // 200 * 1024
  export const KILL_GRACE_MS: number;    // 2_000
  export function runCommand(command: string, opts: RunOptions): RunningCommand;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/cli/src/shell/run-command.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_OUTPUT_BYTES, runCommand } from "./run-command.js";

const SH = "/bin/sh";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True once `pid` is gone: kill(pid, 0) fails with ESRCH, or (Linux)
 * the process is a zombie waiting for init to reap it. */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
  } catch {
    return true;
  }
}

describe("runCommand", () => {
  test("captures stdout and stderr in arrival order and the exit code", async () => {
    const r = await runCommand("echo a; echo b >&2; echo c; exit 3", {
      cwd: process.cwd(),
      shell: SH,
    }).done;
    expect(r.output).toBe("a\nb\nc\n");
    expect(r.exitCode).toBe(3);
    expect(r.interrupted).toBe(false);
    expect(r.droppedBytes).toBe(0);
    expect(r.command).toBe("echo a; echo b >&2; echo c; exit 3");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("exit code 0 and empty output", async () => {
    const r = await runCommand("true", { cwd: process.cwd(), shell: SH }).done;
    expect(r).toMatchObject({ output: "", exitCode: 0, interrupted: false });
  });

  test("runs in the given directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-command-"));
    try {
      const r = await runCommand("pwd", { cwd: dir, shell: SH }).done;
      // macOS tmpdir is a symlink; compare the resolved tail only.
      expect(r.output.trim().endsWith(dir.slice(dir.lastIndexOf("/")))).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("onOutput is called with the whole output so far, more than once", async () => {
    const seen: string[] = [];
    const r = await runCommand(
      "printf one; sleep 0.25; printf two; sleep 0.25; printf three",
      { cwd: process.cwd(), shell: SH, onOutput: (t) => seen.push(t) },
    ).done;
    expect(r.output).toBe("onetwothree");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toBe("one");
    expect(seen[seen.length - 1]).toBe("onetwothree");
  });

  test("the cap kills the command and keeps the tail", async () => {
    // One write per line (unlike `yes`, whose block writes can split a
    // line), so the kept tail always ends on a line boundary. Finite, in
    // case the kill ever fails.
    const r = await runCommand(
      "i=0; while [ $i -lt 100000 ]; do echo 0123456789; i=$((i+1)); done",
      { cwd: process.cwd(), shell: SH, maxBytes: 32 },
    ).done;
    expect(r.interrupted).toBe(true);
    expect(r.exitCode).toBeUndefined();
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(32);
    expect(r.output).toMatch(/0123456789\n$/);
    expect(r.droppedBytes).toBeGreaterThan(0);
    expect(MAX_OUTPUT_BYTES).toBe(200 * 1024);
  });

  test("stop() interrupts, keeps the output so far, and done settles", async () => {
    const running = runCommand("echo started; sleep 10; echo never", {
      cwd: process.cwd(),
      shell: SH,
    });
    await sleep(150);
    const before = Date.now();
    running.stop();
    running.stop(); // idempotent
    const r = await running.done;
    expect(Date.now() - before).toBeLessThan(1_500);
    expect(r.interrupted).toBe(true);
    expect(r.exitCode).toBeUndefined();
    expect(r.output).toBe("started\n");
  });

  test("stop() after exit is a no-op", async () => {
    const running = runCommand("true", { cwd: process.cwd(), shell: SH });
    const r = await running.done;
    expect(() => running.stop()).not.toThrow();
    expect(r.interrupted).toBe(false);
  });

  test("stop() takes the whole process group with it", async () => {
    // The grandchild's pid is printed so the test can check it is gone.
    const running = runCommand("sleep 30 & echo $!; wait", {
      cwd: process.cwd(),
      shell: SH,
    });
    await sleep(200);
    running.stop();
    const r = await running.done;
    const pid = Number.parseInt(r.output.trim(), 10);
    expect(pid).toBeGreaterThan(0);
    for (let i = 0; i < 50 && !gone(pid); i++) await sleep(20);
    expect(gone(pid)).toBe(true);
  });

  test("a missing shell rejects done", async () => {
    await expect(
      runCommand("true", { cwd: process.cwd(), shell: "/no/such/shell" })
        .done,
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("invalid UTF-8 is replaced, not thrown", async () => {
    const r = await runCommand("printf '\\377\\376ok'", {
      cwd: process.cwd(),
      shell: SH,
    }).done;
    expect(r.output.endsWith("ok")).toBe(true);
    expect(r.output).toContain("�");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/cli/src/shell/run-command.test.ts`
Expected: FAIL — cannot resolve `./run-command.js`.

- [ ] **Step 3: Implement `run-command.ts`**

```ts
import { spawn } from "node:child_process";

export interface RunOptions {
  /** Directory the command starts in. */
  cwd: string;
  /** Output cap in bytes. Past it the command is killed and only the tail
   * is kept. Default MAX_OUTPUT_BYTES. */
  maxBytes?: number;
  /** Called with the whole output so far whenever it changes, throttled
   * to OUTPUT_THROTTLE_MS. */
  onOutput?: (text: string) => void;
  /** Test-only: the shell binary. Default $SHELL or /bin/sh. */
  shell?: string;
}

export interface ShellResult {
  command: string;
  /** stdout and stderr interleaved in arrival order, decoded as UTF-8
   * (invalid bytes become U+FFFD). */
  output: string;
  /** Bytes dropped from the head by the cap; 0 when nothing was dropped. */
  droppedBytes: number;
  /** Exit code on normal exit; undefined when killed or stopped. */
  exitCode: number | undefined;
  /** True when stop() ran or the cap killed the command. */
  interrupted: boolean;
  durationMs: number;
}

export interface RunningCommand {
  readonly done: Promise<ShellResult>;
  /** SIGTERM to the process group, SIGKILL after KILL_GRACE_MS. `done`
   * always settles. Idempotent: later calls, and calls after exit, do
   * nothing. */
  stop(): void;
}

export const MAX_OUTPUT_BYTES = 200 * 1024;
export const KILL_GRACE_MS = 2_000;
const OUTPUT_THROTTLE_MS = 100;

export function defaultShell(): string {
  return process.env.SHELL || "/bin/sh";
}

/** Runs `command` through `<shell> -c` in its own process group, with
 * stdin closed and the environment inherited. Never throws synchronously:
 * a shell that cannot start rejects `done`. */
export function runCommand(command: string, opts: RunOptions): RunningCommand {
  const maxBytes = opts.maxBytes ?? MAX_OUTPUT_BYTES;
  const startedAt = Date.now();
  let buf = Buffer.alloc(0);
  let dropped = 0;
  let interrupted = false;
  let settled = false;
  let stopRequested = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let notifyTimer: ReturnType<typeof setTimeout> | undefined;

  const text = () => buf.toString("utf8");

  const flush = () => {
    notifyTimer = undefined;
    if (!settled) opts.onOutput?.(text());
  };

  let stop: () => void = () => {};

  const done = new Promise<ShellResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.shell ?? defaultShell(), ["-c", command], {
        cwd: opts.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(err);
      return;
    }

    const signal = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        // Negative pid: the whole process group (detached: true gave the
        // shell its own), so grandchildren go too.
        process.kill(-child.pid, sig);
      } catch {
        // Already gone.
      }
    };

    stop = () => {
      if (settled || stopRequested) return;
      stopRequested = true;
      interrupted = true;
      signal("SIGTERM");
      killTimer = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
    };

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > maxBytes) {
        dropped += buf.length - maxBytes;
        buf = buf.subarray(buf.length - maxBytes);
        stop();
      }
      if (notifyTimer === undefined) {
        notifyTimer = setTimeout(flush, OUTPUT_THROTTLE_MS);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const finish = () => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (notifyTimer !== undefined) clearTimeout(notifyTimer);
    };

    child.on("error", (err) => {
      finish();
      reject(err);
    });
    // "close": every stdio pipe has drained, so the output is complete.
    child.on("close", (code) => {
      if (settled) return;
      finish();
      resolve({
        command,
        output: text(),
        droppedBytes: dropped,
        exitCode: code ?? undefined,
        interrupted,
        durationMs: Date.now() - startedAt,
      });
    });
  });

  return {
    done,
    stop: () => stop(),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/cli/src/shell/run-command.test.ts`
Expected: PASS. If the `close` event for a spawn failure fires before `error` on this Node/Bun, `settled` already guards the double settle; if the `error` test fails because `close` resolved first with a code, move the `error` listener registration above the `close` listener and add `if (settled) return;` to it too.

- [ ] **Step 5: Check and commit**

```bash
bun run check
git add packages/cli/src/shell/run-command.ts packages/cli/src/shell/run-command.test.ts
git commit -m "feat(cli): runCommand — merged output, cap, process-group stop (Refs #47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 47 --body "Task 3 done: shell/run-command.ts runs <shell> -c in its own process group, merges stdout/stderr, caps output at 200 KiB (tail kept, command killed), stop() = SIGTERM then SIGKILL after 2 s. Next: Task 4 (formatShellSection / formatShellPrompt)."
```

---

### Task 4: `format-result.ts`

**Files:**
- Create: `packages/cli/src/shell/format-result.ts`, `packages/cli/src/shell/format-result.test.ts`

**Interfaces:**
- Consumes: `ShellResult` from `./run-command.js`; `fenceFor` from `../fence.js`.
- Produces: `formatShellSection(result: ShellResult): string`; `formatShellPrompt(leadIn: string, result: ShellResult): string`; `headingFor(command: string): string` (internal, newlines shown as ` ⏎ `).

- [ ] **Step 1: Write the failing tests**

`packages/cli/src/shell/format-result.test.ts`:

````ts
import { describe, expect, test } from "bun:test";
import { formatShellPrompt, formatShellSection } from "./format-result.js";
import type { ShellResult } from "./run-command.js";

function result(over: Partial<ShellResult> = {}): ShellResult {
  return {
    command: "npm test",
    output: "ok\n",
    droppedBytes: 0,
    exitCode: 0,
    interrupted: false,
    durationMs: 5,
    ...over,
  };
}

describe("formatShellSection", () => {
  test("success: heading, fence, output, fence — nothing else", () => {
    expect(formatShellSection(result())).toBe(
      "### $ npm test\n```\nok\n```",
    );
  });

  test("adds the missing trailing newline; empty output stays empty", () => {
    expect(formatShellSection(result({ output: "no newline" }))).toBe(
      "### $ npm test\n```\nno newline\n```",
    );
    expect(formatShellSection(result({ output: "" }))).toBe(
      "### $ npm test\n```\n```",
    );
  });

  test("non-zero exit code is appended; zero is not", () => {
    expect(formatShellSection(result({ exitCode: 1 }))).toBe(
      "### $ npm test\n```\nok\n```\nexit code: 1",
    );
  });

  test("interrupted replaces the exit code", () => {
    expect(
      formatShellSection(result({ exitCode: undefined, interrupted: true })),
    ).toBe("### $ npm test\n```\nok\n```\ninterrupted");
  });

  test("truncation note goes before the fence, in whole KB rounded up", () => {
    expect(
      formatShellSection(
        result({ droppedBytes: 312 * 1024 + 1, interrupted: true }),
      ),
    ).toBe(
      "### $ npm test\n… (truncated: first 313 KB dropped)\n```\nok\n```\ninterrupted",
    );
  });

  test("the fence grows past backtick runs in the output", () => {
    expect(formatShellSection(result({ output: "```\nx\n" }))).toBe(
      "### $ npm test\n````\n```\nx\n````",
    );
  });

  test("a multi-line command is shown on one heading line", () => {
    expect(
      formatShellSection(result({ command: "echo a\necho b" })),
    ).toStartWith("### $ echo a ⏎ echo b\n");
  });
});

describe("formatShellPrompt", () => {
  test("lead-in, blank line, section", () => {
    expect(formatShellPrompt("Check this.", result({ exitCode: 2 }))).toBe(
      "Check this.\n\n### $ npm test\n```\nok\n```\nexit code: 2",
    );
  });
});
````

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/cli/src/shell/format-result.test.ts`
Expected: FAIL — cannot resolve `./format-result.js`.

- [ ] **Step 3: Implement `format-result.ts`**

```ts
import { fenceFor } from "../fence.js";
import type { ShellResult } from "./run-command.js";

/** The command on one line: embedded newlines become ` ⏎ `. */
function headingFor(command: string): string {
  return `### $ ${command.replace(/\r?\n/g, " ⏎ ")}`;
}

/** Whole KB, rounded up, matching the mention size errors. */
function wholeKb(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB`;
}

/** The milestone 6 attachment shape for one command result:
 *
 *   ### $ <command>
 *   … (truncated: first N KB dropped)   ← only when bytes were dropped
 *   ```
 *   <output>
 *   ```
 *   exit code: N                        ← only when non-zero
 *   interrupted                         ← only when stopped or killed
 */
export function formatShellSection(result: ShellResult): string {
  const body =
    result.output === "" || result.output.endsWith("\n")
      ? result.output
      : `${result.output}\n`;
  const fence = fenceFor(body);
  const lines = [headingFor(result.command)];
  if (result.droppedBytes > 0) {
    lines.push(
      `… (truncated: first ${wholeKb(result.droppedBytes)} dropped)`,
    );
  }
  lines.push(`${fence}\n${body}${fence}`);
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    lines.push(`exit code: ${result.exitCode}`);
  }
  if (result.interrupted) lines.push("interrupted");
  return lines.join("\n");
}

/** What is sent after a command finishes when autoSend is on. */
export function formatShellPrompt(leadIn: string, result: ShellResult): string {
  return `${leadIn}\n\n${formatShellSection(result)}`;
}
```

- [ ] **Step 4: Run, check, commit**

```bash
bun test packages/cli/src/shell/format-result.test.ts
bun run check
git add packages/cli/src/shell/format-result.ts packages/cli/src/shell/format-result.test.ts
git commit -m "feat(cli): format a shell result as a labelled fenced section (Refs #47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 47 --body "Task 4 done: shell/format-result.ts builds the '### \$ <command>' fenced section with truncated / exit code / interrupted lines, and the lead-in prompt. Next: Task 5 (config.json shell section)."
```

---

### Task 5: `config.json` `shell` section

**Files:**
- Modify: `packages/cli/src/config.ts`
- Modify: `packages/cli/src/config.test.ts`

**Interfaces:**
- Consumes: `ShellConfig` from `./shell/shell-config.js`.
- Produces: `CliConfig.shell?: Partial<ShellConfig>`; validation errors `"shell" must be an object`, `"shell.leadIn" must be a string`, `"shell.autoSend" must be a boolean` (all `INVALID_CONFIG`).

- [ ] **Step 1: Add the failing tests**

Append inside `describe("loadConfig", ...)` in `packages/cli/src/config.test.ts`:

```ts
  test("reads the shell section", async () => {
    writeFileSync(
      setup(),
      JSON.stringify({ shell: { leadIn: "Check:", autoSend: false } }),
    );
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect(cfg.shell).toEqual({ leadIn: "Check:", autoSend: false });
  });

  test("a partial shell section keeps only the given keys", async () => {
    writeFileSync(setup(), JSON.stringify({ shell: { leadIn: "Check:" } }));
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect(cfg.shell).toEqual({ leadIn: "Check:" });
    expect("autoSend" in (cfg.shell ?? {})).toBe(false);
  });

  test("no shell section leaves the key absent", async () => {
    writeFileSync(setup(), JSON.stringify({ defaultProvider: "@x/p" }));
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect("shell" in cfg).toBe(false);
  });

  test.each([
    [{ shell: [] }, '"shell" must be an object'],
    [{ shell: "x" }, '"shell" must be an object'],
    [{ shell: { leadIn: 5 } }, '"shell.leadIn" must be a string'],
    [{ shell: { autoSend: "no" } }, '"shell.autoSend" must be a boolean'],
  ])("%j is INVALID_CONFIG", async (doc: unknown, why: string) => {
    writeFileSync(setup(), JSON.stringify(doc));
    let caught: unknown;
    try {
      await loadConfig({ configDir: "test-cli", baseDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ChatBridgeError);
    expect((caught as ChatBridgeError).code).toBe("INVALID_CONFIG");
    expect((caught as ChatBridgeError).message).toContain(why);
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/cli/src/config.test.ts`
Expected: FAIL — `cfg.shell` is undefined; invalid documents do not throw.

- [ ] **Step 3: Implement**

In `packages/cli/src/config.ts`:

1. Add `import type { ShellConfig } from "./shell/shell-config.js";` after the `@chatbridge/core` import.
2. Extend the interface:

```ts
export interface CliConfig {
  /** Provider spec used when --provider is absent. Relative paths are
   * already resolved against the config file's directory. */
  defaultProvider?: string;
  /** `!` shell mode overrides; each key is optional and wins over the
   * vendor default from createCli. */
  shell?: Partial<ShellConfig>;
}
```

3. Replace the destructuring line `const { defaultProvider } = doc as Record<string, unknown>;` with `const { defaultProvider, shell } = doc as Record<string, unknown>;` and, after the `defaultProvider` block and before `return cfg;`, add:

```ts
  if (shell !== undefined) {
    if (typeof shell !== "object" || shell === null || Array.isArray(shell)) {
      throw invalid(file, '"shell" must be an object');
    }
    const { leadIn, autoSend } = shell as Record<string, unknown>;
    const out: Partial<ShellConfig> = {};
    if (leadIn !== undefined) {
      if (typeof leadIn !== "string") {
        throw invalid(file, '"shell.leadIn" must be a string');
      }
      out.leadIn = leadIn;
    }
    if (autoSend !== undefined) {
      if (typeof autoSend !== "boolean") {
        throw invalid(file, '"shell.autoSend" must be a boolean');
      }
      out.autoSend = autoSend;
    }
    cfg.shell = out;
  }
```

- [ ] **Step 4: Run, check, commit**

```bash
bun test packages/cli/src/config.test.ts
bun run check
git add packages/cli/src/config.ts packages/cli/src/config.test.ts
git commit -m "feat(cli): read and validate the shell section of config.json (Refs #47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 47 --body "Task 5 done: config.json accepts shell: { leadIn, autoSend } with INVALID_CONFIG on wrong types. Next: Task 6 (ChatModel running state, runShell, held results)."
```

---

### Task 6: `ChatModel` — `running`, `shell` role, `runShell` / `stopShell`, held results

**Files:**
- Modify: `packages/cli/src/tui/chat-model.ts` (full replacement below)
- Modify: `packages/cli/src/tui/chat-model.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `ShellConfig`, `DEFAULT_SHELL_CONFIG` from `../shell/shell-config.js`; `runCommand`, `RunOptions`, `RunningCommand`, `ShellResult` from `../shell/run-command.js`; `formatShellPrompt`, `formatShellSection` from `../shell/format-result.js`.
- Produces:
  ```ts
  export type Role = "user" | "assistant" | "error" | "separator" | "shell";
  export type Status = "idle" | "busy" | "running" | "resetting" | "dead";
  export interface Message { role: Role; text: string; attachments?: Attachment[]; result?: ShellResult; held?: boolean; }
  export interface ChatModelOptions { openSession; expand?; closeTimeoutMs?; shell?: ShellConfig; runCommand?: (cmd: string, opts: RunOptions) => RunningCommand; cwd?: string; }
  class ChatModel { readonly heldResults: ShellResult[]; runShell(command: string): Promise<boolean>; stopShell(): void; }
  ```
  Semantics: `runShell` pushes `{ role: "shell", text: <trimmed command>, result }` at once with an in-progress result (`output: ""`, `exitCode: undefined`, `interrupted: false`), updates `result.output` on every `onOutput`, then either sends `formatShellPrompt(leadIn, result)` (autoSend) or pushes the result to `heldResults` and marks the entry `held: true`. `submit` appends `formatShellSection` for each held result after the expanded prompt and clears `heldResults` and the `held` flags. `reset()` and teardown call `stopShell()`.

- [ ] **Step 1: Write the failing tests**

Add these imports at the top of `packages/cli/src/tui/chat-model.test.ts`:

```ts
import type {
  RunOptions,
  RunningCommand,
  ShellResult,
} from "../shell/run-command.js";
```

Add this helper after `harness(...)`:

```ts
/** A fake command runner. `emit` appends output (as the throttled
 * onOutput would), `finish` settles `done`; `stop()` settles it as
 * interrupted with the output so far. */
function fakeRunner() {
  const calls: Array<{ command: string; cwd: string }> = [];
  let output = "";
  let resolve: ((r: ShellResult) => void) | undefined;
  let reject: ((e: unknown) => void) | undefined;
  let onOutput: ((t: string) => void) | undefined;
  const base = (command: string): ShellResult => ({
    command,
    output: "",
    droppedBytes: 0,
    exitCode: 0,
    interrupted: false,
    durationMs: 1,
  });
  let current = base("");
  const runCommand = (command: string, opts: RunOptions): RunningCommand => {
    calls.push({ command, cwd: opts.cwd });
    output = "";
    current = base(command);
    onOutput = opts.onOutput;
    const done = new Promise<ShellResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return {
      done,
      stop() {
        resolve?.({
          ...current,
          output,
          exitCode: undefined,
          interrupted: true,
        });
      },
    };
  };
  return {
    runCommand,
    calls,
    emit(text: string) {
      output += text;
      onOutput?.(output);
    },
    finish(over: Partial<ShellResult> = {}) {
      resolve?.({ ...current, output, ...over });
    },
    fail(err: unknown) {
      reject?.(err);
    },
  };
}
```

Append a new `describe` at the end of the file:

````ts
describe("ChatModel.runShell", () => {
  test("running, live output, then autoSend sends the lead-in and section", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = new ChatModel(session, {
      ...noReopen,
      runCommand: runner.runCommand,
      cwd: "/work",
    });
    const changes: string[] = [];
    model.onChange = () => changes.push(model.status);

    const p = model.runShell("  echo hi  ");
    await tick();
    expect(model.status).toBe("running");
    expect(runner.calls).toEqual([{ command: "echo hi", cwd: "/work" }]);
    expect(model.messages[0]).toMatchObject({
      role: "shell",
      text: "echo hi",
      result: { command: "echo hi", output: "", interrupted: false },
    });

    runner.emit("hi\n");
    expect(model.messages[0]?.result?.output).toBe("hi\n");
    expect(changes).toEqual(["running", "running"]);

    runner.finish({ exitCode: 0 });
    await tick();
    expect(model.status).toBe("busy");
    expect(calls).toEqual([
      "Please check the execution result.\n\n### $ echo hi\n```\nhi\n```",
    ]);
    // No user entry: the shell entry stands for the turn.
    expect(model.messages.map((m) => m.role)).toEqual(["shell"]);

    replies[0]?.resolve("Looks fine.");
    expect(await p).toBe(true);
    expect(model.status).toBe("idle");
    expect(model.messages[1]).toEqual({
      role: "assistant",
      text: "Looks fine.",
    });
    expect(model.messages[0]?.result).toMatchObject({
      output: "hi\n",
      exitCode: 0,
    });
    expect(changes).toEqual(["running", "running", "busy", "idle"]);
  });

  test("uses the configured lead-in", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = new ChatModel(session, {
      ...noReopen,
      runCommand: runner.runCommand,
      shell: { leadIn: "Check:", autoSend: true },
    });
    const p = model.runShell("true");
    await tick();
    runner.finish();
    await tick();
    expect(calls[0]).toStartWith("Check:\n\n### $ true\n");
    replies[0]?.resolve("ok");
    await p;
  });

  test("blank command and non-idle states are rejected", async () => {
    const { session, replies } = fakeSession();
    const runner = fakeRunner();
    const model = new ChatModel(session, {
      ...noReopen,
      runCommand: runner.runCommand,
    });
    expect(await model.runShell("   ")).toBe(false);
    const p = model.runShell("sleep");
    await tick();
    expect(await model.runShell("other")).toBe(false); // running
    expect(await model.submit("hello")).toBe(false); // running
    runner.finish();
    await tick();
    expect(model.status).toBe("busy");
    expect(await model.runShell("other")).toBe(false); // busy
    replies[0]?.resolve("ok");
    await p;
    expect(runner.calls.map((c) => c.command)).toEqual(["sleep"]);
  });

  test("autoSend off: the result is held and attached to the next submit", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = new ChatModel(session, {
      ...noReopen,
      runCommand: runner.runCommand,
      shell: { leadIn: "unused", autoSend: false },
    });
    const changes: string[] = [];
    model.onChange = () => changes.push(model.status);

    const p = model.runShell("ls");
    await tick();
    runner.emit("a.ts\n");
    runner.finish({ exitCode: 1 });
    expect(await p).toBe(true);
    expect(model.status).toBe("idle");
    expect(calls).toEqual([]);
    expect(model.heldResults).toHaveLength(1);
    expect(model.messages[0]).toMatchObject({ role: "shell", held: true });
    expect(changes).toEqual(["running", "running", "idle"]);

    const q = model.submit("what is this?");
    await tick();
    replies[0]?.resolve("ok");
    await q;
    expect(calls).toEqual([
      "what is this?\n\n### $ ls\n```\na.ts\n```\nexit code: 1",
    ]);
    expect(model.heldResults).toEqual([]);
    expect(model.messages[0]?.held).toBe(false);
    expect(model.messages[1]).toEqual({ role: "user", text: "what is this?" });
  });

  test("several held results go out in order after the expanded prompt", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = new ChatModel(session, {
      ...noReopen,
      runCommand: runner.runCommand,
      shell: { leadIn: "x", autoSend: false },
      expand: async (text) => ({
        prompt: `${text}\n\n### a.ts\n\`\`\`ts\nx\n\`\`\``,
        attachments: [{ path: "a.ts", bytes: 2 }],
      }),
    });
    let p = model.runShell("one");
    await tick();
    runner.finish();
    await p;
    p = model.runShell("two");
    await tick();
    runner.finish();
    await p;
    expect(model.heldResults.map((r) => r.command)).toEqual(["one", "two"]);

    const q = model.submit("see @a.ts");
    await tick();
    replies[0]?.resolve("ok");
    await q;
    expect(calls).toEqual([
      "see @a.ts\n\n### a.ts\n```ts\nx\n```\n\n### $ one\n```\n```\n\n### $ two\n```\n```",
    ]);
  });

  test("a MentionError keeps the held results", async () => {
    const { session, calls } = fakeSession();
    const runner = fakeRunner();
    const model = new ChatModel(session, {
      ...noReopen,
      runCommand: runner.runCommand,
      shell: { leadIn: "x", autoSend: false },
      expand: async () => {
        throw new MentionError(["@x: not found"]);
      },
    });
    const p = model.runShell("ls");
    await tick();
    runner.finish();
    await p;
    expect(await model.submit("@x")).toBe(false);
    expect(calls).toEqual([]);
    expect(model.heldResults).toHaveLength(1);
    expect(model.messages[0]?.held).toBe(true);
  });

  test("stopShell settles the command as interrupted and still sends", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = new ChatModel(session, {
      ...noReopen,
      runCommand: runner.runCommand,
    });
    model.stopShell(); // idle: no-op
    const p = model.runShell("sleep 10");
    await tick();
    runner.emit("partial");
    model.stopShell();
    await tick();
    expect(model.status).toBe("busy");
    expect(calls[0]).toEndWith("### $ sleep 10\n```\npartial\n```\ninterrupted");
    replies[0]?.resolve("ok");
    await p;
    expect(model.messages[0]?.result?.interrupted).toBe(true);
  });

  test("a shell that cannot start is an error entry, not fatal", async () => {
    const { session, calls } = fakeSession();
    const runner = fakeRunner();
    const model = new ChatModel(session, {
      ...noReopen,
      runCommand: runner.runCommand,
    });
    const p = model.runShell("true");
    await tick();
    runner.fail(new Error("spawn /no/sh ENOENT"));
    expect(await p).toBe(true);
    expect(model.status).toBe("idle");
    expect(model.fatal).toBeUndefined();
    expect(calls).toEqual([]);
    expect(model.messages.map((m) => m.role)).toEqual(["shell", "error"]);
    expect(model.messages[1]?.text).toBe(
      "could not start shell: spawn /no/sh ENOENT",
    );
  });

  test("send failures after a command behave like submit", async () => {
    const { session, replies } = fakeSession();
    const runner = fakeRunner();
    const model = new ChatModel(session, {
      ...noReopen,
      runCommand: runner.runCommand,
    });
    const p = model.runShell("true");
    await tick();
    runner.finish();
    await tick();
    replies[0]?.reject(new ResponseTimeoutError("Timed out after 10 ms."));
    await p;
    expect(model.status).toBe("idle");
    expect(model.messages.map((m) => m.role)).toEqual(["shell", "error"]);

    const q = model.runShell("true");
    await tick();
    runner.finish();
    await tick();
    const boom = new Error("page closed");
    replies[1]?.reject(boom);
    await q;
    expect(model.status).toBe("dead");
    expect(model.fatal).toBe(boom);
  });

  test("reset while running stops the command; its output is not sent; held results survive", async () => {
    const h = harness();
    const runner = fakeRunner();
    const model = new ChatModel(h.first.session, {
      closeTimeoutMs: 20,
      openSession: async () => fakeSession("b").session,
      runCommand: runner.runCommand,
      shell: { leadIn: "x", autoSend: false },
    });
    // One held result first.
    let p = model.runShell("one");
    await tick();
    runner.finish();
    await p;
    expect(model.heldResults).toHaveLength(1);

    p = model.runShell("sleep 10");
    await tick();
    runner.emit("partial");
    await model.reset();
    await p;
    expect(model.status).toBe("idle");
    expect(h.first.calls).toEqual([]);
    expect(model.heldResults).toHaveLength(1); // the stopped one was not held
    const shell = model.messages.filter((m) => m.role === "shell");
    expect(shell[1]?.result).toMatchObject({
      output: "partial",
      interrupted: true,
    });
    expect(model.messages.map((m) => m.role)).toEqual([
      "shell",
      "shell",
      "separator",
    ]);
  });
});
````

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/cli/src/tui/chat-model.test.ts`
Expected: FAIL — `runShell` is not a function; type errors on `runCommand` / `shell` / `cwd` options.

- [ ] **Step 3: Replace `chat-model.ts`**

Full new content of `packages/cli/src/tui/chat-model.ts`:

```ts
import { ResponseTimeoutError } from "@chatbridge/core";
import {
  type Attachment,
  type Expansion,
  MentionError,
  expandMentions,
} from "../mentions/expand-mentions.js";
import {
  formatShellPrompt,
  formatShellSection,
} from "../shell/format-result.js";
import {
  type RunOptions,
  type RunningCommand,
  type ShellResult,
  runCommand as runCommandDefault,
} from "../shell/run-command.js";
import {
  DEFAULT_SHELL_CONFIG,
  type ShellConfig,
} from "../shell/shell-config.js";
import { closeOrKill } from "./close-session.js";

/** What the model needs from a ChatSession; lets tests inject a fake. */
export interface ChatSessionLike {
  send(prompt: string): Promise<string>;
  close(): Promise<void>;
  kill(): Promise<void>;
}

export type Role = "user" | "assistant" | "error" | "separator" | "shell";
export interface Message {
  role: Role;
  text: string;
  /** Files appended to the prompt; the history shows one line per entry. */
  attachments?: Attachment[];
  /** `shell` entries: the command's result — updated live while it runs. */
  result?: ShellResult;
  /** `shell` entries: the result is waiting for the next submit. */
  held?: boolean;
}
/** idle: accepting input. busy: a turn is in flight. running: a shell
 * command is in flight (input locked, Ctrl+C stops it). resetting: the
 * browser is being replaced. dead: a fatal error happened; only Ctrl+R
 * (reset) or Ctrl+C (quit) make sense. */
export type Status = "idle" | "busy" | "running" | "resetting" | "dead";

/** How long a reset waits for the old browser to close before killing it. */
export const RESET_CLOSE_TIMEOUT_MS = 5_000;
export const SEPARATOR_TEXT = "reopened";

export interface ChatModelOptions {
  /** Opens a replacement session for reset(). The first session is opened
   * by the caller before any UI exists so startup errors surface plainly. */
  openSession: () => Promise<ChatSessionLike>;
  /** Turns the typed text into the prompt to send. Default: expandMentions
   * against process.cwd(). Tests inject a fake. */
  expand?: (text: string) => Promise<Expansion>;
  /** Close cap before a reset kills the old browser. Tests shorten it. */
  closeTimeoutMs?: number;
  /** `!` shell mode settings. Default: DEFAULT_SHELL_CONFIG. */
  shell?: ShellConfig;
  /** Test-only: replaces runCommand. */
  runCommand?: (command: string, opts: RunOptions) => RunningCommand;
  /** Directory shell commands start in. Default: process.cwd(). */
  cwd?: string;
}

/** Conversation state for the interactive UI. No OpenTUI dependency. */
export class ChatModel {
  readonly messages: Message[] = [];
  status: Status = "idle";
  /** The last fatal error; the reason the model is `dead`. Cleared by a
   * successful reset. Reported by the app when the user quits. */
  fatal: unknown = undefined;
  /** Results waiting for the next submit (autoSend: false). */
  readonly heldResults: ShellResult[] = [];
  /** Called after every state change. */
  onChange: () => void = () => {};
  private current: ChatSessionLike;
  /** Bumped by every reset; a send from an older generation is stale and
   * its outcome is dropped. */
  private generation = 0;
  /** The reset currently in flight, so teardown can wait for the new
   * session to exist before closing it. */
  private pending: Promise<void> | undefined;
  /** The shell command in flight, so stopShell() and reset() can end it. */
  private running: RunningCommand | undefined;
  private readonly openSession: () => Promise<ChatSessionLike>;
  private readonly expand: (text: string) => Promise<Expansion>;
  private readonly closeTimeoutMs: number;
  private readonly shell: ShellConfig;
  private readonly runCommand: (
    command: string,
    opts: RunOptions,
  ) => RunningCommand;
  private readonly cwd: string;

  constructor(session: ChatSessionLike, opts: ChatModelOptions) {
    this.current = session;
    this.openSession = opts.openSession;
    this.expand =
      opts.expand ?? ((text) => expandMentions(text, process.cwd()));
    this.closeTimeoutMs = opts.closeTimeoutMs ?? RESET_CLOSE_TIMEOUT_MS;
    this.shell = opts.shell ?? DEFAULT_SHELL_CONFIG;
    this.runCommand = opts.runCommand ?? runCommandDefault;
    this.cwd = opts.cwd ?? process.cwd();
  }

  /** The session in use right now; teardown closes this one. */
  get session(): ChatSessionLike {
    return this.current;
  }

  /** Sends one turn. Resolves true when the message was accepted (the view
   * clears the textarea), false when it was ignored — blank input, input
   * while not idle — or blocked by a mention problem, which is shown as an
   * error entry without sending anything. Held shell results go out with
   * the message, after the expanded prompt. */
  async submit(text: string): Promise<boolean> {
    const prompt = text.trim();
    if (!prompt || this.status !== "idle") {
      return false;
    }
    // Claim the turn before awaiting, so a second Enter in the same tick is
    // rejected by the guard above instead of racing through expansion.
    // No onChange yet: nothing observable has changed for the view.
    this.status = "busy";
    let expansion: Expansion;
    try {
      expansion = await this.expand(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({ role: "error", text: message });
      // A mention problem is the user's to fix; anything else is a bug.
      if (err instanceof MentionError) {
        this.status = "idle";
      } else {
        this.fatal = err;
        this.status = "dead";
      }
      this.onChange();
      return false;
    }
    const message: Message = { role: "user", text: prompt };
    if (expansion.attachments.length > 0) {
      message.attachments = expansion.attachments;
    }
    this.messages.push(message);
    let outgoing = expansion.prompt;
    if (this.heldResults.length > 0) {
      outgoing = [outgoing, ...this.heldResults.map(formatShellSection)].join(
        "\n\n",
      );
      this.heldResults.length = 0;
      for (const m of this.messages) if (m.held) m.held = false;
    }
    this.onChange();
    await this.sendPrompt(outgoing);
    return true;
  }

  /** Runs one shell command from `idle`. The entry is pushed at once and
   * its `result` is updated as output arrives. When it finishes the result
   * is sent under the lead-in (autoSend) or held for the next submit.
   * Resolves false when ignored: blank command, not idle. */
  async runShell(command: string): Promise<boolean> {
    const cmd = command.trim();
    if (!cmd || this.status !== "idle") return false;
    this.status = "running";
    const entry: Message = {
      role: "shell",
      text: cmd,
      result: {
        command: cmd,
        output: "",
        droppedBytes: 0,
        exitCode: undefined,
        interrupted: false,
        durationMs: 0,
      },
    };
    this.messages.push(entry);
    this.onChange();
    const generation = this.generation;
    let result: ShellResult;
    try {
      const running = this.runCommand(cmd, {
        cwd: this.cwd,
        onOutput: (output) => {
          if (entry.result) entry.result = { ...entry.result, output };
          this.onChange();
        },
      });
      this.running = running;
      result = await running.done;
    } catch (err) {
      this.running = undefined;
      if (generation !== this.generation) return true; // stale: reset ran
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({
        role: "error",
        text: `could not start shell: ${message}`,
      });
      this.status = "idle";
      this.onChange();
      return true;
    }
    this.running = undefined;
    // The entry belongs to the history, which survives a reset, so it
    // always gets the final result (an interrupted one after a reset).
    entry.result = result;
    if (generation !== this.generation) {
      this.onChange();
      return true; // stale: reset ran; nothing is sent or held
    }
    if (!this.shell.autoSend) {
      this.heldResults.push(result);
      entry.held = true;
      this.status = "idle";
      this.onChange();
      return true;
    }
    this.status = "busy";
    this.onChange();
    await this.sendPrompt(formatShellPrompt(this.shell.leadIn, result));
    return true;
  }

  /** Stops the running shell command; no-op in every other state. The
   * command settles as interrupted and runShell continues from there. */
  stopShell(): void {
    this.running?.stop();
  }

  /** The send half of a turn, shared by submit and runShell. The caller has
   * already set `busy` and notified the view. */
  private async sendPrompt(prompt: string): Promise<void> {
    const session = this.current;
    const generation = this.generation;
    try {
      const reply = await session.send(prompt);
      if (generation !== this.generation) return; // stale: reset ran
      this.messages.push({ role: "assistant", text: reply });
      this.status = "idle";
    } catch (err) {
      if (generation !== this.generation) return; // stale: reset ran
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({ role: "error", text: message });
      // A timeout leaves the browser usable; anything else ends the session.
      if (err instanceof ResponseTimeoutError) {
        this.status = "idle";
      } else {
        this.fatal = err;
        this.status = "dead";
      }
    }
    this.onChange();
  }

  /** The in-flight reset, or undefined when none is running. Teardown awaits
   * it so the session it opens is not leaked. */
  get pendingReset(): Promise<void> | undefined {
    return this.pending;
  }

  /** Replaces the browser: close-or-kill the current session, open a new
   * one, mark the history. Works in every state — the main use is a hung
   * page mid-turn. A running shell command is stopped first and its output
   * is neither sent nor held. Ignored while a reset is already running. On
   * failure the model is `dead` with the reopen error as `fatal`. */
  reset(): Promise<void> {
    if (this.status === "resetting") return Promise.resolve();
    // runReset sets the status synchronously, so the guard above rejects a
    // second Ctrl+R in the same tick.
    const run = this.runReset();
    this.pending = run;
    return run.finally(() => {
      if (this.pending === run) this.pending = undefined;
    });
  }

  private async runReset(): Promise<void> {
    this.stopShell();
    this.status = "resetting";
    this.generation++;
    this.onChange();
    const old = this.current;
    await closeOrKill(old, this.closeTimeoutMs);
    try {
      this.current = await this.openSession();
      this.messages.push({ role: "separator", text: SEPARATOR_TEXT });
      this.fatal = undefined;
      this.status = "idle";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({ role: "error", text: message });
      this.fatal = err;
      this.status = "dead";
    }
    this.onChange();
  }
}
```

- [ ] **Step 4: Run the model tests**

Run: `bun test packages/cli/src/tui/chat-model.test.ts`
Expected: PASS, including every pre-existing test (the `submit` flow is unchanged in behaviour; only the send half moved into `sendPrompt`). The `changes` sequence in the first test is one `running` for the entry push, one for the `emit`, then `busy` (the final result and the status change share one notification) and `idle`.

- [ ] **Step 5: Check and commit**

```bash
bun run check
git add packages/cli/src/tui/chat-model.ts packages/cli/src/tui/chat-model.test.ts
git commit -m "feat(cli): ChatModel runs shell commands — running state, held results (Refs #47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 47 --body "Task 6 done: ChatModel gains status 'running', role 'shell', runShell()/stopShell(), heldResults attached on the next submit, and a shared sendPrompt(); reset() stops a running command. Next: Task 7 (ChatView shell mode, live output, status texts)."
```

---

### Task 7: `ChatView` — shell mode, live output, status texts, theme

**Files:**
- Modify: `packages/cli/src/tui/theme.ts` (add `shell`)
- Modify: `packages/cli/src/tui/banner.ts` (`BANNER_HINT`)
- Modify: `packages/cli/src/tui/chat-view.ts` (full replacement below)
- Modify: `packages/cli/src/tui/chat-view.test.ts`

**Interfaces:**
- Consumes: `ChatModel` from Task 6 (`status === "running"`, `role === "shell"`, `result`, `held`, `heldResults`, `runShell`, `stopShell`); Task 1's findings for the Backspace / paste mock-input names and whether `placeholder` is settable.
- Produces: exported `GUIDE`, `SHELL_GUIDE`, `HELD_GUIDE`, `SHELL_PLACEHOLDER`, `RUNNING_LABEL`, `idleGuide(shellMode: boolean, held: number): string`; `ChatView.shellMode: boolean` (read-only getter, for tests).

- [ ] **Step 1: Theme and banner**

In `packages/cli/src/tui/theme.ts`, change the ANSI table and add a style:

```ts
const ANSI = { red: 1, green: 2, yellow: 3, blue: 4, brightBlack: 8 } as const;
```

and in `theme`, after `error:`:

```ts
  /** Shell-mode prompt, the `shell` role label and its command line. */
  shell: make(TextAttributes.BOLD, ANSI.yellow),
```

In `packages/cli/src/tui/banner.ts`:

```ts
// With "Connected to dummy-chat. " in front this is exactly 80 cells.
export const BANNER_HINT =
  "Type a message, @ to attach a file, ! to run a command.";
```

- [ ] **Step 2: Update existing tests and add the new ones**

In `packages/cli/src/tui/chat-view.test.ts`:

1. Extend the imports from `./chat-view.js`:

```ts
import {
  ChatView,
  DEAD_GUIDE,
  GUIDE,
  HELD_GUIDE,
  MAX_INPUT_ROWS,
  RESETTING_STATUS,
  SHELL_GUIDE,
  SHELL_PLACEHOLDER,
  idleGuide,
} from "./chat-view.js";
```

and add:

```ts
import type { ShellConfig } from "../shell/shell-config.js";
import type {
  RunOptions,
  RunningCommand,
  ShellResult,
} from "../shell/run-command.js";
```

2. Add the fake runner (same shape as Task 6's) after `deferred`:

```ts
function fakeRunner() {
  const calls: string[] = [];
  let output = "";
  let resolve: ((r: ShellResult) => void) | undefined;
  let onOutput: ((t: string) => void) | undefined;
  let current: ShellResult | undefined;
  const runCommand = (command: string, opts: RunOptions): RunningCommand => {
    calls.push(command);
    output = "";
    onOutput = opts.onOutput;
    current = {
      command,
      output: "",
      droppedBytes: 0,
      exitCode: 0,
      interrupted: false,
      durationMs: 1,
    };
    const done = new Promise<ShellResult>((res) => {
      resolve = res;
    });
    return {
      done,
      stop() {
        if (current)
          resolve?.({ ...current, output, exitCode: undefined, interrupted: true });
      },
    };
  };
  return {
    runCommand,
    calls,
    emit(text: string) {
      output += text;
      onOutput?.(output);
    },
    finish(over: Partial<ShellResult> = {}) {
      if (current) resolve?.({ ...current, output, ...over });
    },
  };
}
```

3. Extend `setup`'s options with `runCommand?: (c: string, o: RunOptions) => RunningCommand; shell?: ShellConfig;` and pass them to the `ChatModel` constructor: `runCommand: opts.runCommand, shell: opts.shell,`.

4. Change the two assertions that hard-code old strings:
   - In `"the banner is centred in the empty history"`: the expected hint line becomes `"Connected to dummy-chat. Type a message, @ to attach a file, ! to run a command."` (exactly 80 cells, so it still fits an 80-column frame).
   - In `"the guide mentions @ file"`: `expect(GUIDE).toBe("Enter send · Ctrl+J newline · @ file · ! shell · Ctrl+R reopen · Ctrl+C quit");`.

5. Append a new `describe` at the end:

```ts
describe("ChatView shell mode", () => {
  test("! on an empty input enters shell mode and is not typed", async () => {
    const t = await setup();
    await t.mockInput.typeText("!");
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(t.view.shellMode).toBe(true);
    expect(frame).toContain(`! ${SHELL_PLACEHOLDER}`);
    expect(frame).toContain(SHELL_GUIDE);
    expect(frame).not.toContain(GUIDE);
    await t.mockInput.typeText("ls");
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("! ls");
  });

  test("a ! after other text is an ordinary character", async () => {
    const t = await setup();
    await t.mockInput.typeText("wow!");
    await t.renderOnce();
    expect(t.view.shellMode).toBe(false);
    expect(t.captureCharFrame()).toContain("> wow!");
  });

  test("a pasted !command enters shell mode with the command kept", async () => {
    const t = await setup();
    t.mockInput.pasteText("!git status"); // name from the Task 1 spike
    await t.renderOnce();
    expect(t.view.shellMode).toBe(true);
    expect(t.captureCharFrame()).toContain("! git status");
  });

  test("Escape on an empty shell input exits shell mode", async () => {
    const t = await setup();
    await t.mockInput.typeText("!");
    await t.renderOnce();
    t.mockInput.pressEscape();
    for (let i = 0; i < 100 && t.view.shellMode; i++) {
      await sleep(20);
      await t.renderOnce();
    }
    expect(t.view.shellMode).toBe(false);
    expect(t.captureCharFrame()).toContain("> Type a message");
    expect(t.captureCharFrame()).toContain(GUIDE);
  });

  test("Backspace exits only once the input is empty", async () => {
    const t = await setup();
    await t.mockInput.typeText("!a");
    t.mockInput.pressBackspace(); // name from the Task 1 spike
    await t.renderOnce();
    expect(t.view.shellMode).toBe(true);
    t.mockInput.pressBackspace();
    await t.renderOnce();
    expect(t.view.shellMode).toBe(false);
  });

  test("Ctrl+U on an empty shell input exits shell mode", async () => {
    const t = await setup();
    await t.mockInput.typeText("!");
    t.mockInput.pressKey("u", { ctrl: true });
    await t.renderOnce();
    expect(t.view.shellMode).toBe(false);
  });

  test("@ shows no popup in shell mode", async () => {
    const t = await setup({ paths: ["types/node.d.ts"] });
    await t.mockInput.typeText("!npm i @types");
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("types/node.d.ts");
    expect(t.captureCharFrame()).not.toContain(POPUP_HINT);
  });

  test("Enter runs the command, keeps shell mode, streams output, then sends", async () => {
    const runner = fakeRunner();
    const t = await setup({ runCommand: runner.runCommand, delayMs: 200 });
    await t.mockInput.typeText("!echo hi");
    t.mockInput.pressEnter();
    const running = await t.frameWith("Running…");
    expect(runner.calls).toEqual(["echo hi"]);
    expect(running).toContain("shell");
    expect(running).toContain("$ echo hi");
    expect(running).toMatch(/[●○]{3} Running… {2}\ds · Ctrl\+C stop/);
    expect(t.view.shellMode).toBe(true);
    expect(running).toContain(`! ${SHELL_PLACEHOLDER}`);

    runner.emit("line one\n");
    const live = await t.frameWith("line one");
    runner.emit("line two\n");
    const more = await t.frameWith("line two");
    expect(more).toContain("line one");
    expect(live).not.toContain("Thinking…");

    runner.finish({ exitCode: 0 });
    const thinking = await t.frameWith("Thinking…");
    expect(thinking).not.toContain("Running…");
    const done = await t.frameWith("Echo: Please check");
    expect(done).toContain("assistant");
    expect(done).toContain(SHELL_GUIDE);
    expect(done).not.toContain("exit code");
  });

  test("Enter with an empty shell input does nothing", async () => {
    const runner = fakeRunner();
    const t = await setup({ runCommand: runner.runCommand });
    await t.mockInput.typeText("!");
    t.mockInput.pressEnter();
    await t.renderOnce();
    expect(runner.calls).toEqual([]);
    expect(t.model.messages).toEqual([]);
  });

  test("non-zero exit, interrupted and truncation are shown as a footer", async () => {
    const runner = fakeRunner();
    const t = await setup({
      runCommand: runner.runCommand,
      shell: { leadIn: "x", autoSend: false },
    });
    await t.mockInput.typeText("!false");
    t.mockInput.pressEnter();
    await t.frameWith("Running…");
    runner.finish({ exitCode: 1, interrupted: true, droppedBytes: 2048 });
    const frame = await t.frameWith("exit code: 1");
    expect(frame).toContain("interrupted");
    expect(frame).toContain("… (truncated: first 2 KB dropped)");
  });

  test("autoSend off: held footer, held count in the guide, cleared on send", async () => {
    const runner = fakeRunner();
    const t = await setup({
      runCommand: runner.runCommand,
      shell: { leadIn: "x", autoSend: false },
      delayMs: 10,
    });
    await t.mockInput.typeText("!ls");
    t.mockInput.pressEnter();
    await t.frameWith("Running…");
    runner.emit("a.ts\n");
    runner.finish();
    const held = await t.frameWith("📎 held, sent with your next message");
    expect(held).toContain(`📎 1 held · ${SHELL_GUIDE}`);
    expect(t.model.status).toBe("idle");

    t.mockInput.pressEscape();
    for (let i = 0; i < 100 && t.view.shellMode; i++) {
      await sleep(20);
      await t.renderOnce();
    }
    expect(t.captureCharFrame()).toContain(`📎 1 held · ${HELD_GUIDE}`);

    await t.mockInput.typeText("what is this?");
    t.mockInput.pressEnter();
    const done = await t.frameWith("Echo: what is this?");
    expect(done).toContain(GUIDE);
    expect(done).not.toContain("held");
  });

  test("Ctrl+R while running stops the command and reopens", async () => {
    const runner = fakeRunner();
    const t = await setup({ runCommand: runner.runCommand });
    await t.mockInput.typeText("!sleep 10");
    t.mockInput.pressEnter();
    await t.frameWith("Running…");
    t.mockInput.pressKey("r", { ctrl: true });
    const frame = await t.frameWith("── reopened ──");
    expect(frame).toContain("interrupted");
    expect(t.model.status).toBe("idle");
  });

  test("idleGuide texts fit 80 columns", () => {
    for (const text of [
      idleGuide(false, 0),
      idleGuide(true, 0),
      idleGuide(false, 12),
      idleGuide(true, 12),
      DEAD_GUIDE,
    ]) {
      expect([...text].length).toBeLessThanOrEqual(78); // 📎 is 2 cells wide
    }
    expect(idleGuide(false, 0)).toBe(GUIDE);
    expect(idleGuide(true, 0)).toBe(SHELL_GUIDE);
    expect(idleGuide(false, 2)).toBe(`📎 2 held · ${HELD_GUIDE}`);
    expect(idleGuide(true, 2)).toBe(`📎 2 held · ${SHELL_GUIDE}`);
  });
});
```

If Task 1 found no `placeholder` setter, delete the two `SHELL_PLACEHOLDER` assertions and the `SHELL_PLACEHOLDER` import, and assert `"! "` at the start of the input row instead.

- [ ] **Step 3: Run to see the new tests fail**

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: FAIL — `HELD_GUIDE` etc. are not exported; `shellMode` is undefined.

- [ ] **Step 4: Replace `chat-view.ts`**

Full new content of `packages/cli/src/tui/chat-view.ts`:

```ts
import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  ScrollBoxRenderable,
  type StyledText,
  TextRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { formatSize } from "../mentions/expand-mentions.js";
import type { FileIndex } from "../mentions/file-index.js";
import { mentionAtCursor } from "../mentions/parse-mentions.js";
import type { ChatModel, Message, Role } from "./chat-model.js";
import { MAX_ROWS, MentionPopup } from "./mention-popup.js";
import { MUTED_COLOR, styled, theme } from "./theme.js";

// Status-row texts must fit 80 columns: the row is one fixed line and
// clips. Shift+Enter is left out for room (README documents it).
export const GUIDE =
  "Enter send · Ctrl+J newline · @ file · ! shell · Ctrl+R reopen · Ctrl+C quit";
export const SHELL_GUIDE =
  "Enter run · Esc exit shell · Ctrl+R reopen · Ctrl+C quit";
/** The idle guide while shell results are held; shorter to leave room for
 * the `📎 N held · ` prefix. */
export const HELD_GUIDE =
  "Enter send · @ file · ! shell · Ctrl+R reopen · Ctrl+C quit";
/** Shown instead of GUIDE once a fatal error left the session unusable. */
export const DEAD_GUIDE = "Ctrl+R reopen · Ctrl+C quit";
export const RESETTING_STATUS = "Reopening browser...";
export const RUNNING_LABEL = "Running…";
export const SHELL_PLACEHOLDER = "Run a shell command";
const PLACEHOLDER = "Type a message";
const HELD_FOOTER = "📎 held, sent with your next message";
/** Three fixed cells so legacy terminals keep the line aligned. */
const FRAMES = ["●○○", "○●○", "○○●", "○●○"];
const FRAME_INTERVAL_MS = 120;
const LABELS: Record<Exclude<Role, "separator">, () => StyledText> = {
  user: () => styled(theme.user("user")),
  assistant: () => styled(theme.assistant("assistant")),
  error: () => styled(theme.error("error")),
  shell: () => styled(theme.shell("shell")),
};
/** The input starts one row tall and grows with its content up to this. */
export const MAX_INPUT_ROWS = 5;

/** The idle status text for the given shell-mode flag and held count. */
export function idleGuide(shellMode: boolean, held: number): string {
  if (held === 0) return shellMode ? SHELL_GUIDE : GUIDE;
  return `📎 ${held} held · ${shellMode ? SHELL_GUIDE : HELD_GUIDE}`;
}

/** The muted line under a shell entry's output; empty when nothing
 * applies. */
function shellFooter(message: Message): string {
  const r = message.result;
  if (!r) return "";
  const parts: string[] = [];
  if (r.droppedBytes > 0) {
    parts.push(
      `… (truncated: first ${Math.ceil(r.droppedBytes / 1024)} KB dropped)`,
    );
  }
  if (r.exitCode !== undefined && r.exitCode !== 0) {
    parts.push(`exit code: ${r.exitCode}`);
  }
  if (r.interrupted) parts.push("interrupted");
  if (message.held) parts.push(HELD_FOOTER);
  return parts.join(" · ");
}

export interface ChatViewOptions {
  title: string;
  providerName: string;
  /** Response timeout budget shown next to the elapsed time. */
  timeoutMs: number;
  /** Shown in the header as "headless" or "headful". */
  headless: boolean;
  /** Startup banner lines, shown centred until the first message. */
  banner: StyledText[];
  /** Candidates for `@` mentions. */
  index: FileIndex;
}

/** KeyHandler's `on` is typed through a generic EventEmitter that does not
 * type-check under our config; this is the shape we rely on at runtime. */
interface KeypressSource {
  on(event: "keypress", handler: (key: KeyEvent) => void): unknown;
  off(event: "keypress", handler: (key: KeyEvent) => void): unknown;
}

/** The renderables of one shell entry that change after it is drawn. */
interface ShellEntry {
  message: Message;
  output: TextRenderable;
  footer: TextRenderable;
  drawnOutput: string;
  drawnFooter: string;
}

/** Builds the OpenTUI tree for one ChatModel and mirrors its state.
 * Layout, top to bottom: badge header / banner-or-history / hairline input
 * (1–5 rows) / inline mention popup (hidden unless the cursor is in an `@`
 * mention) / status line. */
export class ChatView {
  private readonly body: BoxRenderable;
  private readonly banner: BoxRenderable;
  private bannerShown = true;
  private readonly history: ScrollBoxRenderable;
  private readonly prompt: TextRenderable;
  private readonly input: TextareaRenderable;
  private readonly status: TextRenderable;
  private readonly popup: MentionPopup;
  private readonly index: FileIndex;
  private readonly onKeypress: (key: KeyEvent) => void;
  private rendered = 0;
  /** Shell entries already drawn; their output and footer are refreshed
   * from the model on every update (live output, held → sent). */
  private readonly shellEntries: ShellEntry[] = [];
  private spinner: ReturnType<typeof setInterval> | undefined;
  private spinnerMode: "busy" | "running" | undefined;
  private frame = 0;
  private readonly budgetSec: number;
  private startedAt = 0;
  private destroyed = false;
  private statusPinned = false;
  /** Shell mode is a property of the input box, not of the conversation. */
  private shell = false;
  /** The textarea content before the latest change, for the `!`-on-empty
   * detection. */
  private lastContent = "";

  constructor(
    private readonly renderer: CliRenderer,
    private readonly model: ChatModel,
    opts: ChatViewOptions,
  ) {
    this.budgetSec = Math.round(opts.timeoutMs / 1000);
    this.index = opts.index;
    const root = new BoxRenderable(renderer, {
      id: "root",
      flexDirection: "column",
      width: "100%",
      height: "100%",
    });
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
    this.body = new BoxRenderable(renderer, {
      id: "body",
      flexGrow: 1,
      // The slot's content (banner, then a growing history) must never size
      // it: without a zero basis the body takes a row from the input box.
      flexShrink: 1,
      flexBasis: 0,
      minHeight: 0,
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

    const inputBox = new BoxRenderable(renderer, {
      id: "input-box",
      flexDirection: "row",
      flexShrink: 0,
      border: ["top", "bottom"],
      borderColor: MUTED_COLOR,
    });
    this.prompt = new TextRenderable(renderer, {
      id: "prompt",
      content: styled(theme.muted("> ")),
      flexShrink: 0,
    });
    inputBox.add(this.prompt);
    this.input = new TextareaRenderable(renderer, {
      id: "input",
      flexGrow: 1,
      height: 1,
      wrapMode: "word",
      placeholder: PLACEHOLDER,
      placeholderColor: MUTED_COLOR,
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "kpenter", action: "submit" },
        // Shift+Enter needs the kitty keyboard protocol. Ctrl+J arrives as
        // a linefeed byte on legacy terminals and as ctrl+j under kitty.
        { name: "return", shift: true, action: "newline" },
        { name: "linefeed", action: "newline" },
        { name: "j", ctrl: true, action: "newline" },
      ],
    });
    inputBox.add(this.input);
    root.add(inputBox);

    // Inline: the popup occupies the rows between the input and the status.
    this.popup = new MentionPopup(renderer, root);

    this.status = new TextRenderable(renderer, {
      id: "status",
      content: styled(theme.muted(GUIDE)),
      // Fixed: a guide longer than the terminal must not wrap and push the
      // input box off the bottom.
      height: 1,
      flexShrink: 0,
    });
    root.add(this.status);
    renderer.root.add(root);

    this.input.onSubmit = () => this.submit();
    // Global listener: runs before the focused textarea and can stop it.
    this.onKeypress = (key) => this.handleKey(key);
    (renderer.keyInput as unknown as KeypressSource).on(
      "keypress",
      this.onKeypress,
    );
    this.input.onContentChange = () => {
      this.detectShellMode();
      this.fitInput();
      this.refreshPopup();
    };
    this.input.onCursorChange = () => this.refreshPopup();
    this.model.onChange = () => this.update();
    this.input.focus();
    this.update();
  }

  /** True while the input box is in `!` shell mode. */
  get shellMode(): boolean {
    return this.shell;
  }

  /** True once this view — or the renderer under it — is gone. OpenTUI
   * destroys the renderer on SIGINT without telling the view, so a write
   * after that would throw from the native text buffer. */
  private get torn(): boolean {
    return this.destroyed || this.renderer.isDestroyed;
  }

  /** Appends messages not yet drawn, refreshes live shell entries, and
   * syncs the status line. */
  update(): void {
    // A turn still in flight when the view is destroyed would otherwise
    // write to renderables the renderer has already torn down.
    if (this.torn) return;
    if (this.bannerShown && this.model.messages.length > 0) {
      this.bannerShown = false;
      this.body.remove(this.banner);
      this.body.add(this.history);
    }
    for (; this.rendered < this.model.messages.length; this.rendered++) {
      const message = this.model.messages[this.rendered];
      if (message) this.history.add(this.messageBox(message));
    }
    for (const entry of this.shellEntries) this.refreshShell(entry);
    if (this.statusPinned) return;
    switch (this.model.status) {
      case "busy":
        this.startSpinner("busy");
        break;
      case "running":
        this.startSpinner("running");
        break;
      case "resetting":
        this.stopSpinner();
        this.status.content = styled(theme.muted(RESETTING_STATUS));
        break;
      case "dead":
        this.stopSpinner();
        this.status.content = styled(theme.errorText(DEAD_GUIDE));
        break;
      default:
        this.stopSpinner();
        this.status.content = styled(
          theme.muted(idleGuide(this.shell, this.model.heldResults.length)),
        );
    }
  }

  /** Pins a message on the status line (e.g. "Closing browser...") so the
   * user sees that teardown started. Later model changes leave it alone. */
  setStatus(text: string): void {
    if (this.torn) {
      // Nothing can be drawn any more, but the spinner interval must not
      // outlive the buffer it writes to.
      this.stopSpinner();
      return;
    }
    this.statusPinned = true;
    this.stopSpinner();
    this.status.content = text;
  }

  destroy(): void {
    this.destroyed = true;
    // Deliberately severs the model→view link: a turn still in flight must
    // not reach renderables the renderer is about to tear down.
    this.model.onChange = () => {};
    (this.renderer.keyInput as unknown as KeypressSource).off(
      "keypress",
      this.onKeypress,
    );
    this.popup.destroy();
    this.stopSpinner();
  }

  /** Enter: a message, or in shell mode a command. Mirrors the cases the
   * model drops synchronously, so the textarea is never cleared for input
   * the model is going to ignore. */
  private submit(): void {
    const text = this.input.plainText;
    if (!text.trim() || this.model.status !== "idle") {
      return;
    }
    this.input.clear();
    this.fitInput();
    if (this.shell) {
      // Shell mode stays on so the next command can be typed at once.
      void this.model.runShell(text);
      return;
    }
    // A mention problem is only known after expansion, and the box is
    // empty by then; put the text back so the user can fix it.
    void this.model.submit(text).then((accepted) => {
      // Trade-off: anything typed during expansion wins over the refill.
      if (!accepted && !this.torn && !this.input.plainText) {
        this.input.insertText(text);
        this.fitInput();
      }
    });
  }

  /** Ctrl+R reopens the browser in every state. In shell mode, Escape /
   * Backspace / Ctrl+U on an empty input leave the mode. While the popup
   * is open, navigation and accept keys belong to it and never reach the
   * textarea. Everything else falls through and the content/cursor hooks
   * re-run the search. */
  private handleKey(key: KeyEvent): void {
    if (this.torn) return;
    if (key.ctrl && key.name === "r") {
      key.preventDefault();
      void this.model.reset();
      return;
    }
    if (this.shell && this.input.plainText === "") {
      const exits =
        key.name === "escape" ||
        key.name === "backspace" ||
        (key.ctrl && key.name === "u");
      if (exits) {
        key.preventDefault();
        this.setShellMode(false);
        return;
      }
    }
    if (!this.popup.visible) return;
    switch (key.name) {
      case "up":
        this.popup.move(-1);
        break;
      case "down":
        this.popup.move(1);
        break;
      case "tab":
      case "return":
      case "kpenter":
        if (key.shift || key.ctrl) return;
        this.acceptSelection();
        break;
      case "escape":
        this.popup.hide();
        break;
      default:
        return;
    }
    key.preventDefault();
  }

  /** `!` typed or pasted into an empty input switches to shell mode; the
   * `!` itself is removed and anything after it (a paste) is kept. Runs
   * from onContentChange, so the re-insert below re-enters it; the flag
   * is set first so the nested call is a no-op. */
  private detectShellMode(): void {
    const text = this.input.plainText;
    if (!this.shell && this.lastContent === "" && text.startsWith("!")) {
      this.setShellMode(true);
      const rest = text.slice(1);
      this.input.clear();
      if (rest) this.input.insertText(rest);
    }
    this.lastContent = this.input.plainText;
  }

  private setShellMode(on: boolean): void {
    if (this.shell === on) return;
    this.shell = on;
    this.prompt.content = on
      ? styled(theme.shell("! "))
      : styled(theme.muted("> "));
    this.input.placeholder = on ? SHELL_PLACEHOLDER : PLACEHOLDER;
    if (on) this.popup.hide();
    this.update();
  }

  /** One row when empty, then one row per *visual* line up to
   * MAX_INPUT_ROWS; beyond that the textarea scrolls internally and the
   * history gives up rows. The visual rows are estimated from the text
   * rather than read off OpenTUI: its `virtualLineCount` is computed
   * against the current viewport, so at height 1 it always reports 1 and
   * only catches up after the height is raised and a layout pass runs. */
  private fitInput(): void {
    // Before the first frame the textarea has no laid-out width; the box is
    // the full terminal minus the 2-cell "> " prompt.
    const usable = Math.max(
      1,
      this.input.width || this.renderer.terminalWidth - 2,
    );
    let rows = 0;
    for (const line of this.input.plainText.split("\n")) {
      rows += Math.max(1, Math.ceil(line.length / usable));
    }
    this.input.height = Math.min(MAX_INPUT_ROWS, Math.max(1, rows));
  }

  /** Reads the textarea and shows or hides the popup accordingly. No
   * popup in shell mode: `@` is an ordinary character there. */
  private refreshPopup(): void {
    if (this.torn) return;
    if (this.shell) {
      this.popup.hide();
      return;
    }
    const mention = mentionAtCursor(
      this.input.plainText,
      this.input.cursorOffset,
    );
    if (!mention) {
      this.popup.hide();
      return;
    }
    this.popup.show(this.index.search(mention.path, MAX_ROWS));
  }

  /** Replaces the mention under the cursor with `@<path> ` and puts the
   * cursor after it. `insertText` on a selection replaces the selection. */
  private acceptSelection(): void {
    const path = this.popup.selected;
    const mention = mentionAtCursor(
      this.input.plainText,
      this.input.cursorOffset,
    );
    if (path === undefined || !mention) {
      this.popup.hide();
      return;
    }
    this.input.setSelection(mention.start, mention.end);
    this.input.insertText(`@${path} `);
    this.popup.hide();
  }

  private messageBox(message: Message): BoxRenderable {
    const box = new BoxRenderable(this.renderer, {
      flexDirection: "column",
      marginBottom: 1,
    });
    if (message.role === "separator") {
      box.add(
        new TextRenderable(this.renderer, {
          content: styled(theme.muted(`── ${message.text} ──`)),
          wrapMode: "none",
        }),
      );
      return box;
    }
    box.add(
      new TextRenderable(this.renderer, { content: LABELS[message.role]() }),
    );
    if (message.role === "shell") {
      box.add(
        new TextRenderable(this.renderer, {
          content: styled(theme.shell(`$ ${message.text}`)),
          wrapMode: "word",
        }),
      );
      const output = new TextRenderable(this.renderer, {
        content: "",
        wrapMode: "word",
        visible: false,
      });
      const footer = new TextRenderable(this.renderer, {
        content: "",
        wrapMode: "word",
        visible: false,
      });
      box.add(output);
      box.add(footer);
      const entry: ShellEntry = {
        message,
        output,
        footer,
        drawnOutput: "",
        drawnFooter: "",
      };
      this.shellEntries.push(entry);
      this.refreshShell(entry);
      return box;
    }
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
    return box;
  }

  /** Rewrites a shell entry's output and footer when they changed. Hidden
   * renderables take no rows, so an empty output or footer costs nothing. */
  private refreshShell(entry: ShellEntry): void {
    const output = entry.message.result?.output ?? "";
    if (output !== entry.drawnOutput) {
      entry.drawnOutput = output;
      // Trailing newline would draw an empty row under the output.
      entry.output.content = output.endsWith("\n")
        ? output.slice(0, -1)
        : output;
      entry.output.visible = output !== "";
    }
    const footer = shellFooter(entry.message);
    if (footer !== entry.drawnFooter) {
      entry.drawnFooter = footer;
      entry.footer.content = styled(theme.muted(footer));
      entry.footer.visible = footer !== "";
    }
  }

  private startSpinner(mode: "busy" | "running"): void {
    if (this.spinner && this.spinnerMode === mode) return;
    this.stopSpinner();
    this.spinnerMode = mode;
    this.startedAt = Date.now();
    const tick = () => {
      // The renderer can be destroyed from under a running turn (SIGINT);
      // the interval outlives it until teardown reaches this view.
      if (this.torn) return this.stopSpinner();
      this.frame = (this.frame + 1) % FRAMES.length;
      const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
      this.status.content =
        mode === "running"
          ? `${FRAMES[this.frame]} ${RUNNING_LABEL}  ${elapsed}s · Ctrl+C stop`
          : `${FRAMES[this.frame]} Thinking…  ${elapsed}s / ${this.budgetSec}s`;
    };
    tick();
    this.spinner = setInterval(tick, FRAME_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = undefined;
    this.spinnerMode = undefined;
  }
}
```

If Task 1 found that `placeholder` is not settable, remove the `this.input.placeholder = ...` line and the `SHELL_PLACEHOLDER` / `PLACEHOLDER` constants' use there (keep `PLACEHOLDER` for the constructor).

- [ ] **Step 5: Run the view tests**

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: PASS. Likely adjustments:
- If `insertText` inside `onContentChange` does not re-enter (no nested change event), `lastContent` is still set correctly at the end of `detectShellMode`; nothing to do.
- If the test renderer reports the Escape key only after its escape-sequence timeout, the polling loops in the tests already wait for it.
- If Task 1 found that `Ctrl+U` or `Backspace` do not reach the global listener before the textarea, handle the exit in `onContentChange` instead: when in shell mode the previous content was empty and the key was one of those, leave the mode. Record the deviation in the commit message.

- [ ] **Step 6: Run the whole cli package, check, commit**

```bash
bun test packages/cli
bun run check
git add packages/cli/src/tui/theme.ts packages/cli/src/tui/banner.ts packages/cli/src/tui/chat-view.ts packages/cli/src/tui/chat-view.test.ts
git commit -m "feat(cli): shell mode in the TUI — ! prompt, live output, status texts (Refs #47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 47 --body "Task 7 done: ChatView enters shell mode on ! (typed or pasted) in an empty input, exits on Esc/Backspace/Ctrl+U when empty, hides the @ popup in shell mode, streams command output into the shell entry, shows exit code / interrupted / truncated / held footers, and the Running… / held-count status texts. Next: Task 8 (runInteractive + createCli wiring)."
```

---

### Task 8: Wiring — `runInteractive`, `waitForQuit`, `createCli`

**Files:**
- Modify: `packages/cli/src/tui/run-interactive.ts`
- Modify: `packages/cli/src/tui/run-interactive.test.ts`
- Modify: `packages/cli/src/create-cli.ts`
- Modify: `packages/cli/src/create-cli.test.ts`

**Interfaces:**
- Consumes: `ShellConfig`, `resolveShellConfig` (Task 2); `CliConfig.shell` (Task 5); `ChatModel.stopShell`, `status === "running"` (Task 6).
- Produces: `InteractiveOptions.shell?: ShellConfig`; `CreateCliOptions.shell?: Partial<ShellConfig>`; `waitForQuit` routes Ctrl+C to `stopShell()` while `running`; the interactive path always reads `config.json`.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/tui/run-interactive.test.ts`, inside `describe("waitForQuit", ...)`, append:

```ts
  test("Ctrl+C while a shell command runs stops it and does not quit", async () => {
    const t = await createTestRenderer({ width: 40, height: 12 });
    let stopped = 0;
    const model = new ChatModel(
      {
        async send() {
          return "";
        },
        async close() {},
        async kill() {},
      },
      {
        openSession: async () => {
          throw new Error("not expected");
        },
        shell: { leadIn: "x", autoSend: false },
        runCommand: (command) => {
          let resolve!: (r: ShellResult) => void;
          const done = new Promise<ShellResult>((res) => {
            resolve = res;
          });
          return {
            done,
            stop() {
              stopped++;
              resolve({
                command,
                output: "",
                droppedBytes: 0,
                exitCode: undefined,
                interrupted: true,
                durationMs: 1,
              });
            },
          };
        },
      },
    );
    const view = new ChatView(t.renderer, model, {
      title: "test-cli",
      providerName: "dummy-chat",
      timeoutMs: 1_000,
      headless: true,
      banner: [],
      index: FileIndex.fromPaths([]),
    });
    const quit = waitForQuit(t.renderer, model);
    const run = model.runShell("sleep 10");
    await new Promise((r) => setTimeout(r, 0));
    expect(model.status).toBe("running");
    t.mockInput.pressKey("c", { ctrl: true });
    await run;
    expect(stopped).toBe(1);
    expect(model.status).toBe("idle");
    const raced = await Promise.race([
      quit.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("pending"), 50)),
    ]);
    expect(raced).toBe("pending");
    t.mockInput.pressKey("c", { ctrl: true });
    expect(await quit).toBeUndefined();
    view.destroy();
    t.renderer.destroy();
  });
```

and add `import type { ShellResult } from "../shell/run-command.js";` to the imports.

In `packages/cli/src/create-cli.test.ts`, inside `describe("interactive mode gate", ...)`, append:

```ts
  test("a pinned-provider CLI still reads config.json's shell section", async () => {
    captureStderr();
    const dir = setup();
    mkdirSync(join(dir, "test-cli"), { recursive: true });
    writeFileSync(
      join(dir, "test-cli", "config.json"),
      JSON.stringify({ shell: { leadIn: 5 } }),
    );
    const cli = createCli({
      name: "test-cli",
      provider: stubProvider(),
      baseDir: dir,
      isTerminal: true,
    });
    // Reaching the validation error proves the config was loaded on the
    // interactive path before any browser work.
    expect(await cli.run(["bun", "cli"])).toBe(1);
    expect(stderrChunks.join("")).toContain('"shell.leadIn" must be a string');
  });

  test("createCli accepts vendor shell defaults", async () => {
    const cli = createCli({
      name: "test-cli",
      provider: stubProvider(),
      shell: { leadIn: "Vendor lead-in", autoSend: false },
      isTerminal: false,
    });
    // Type-level check plus the gate still applies.
    expect(await cli.run(["bun", "cli"])).toBe(1);
  });
```

and in `describe("--version", ...)` (which already captures `console.log`), append:

```ts
  test("help mentions ! shell mode and the shell config keys", async () => {
    captureLog();
    const cli = createCli({ name: "test-cli", baseDir: setup() });
    await cli.run(["bun", "cli", "--help"]);
    const out = logs.join("\n");
    expect(out).toContain("! runs a shell command");
    expect(out).toContain('"shell"');
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test packages/cli/src/tui/run-interactive.test.ts packages/cli/src/create-cli.test.ts`
Expected: FAIL — Ctrl+C resolves `quit` while running; the pinned-provider run exits 2 (config not read); `shell` is not a known option; help lacks the text.

- [ ] **Step 3: `run-interactive.ts`**

1. Add `import type { ShellConfig } from "../shell/shell-config.js";`.
2. Add to `InteractiveOptions` after `banner?`:

```ts
  /** Resolved `!` shell mode settings. Default: DEFAULT_SHELL_CONFIG. */
  shell?: ShellConfig;
```

3. Replace the Ctrl+C line in `waitForQuit` and update its doc comment:

```ts
/**
 * Resolves when the user asks to quit: Ctrl+C, or the renderer being
 * destroyed from outside — OpenTUI installs its own SIGINT/SIGTERM/SIGHUP
 * handlers that destroy the renderer without exiting the process, so
 * without this the caller's promise would stay pending and the browser
 * would keep the process alive. While a shell command is running, Ctrl+C
 * stops the command instead of quitting. A fatal model error does not
 * quit (the model goes `dead` and Ctrl+R can recover); the resolved value
 * is the model's `fatal` at quit time so a quit from `dead` reports the
 * error.
 */
export function waitForQuit(
  renderer: CliRenderer,
  model: ChatModel,
): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    (renderer.keyInput as unknown as KeypressSource).on("keypress", (key) => {
      if (!key.ctrl || key.name !== "c") return;
      if (model.status === "running") {
        model.stopShell();
        return;
      }
      resolve(model.fatal);
    });
    (renderer as unknown as DestroySource).on("destroy", () =>
      resolve(model.fatal),
    );
  });
}
```

4. Pass the config to the model:

```ts
    model = new ChatModel(session, {
      openSession: () => ChatSession.open(sessionOpts),
      shell: opts.shell,
    });
```

5. In the `finally`, before `view?.setStatus(CLOSING_STATUS);`, add:

```ts
    // A shell command must not outlive the TUI.
    model?.stopShell();
```

- [ ] **Step 4: `create-cli.ts`**

1. Imports: `import { type CliConfig, configPath, loadConfig } from "./config.js";` and `import { type ShellConfig, resolveShellConfig } from "./shell/shell-config.js";`.
2. `CreateCliOptions`, after `banner?`:

```ts
  /** Vendor defaults for `!` shell mode in the interactive TUI; the user's
   * config.json overrides them key by key. */
  shell?: Partial<ShellConfig>;
```

3. `help()`: after the `"One-shot mode prints the AI response to stdout."` line add

```ts
      "Interactive mode: @ attaches a file, ! runs a shell command and sends its output.",
```

and change the config note at the end to:

```ts
      ...(opts.provider
        ? [
            "",
            `${configPath(location)} may set "shell": { "leadIn", "autoSend" } for ! shell mode.`,
          ]
        : [
            "",
            `Without --provider, "defaultProvider" from ${configPath(location)} is used;`,
            `"shell": { "leadIn", "autoSend" } there configures ! shell mode.`,
          ]),
```

4. `getProvider` takes an optional preloaded config so the interactive path reads the file once:

```ts
  /** Resolution order: pinned provider → --provider → config defaultProvider.
   * `config`, when given, is used instead of reading the file again. */
  async function getProvider(
    flag: string | undefined,
    config?: CliConfig,
  ): Promise<Provider> {
    if (opts.provider) {
      if (flag !== undefined) {
        throw new ChatBridgeError(
          "INVALID_ARGUMENT",
          `${opts.name} has a fixed provider; --provider is not accepted`,
        );
      }
      return opts.provider;
    }
    const spec =
      flag ?? (config ?? (await loadConfig(location))).defaultProvider;
    if (!spec) {
      throw new ProviderLoadError(
        `No provider specified. Pass --provider <npm-package|./path> or set "defaultProvider" in ${configPath(location)}.`,
      );
    }
    return resolveProvider(spec);
  }
```

5. In the interactive branch, replace `const provider = await getProvider(values.provider);` with:

```ts
        // Read even with a pinned provider: the shell section is the
        // user's to override regardless of who ships the CLI.
        const config = await loadConfig(location);
        const provider = await getProvider(values.provider, config);
```

and add `shell: resolveShellConfig(opts.shell, config.shell),` to the `runInteractive({...})` call after `banner: opts.banner,`.

- [ ] **Step 5: Run, check, commit**

```bash
bun test packages/cli
bun run check
git add packages/cli/src/tui/run-interactive.ts packages/cli/src/tui/run-interactive.test.ts packages/cli/src/create-cli.ts packages/cli/src/create-cli.test.ts
git commit -m "feat(cli): wire shell-mode config through createCli; Ctrl+C stops a running command (Refs #47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 47 --body "Task 8 done: createCli({ shell }) + config.json shell section resolved and passed to runInteractive (config now read on the interactive path even with a pinned provider); Ctrl+C stops a running command instead of quitting; teardown stops a running command. Next: Task 9 (README + roadmap), then whole-branch review and PR."
```

---

### Task 9: Docs — README and roadmap

**Files:**
- Modify: `README.md` (config example, `createCli` example, Interactive mode bullets)
- Modify: `docs/ROADMAP.md` (milestone 10 entry; remove the backlog item)

- [ ] **Step 1: README — configuration**

Replace the `config.json` example block:

```json
{
  "defaultProvider": "@your-scope/your-provider",
  "shell": { "leadIn": "Please check the execution result.", "autoSend": true }
}
```

and add after the sentence about globally installed CLIs:

```markdown
`shell` is optional and configures `!` shell mode in the interactive TUI
(see below): `leadIn` is the first line of the message sent with a
command's output, `autoSend: false` holds the output back until your next
message. Both override the defaults a derived CLI ships.
```

In the `createCli` example add a line after `banner:`:

```ts
  shell: { leadIn: "実行結果を確認してください。" }, // optional: default lead-in for ! shell mode
```

- [ ] **Step 2: README — Interactive mode**

In the first bullet, change `**Ctrl+R** reopens the browser. **Ctrl+C** quits.` to `**Ctrl+R** reopens the browser. **Ctrl+C** quits (while a `!` command runs it stops the command instead).`

After the `@` bullet, add:

```markdown
- Type **`!`** in an empty input to run a shell command (pasting text that
  starts with `!` works too). The prompt turns into `! `; **Enter** runs
  the command in the directory you started `chatbridge` in, with your own
  user and environment and no sandbox. Its output streams into the history
  under a `shell` label; the status row shows `Running…  12s · Ctrl+C
  stop`. When the command finishes, the output is sent to the service as a
  fenced block under `### $ <command>` after a lead-in line (default
  `Please check the execution result.`, configurable in `config.json` and by
  a derived CLI), so the assistant reacts to it in the same turn. A non-zero
  exit code is appended as `exit code: N`; a stopped command is marked
  `interrupted`. Output is capped at 200 KB: past that the command is killed
  and only the tail is kept, with a `truncated` note. Shell mode stays on
  for the next command; **Esc**, **Backspace**, or **Ctrl+U** on an empty
  input leave it. `@` has no special meaning in shell mode. Each command
  starts fresh in the start directory (`cd` does not carry over).
- With `"shell": { "autoSend": false }` in `config.json` the output is held
  instead of sent: the entry shows `📎 held, sent with your next message`,
  the status row counts the held results, and they are appended to the next
  message you send. Held results are dropped when you quit.
```

- [ ] **Step 3: ROADMAP**

Remove the backlog bullet that starts with `- **\`!\` shell mode in the TUI.**` (the whole bullet, up to `recorded in issue #38.`). Insert a new milestone after `### 8. ...` and before `### 5. Company adoption`:

```markdown
### 9. `!` shell mode in the TUI — in progress (issue #47)

Claude Code-style: `!` on an empty input switches the input box into shell
mode; Enter runs the command in the start directory (own privileges, no
sandbox) and streams its output into the history; the result is sent as a
`### $ <command>` fenced section under a configurable lead-in, or held and
attached to the next message with `autoSend: false`. Lead-in and switch are
resolved built-in → `createCli({ shell })` → `config.json`. Output is
capped at 200 KiB (tail kept), stdout/stderr merged, `exit code` /
`interrupted` labelled; Ctrl+C stops a running command; Ctrl+R kills it.
Everything lives in `@chatbridge/cli`. Left for later: `Tab` command
history, `/` path completion, `Ctrl+B` backgrounding, `cd` carry-over,
ANSI stripping, running commands while a turn is in flight.
Spec: `docs/superpowers/specs/2026-09-17-shell-mode-design.md`.
```

(The `— in progress` suffix becomes `— done (issue #47, PR #N, <date>)` when the PR merges.)

- [ ] **Step 4: Check and commit**

```bash
bun run check
git add README.md docs/ROADMAP.md
git commit -m "docs: ! shell mode in README and roadmap (Refs #47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 47 --body "Task 9 done: README (config, createCli, interactive-mode bullets) and ROADMAP milestone 10 entry. All plan tasks committed on issue-47. Next: whole-branch review, then PR."
```

---

## Spec coverage check

| Spec item | Task |
|---|---|
| `run-command.ts` API, process group, cap, throttle, UTF-8 | 3 |
| `format-result.ts` exact shape | 4 |
| `shell-config.ts` layers | 2 |
| `fenceFor` shared | 2 |
| `ChatModel` states, `runShell` steps 1–7, `submit` held append, `reset` stops, teardown stops | 6, 8 |
| View: enter/exit, popup off, newlines kept, submit branch, live output, footers, status texts, Ctrl+C, banner | 7, 8 |
| `config.ts` validation | 5 |
| `createCli` option, config always loaded, help text | 8 |
| README, roadmap | 9 |
| Error table: shell cannot start / non-zero / cap / Ctrl+C / SIGKILL / Ctrl+R / non-UTF-8 / send failures / held on quit / logging / ANSI passthrough | 3, 6, 7, 8 |
| Spike | 1 |
