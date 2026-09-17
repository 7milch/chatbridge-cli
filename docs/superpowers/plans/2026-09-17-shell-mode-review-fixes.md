# Shell Mode Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the eight findings of the PR #50 review (`!` shell mode, milestone 10) on branch `issue-47` before merge: signal deaths reported as success, held results lost on a send failure, an unmarked "shell did not start" entry, a pinned-provider CLI failing on an ignored config key, a banner line that overflows 80 columns for long provider names, a quadratic output buffer, and two documentation defects.

**Architecture:** Every fix stays inside the existing shell-mode seams. `ShellResult` gains an optional `signal`, `Message` gains `failed`, `ChatModel` releases held results only once a reply arrives, `loadConfig` learns that a pinned provider makes `defaultProvider` irrelevant, the banner puts the hint on its own line, and the runner keeps a chunk list instead of re-concatenating a buffer. No new modules, no new dependencies, no change to the OpenTUI-free boundary of `packages/cli/src/shell/` and `chat-model.ts`.

**Tech Stack:** TypeScript, Bun (workspaces, `bun test`), OpenTUI 0.5.10 (`@opentui/core`, `@opentui/core/testing`), Node `child_process`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-17-shell-mode-design.md` (updated in place by the tasks below where behaviour changes). Review findings: the PR #50 code review of 2026-09-17, reproduced per task under "Finding".

## Global Constraints

- Branch `issue-47`; every commit message ends with `(Refs #47)` and the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. After every commit: `gh issue comment 47 --body "<what was committed> + <what's next>"` in English.
- `bun run check` (Biome lint + `tsc --build` + `bun test`) must pass before every commit. Tests import cross-package code from `dist/`, so `bun run build` after editing another package (not needed here: every file is under `packages/cli`).
- Dependency direction is one-way: `cli → core → runtime → provider`. Nothing under `packages/cli/src/shell/` and nothing in `chat-model.ts` may import `@opentui/core`.
- Every document, comment, commit message and issue comment is in English.
- Command lines and command output go only into the history: never to `onProgress`, never to stderr, never to logs.
- Linux and macOS only: `stop()` relies on process groups. CI runs Ubuntu.
- Exact strings introduced by this plan: footer/section line `killed by <SIGNAL>` (e.g. `killed by SIGKILL`); footer `did not start` for a shell that could not be spawned; banner line 2 `Connected to <provider>.`; banner line 3 (`BANNER_HINT`) `Type a message, @ to attach a file, ! to run a command.` unchanged.
- Unchanged exact strings that tests still assert: default lead-in `Please check the execution result.`; held footer `📎 held, sent with your next message`; error entry `could not start shell: <message>`; output cap `200 * 1024`; SIGKILL grace `2_000` ms; output throttle `100` ms.
- Status-row texts and banner lines must fit 80 columns.
- Subagent model policy: Task 1, 2, 3, 6 → Opus (runner / model / view judgement); Task 4, 5, 7 → Sonnet (the plan carries the full code or the edit is textual).
- Test helpers already exist and are reused verbatim: `fakeSession` / `fakeRunner` / `tick` / `noReopen` in `packages/cli/src/tui/chat-model.test.ts`; `setup` / `fakeRunner` / `frameWith` in `packages/cli/src/tui/chat-view.test.ts`; `result()` in `packages/cli/src/shell/format-result.test.ts`; `setup()` / `stubProvider()` / `captureStderr()` in `packages/cli/src/create-cli.test.ts`; `setup()` in `packages/cli/src/config.test.ts`.

## File map

| File | Task | Change |
|---|---|---|
| `packages/cli/src/shell/run-command.ts` | 1, 6 | `signal` on `ShellResult`; close handler keeps Node's signal; chunk list instead of `Buffer.concat` per chunk |
| `packages/cli/src/shell/run-command.test.ts` | 1, 6 | signal death test; single-chunk and multi-chunk trim tests |
| `packages/cli/src/shell/format-result.ts` / `.test.ts` | 1 | `killed by <SIGNAL>` line |
| `packages/cli/src/tui/chat-view.ts` / `.test.ts` | 1, 3 | footer `killed by <SIGNAL>`; footer `did not start`; `fail()` on the view test's fake runner |
| `packages/cli/src/tui/chat-model.ts` / `.test.ts` | 2, 3 | held results released on reply, not on send; `Message.failed` |
| `packages/cli/src/config.ts` / `.test.ts` | 4 | `loadConfig(loc, { providerPinned })` skips `defaultProvider` |
| `packages/cli/src/create-cli.ts` / `.test.ts` | 4 | interactive path passes `providerPinned` |
| `packages/cli/src/tui/banner.ts` / `.test.ts` | 5 | hint on its own line |
| `docs/superpowers/specs/2026-09-17-shell-mode-design.md` | 1, 2, 3, 5 | interface, format, footer, error table, banner |
| `README.md` | 1, 2, 4 | signal line; held results survive a timeout; config.json with a pinned provider |
| `docs/superpowers/plans/2026-09-17-shell-mode.md` | 7 | Japanese lead-in replaced |
| `.claude/skills/creating-provider-repo/SKILL.md` | 7 | `shell` as a vendor knob |

---

### Task 1: Report a signal death instead of a clean success

**Finding:** `packages/cli/src/shell/run-command.ts:144` — the `close` handler drops Node's `signal` argument. A command killed by a signal that `stop()` did not send (`kill -9 $$`, a shell segfault, an OOM kill, a kill from another terminal) settles with `exitCode: undefined, interrupted: false`, which `formatShellSection` and the TUI footer render exactly like exit 0.

**Files:**
- Modify: `packages/cli/src/shell/run-command.ts:17-29` (interface), `:132-148` (settle), `:196-199` (close handler)
- Modify: `packages/cli/src/shell/format-result.ts:16-42`
- Modify: `packages/cli/src/tui/chat-view.ts:71-82` (`shellFooter`)
- Test: `packages/cli/src/shell/run-command.test.ts`, `packages/cli/src/shell/format-result.test.ts`, `packages/cli/src/tui/chat-view.test.ts`
- Docs: `docs/superpowers/specs/2026-09-17-shell-mode-design.md` (interface at line ~97, format block at ~140-149, footer list at ~285-288, error table at ~361-372), `README.md:150-152`

**Interfaces:**
- Produces: `ShellResult.signal?: NodeJS.Signals` — set only when the child ended on a signal and `interrupted` is false. `formatShellSection` and the view footer render it as `killed by <SIGNAL>`. Later tasks do not depend on it, but every fake runner keeps working because the field is optional.

- [ ] **Step 1: Write the failing runner test**

Append inside `describe("runCommand", …)` in `packages/cli/src/shell/run-command.test.ts`:

```ts
  test("a command killed by a signal stop() did not send reports the signal", async () => {
    // `$$` is the user's shell itself (the wrapper exec'd into it), so the
    // kill reaches our direct child and "close" fires with code null.
    const r = await runCommand("echo hi; kill -9 $$", {
      cwd: process.cwd(),
      shell: SH,
    }).done;
    expect(r.output).toBe("hi\n");
    expect(r.exitCode).toBeUndefined();
    expect(r.interrupted).toBe(false);
    expect(r.signal).toBe("SIGKILL");
  });
```

And extend the existing `"stop() interrupts, keeps the output so far, and done settles"` test with one more assertion after `expect(r.output).toBe("started\n");`:

```ts
    // Our own SIGTERM is not reported as a signal death.
    expect(r.signal).toBeUndefined();
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/cli/src/shell/run-command.test.ts -t "signal stop"`
Expected: FAIL — `r.signal` is `undefined`, expected `"SIGKILL"` (and tsc will complain that `signal` is not on `ShellResult`; that is fine at this step).

- [ ] **Step 3: Add the field and keep the signal in the close handler**

In `packages/cli/src/shell/run-command.ts`, extend the interface (after `interrupted`):

```ts
  /** True when stop() ran or the cap killed the command. */
  interrupted: boolean;
  /** The signal that ended the command when something other than stop()
   * killed it — a `kill` from elsewhere, a crash of the shell itself.
   * Absent on a normal exit and on an interrupted result. */
  signal?: NodeJS.Signals;
  durationMs: number;
```

Replace `settle` (the function inside the `done` promise) with:

```ts
    const settle = (code: number | null, sig: NodeJS.Signals | null) => {
      finish();
      // The last throttled tick may still be pending: deliver the final
      // output before resolving so onOutput never lags the result.
      if (unnotified) flush();
      const result: ShellResult = {
        command,
        output: text(),
        droppedBytes: dropped,
        // A stopped command reports no exit code even when it happened to
        // exit on its own before the signal landed.
        exitCode: interrupted ? undefined : (code ?? undefined),
        interrupted,
        durationMs: Date.now() - startedAt,
      };
      // Our own SIGTERM/SIGKILL is `interrupted`; only a signal we did
      // not send is worth naming.
      if (!interrupted && sig !== null) result.signal = sig;
      resolve(result);
    };
```

Update the two call sites: the pre-spawn stop becomes `settle(null, null);` and the close handler becomes:

```ts
      // "close": every stdio pipe has drained, so the output is complete.
      child.on("close", (code, sig) => {
        if (settled) return;
        settle(code, sig);
      });
```

- [ ] **Step 4: Run the runner tests**

Run: `bun test packages/cli/src/shell/run-command.test.ts`
Expected: PASS (all, including the new one).

- [ ] **Step 5: Write the failing format test**

Append inside `describe("formatShellSection", …)` in `packages/cli/src/shell/format-result.test.ts`:

```ts
  test("a signal death is named instead of an exit code", () => {
    expect(
      formatShellSection(result({ exitCode: undefined, signal: "SIGKILL" })),
    ).toBe("### $ npm test\n```\nok\n```\nkilled by SIGKILL");
  });
```

Run: `bun test packages/cli/src/shell/format-result.test.ts -t "signal death"`
Expected: FAIL — received string lacks the `killed by SIGKILL` line.

- [ ] **Step 6: Emit the line in `formatShellSection`**

In `packages/cli/src/shell/format-result.ts`, update the doc comment and add the line between the exit code and `interrupted`:

```ts
/** The milestone 6 attachment shape for one command result:
 *
 *   ### $ <command>
 *   … (truncated: first N KB dropped)   ← only when bytes were dropped
 *   ```
 *   <output>
 *   ```
 *   exit code: N                        ← only when non-zero
 *   killed by SIGKILL                   ← only when a signal we did not send ended it
 *   interrupted                         ← only when stopped or killed by the cap
 */
export function formatShellSection(result: ShellResult): string {
  const body =
    result.output === "" || result.output.endsWith("\n")
      ? result.output
      : `${result.output}\n`;
  const fence = fenceFor(body);
  const lines = [headingFor(result.command)];
  if (result.droppedBytes > 0) {
    lines.push(truncatedNote(result.droppedBytes));
  }
  lines.push(`${fence}\n${body}${fence}`);
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    lines.push(`exit code: ${result.exitCode}`);
  }
  if (result.signal !== undefined) lines.push(`killed by ${result.signal}`);
  if (result.interrupted) lines.push("interrupted");
  return lines.join("\n");
}
```

Run: `bun test packages/cli/src/shell/format-result.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing view test**

Append inside `describe("ChatView shell mode", …)` in `packages/cli/src/tui/chat-view.test.ts`, right after the `"non-zero exit, interrupted and truncation are shown as a footer"` test:

```ts
  test("a signal death is shown as a footer", async () => {
    const runner = fakeRunner();
    const t = await setup({
      runCommand: runner.runCommand,
      shell: { leadIn: "x", autoSend: false },
    });
    await t.mockInput.typeText("!./crashy");
    t.mockInput.pressEnter();
    await t.frameWith("Running…");
    runner.finish({ exitCode: undefined, signal: "SIGSEGV" });
    const frame = await t.frameWith("killed by SIGSEGV");
    expect(frame).not.toContain("exit code");
    expect(frame).not.toContain("interrupted");
  });
```

Run: `bun test packages/cli/src/tui/chat-view.test.ts -t "signal death"`
Expected: FAIL — `frameWith("killed by SIGSEGV")` times out.

- [ ] **Step 8: Emit the footer in the view**

In `packages/cli/src/tui/chat-view.ts`, `shellFooter`:

```ts
function shellFooter(message: Message): string {
  const r = message.result;
  if (!r) return "";
  const parts: string[] = [];
  if (r.droppedBytes > 0) parts.push(truncatedNote(r.droppedBytes));
  if (r.exitCode !== undefined && r.exitCode !== 0) {
    parts.push(`exit code: ${r.exitCode}`);
  }
  if (r.signal !== undefined) parts.push(`killed by ${r.signal}`);
  if (r.interrupted) parts.push("interrupted");
  if (message.held) parts.push(HELD_FOOTER);
  return parts.join(" · ");
}
```

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: PASS.

- [ ] **Step 9: Update the spec and README**

`docs/superpowers/specs/2026-09-17-shell-mode-design.md`:

1. In the `ShellResult` interface block (around line 97), after `interrupted: boolean;` add:
   ```ts
     /** The signal that ended the command when something other than stop()
      * killed it; absent on a normal exit and on an interrupted result. */
     signal?: NodeJS.Signals;
   ```
2. In the format block (around line 147), after the `exit code: 1` line add `killed by SIGKILL                        ← only when a signal we did not send ended it`.
3. In the `messageBox` paragraph (around line 286) change ``exit code: N`, `interrupted`, `… (truncated: …)`, and`` to ``exit code: N`, `killed by SIGKILL`, `interrupted`, `… (truncated: …)`, and``.
4. In the error table (section 5) add, after the `Ctrl+C while running` row:
   `| Killed by a signal stop() did not send (`kill -9` from elsewhere, a crash of the shell) | not `interrupted`; `killed by <SIGNAL>` appended; sent or held as usual |`

`README.md` line 151-152: change `a stopped command is marked \`interrupted\`.` to `a stopped command is marked \`interrupted\`, and one killed from outside (or crashed) is marked \`killed by SIGKILL\` with the signal name.`

- [ ] **Step 10: Check and commit**

Run: `bun run check`
Expected: lint clean, build clean, all tests pass.

```bash
git add packages/cli/src/shell/run-command.ts packages/cli/src/shell/run-command.test.ts packages/cli/src/shell/format-result.ts packages/cli/src/shell/format-result.test.ts packages/cli/src/tui/chat-view.ts packages/cli/src/tui/chat-view.test.ts docs/superpowers/specs/2026-09-17-shell-mode-design.md README.md
git commit -m "fix(cli): report a shell command killed by a foreign signal instead of success (Refs #47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 47 --body "Review fix 1/7 committed: ShellResult.signal, rendered as \`killed by <SIGNAL>\` in the section and the footer. What's next: held results survive a send failure (Task 2)."
```

---

### Task 2: Held results survive a send failure

**Finding:** `packages/cli/src/tui/chat-model.ts:183` — `runTurn` empties `heldResults` and clears every `held` flag before awaiting `sendPrompt`. A `ResponseTimeoutError` returns the model to `idle` — the state the user retries from — with the held shell output gone. The `MentionError` path deliberately keeps them; the send-failure path silently does not.

**Files:**
- Modify: `packages/cli/src/tui/chat-model.ts:174-186` (runTurn tail), `:277-308` (sendPrompt)
- Test: `packages/cli/src/tui/chat-model.test.ts` (`describe("ChatModel.runShell", …)`)
- Docs: `docs/superpowers/specs/2026-09-17-shell-mode-design.md` (`submit(text)` section ~232-238, error table), `README.md:157-160`

**Interfaces:**
- Consumes: `ChatModel.heldResults`, `Message.held`, `sendPrompt(prompt)` as they exist.
- Produces: `private sendPrompt(prompt: string, releasesHeld = false): Promise<void>` and `private releaseHeld(): void`. Behaviour: the held results and `held` flags are cleared only when the reply arrives for the current generation. A timeout, a fatal error, or a reset during the send leaves them held. While the send is in flight the entry footer still reads `📎 held, sent with your next message`; it clears with the reply.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("ChatModel.runShell", …)` in `packages/cli/src/tui/chat-model.test.ts`, after `"a MentionError keeps the held results"`:

```ts
  test("a timeout keeps the held results for the retry", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = new ChatModel(session, {
      ...noReopen,
      runCommand: runner.runCommand,
      shell: { leadIn: "unused", autoSend: false },
    });
    const p = model.runShell("npm test");
    await tick();
    runner.emit("FAIL\n");
    runner.finish({ exitCode: 1 });
    await p;

    const first = model.submit("why did it fail?");
    await tick();
    // Still held while the send is in flight …
    expect(model.heldResults).toHaveLength(1);
    expect(model.messages[0]?.held).toBe(true);
    replies[0]?.reject(new ResponseTimeoutError("Timed out after 10 ms."));
    await first;
    expect(model.status).toBe("idle");
    // … and after a recoverable failure, so the retry carries them.
    expect(model.heldResults).toHaveLength(1);
    expect(model.messages[0]?.held).toBe(true);

    const second = model.submit("why did it fail?");
    await tick();
    replies[1]?.resolve("because");
    await second;
    const section = "### $ npm test\n```\nFAIL\n```\nexit code: 1";
    expect(calls).toEqual([
      `why did it fail?\n\n${section}`,
      `why did it fail?\n\n${section}`,
    ]);
    expect(model.heldResults).toEqual([]);
    expect(model.messages[0]?.held).toBe(false);
  });

  test("a fatal send failure keeps the held results for after a reset", async () => {
    const first = fakeSession("a");
    const second = fakeSession("b");
    const runner = fakeRunner();
    const model = new ChatModel(first.session, {
      closeTimeoutMs: 20,
      openSession: async () => second.session,
      runCommand: runner.runCommand,
      shell: { leadIn: "unused", autoSend: false },
    });
    const p = model.runShell("ls");
    await tick();
    runner.finish();
    await p;

    const q = model.submit("hi");
    await tick();
    first.replies[0]?.reject(new Error("page closed"));
    await q;
    expect(model.status).toBe("dead");
    expect(model.heldResults).toHaveLength(1);

    await model.reset();
    const r = model.submit("hi again");
    await tick();
    second.replies[0]?.resolve("ok");
    await r;
    expect(second.calls).toEqual(["b:hi again\n\n### $ ls\n```\n```"]);
    expect(model.heldResults).toEqual([]);
    expect(model.messages[0]?.held).toBe(false);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/cli/src/tui/chat-model.test.ts -t "keeps the held results for"`
Expected: FAIL — `heldResults` has length 0 right after `submit` (first test) and after the fatal error (second test).

- [ ] **Step 3: Release held results on the reply**

In `packages/cli/src/tui/chat-model.ts`, replace the tail of `runTurn` (from `let outgoing = expansion.prompt;` to `return true;`) with:

```ts
    let outgoing = expansion.prompt;
    // The held results ride along but are released only when the reply
    // arrives: a timeout returns to idle for a retry, and that retry must
    // carry them again.
    const carriesHeld = this.heldResults.length > 0;
    if (carriesHeld) {
      outgoing = [outgoing, ...this.heldResults.map(formatShellSection)].join(
        "\n\n",
      );
    }
    this.onChange();
    await this.sendPrompt(outgoing, carriesHeld);
    return true;
```

Replace the `sendPrompt` doc comment and signature, and add the release on success:

```ts
  /** The send half of a turn, shared by runTurn and runShell. The caller has
   * already set `busy` and notified the view. Draining happens here, so
   * every turn end — typed, queued or auto-sent — continues the queue
   * exactly once. `releasesHeld`: the prompt carries the held shell
   * results; they are released when the reply arrives, so a failed or
   * stale send keeps them for the next message. */
  private async sendPrompt(prompt: string, releasesHeld = false): Promise<void> {
    const session = this.current;
    const generation = this.generation;
    try {
      const reply = await session.send(prompt);
      if (generation !== this.generation) return; // stale: reset ran
      if (releasesHeld) this.releaseHeld();
      this.messages.push({ role: "assistant", text: reply });
      this.status = "idle";
    } catch (err) {
```

(the rest of `sendPrompt` is unchanged). Add the helper right after `sendPrompt`:

```ts
  /** Forgets the held results and clears the flag on their entries. Runs
   * before drain(), so a queued entry never re-attaches them. */
  private releaseHeld(): void {
    this.heldResults.length = 0;
    for (const m of this.messages) if (m.held) m.held = false;
  }
```

- [ ] **Step 4: Run the model and view tests**

Run: `bun test packages/cli/src/tui/chat-model.test.ts packages/cli/src/tui/chat-view.test.ts`
Expected: PASS. In particular `"autoSend off: the result is held and attached to the next submit"`, `"several held results go out in order …"`, `"autoSend off: a queued entry drains and carries the held section"` and the view's `"autoSend off: held footer, held count in the guide, cleared on send"` still pass: they observe the state after the reply resolved.

- [ ] **Step 5: Update the spec and README**

`docs/superpowers/specs/2026-09-17-shell-mode-design.md`, `### submit(text)` section: replace

> After expansion, when `heldResults` is non-empty, append `formatShellSection` for each held result to the expanded prompt, blank-line separated, clear `heldResults`, and clear `held` on the matching entries. A `MentionError` leaves the held results untouched so they go with the corrected message.

with

> After expansion, when `heldResults` is non-empty, append `formatShellSection` for each held result to the expanded prompt, blank-line separated. `heldResults` and the `held` flags are cleared only when the reply arrives (before the queue drains), so a `MentionError`, a timeout, a fatal send error and a reset during the send all leave the results held for the next message. While the send is in flight the entry still shows the held footer.

Error table: change the `Send fails (timeout, fatal)` row to `| Send fails (timeout, fatal) | exactly as \`submit\`: timeout → \`idle\`, otherwise \`dead\`; held results that rode along stay held |`.

`README.md` held paragraph (line 157-160): after `and they are appended to the next message you send.` add `If that send fails (a timeout, a reopened browser) they stay held for the next try.`

- [ ] **Step 6: Check and commit**

Run: `bun run check`
Expected: PASS.

```bash
git add packages/cli/src/tui/chat-model.ts packages/cli/src/tui/chat-model.test.ts docs/superpowers/specs/2026-09-17-shell-mode-design.md README.md
git commit -m "fix(tui): release held shell results only when the reply arrives (Refs #47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 47 --body "Review fix 2/7 committed: held results survive a timeout, a fatal send error and a reset; released on the reply. What's next: mark the shell entry when the shell could not start (Task 3)."
```

---

### Task 3: Mark the entry when the shell could not start

**Finding:** `packages/cli/src/tui/chat-model.ts:238` — when `done` rejects (ENOENT / EACCES), the already-pushed `shell` entry keeps its zeroed placeholder, so it renders as a `$ cmd` block with no output and no footer, indistinguishable from a command that printed nothing. The cause sits only in the following error entry.

**Files:**
- Modify: `packages/cli/src/tui/chat-model.ts:31-41` (`Message`), `:231-247` (runShell catch)
- Modify: `packages/cli/src/tui/chat-view.ts:71-82` (`shellFooter`)
- Test: `packages/cli/src/tui/chat-model.test.ts` (`"a shell that cannot start is an error entry, not fatal"`), `packages/cli/src/tui/chat-view.test.ts` (`fakeRunner` gains `fail`)
- Docs: `docs/superpowers/specs/2026-09-17-shell-mode-design.md` (runShell step 7 ~line 229, `messageBox` paragraph ~286, error table row `Shell cannot start`)

**Interfaces:**
- Produces: `Message.failed?: boolean` — `shell` entries only; true when the shell could not be spawned. The view renders the footer `did not start`.

- [ ] **Step 1: Extend the failing model test**

In `packages/cli/src/tui/chat-model.test.ts`, test `"a shell that cannot start is an error entry, not fatal"`, add after the `roles` assertion:

```ts
    expect(model.messages[0]).toMatchObject({ role: "shell", failed: true });
```

Run: `bun test packages/cli/src/tui/chat-model.test.ts -t "cannot start"`
Expected: FAIL — `failed` is missing on the entry.

- [ ] **Step 2: Set the flag in the model**

In `packages/cli/src/tui/chat-model.ts`, extend `Message`:

```ts
  /** `shell` entries: the result is waiting for the next submit. */
  held?: boolean;
  /** `shell` entries: the shell could not be started; the error entry
   * pushed right after it says why. */
  failed?: boolean;
```

In `runShell`, the `catch` block becomes (only the first lines change):

```ts
    } catch (err) {
      if (this.running === running) this.running = undefined;
      // The entry belongs to the history, which survives a reset, so it is
      // marked even when the reset makes the rest stale.
      entry.failed = true;
      if (generation !== this.generation) return true; // stale: reset ran
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({
        role: "error",
        text: `could not start shell: ${message}`,
      });
```

Run: `bun test packages/cli/src/tui/chat-model.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing view test**

In `packages/cli/src/tui/chat-view.test.ts`, give the view's `fakeRunner` a `fail` method. Change the `done` promise and the returned object:

```ts
  let reject: ((e: unknown) => void) | undefined;
  …
    const done = new Promise<ShellResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  …
    fail(err: unknown) {
      reject?.(err);
    },
```

(add `let reject …` next to `let resolve …`; add `fail` after `finish` in the returned object.) Then append inside `describe("ChatView shell mode", …)`:

```ts
  test("a shell that cannot start is marked on its entry and explained after it", async () => {
    const runner = fakeRunner();
    const t = await setup({ runCommand: runner.runCommand });
    await t.mockInput.typeText("!ls");
    t.mockInput.pressEnter();
    await t.frameWith("Running…");
    runner.fail(new Error("spawn /no/sh ENOENT"));
    const frame = await t.frameWith("could not start shell: spawn /no/sh ENOENT");
    expect(frame).toContain("did not start");
    expect(t.model.status).toBe("idle");
  });
```

Run: `bun test packages/cli/src/tui/chat-view.test.ts -t "cannot start"`
Expected: FAIL — the frame contains the error entry but not `did not start`.

- [ ] **Step 4: Render the footer**

In `packages/cli/src/tui/chat-view.ts`, add a constant next to `HELD_FOOTER`:

```ts
const HELD_FOOTER = "📎 held, sent with your next message";
/** Footer of a shell entry whose shell could not be spawned. */
const FAILED_FOOTER = "did not start";
```

and in `shellFooter`, before the `if (message.held)` line:

```ts
  if (message.failed) parts.push(FAILED_FOOTER);
```

Run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the spec**

`docs/superpowers/specs/2026-09-17-shell-mode-design.md`:

1. runShell step 7 becomes: `7. A rejected \`done\` (the shell could not start) marks the entry \`failed\`, pushes an error entry \`could not start shell: <message>\` and returns to \`idle\`; not fatal.`
2. In the `messageBox` paragraph add `did not start` to the footer list: ``… `interrupted`, `… (truncated: first N KB dropped)`, `did not start` for a shell that could not be spawned, and `📎 held, …```.
3. Error table row: `| Shell cannot start | entry footer \`did not start\`; error entry \`could not start shell: <message>\`; back to \`idle\`; not fatal |`.
4. Near `Message` (line ~190, "`result?: ShellResult` … and `held?: boolean`") add `and \`failed?: boolean\` (the shell could not be spawned)`.

- [ ] **Step 6: Check and commit**

Run: `bun run check`
Expected: PASS.

```bash
git add packages/cli/src/tui/chat-model.ts packages/cli/src/tui/chat-model.test.ts packages/cli/src/tui/chat-view.ts packages/cli/src/tui/chat-view.test.ts docs/superpowers/specs/2026-09-17-shell-mode-design.md
git commit -m "fix(tui): mark a shell entry whose shell could not start (Refs #47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 47 --body "Review fix 3/7 committed: Message.failed and the \`did not start\` footer. What's next: a pinned-provider CLI ignores config.json's defaultProvider instead of validating it (Task 4)."
```

---

### Task 4: A pinned provider ignores `defaultProvider` instead of validating it

**Finding:** `packages/cli/src/create-cli.ts:242` — interactive mode now calls `loadConfig()` unconditionally (it needs the `shell` section), so a `defaultProvider` of the wrong type fails a pinned-provider CLI at startup with INVALID_CONFIG about a key the CLI documents as ignored, while `-p` on the same file works. Genuinely broken files (invalid JSON, unreadable) are still errors: the file is the user's and the `shell` section is read from it.

**Files:**
- Modify: `packages/cli/src/config.ts:38-68`
- Modify: `packages/cli/src/create-cli.ts:240-243`
- Test: `packages/cli/src/config.test.ts`, `packages/cli/src/create-cli.test.ts` (`describe("interactive mode gate", …)`)
- Docs: `README.md:72-76`

**Interfaces:**
- Produces: `export interface LoadConfigOptions { providerPinned?: boolean }` and `loadConfig(loc: ConfigLocation, opts?: LoadConfigOptions): Promise<CliConfig>`. With `providerPinned: true` the `defaultProvider` key is neither validated nor returned.

- [ ] **Step 1: Write the failing config test**

Append inside `describe("loadConfig", …)` in `packages/cli/src/config.test.ts`:

```ts
  test("providerPinned: defaultProvider is ignored even when invalid", async () => {
    writeFileSync(
      setup(),
      JSON.stringify({ defaultProvider: 5, shell: { autoSend: false } }),
    );
    const cfg = await loadConfig(
      { configDir: "test-cli", baseDir },
      { providerPinned: true },
    );
    expect(cfg).toEqual({ shell: { autoSend: false } });
  });
```

Run: `bun test packages/cli/src/config.test.ts -t "providerPinned"`
Expected: FAIL — throws `Invalid config …: "defaultProvider" must be a string`.

- [ ] **Step 2: Add the option to `loadConfig`**

In `packages/cli/src/config.ts`, add after `ConfigLocation`:

```ts
export interface LoadConfigOptions {
  /** The CLI ships a pinned provider: "defaultProvider" is documented as
   * ignored, so it is neither validated nor returned. */
  providerPinned?: boolean;
}
```

and change the function head and the `defaultProvider` branch:

```ts
/** Reads <base>/<configDir>/config.json. Missing file → {}. A file that
 * exists must be valid JSON with the documented shapes; every mode that
 * reads it fails the same way on a broken file. */
export async function loadConfig(
  loc: ConfigLocation,
  opts: LoadConfigOptions = {},
): Promise<CliConfig> {
  …
  if (defaultProvider !== undefined && !opts.providerPinned) {
    if (typeof defaultProvider !== "string") {
      throw invalid(file, '"defaultProvider" must be a string');
    }
    …
  }
```

Run: `bun test packages/cli/src/config.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing CLI tests**

Append inside `describe("interactive mode gate", …)` in `packages/cli/src/create-cli.test.ts`, after `"a pinned-provider CLI still reads config.json's shell section"`:

```ts
  test("a pinned-provider CLI ignores config.json's defaultProvider, valid or not", async () => {
    captureStderr();
    const dir = setup();
    mkdirSync(join(dir, "test-cli"), { recursive: true });
    writeFileSync(
      join(dir, "test-cli", "config.json"),
      JSON.stringify({ defaultProvider: 5 }),
    );
    const cli = createCli({
      name: "test-cli",
      provider: stubProvider(),
      baseDir: dir,
      isTerminal: true,
    });
    // Past the config stage: the next gate is the missing auth state.
    expect(await cli.run(["bun", "cli"])).toBe(2);
    expect(stderrChunks.join("")).toContain("auth login");
  });

  test("a pinned-provider CLI still rejects a config.json that is not JSON", async () => {
    captureStderr();
    const dir = setup();
    mkdirSync(join(dir, "test-cli"), { recursive: true });
    writeFileSync(join(dir, "test-cli", "config.json"), "{ nope");
    const cli = createCli({
      name: "test-cli",
      provider: stubProvider(),
      baseDir: dir,
      isTerminal: true,
    });
    expect(await cli.run(["bun", "cli"])).toBe(1);
    expect(stderrChunks.join("")).toContain("not valid JSON");
  });
```

Run: `bun test packages/cli/src/create-cli.test.ts -t "pinned-provider CLI"`
Expected: the `ignores … defaultProvider` test FAILS with exit 1 (`"defaultProvider" must be a string`); the other two pass.

- [ ] **Step 4: Pass the option from the interactive path**

In `packages/cli/src/create-cli.ts`, the interactive branch:

```ts
        // Read even with a pinned provider: the shell section is the
        // user's to override regardless of who ships the CLI. The provider
        // key is that CLI's own business, so it is not validated then.
        const config = await loadConfig(location, {
          providerPinned: opts.provider !== undefined,
        });
```

Run: `bun test packages/cli/src/create-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Document it in the README**

`README.md`, after the paragraph ending `Both override the defaults a derived CLI ships.` (line ~76), add:

> Interactive mode reads `config.json` even when the CLI ships its own provider (the `shell` section still applies), so a file that is not valid JSON stops it at startup with exit 1. A derived CLI ignores `defaultProvider` entirely; one-shot mode (`-p`) and `auth` never read the file when the provider is pinned.

- [ ] **Step 6: Check and commit**

Run: `bun run check`
Expected: PASS.

```bash
git add packages/cli/src/config.ts packages/cli/src/config.test.ts packages/cli/src/create-cli.ts packages/cli/src/create-cli.test.ts README.md
git commit -m "fix(cli): a pinned provider does not validate config.json's defaultProvider (Refs #47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 47 --body "Review fix 4/7 committed: loadConfig({ providerPinned }) skips defaultProvider for a pinned-provider CLI; broken JSON is still an error. What's next: banner hint on its own line (Task 5)."
```

---

### Task 5: Banner hint on its own line

**Finding:** `packages/cli/src/tui/banner.ts:13` — `Connected to ` (13) + name + `. ` (2) + hint (55) is 80 cells only for a 10-character name; banner lines use `wrapMode: "none"`, so a longer vendor provider name clips the new `! to run a command.` on an 80-column terminal.

**Files:**
- Modify: `packages/cli/src/tui/banner.ts:12-31`
- Test: `packages/cli/src/tui/banner.test.ts`, `packages/cli/src/tui/chat-view.test.ts:562-578` (`"the banner is centred in the empty history"`)
- Docs: `docs/superpowers/specs/2026-09-17-shell-mode-design.md` (`### Banner`, ~line 311-314)

**Interfaces:**
- Produces: `resolveBanner` returns three lines for the default banner: title, `Connected to <provider>.`, `BANNER_HINT`. `BANNER_HINT` is unchanged. `run-interactive.test.ts` only asserts `Connected to fake.` and keeps passing.

- [ ] **Step 1: Update the banner tests**

In `packages/cli/src/tui/banner.test.ts`, the first test becomes:

```ts
  test("default banner: bold name, muted version, muted connection line and hint", () => {
    const lines = resolveBanner({
      name: "chatbridge",
      version: "0.3.0",
      providerName: "dummy-chat",
    });
    expect(text(lines)).toEqual([
      "chatbridge v0.3.0",
      "Connected to dummy-chat.",
      "Type a message, @ to attach a file, ! to run a command.",
    ]);
    const [title, connected, hint] = lines;
    expect(title?.chunks[0]?.attributes).toBe(TextAttributes.BOLD);
    expect(title?.chunks[1]?.attributes).toBe(TextAttributes.DIM);
    expect(connected?.chunks[0]?.attributes).toBe(TextAttributes.DIM);
    expect(hint?.chunks[0]?.attributes).toBe(TextAttributes.DIM);
  });
```

and add after it:

```ts
  test("a long provider name never pushes the hint past 80 cells", () => {
    const lines = text(
      resolveBanner({ name: "acme", providerName: "a".repeat(40) }),
    );
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(lines[2]).toBe(
      "Type a message, @ to attach a file, ! to run a command.",
    );
  });
```

In `packages/cli/src/tui/chat-view.test.ts`, test `"the banner is centred in the empty history"`, replace the `rows[title + 1]` assertion with:

```ts
    expect(rows[title + 1]).toContain("Connected to dummy-chat.");
    expect(rows[title + 2]).toContain(
      "Type a message, @ to attach a file, ! to run a command.",
    );
```

(The vertical-centring assertion tolerates ±2 rows and still holds with three banner rows; if it does not on the 20-row test renderer, widen the tolerance to 3 and say so in the commit body.)

Run: `bun test packages/cli/src/tui/banner.test.ts packages/cli/src/tui/chat-view.test.ts -t "banner"`
Expected: FAIL — the second line still contains the hint.

- [ ] **Step 2: Split the line**

`packages/cli/src/tui/banner.ts`:

```ts
/** The one-line hint under the connection line: 55 cells, so it always
 * fits an 80-column terminal on its own. */
export const BANNER_HINT =
  "Type a message, @ to attach a file, ! to run a command.";

/** Lines shown centred in the empty history until the first message.
 * A vendor banner is passed through verbatim (all muted); the default is
 * the CLI name (bold), its version (muted), the provider it is connected
 * to, and a one-line hint. */
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
    // Banner lines do not wrap and the provider name has no length budget,
    // so the fixed-width hint gets its own line.
    styled(theme.muted(`Connected to ${input.providerName}.`)),
    styled(theme.muted(BANNER_HINT)),
  ];
}
```

Run: `bun test packages/cli/src/tui/banner.test.ts packages/cli/src/tui/chat-view.test.ts packages/cli/src/tui/run-interactive.test.ts`
Expected: PASS.

- [ ] **Step 3: Update the spec**

`docs/superpowers/specs/2026-09-17-shell-mode-design.md`, `### Banner`:

> `BANNER_HINT` becomes `Type a message, @ to attach a file, ! to run a command.` and moves to its own line under `Connected to <provider>.`: banner lines do not wrap and the provider name has no length budget, so the hint (55 cells) must not share a line with it.

- [ ] **Step 4: Check and commit**

Run: `bun run check`
Expected: PASS.

```bash
git add packages/cli/src/tui/banner.ts packages/cli/src/tui/banner.test.ts packages/cli/src/tui/chat-view.test.ts docs/superpowers/specs/2026-09-17-shell-mode-design.md
git commit -m "fix(tui): put the banner hint on its own line so long provider names do not clip it (Refs #47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 47 --body "Review fix 5/7 committed: default banner is three lines; the hint no longer shares a line with the provider name. What's next: chunk-list output buffer in the runner (Task 6)."
```

---

### Task 6: Chunk list instead of a re-concatenated buffer

**Finding:** `packages/cli/src/shell/run-command.ts:174` — `buf = Buffer.concat([buf, chunk])` copies the whole accumulated buffer on every chunk (O(n²) in bytes received), and after the cap trips the command keeps writing for up to 2.5 s of grace, paying a full-cap copy per chunk on the TUI's main thread.

**Files:**
- Modify: `packages/cli/src/shell/run-command.ts:63-77` (state, `text`), `:173-186` (`onData`)
- Test: `packages/cli/src/shell/run-command.test.ts`

**Interfaces:**
- Consumes: `ShellResult` with `signal` from Task 1 (no change to it).
- Produces: identical observable behaviour: `output` is the UTF-8 decode of the kept bytes, `droppedBytes` counts what the cap removed, the cap still calls `stop()`.

- [ ] **Step 1: Write the failing trim tests**

Append inside `describe("runCommand", …)`:

```ts
  test("a single chunk larger than the cap keeps only its tail", async () => {
    const r = await runCommand(
      "printf '%s' abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      { cwd: process.cwd(), shell: SH, maxBytes: 32 },
    ).done;
    expect(r.output).toBe("456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(r.droppedBytes).toBe(30);
    expect(r.interrupted).toBe(true);
  });

  test("the cap trims across chunk boundaries", async () => {
    // Three separate writes: the cap drops the first chunk whole and the
    // head of the second.
    const r = await runCommand(
      "printf a; sleep 0.15; printf bcd; sleep 0.15; printf efgh",
      { cwd: process.cwd(), shell: SH, maxBytes: 5 },
    ).done;
    expect(r.output).toBe("defgh");
    expect(r.droppedBytes).toBe(3);
    expect(r.interrupted).toBe(true);
  });
```

Run: `bun test packages/cli/src/shell/run-command.test.ts -t "cap"`
Expected: both PASS already against the current implementation (they pin behaviour before the rewrite). Keep going.

- [ ] **Step 2: Rewrite the buffer as a chunk list**

In `packages/cli/src/shell/run-command.ts`, replace the state and `text`:

```ts
  const maxBytes = opts.maxBytes ?? MAX_OUTPUT_BYTES;
  const startedAt = Date.now();
  /** Output so far, in arrival order; joined only when read, so a chunk
   * costs one push rather than a copy of everything before it. */
  const chunks: Buffer[] = [];
  /** Total bytes in `chunks`. */
  let size = 0;
  let dropped = 0;
  …
  const text = () => Buffer.concat(chunks, size).toString("utf8");
```

and `onData`:

```ts
      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size > maxBytes) {
          // Drop from the head until the cap holds. The cap bounds the
          // bytes kept, not the length of the decoded string, and the cut
          // can split a multi-byte character.
          let excess = size - maxBytes;
          dropped += excess;
          size = maxBytes;
          while (excess > 0) {
            const head = chunks[0];
            if (head === undefined) break;
            if (head.length <= excess) {
              chunks.shift();
              excess -= head.length;
            } else {
              chunks[0] = head.subarray(excess);
              excess = 0;
            }
          }
          stop();
        }
        unnotified = true;
        if (notifyTimer === undefined) {
          notifyTimer = setTimeout(flush, OUTPUT_THROTTLE_MS);
        }
      };
```

Remove the old `let buf = Buffer.alloc(0);` line.

- [ ] **Step 3: Run the runner tests**

Run: `bun test packages/cli/src/shell/run-command.test.ts`
Expected: PASS — including `"the cap kills the command and keeps the tail"`, `"a command that exits on its own while being stopped reports no exit code"` and the two new trim tests.

- [ ] **Step 4: Check and commit**

Run: `bun run check`
Expected: PASS.

```bash
git add packages/cli/src/shell/run-command.ts packages/cli/src/shell/run-command.test.ts
git commit -m "perf(cli): keep shell output as a chunk list instead of re-concatenating per chunk (Refs #47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 47 --body "Review fix 6/7 committed: runner output is a chunk list joined on read; cap trimming pinned by two tests. What's next: docs — plan lead-in in English, provider-repo skill lists the shell knob (Task 7)."
```

---

### Task 7: Documentation — English lead-in in the plan, `shell` in the provider-repo skill

**Findings:**
- `docs/superpowers/plans/2026-09-17-shell-mode.md:2894` carries a Japanese lead-in string; the repo language policy requires English in every pushed document.
- `.claude/skills/creating-provider-repo/SKILL.md:77` says `version` and `banner` are the only vendor-facing TUI knobs and its `bin.ts` template omits `shell`, contradicting `createCli({ shell })`.

**Files:**
- Modify: `docs/superpowers/plans/2026-09-17-shell-mode.md:2894`
- Modify: `.claude/skills/creating-provider-repo/SKILL.md` (file listing line for `src/bin.ts`, the `bin.ts` template, the "only vendor-facing TUI knobs" sentence)

- [ ] **Step 1: Replace the Japanese string**

In `docs/superpowers/plans/2026-09-17-shell-mode.md` line 2894, replace

```ts
  shell: { leadIn: "実行結果を確認してください。" }, // optional: default lead-in for ! shell mode
```

with the string the shipped README uses:

```ts
  shell: { leadIn: "Here is the output of a command I ran:" }, // optional: default lead-in for ! shell mode
```

Verify: `grep -nP '[\x{3040}-\x{30ff}\x{4e00}-\x{9fff}]' docs/superpowers/plans/2026-09-17-shell-mode.md` prints nothing.

- [ ] **Step 2: Add `shell` to the provider-repo skill**

In `.claude/skills/creating-provider-repo/SKILL.md`:

1. File listing: `src/bin.ts            process.exitCode = await createCli({ name, version, provider, banner?, shell? }).run(process.argv) — see Derived CLI identity`
2. In the `bin.ts` template, after the `banner: [...]` line and before `}).run(process.argv);`, add:
   ```ts
     // Optional `{ leadIn?: string; autoSend?: boolean }`: vendor defaults for
     // `!` shell mode in the interactive TUI. `leadIn` is the first line of
     // the message sent with a command's output (default "Please check the
     // execution result."); `autoSend: false` holds the output back until the
     // user's next message. The user's config.json overrides each key.
     shell: { leadIn: "Here is the output of a command I ran:" },
   ```
3. Replace the sentence `` `version` and `banner` are the only vendor-facing TUI knobs; colours and layout are fixed by the framework.`` with `` `version`, `banner` and `shell` are the only vendor-facing TUI knobs (`shell` needs the `@chatbridge/cli` release that ships milestone 10, the first after 0.6.0); colours and layout are fixed by the framework.``

- [ ] **Step 3: Check and commit**

Run: `bun run check`
Expected: PASS (no code changed; confirms the tree is still green).

```bash
git add docs/superpowers/plans/2026-09-17-shell-mode.md .claude/skills/creating-provider-repo/SKILL.md
git commit -m "docs: English lead-in in the shell-mode plan; provider-repo skill lists the shell knob (Refs #47)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 47 --body "Review fix 7/7 committed: plan doc is English-only again; creating-provider-repo documents createCli({ shell }). What's next: push issue-47, whole-branch review of the seven fixes, then merge PR #50."
```

---

### Task 8: Push and whole-branch review

- [ ] **Step 1: Push**

```bash
git push origin issue-47
```

- [ ] **Step 2: Whole-branch review (Fable)**

Dispatch the final review over `git diff origin/main...issue-47` restricted to the seven commits above, checking each finding is closed by a test, no Japanese remains in tracked docs (`git grep -nP '[\x{3040}-\x{30ff}\x{4e00}-\x{9fff}]' -- docs README.md packages .claude/skills/creating-provider-repo`), and `bun run check` is green.

- [ ] **Step 3: Sync the issue**

```bash
gh issue comment 47 --body "All seven review fixes for PR #50 are pushed and reviewed. What's next: merge PR #50."
```

## Self-review

- **Coverage:** finding 1 → Task 1; 2 → Task 2; 3 → Task 3; 4 → Task 4; 5 → Task 5; 6 → Task 6; 7 and 8 → Task 7. No finding without a task.
- **Placeholders:** every code step carries the code; every doc step carries the exact replacement text.
- **Type consistency:** `ShellResult.signal?: NodeJS.Signals` (Task 1) is what Task 1's format/view code and Task 6's unchanged `settle` use; `Message.failed?: boolean` (Task 3) is what `shellFooter` reads; `sendPrompt(prompt, releasesHeld)` / `releaseHeld()` (Task 2) are private to `ChatModel`; `LoadConfigOptions.providerPinned` (Task 4) is what `create-cli.ts` passes.
