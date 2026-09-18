# VSCode Parity (milestone 12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the VSCode sidebar the TUI's message queue and Ctrl+R reopen, add `/login /logout /new /reopen /help` slash commands to both UIs (with the TUI starting before the browser opens), and let the webview take dropped files and pasted editor selections as attachment chips.

**Architecture:** The slash-command table and parser live in `@chatbridge/core` (`slash-commands.ts`, also exported as the subpath `@chatbridge/core/slash-commands` so the browser-side webview bundle can import it without pulling in Playwright). `SessionController` (vscode, no `vscode` import) gains a queue, a generation counter and `reopen()`, mirroring `ChatModel`. `ChatModel` (cli) stops taking a session in its constructor: it opens eagerly with a new `opening` status, and learns slash commands plus a `logging-in` status driven by an injected `login` function. Drop/paste are two new webview→host messages resolved in `commands.ts` against the existing `VscodeUi` slice.

**Tech Stack:** TypeScript, Bun (`bun test`), Playwright, esbuild (webview IIFE bundle), `@types/vscode`, `@vscode/test-electron`, OpenTUI, Biome.

**Spec:** `docs/superpowers/specs/2026-09-18-vscode-parity-design.md`

## Global Constraints

- Branch `issue-64`; every commit message ends with `(Refs #64)` and the trailers `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01XkTHKt1JRH3rdns86gRiuc`.
- `bun run check` (Biome + `tsc --build` + `bun test`) must pass before every commit. Tests import cross-package code from `dist`, so run `bun run build` after editing another package.
- After every commit: `gh issue comment 64 --body "<what was committed> + What's next: <next task>"` (English).
- Dependency direction: `vscode → core → runtime → provider`, `cli → core`. Never import in reverse. Only `create-extension.ts`, `vscode-ui.ts`, `chat-view-provider.ts` import `vscode`.
- The webview bundle (`packages/vscode/src/webview/main.ts`) runs in a browser: it may import only `../protocol.js` types and `@chatbridge/core/slash-commands`; never `@chatbridge/core` itself.
- Every document, comment and commit message is in English.
- Exact strings: separators `reopened`, `new chat` (TUI `/new`), `New chat` (VSCode newChat), `Logged in`, `Logged out`, `Login cancelled`; unknown command error `Unknown command: /<word>. Type /help.`; TUI auth hint `Type /login to log in.`; TUI browser-missing hint `Run: npx playwright install chromium`; newChat-busy warning `Wait for the current reply to finish, or press Ctrl+R to reopen.`; webview statuses `Opening browser...`, `Reopening browser...`, `Waiting...`, TUI login status `Log in in the browser window… (Ctrl+C cancel)`; paste round-trip timeout `500` ms; close timeout `5_000` ms.
- Version stays `0.8.x` (next tag is a patch); do not bump package versions in this plan.
- Model policy: Task 1 → Sonnet; Tasks 2–8 → Opus; Task 9 → Sonnet. Reviews of Opus tasks → Opus.

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/core/src/slash-commands.ts` (new) | `SLASH_COMMANDS`, `parseSlashCommand`, `helpText` | 1 |
| `packages/core/src/slash-commands.test.ts` (new) | parser tests | 1 |
| `packages/core/src/index.ts`, `packages/core/package.json` | re-export + `./slash-commands` subpath | 1 |
| `packages/vscode/src/protocol.ts` | `QueueEntry`, `State.queue`, `reopening`, new messages | 2, 5 |
| `packages/vscode/src/session-controller.ts` | queue, generation, `reopen`, `takeBack`, `removeQueued` | 2 |
| `packages/vscode/src/session-controller.test.ts` | queue / reopen tests | 2 |
| `packages/vscode/src/chat-view-bridge.ts` | route `takeBack`, `removeQueued`, `reopen`, `attachUris`, `pasted` | 3, 5 |
| `packages/vscode/src/commands.ts` | `reopen`, newChat warning, `attachUris`, `pasted` | 3, 5 |
| `packages/vscode/src/manifest.ts` | eight commands | 3 |
| `packages/vscode/src/create-extension.ts` | wire new handlers, `handlers` on `ExtensionApi` | 3, 5 |
| `packages/vscode/src/webview/main.ts`, `style.css`, `webview-html.ts` | queue list, take back, Reopen, Ctrl+R, slash, drop, paste | 4, 6 |
| `packages/vscode/README.md`, `examples/vscode-dummy-chat/package.json` | reopen command + keybinding | 3 |
| `packages/cli/src/tui/chat-model.ts` | eager open, `opening`, slash commands, `logging-in` | 7 |
| `packages/cli/src/tui/chat-model.test.ts`, `chat-view.test.ts`, `run-interactive.test.ts` | constructor change, new tests | 7, 8 |
| `packages/cli/src/tui/chat-view.ts`, `run-interactive.ts` | statuses, Ctrl+C cancels login, open after UI | 8 |
| `examples/vscode-dummy-chat/test/suite.ts`, `docs/ROADMAP.md` | E2E, roadmap | 9 |

---

### Task 1: slash-command table in core

**Files:**
- Create: `packages/core/src/slash-commands.ts`, `packages/core/src/slash-commands.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/package.json`

**Interfaces:**
- Produces: `SLASH_COMMANDS`, `type SlashCommand = "login" | "logout" | "new" | "reopen" | "help"`, `parseSlashCommand(text): { command: SlashCommand } | { unknown: string } | undefined`, `helpText(): string`, `unknownCommandMessage(word: string): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/slash-commands.test.ts
import { describe, expect, test } from "bun:test";
import {
  SLASH_COMMANDS,
  helpText,
  parseSlashCommand,
  unknownCommandMessage,
} from "./slash-commands.js";

describe("parseSlashCommand", () => {
  test("bare command, with surrounding whitespace", () => {
    expect(parseSlashCommand("/login")).toEqual({ command: "login" });
    expect(parseSlashCommand("  /help \n")).toEqual({ command: "help" });
  });
  test("every table entry parses", () => {
    for (const c of SLASH_COMMANDS) {
      expect(parseSlashCommand(`/${c.name}`)).toEqual({ command: c.name });
    }
  });
  test("unknown word", () => {
    expect(parseSlashCommand("/frobnicate")).toEqual({ unknown: "frobnicate" });
  });
  test("not a command: arguments, extra lines, plain text, lone slash", () => {
    expect(parseSlashCommand("/login now")).toBeUndefined();
    expect(parseSlashCommand("/login\nmore")).toBeUndefined();
    expect(parseSlashCommand("login")).toBeUndefined();
    expect(parseSlashCommand("/")).toBeUndefined();
    expect(parseSlashCommand("/usr/bin/env")).toBeUndefined();
  });
});

test("helpText lists every command with its description", () => {
  const text = helpText();
  for (const c of SLASH_COMMANDS) {
    expect(text).toContain(`/${c.name}`);
    expect(text).toContain(c.description);
  }
});

test("unknownCommandMessage", () => {
  expect(unknownCommandMessage("x")).toBe("Unknown command: /x. Type /help.");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/core/src/slash-commands.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/slash-commands.ts
/** Commands typed as `/name` on their own in either UI. The table is the
 * single source for the TUI, the webview and `/help`. No UI dependency. */
export const SLASH_COMMANDS = [
  { name: "login", description: "Log in in a browser window" },
  { name: "logout", description: "Delete the saved login and close the chat" },
  { name: "new", description: "Start a new chat" },
  { name: "reopen", description: "Reopen the browser (also Ctrl+R)" },
  { name: "help", description: "List these commands" },
] as const;

export type SlashCommand = (typeof SLASH_COMMANDS)[number]["name"];

const NAMES: ReadonlySet<string> = new Set(SLASH_COMMANDS.map((c) => c.name));
/** `/word` alone on one line; `word` is letters only so paths like
 * `/usr/bin` never match. */
const PATTERN = /^\/([a-z]+)$/;

/** The bare form only: `/login` (surrounding whitespace allowed) is a
 * command; `/login now`, a second line, or a path is an ordinary message. */
export function parseSlashCommand(
  text: string,
): { command: SlashCommand } | { unknown: string } | undefined {
  const m = PATTERN.exec(text.trim());
  if (!m || m[1] === undefined) return undefined;
  const word = m[1];
  return NAMES.has(word)
    ? { command: word as SlashCommand }
    : { unknown: word };
}

export function unknownCommandMessage(word: string): string {
  return `Unknown command: /${word}. Type /help.`;
}

/** One line per command, aligned, for the history. */
export function helpText(): string {
  const width = Math.max(...SLASH_COMMANDS.map((c) => c.name.length)) + 1;
  return SLASH_COMMANDS.map(
    (c) => `/${c.name.padEnd(width)} ${c.description}`,
  ).join("\n");
}
```

Add to `packages/core/src/index.ts`:

```ts
export {
  SLASH_COMMANDS,
  type SlashCommand,
  helpText,
  parseSlashCommand,
  unknownCommandMessage,
} from "./slash-commands.js";
```

Add the subpath to `packages/core/package.json` `exports`:

```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./slash-commands": {
    "types": "./dist/slash-commands.d.ts",
    "default": "./dist/slash-commands.js"
  }
},
```

- [ ] **Step 4: Run tests and check**

Run: `bun test packages/core/src/slash-commands.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit and sync**

```bash
git add packages/core
git commit -m "feat(core): slash-command table and parser (Refs #64)"
gh issue comment 64 --body "Added core slash-commands table/parser with the ./slash-commands subpath export. What's next: Task 2, queue + reopen in SessionController."
```

---

### Task 2: queue, generation and reopen in `SessionController`

**Files:**
- Modify: `packages/vscode/src/protocol.ts`, `packages/vscode/src/session-controller.ts`, `packages/vscode/src/session-controller.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (on `SessionController`): `send(text): Promise<SendResult>` where `SendResult = { ok: true; queued?: true } | { ok: false; code; message }`; `takeBack(): QueueEntry[]`; `removeQueued(index: number): void`; `reopen(): Promise<void>`; `State.queue: QueueEntry[]`; `Status` gains `"reopening"`; exported `REOPENED_SEPARATOR = "reopened"`.

- [ ] **Step 1: Protocol types**

In `packages/vscode/src/protocol.ts` replace `Status` and `State`, add `QueueEntry`:

```ts
/** closed: no browser. opening: ChatSession.open in flight. idle: ready.
 * busy: a turn is in flight. reopening: Ctrl+R is replacing the browser.
 * dead: fatal error; New chat, Log in or Reopen recover. */
export type Status =
  | "closed"
  | "opening"
  | "idle"
  | "busy"
  | "reopening"
  | "dead";

/** A message waiting for its turn: sent while the controller was not idle. */
export interface QueueEntry {
  text: string;
  attachments: Attachment[];
}

export interface State {
  status: Status;
  messages: Message[];
  pendingAttachments: Attachment[];
  /** Oldest first; drained one entry per turn end. */
  queue: QueueEntry[];
  /** `ChatBridgeError.code` of the error that made the status `dead`. */
  lastError?: string;
}
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/vscode/src/session-controller.test.ts` (reuse the file's `harness()` and `deferred()`; `h.replies[i].resolve(...)` answers the i-th send; `states` records statuses via `onChange`):

```ts
describe("queue", () => {
  test("send while busy queues and drains in order after the reply", async () => {
    const h = harness();
    const first = h.controller.send("one");
    await tick();
    expect(h.controller.getState().status).toBe("busy");
    expect(await h.controller.send("two")).toEqual({ ok: true, queued: true });
    expect(await h.controller.send("three")).toEqual({ ok: true, queued: true });
    expect(h.controller.getState().queue.map((e) => e.text)).toEqual(["two", "three"]);
    h.replies[0]?.resolve("r1");
    expect(await first).toEqual({ ok: true });
    await tick();
    // The next turn was claimed before the idle frame.
    expect(h.controller.getState().status).toBe("busy");
    expect(h.controller.getState().queue.map((e) => e.text)).toEqual(["three"]);
    expect(h.sent).toEqual(["one", "two"]);
    h.replies[1]?.resolve("r2");
    await tick();
    h.replies[2]?.resolve("r3");
    await tick();
    expect(h.sent).toEqual(["one", "two", "three"]);
    expect(h.controller.getState().status).toBe("idle");
    expect(h.controller.getState().queue).toEqual([]);
  });

  test("a queued entry carries the pending attachments", async () => {
    const h = harness();
    const first = h.controller.send("one");
    await tick();
    h.controller.addAttachment({ path: "a.ts", bytes: 3, content: "abc" });
    await h.controller.send("two");
    const s = h.controller.getState();
    expect(s.pendingAttachments).toEqual([]);
    expect(s.queue[0]?.attachments).toEqual([{ path: "a.ts", bytes: 3 }]);
    h.replies[0]?.resolve("r1");
    await first;
    await tick();
    expect(h.sent[1]).toContain("abc");
    const user = h.controller.getState().messages.find((m) => m.text === "two");
    expect(user?.attachments).toEqual([{ path: "a.ts", bytes: 3 }]);
  });

  test("blank text with no attachments is EMPTY even while busy", async () => {
    const h = harness();
    void h.controller.send("one");
    await tick();
    expect((await h.controller.send("  ")).ok).toBe(false);
    expect(h.controller.getState().queue).toEqual([]);
  });

  test("a fatal error stops draining; the queue survives newChat and drains after it", async () => {
    const h = harness();
    const first = h.controller.send("one");
    await tick();
    await h.controller.send("two");
    h.replies[0]?.reject(new Error("page closed"));
    await first;
    expect(h.controller.getState().status).toBe("dead");
    expect(h.controller.getState().queue.map((e) => e.text)).toEqual(["two"]);
    expect(h.sent).toEqual(["one"]);
    await h.controller.newChat();
    await tick();
    expect(h.sent).toEqual(["one", "two"]);
  });

  test("takeBack returns the entries with attachments restored as pending", async () => {
    const h = harness();
    void h.controller.send("one");
    await tick();
    h.controller.addAttachment({ path: "a.ts", bytes: 3, content: "abc" });
    await h.controller.send("two");
    await h.controller.send("three");
    const entries = h.controller.takeBack();
    expect(entries.map((e) => e.text)).toEqual(["two", "three"]);
    const s = h.controller.getState();
    expect(s.queue).toEqual([]);
    expect(s.pendingAttachments).toEqual([{ path: "a.ts", bytes: 3 }]);
    expect(h.controller.takeBack()).toEqual([]);
  });

  test("removeQueued drops one entry and ignores bad indexes", async () => {
    const h = harness();
    void h.controller.send("one");
    await tick();
    await h.controller.send("two");
    await h.controller.send("three");
    h.controller.removeQueued(5);
    h.controller.removeQueued(0);
    expect(h.controller.getState().queue.map((e) => e.text)).toEqual(["three"]);
  });
});

describe("reopen", () => {
  test("mid-turn: the old result is dropped, history marked, queue drained", async () => {
    const h = harness();
    const first = h.controller.send("one");
    await tick();
    await h.controller.send("two");
    const reopen = h.controller.reopen();
    expect(h.controller.getState().status).toBe("reopening");
    await reopen;
    // The abandoned send settles late; nothing from it is recorded.
    h.replies[0]?.resolve("stale");
    expect(await first).toEqual({ ok: true });
    await tick();
    const s = h.controller.getState();
    expect(s.messages.some((m) => m.text === "stale")).toBe(false);
    expect(s.messages.some((m) => m.role === "separator" && m.text === "reopened")).toBe(true);
    expect(h.opens).toBe(2);
    expect(h.killed + h.closed).toBeGreaterThan(0);
    expect(h.sent).toEqual(["one", "two"]);
    expect(s.status).toBe("busy");
  });

  test("from dead: clears lastError and drops the error banner state", async () => {
    const h = harness();
    const first = h.controller.send("one");
    await tick();
    h.replies[0]?.reject(new Error("page closed"));
    await first;
    expect(h.controller.getState().lastError).toBe("UNKNOWN");
    await h.controller.reopen();
    const s = h.controller.getState();
    expect(s.status).toBe("idle");
    expect(s.lastError).toBeUndefined();
  });

  test("failure: error entry, dead, queue kept", async () => {
    const h = harness();
    void h.controller.send("one");
    await tick();
    await h.controller.send("two");
    h.openError = new Error("launch failed");
    await h.controller.reopen();
    const s = h.controller.getState();
    expect(s.status).toBe("dead");
    expect(s.messages.at(-1)).toEqual({ role: "error", text: "launch failed" });
    expect(s.queue.map((e) => e.text)).toEqual(["two"]);
  });

  test("a second reopen while one runs is ignored", async () => {
    const h = harness();
    const a = h.controller.reopen();
    const b = h.controller.reopen();
    await Promise.all([a, b]);
    expect(h.opens).toBe(1);
  });
});
```

Add near the top of the test file if missing:

```ts
function tick() {
  return new Promise<void>((r) => setTimeout(r, 0));
}
```

Check the harness: `openSession` must honour `h.openError` (throw it when set) and count `h.opens`. If it does not, extend the harness accordingly.

- [ ] **Step 3: Run to verify they fail**

Run: `bun test packages/vscode/src/session-controller.test.ts`
Expected: FAIL (`queued`, `takeBack`, `reopen` missing).

- [ ] **Step 4: Implement**

Rewrite `packages/vscode/src/session-controller.ts` around these changes (keep everything not mentioned):

```ts
import type { Message, QueueEntry, State, Status } from "./protocol.js";

export type SendResult =
  | { ok: true; queued?: true }
  | { ok: false; code: string; message: string };

export const REOPENED_SEPARATOR = "reopened";

/** Controller-internal queue entry: the attachments keep their content. */
interface QueuedTurn {
  text: string;
  attachments: PendingAttachment[];
}

export class SessionController {
  // ...existing fields...
  private queue: QueuedTurn[] = [];
  /** Bumped by every reopen; a send from an older generation is stale. */
  private generation = 0;
  private reopening: Promise<void> | undefined;

  getState(): State {
    const state: State = {
      status: this.status,
      messages: /* unchanged */,
      pendingAttachments: /* unchanged */,
      queue: this.queue.map((q) => ({
        text: q.text,
        attachments: q.attachments.map(({ path, bytes }) => ({ path, bytes })),
      })),
    };
    if (this.lastError !== undefined) state.lastError = this.lastError;
    return state;
  }

  private get idle(): boolean {
    return this.status === "idle" || this.status === "closed";
  }

  async send(text: string): Promise<SendResult> {
    const body = text.trim() === "" ? "" : text;
    if (body === "" && this.pending.length === 0) return EMPTY;
    const attachments = this.pending;
    this.pending = [];
    if (!this.idle) {
      this.queue.push({ text: body, attachments });
      this.emit();
      return { ok: true, queued: true };
    }
    return this.startTurn({ text: body, attachments });
  }

  /** Pushes the user entry and runs the turn. Shared by send and drain. */
  private startTurn(turn: QueuedTurn): Promise<SendResult> {
    const sections = turn.attachments.map((a) => formatAttachment(a.path, a.content));
    const prompt = [turn.text, ...sections].filter((s) => s !== "").join("\n\n");
    this.push({
      role: "user",
      text: turn.text,
      attachments: turn.attachments.map(({ path, bytes }) => ({ path, bytes })),
    });
    this.lastPrompt = prompt;
    return this.runTurn(prompt);
  }

  /** Sends the oldest queued entry, if any. Called at every transition to
   * idle; claims the turn before the caller emits. */
  private drain(): void {
    const next = this.queue.shift();
    if (next === undefined) return;
    void this.startTurn(next);
  }

  takeBack(): QueueEntry[] {
    if (this.queue.length === 0) return [];
    const entries = this.queue.splice(0);
    for (const e of entries) this.pending.push(...e.attachments);
    this.emit();
    return entries.map((e) => ({
      text: e.text,
      attachments: e.attachments.map(({ path, bytes }) => ({ path, bytes })),
    }));
  }

  removeQueued(index: number): void {
    if (index < 0 || index >= this.queue.length) return;
    this.queue.splice(index, 1);
    this.emit();
  }

  private async runTurn(prompt: string): Promise<SendResult> {
    this.lastError = undefined;
    const generation = this.generation;
    try {
      if (this.session === undefined) {
        this.setStatus("opening");
        const session = await this.opts.openSession();
        if (generation !== this.generation) {
          await closeOrKill(session, this.closeTimeoutMs);
          return { ok: true };
        }
        this.session = session;
      }
      this.setStatus("busy");
      const reply = await this.session.send(prompt);
      if (generation !== this.generation) return { ok: true }; // stale: reopen ran
      this.messages.push({ role: "assistant", text: reply });
      this.status = "idle";
      this.drain();
      this.emit();
      return { ok: true };
    } catch (err) {
      if (generation !== this.generation) return { ok: true }; // stale
      return this.fail(err);
    }
  }

  private async fail(err: unknown): Promise<SendResult> {
    // ...unchanged up to the RESPONSE_TIMEOUT branch...
    if (code === "RESPONSE_TIMEOUT") {
      this.status = "idle";
      this.drain();
      this.emit();
    } else {
      this.lastError = code;
      await this.dropSession();
      this.setStatus("dead");
    }
    return { ok: false, code, message };
  }

  /** Ctrl+R: replaces the browser in every state. The in-flight turn, if
   * any, is abandoned (its result is dropped by the generation check).
   * Ignored while a reopen is already running. */
  reopen(): Promise<void> {
    if (this.reopening) return this.reopening;
    const run = this.runReopen().finally(() => {
      this.reopening = undefined;
    });
    this.reopening = run;
    return run;
  }

  private async runReopen(): Promise<void> {
    this.generation++;
    this.setStatus("reopening");
    await this.dropSession();
    try {
      this.session = await this.opts.openSession();
      this.lastError = undefined;
      this.messages.push({ role: "separator", text: REOPENED_SEPARATOR });
      this.status = "idle";
      this.drain();
      this.emit();
    } catch (err) {
      const code = err instanceof ChatBridgeError ? err.code : "UNKNOWN";
      const message = err instanceof Error ? err.message : String(err);
      const hint = this.opts.hints?.[code];
      this.messages.push({ role: "error", text: hint === undefined ? message : `${message}\n${hint}` });
      this.lastError = code;
      this.setStatus("dead");
    }
  }

  async discard(separator: string): Promise<boolean> {
    if (this.status === "busy" || this.status === "opening" || this.status === "reopening") return false;
    await this.dropSession();
    this.lastError = undefined;
    this.lastPrompt = undefined;
    this.status = "closed";
    this.messages.push({ role: "separator", text: separator });
    this.drain();
    this.emit();
    return true;
  }

  markLoggedIn(): void {
    if (this.status === "dead") {
      this.lastError = undefined;
      this.status = "closed";
    }
    this.messages.push({ role: "separator", text: "Logged in" });
    this.drain();
    this.emit();
  }
```

`retryLast` keeps its busy/opening guard (add `reopening`) and otherwise is unchanged. `dropSession` is unchanged. Note `drain()` after `discard` / `markLoggedIn` opens the browser lazily on the queued entry, which is what the spec wants ("drain again after New chat, Log in or reopen").

- [ ] **Step 5: Run tests and check**

Run: `bun test packages/vscode && bun run check`
Expected: PASS. Existing tests that asserted `INVALID_STATE` for a send while busy now expect `{ ok: true, queued: true }`; update them.

- [ ] **Step 6: Commit and sync**

```bash
git add packages/vscode/src/protocol.ts packages/vscode/src/session-controller.ts packages/vscode/src/session-controller.test.ts
git commit -m "feat(vscode): message queue and reopen in SessionController (Refs #64)"
gh issue comment 64 --body "SessionController: queue with take-back/remove, generation counter, reopen(). What's next: Task 3, bridge/commands/manifest wiring for reopen and the queue."
```

---

### Task 3: bridge, commands, manifest and keybinding for reopen and the queue

**Files:**
- Modify: `packages/vscode/src/protocol.ts`, `packages/vscode/src/chat-view-bridge.ts`, `packages/vscode/src/chat-view-bridge.test.ts`, `packages/vscode/src/commands.ts`, `packages/vscode/src/commands.test.ts`, `packages/vscode/src/manifest.ts`, `packages/vscode/src/manifest.test.ts`, `packages/vscode/src/create-extension.ts`, `packages/vscode/README.md`, `examples/vscode-dummy-chat/package.json`

**Interfaces:**
- Consumes: `SessionController.reopen/takeBack/removeQueued`, `SendResult.queued`.
- Produces: `ToHost` gains `{ type: "takeBack" }`, `{ type: "removeQueued"; index }`, command name `"reopen"`; `CommandHandlers.reopen(): Promise<void>`; `COMMAND_NAMES` has eight entries; `ChatViewHandlers` gains `takeBack()`, `removeQueued(index)`; `ExtensionApi.handlers: CommandHandlers`.

- [ ] **Step 1: Protocol**

In `protocol.ts`:

```ts
export type WebviewCommand = "login" | "logout" | "newChat" | "installBrowser" | "reopen";

/** webview → host */
export type ToHost =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "removeAttachment"; index: number }
  | { type: "takeBack" }
  | { type: "removeQueued"; index: number }
  | { type: "command"; name: WebviewCommand };
```

- [ ] **Step 2: Failing tests**

`chat-view-bridge.test.ts` — add a test that `{type:"takeBack"}`, `{type:"removeQueued", index: 1}` and `{type:"command", name:"reopen"}` / `"logout"` reach the corresponding handler, and that `{type:"removeQueued"}` without a numeric index is dropped (follow the file's existing fake-webview pattern).

`commands.test.ts` — add:

```ts
test("reopen delegates to the controller", async () => {
  const { handlers, controller } = setup(); // the file's helper
  await handlers.reopen();
  expect(controller.getState().messages.at(-1)).toEqual({ role: "separator", text: "reopened" });
});

test("newChat while busy warns instead of silently ignoring", async () => {
  const { handlers, ui, controller } = setup();
  void controller.send("one");
  await tick();
  await handlers.newChat();
  expect(ui.warnings).toEqual(["Wait for the current reply to finish, or press Ctrl+R to reopen."]);
});

test("send that was queued does not prompt for a browser install", async () => {
  const { handlers, ui, controller } = setup();
  void controller.send("one");
  await tick();
  await handlers.send("two");
  expect(ui.errors).toEqual([]);
});
```

`manifest.test.ts` — extend the "lists every missing id" expectation with `commands: <id>.reopen` and assert `COMMAND_NAMES.length === 8`.

- [ ] **Step 3: Run to verify they fail**

Run: `bun test packages/vscode`
Expected: FAIL on the new tests.

- [ ] **Step 4: Implement**

`manifest.ts`: add `"reopen"` after `"newChat"` in `COMMAND_NAMES`.

`chat-view-bridge.ts`:

```ts
export interface ChatViewHandlers {
  send(text: string): void;
  removeAttachment(index: number): void;
  takeBack(): void;
  removeQueued(index: number): void;
  command(name: WebviewCommand): void;
}
const COMMANDS: ReadonlySet<string> = new Set(["login", "logout", "newChat", "installBrowser", "reopen"]);
// in isToHost:
case "takeBack": return true;
case "removeQueued": return typeof msg.index === "number";
case "command": return typeof msg.name === "string" && COMMANDS.has(msg.name);
// in attach's switch:
case "takeBack": this.handlers.takeBack(); break;
case "removeQueued": this.handlers.removeQueued(raw.index); break;
```

`commands.ts`:

```ts
export interface CommandHandlers {
  // ...existing...
  reopen(): Promise<void>;
}
// in createCommands' returned object:
async newChat() {
  if (!(await controller.newChat())) {
    ui.showWarningMessage("Wait for the current reply to finish, or press Ctrl+R to reopen.");
  }
},
reopen: () => controller.reopen(),
async send(text) {
  const result = await controller.send(text);
  if (result.ok || result.code !== "BROWSER_UNAVAILABLE") return;
  // ...unchanged...
},
```

`SessionController.newChat()` must return the boolean from `discard` — change its signature to `newChat(): Promise<boolean>` (`return this.discard("New chat")`).

`create-extension.ts`:

```ts
export interface ExtensionApi {
  controller: SessionController;
  /** The E2E drives the command handlers directly. */
  handlers: CommandHandlers;
}
// bridge handlers:
takeBack: () => controller?.takeBack(),
removeQueued: (i) => controller?.removeQueued(i),
command: (name) => void handlers[name](),
// onChange: also show the status bar while "reopening".
// return { controller, handlers };
```

`examples/vscode-dummy-chat/package.json`: add the command

```json
{ "command": "chatbridge-dummy.reopen", "title": "Reopen Browser", "category": "Dummy Chat" }
```

and a top-level `contributes.keybindings`:

```json
"keybindings": [
  { "command": "chatbridge-dummy.reopen", "key": "ctrl+r", "mac": "cmd+r", "when": "focusedView == chatbridge-dummy.chat" }
]
```

`packages/vscode/README.md` — in **Manifest**: list `<id>.reopen` among the commands ("all eight"), and add a paragraph:

> A `keybindings` entry is recommended so Ctrl+R (Cmd+R on macOS) reopens the browser while the chat view is focused; it is not validated. The webview also handles the shortcut itself when the composer has focus.

with the JSON above (`<id>` form).

- [ ] **Step 5: Run check**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 6: Commit and sync**

```bash
git add packages/vscode examples/vscode-dummy-chat/package.json
git commit -m "feat(vscode): reopen command, keybinding, queue messages in bridge (Refs #64)"
gh issue comment 64 --body "Wired reopen through commands/bridge/manifest (8 commands now), newChat warns while busy (#59 item 9), example manifest has the Ctrl+R keybinding. What's next: Task 4, webview queue list, take back, Reopen, slash commands."
```

---

### Task 4: webview — queue list, take back, Reopen, Ctrl+R, slash commands

**Files:**
- Modify: `packages/vscode/src/webview/main.ts`, `packages/vscode/src/webview/style.css`, `packages/vscode/src/webview-html.ts`, `packages/vscode/src/webview-html.test.ts`

**Interfaces:**
- Consumes: `State.queue`, `ToHost` from Task 3, `parseSlashCommand` / `helpText` / `unknownCommandMessage` from `@chatbridge/core/slash-commands`.

No unit test runs the webview (it needs a DOM); `webview-html.test.ts` pins the new elements, and Task 9's E2E covers the host side. Keep `main.ts` free of anything untestable by inspection: small functions, no state outside the `State` it last received.

- [ ] **Step 1: HTML test**

In `webview-html.test.ts` add: the document contains `id="queue"` and `id="inline-error"`.

- [ ] **Step 2: HTML and CSS**

`webview-html.ts` body becomes:

```html
<div id="welcome" hidden><img id="banner" alt="" hidden><p id="welcome-text"></p></div>
<main id="history" aria-live="polite"></main>
<div id="status" hidden></div>
<ul id="queue" hidden></ul>
<div id="attachments"></div>
<div id="inline-error" hidden></div>
<form id="composer">
<textarea id="input" rows="3" placeholder="Message (Enter to send, Shift+Enter for a newline, / for commands)"></textarea>
<button id="send" type="submit">Send</button>
</form>
<footer id="footer" hidden></footer>
```

`style.css` additions:

```css
#queue {
  list-style: none;
  margin: 0;
  padding: 0 8px;
  font-size: 90%;
  opacity: 0.8;
}
#queue li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#queue li .queue-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
#inline-error {
  padding: 2px 8px;
  color: var(--vscode-errorForeground);
  font-size: 90%;
}
.message.help {
  font-family: var(--vscode-editor-font-family);
  white-space: pre;
  opacity: 0.8;
}
```

- [ ] **Step 3: main.ts changes**

Add imports and elements:

```ts
import {
  helpText,
  parseSlashCommand,
  unknownCommandMessage,
} from "@chatbridge/core/slash-commands";
const queue = document.getElementById("queue") as HTMLElement;
const inlineError = document.getElementById("inline-error") as HTMLElement;
let lastState: State | undefined;
```

Queue rendering and status:

```ts
function renderQueue(s: State): void {
  queue.replaceChildren();
  queue.hidden = s.queue.length === 0;
  s.queue.forEach((entry, index) => {
    const li = document.createElement("li");
    const label = entry.attachments.length > 0
      ? `${entry.text.split("\n")[0] ?? ""} 📎 ${entry.attachments.length}`
      : (entry.text.split("\n")[0] ?? "");
    li.appendChild(el("span", "queue-text", `▹ ${label}`));
    const x = button("×", () => vscode.postMessage({ type: "removeQueued", index }));
    x.className = "chip-remove";
    li.appendChild(x);
    queue.appendChild(li);
  });
}
```

In `renderStatus`: the busy/opening/reopening branch shows the spinner with `Reopening browser...` for `reopening`, `Opening browser...` for `opening`, else `Waiting...`, and appends ` · N queued` when `s.queue.length > 0`. The `dead` branch adds a `Reopen` button (`command: "reopen"`) before `New chat`.

In `render`: call `renderQueue(s)`, keep `lastState = s`, and replace the lock logic:

```ts
const active = s.status === "busy" || s.status === "opening" || s.status === "reopening";
input.disabled = false;
sendButton.disabled = false;
sendButton.textContent = active ? "Queue" : "Send";
input.focus();
```

Slash handling and inline error in `submit`:

```ts
function showInlineError(text: string | undefined): void {
  inlineError.textContent = text ?? "";
  inlineError.hidden = text === undefined;
}

function submit(): void {
  const text = input.value;
  if (text.trim() === "" && attachments.childElementCount === 0) return;
  const slash = parseSlashCommand(text);
  if (slash && "unknown" in slash) {
    showInlineError(unknownCommandMessage(slash.unknown));
    return;
  }
  showInlineError(undefined);
  if (slash) {
    input.value = "";
    if (slash.command === "help") {
      history.appendChild(el("div", "message help", helpText()));
      history.scrollTop = history.scrollHeight;
      return;
    }
    const name = slash.command === "new" ? "newChat" : slash.command;
    vscode.postMessage({ type: "command", name });
    return;
  }
  vscode.postMessage({ type: "send", text });
  input.value = "";
}
```

The help block is local to the webview and disappears on the next `state` render (history is rebuilt from `s.messages`); that is acceptable — `/help` is a glance, not history.

Keys:

```ts
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
    return;
  }
  if (e.key === "ArrowUp" && input.value === "" && (lastState?.queue.length ?? 0) > 0) {
    e.preventDefault();
    const entries = lastState?.queue ?? [];
    input.value = entries.map((q) => q.text).join("\n\n");
    vscode.postMessage({ type: "takeBack" });
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "r" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    vscode.postMessage({ type: "command", name: "reopen" });
  }
});
```

Also clear the inline error on `input` events (`input.addEventListener("input", () => showInlineError(undefined))`).

- [ ] **Step 4: Build and check**

Run: `bun run check` and `bun run --filter chatbridge-example-vscode-dummy-chat build` (the esbuild bundle must resolve `@chatbridge/core/slash-commands`; if esbuild cannot resolve the subpath through the workspace symlink, add `packages/core/dist/slash-commands.js` to the example's `esbuild.mjs` `alias` and note it in the README packaging section).
Expected: PASS, bundle emitted.

- [ ] **Step 5: Commit and sync**

```bash
git add packages/vscode examples/vscode-dummy-chat
git commit -m "feat(vscode): webview queue list, take back, Reopen, Ctrl+R, slash commands (Refs #64)"
gh issue comment 64 --body "Webview shows the queue, takes it back with Up, has a Reopen button and Ctrl+R, and handles /login /logout /new /reopen /help. What's next: Task 5, host side of drop and paste."
```

---

### Task 5: host side of drop and paste

**Files:**
- Modify: `packages/vscode/src/protocol.ts`, `packages/vscode/src/chat-view-bridge.ts`, `packages/vscode/src/chat-view-bridge.test.ts`, `packages/vscode/src/commands.ts`, `packages/vscode/src/commands.test.ts`, `packages/vscode/src/vscode-ui.ts`, `packages/vscode/src/create-extension.ts`

**Interfaces:**
- Produces: `ToHost` gains `{ type: "attachUris"; uris: string[] }` and `{ type: "pasted"; id: number; text: string }`; `ToWebview` gains `{ type: "pasteResult"; id: number; attached: boolean }`; `CommandHandlers.attachUris(uris: string[]): Promise<void>` and `CommandHandlers.pasted(text: string): boolean` (true when attached); `VscodeUi.parseUri(uri: string): unknown` (returns a `vscode.Uri` or throws); `ChatViewHandlers.attachUris(uris)`, `ChatViewHandlers.pasted(id, text)`; `ChatViewBridge.pushPasteResult(id, attached)`.

- [ ] **Step 1: Failing tests**

`commands.test.ts` (extend the file's fake `ui` with `parseUri: (u) => u` and make `openDocument` reject for URIs ending in `/dir` or with a scheme other than `file:`):

```ts
test("attachUris attaches every readable file and warns once about the rest", async () => {
  const { handlers, ui, controller } = setup();
  await handlers.attachUris(["file:///w/a.ts", "file:///w/dir", "untitled:x", "file:///w/b.ts"]);
  expect(controller.getState().pendingAttachments.map((a) => a.path)).toEqual(["a.ts", "b.ts"]);
  expect(ui.warnings).toEqual(["Skipped: file:///w/dir, untitled:x"]);
});

test("pasted text equal to the editor selection becomes a selection chip", () => {
  const { handlers, ui, controller } = setup();
  ui.editor = { path: "src/x.ts", text: "a\nb\nc\nd", selection: { text: "b\nc", startLine: 2, endLine: 3 } };
  expect(handlers.pasted("b\r\nc")).toBe(true);
  expect(controller.getState().pendingAttachments[0]?.path).toBe("src/x.ts:L2-L3");
});

test("pasted text that differs is not attached", () => {
  const { handlers, ui, controller } = setup();
  ui.editor = { path: "src/x.ts", text: "a\nb", selection: { text: "a", startLine: 1, endLine: 1 } };
  expect(handlers.pasted("zzz")).toBe(false);
  expect(controller.getState().pendingAttachments).toEqual([]);
});
```

`chat-view-bridge.test.ts`: `attachUris` with a string array reaches the handler, one with a non-array is dropped; `pasted` reaches `handlers.pasted(id, text)`; `pushPasteResult(3, true)` posts `{ type: "pasteResult", id: 3, attached: true }`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/vscode`

- [ ] **Step 3: Implement**

`protocol.ts`:

```ts
// ToHost additions
| { type: "attachUris"; uris: string[] }
| { type: "pasted"; id: number; text: string }
// ToWebview addition
| { type: "pasteResult"; id: number; attached: boolean }
```

`vscode-ui.ts`: add `parseUri(uri: string): unknown` to the interface, implemented as `(uri) => api.Uri.parse(uri, true)`.

`chat-view-bridge.ts`:

```ts
// ChatViewHandlers
attachUris(uris: string[]): void;
pasted(id: number, text: string): void;
// isToHost
case "attachUris": return Array.isArray(msg.uris) && msg.uris.every((u) => typeof u === "string");
case "pasted": return typeof msg.id === "number" && typeof msg.text === "string";
// attach switch
case "attachUris": this.handlers.attachUris(raw.uris); break;
case "pasted": this.handlers.pasted(raw.id, raw.text); break;
// method
pushPasteResult(id: number, attached: boolean): void {
  void this.webview?.postMessage({ type: "pasteResult", id, attached });
}
```

`commands.ts`:

```ts
async attachUris(uris) {
  const skipped: string[] = [];
  for (const raw of uris) {
    try {
      const doc = await ui.openDocument(ui.parseUri(raw));
      attach(doc.path, doc.text);
    } catch {
      skipped.push(raw);
    }
  }
  if (skipped.length > 0) ui.showWarningMessage(`Skipped: ${skipped.join(", ")}`);
},

pasted(text) {
  const editor = ui.activeEditor();
  const selection = editor?.selection;
  if (!editor || !selection) return false;
  const normalise = (s: string) => s.replace(/\r\n/g, "\n");
  if (normalise(text) !== normalise(selection.text)) return false;
  attachEditor(editor, true);
  return true;
},
```

`create-extension.ts` bridge handlers:

```ts
attachUris: (uris) => void handlers.attachUris(uris),
pasted: (id, text) => bridge.pushPasteResult(id, handlers.pasted(text)),
```

- [ ] **Step 4: Check**

Run: `bun run check` — PASS.

- [ ] **Step 5: Commit and sync**

```bash
git add packages/vscode
git commit -m "feat(vscode): attachUris and pasted handlers for drop/paste chips (Refs #64)"
gh issue comment 64 --body "Host side of drop/paste: attachUris resolves dropped URIs to chips, pasted matches the editor selection. What's next: Task 6, webview drop and paste."
```

---

### Task 6: webview drop and paste

**Files:**
- Modify: `packages/vscode/src/webview/main.ts`, `packages/vscode/src/webview/style.css`

**Interfaces:**
- Consumes: `attachUris`, `pasted`, `pasteResult` from Task 5.

- [ ] **Step 1: Drop**

```ts
function urisFromDrop(dt: DataTransfer | null): string[] {
  const list = dt?.getData("text/uri-list") ?? "";
  return list
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("drop-target");
});
document.addEventListener("dragleave", () => document.body.classList.remove("drop-target"));
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("drop-target");
  const uris = urisFromDrop(e.dataTransfer);
  if (uris.length > 0) vscode.postMessage({ type: "attachUris", uris });
});
```

CSS: `body.drop-target { outline: 2px dashed var(--vscode-focusBorder); outline-offset: -2px; }`.

- [ ] **Step 2: Paste**

```ts
const PASTE_TIMEOUT_MS = 500;
let pasteSeq = 0;
const pendingPastes = new Map<number, { text: string; timer: ReturnType<typeof setTimeout> }>();

function insertAtCaret(text: string): void {
  input.focus();
  if (!document.execCommand("insertText", false, text)) {
    const { selectionStart, selectionEnd, value } = input;
    input.value = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
    const pos = selectionStart + text.length;
    input.setSelectionRange(pos, pos);
  }
}

input.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text/plain") ?? "";
  if (!text.includes("\n")) return; // single line: default paste
  e.preventDefault();
  const id = ++pasteSeq;
  const timer = setTimeout(() => {
    pendingPastes.delete(id);
    insertAtCaret(text);
  }, PASTE_TIMEOUT_MS);
  pendingPastes.set(id, { text, timer });
  vscode.postMessage({ type: "pasted", id, text });
});
```

In the `message` listener:

```ts
} else if (m.type === "pasteResult") {
  const p = pendingPastes.get(m.id);
  if (!p) return;
  clearTimeout(p.timer);
  pendingPastes.delete(m.id);
  if (!m.attached) insertAtCaret(p.text);
}
```

- [ ] **Step 3: Check and manual smoke**

Run: `bun run check && bun run --filter chatbridge-example-vscode-dummy-chat build`.
Then, if a desktop is available, `code --extensionDevelopmentPath=examples/vscode-dummy-chat` and verify: drag a file from the explorer onto the view → chip; select lines in an editor, copy, paste in the composer → `path:Lx-Ly` chip; paste other multi-line text → inserted. Record the observed `text/uri-list` payload in a comment in `main.ts` next to `urisFromDrop`. If no desktop is available, say so in the issue comment.

- [ ] **Step 4: Commit and sync**

```bash
git add packages/vscode
git commit -m "feat(vscode): drop files and paste editor selections as chips (Refs #64)"
gh issue comment 64 --body "Webview: dropped files and selection pastes become chips (500 ms fallback inserts text). What's next: Task 7, ChatModel opens eagerly, slash commands, /login."
```

---

### Task 7: `ChatModel` — eager open, `opening`, slash commands, `/login`

**Files:**
- Modify: `packages/cli/src/tui/chat-model.ts`, `packages/cli/src/tui/chat-model.test.ts`, `packages/cli/src/tui/chat-view.test.ts`, `packages/cli/src/tui/run-interactive.test.ts`

**Interfaces:**
- Consumes: `parseSlashCommand`, `helpText`, `unknownCommandMessage` from `@chatbridge/core`.
- Produces: `new ChatModel(opts)` (no session argument); `ChatModelOptions` gains `login: (opts: { signal: AbortSignal; onProgress: (m: string) => void }) => Promise<void>` and `clearAuth: () => Promise<void>`; `Status` gains `"opening"` and `"logging-in"`; `session` getter returns `ChatSessionLike | undefined`; `ready: Promise<void>` (the initial open, never rejects); `loginProgress: string | undefined`; `cancelLogin(): void`; `NEW_CHAT_SEPARATOR = "new chat"`; `Role` gains `"help"`.

- [ ] **Step 1: Update existing tests for the constructor**

Every `new ChatModel(session, opts)` becomes `new ChatModel({ ...opts, openSession: async () => session })` followed by `await model.ready`. Add a helper at the top of each test file:

```ts
async function modelWith(session: ChatSessionLike, opts: Partial<ChatModelOptions> = {}) {
  const model = new ChatModel({
    openSession: async () => session,
    login: async () => {},
    clearAuth: async () => {},
    ...opts,
  });
  await model.ready;
  return model;
}
```

Tests that use a *different* `openSession` for reset must return the first session on the first call and the second afterwards (a counter).

- [ ] **Step 2: New failing tests** (`chat-model.test.ts`)

```ts
describe("startup", () => {
  test("opens eagerly: status opening, then idle; input typed meanwhile drains", async () => {
    const open = deferred<ChatSessionLike>();
    const s = fakeSession();
    const model = new ChatModel({ openSession: () => open.promise, login: async () => {}, clearAuth: async () => {}, expand: async (t) => ({ prompt: t, attachments: [] }) });
    expect(model.status).toBe("opening");
    expect(await model.submit("hi")).toBe(true);
    expect(model.queue).toEqual(["hi"]);
    open.resolve(s.session);
    await model.ready;
    await tick();
    expect(s.calls).toEqual(["hi"]);
  });

  test("a failed open is dead with the /login hint for auth errors", async () => {
    const model = new ChatModel({ openSession: async () => { throw new AuthRequiredError("not logged in"); }, login: async () => {}, clearAuth: async () => {} });
    await model.ready;
    expect(model.status).toBe("dead");
    expect(model.messages.at(-1)).toEqual({ role: "error", text: "not logged in\nType /login to log in." });
  });

  test("BROWSER_UNAVAILABLE gets the install hint", async () => {
    const model = new ChatModel({ openSession: async () => { throw new BrowserUnavailableError("no chromium"); }, login: async () => {}, clearAuth: async () => {} });
    await model.ready;
    expect(model.messages.at(-1)?.text).toBe("no chromium\nRun: npx playwright install chromium");
  });
});

describe("slash commands", () => {
  test("/help pushes a help entry without sending", async () => {
    const s = fakeSession();
    const model = await modelWith(s.session);
    expect(await model.submit("/help")).toBe(true);
    expect(model.messages.at(-1)?.role).toBe("help");
    expect(s.calls).toEqual([]);
  });
  test("unknown command: error entry, text refused", async () => {
    const model = await modelWith(fakeSession().session);
    expect(await model.submit("/nope")).toBe(false);
    expect(model.messages.at(-1)).toEqual({ role: "error", text: "Unknown command: /nope. Type /help." });
  });
  test("/new resets with the `new chat` separator; /reopen with `reopened`", async () => {
    let n = 0;
    const a = fakeSession("a"); const b = fakeSession("b"); const c = fakeSession("c");
    const model = await modelWith(a.session, { openSession: async () => [a, b, c][n++]!.session });
    await model.submit("/new");
    expect(model.messages.at(-1)).toEqual({ role: "separator", text: "new chat" });
    await model.submit("/reopen");
    expect(model.messages.at(-1)).toEqual({ role: "separator", text: "reopened" });
  });
  test("/logout clears auth, then the reopen fails as dead", async () => {
    let cleared = 0;
    const a = fakeSession();
    const model = await modelWith(a.session, {
      openSession: (() => { let first = true; return async () => { if (first) { first = false; return a.session; } throw new AuthRequiredError("not logged in"); }; })(),
      clearAuth: async () => { cleared++; },
    });
    await model.submit("/logout");
    expect(cleared).toBe(1);
    expect(model.messages.map((m) => m.text)).toContain("Logged out");
    expect(model.status).toBe("dead");
  });
  test("a command runs while busy and is never queued", async () => {
    const s = fakeSession();
    const model = await modelWith(s.session, { expand: async (t) => ({ prompt: t, attachments: [] }) });
    void model.submit("x");
    await tick();
    await model.submit("/help");
    expect(model.queue).toEqual([]);
    expect(model.messages.at(-1)?.role).toBe("help");
  });
});

describe("/login", () => {
  test("success: Logged in separator, reset, queue drains", async () => {
    let n = 0;
    const a = fakeSession("a"); const b = fakeSession("b");
    const login = deferred<void>();
    const model = await modelWith(a.session, {
      openSession: async () => [a, b][n++]!.session,
      login: () => login.promise,
      expand: async (t) => ({ prompt: t, attachments: [] }),
    });
    const p = model.submit("/login");
    expect(model.status).toBe("logging-in");
    await model.submit("later");
    login.resolve();
    await p;
    await tick();
    expect(model.messages.map((m) => m.text)).toContain("Logged in");
    expect(model.messages.map((m) => m.text)).toContain("reopened");
    expect(b.calls).toEqual(["b:later"]);
  });
  test("cancel: Login cancelled, back to the previous status", async () => {
    const model = await modelWith(fakeSession().session, {
      login: ({ signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new LoginAbortedError()))),
    });
    const p = model.submit("/login");
    model.cancelLogin();
    await p;
    expect(model.status).toBe("idle");
    expect(model.messages.at(-1)).toEqual({ role: "separator", text: "Login cancelled" });
  });
  test("failure: error entry, previous status kept; second /login while running is ignored", async () => {
    let calls = 0;
    const login = deferred<void>();
    const model = await modelWith(fakeSession().session, { login: () => { calls++; return login.promise; } });
    const p = model.submit("/login");
    await model.submit("/login");
    expect(calls).toBe(1);
    login.reject(new Error("idp down"));
    await p;
    expect(model.status).toBe("idle");
    expect(model.messages.at(-1)).toEqual({ role: "error", text: "idp down" });
  });
  test("progress is exposed", async () => {
    const model = await modelWith(fakeSession().session, {
      login: async ({ onProgress }) => { onProgress("Waiting for login..."); },
    });
    const p = model.submit("/login");
    await tick();
    expect(model.loginProgress).toBe("Waiting for login...");
    await p;
    expect(model.loginProgress).toBeUndefined();
  });
});
```

Import `AuthRequiredError`, `BrowserUnavailableError`, `LoginAbortedError` from `@chatbridge/core`.

- [ ] **Step 3: Run to verify they fail**

Run: `bun test packages/cli/src/tui/chat-model.test.ts`

- [ ] **Step 4: Implement**

Changes to `chat-model.ts`:

```ts
import {
  AuthExpiredError, AuthRequiredError, BrowserUnavailableError, LoginAbortedError,
  ResponseTimeoutError, closeOrKill, helpText, parseSlashCommand, unknownCommandMessage,
} from "@chatbridge/core";

export type Role = "user" | "assistant" | "error" | "separator" | "shell" | "help";
export type Status = "opening" | "idle" | "busy" | "running" | "resetting" | "logging-in" | "dead";
export const NEW_CHAT_SEPARATOR = "new chat";
export const AUTH_HINT = "Type /login to log in.";
export const INSTALL_HINT = "Run: npx playwright install chromium";

export interface ChatModelOptions {
  /** Opens a session: called once by the constructor and by every reset. */
  openSession: () => Promise<ChatSessionLike>;
  /** `/login`: the headful login; resolves when the auth state is saved. */
  login: (opts: { signal: AbortSignal; onProgress: (message: string) => void }) => Promise<void>;
  /** `/logout`: deletes the saved auth state. */
  clearAuth: () => Promise<void>;
  // ...existing optional fields...
}

export class ChatModel {
  status: Status = "opening";
  /** Resolves when the initial open settled (idle or dead). Never rejects. */
  readonly ready: Promise<void>;
  /** Last progress line from the running login, for the status row. */
  loginProgress: string | undefined;
  private current: ChatSessionLike | undefined;
  private loginAbort: AbortController | undefined;
  private readonly login: ChatModelOptions["login"];
  private readonly clearAuth: () => Promise<void>;

  constructor(opts: ChatModelOptions) {
    // ...assign fields as before, without `session`...
    this.ready = this.openInitial();
  }

  get session(): ChatSessionLike | undefined { return this.current; }

  private async openInitial(): Promise<void> {
    try {
      this.current = await this.openSession();
      this.status = "idle";
      this.drain();
    } catch (err) {
      this.messages.push({ role: "error", text: this.describe(err) });
      this.fatal = err;
      this.status = "dead";
    }
    this.onChange();
  }

  /** Error text plus the TUI-side remedy for the codes a user can fix. */
  private describe(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AuthRequiredError || err instanceof AuthExpiredError) return `${message}\n${AUTH_HINT}`;
    if (err instanceof BrowserUnavailableError) return `${message}\n${INSTALL_HINT}`;
    return message;
  }

  async submit(text: string): Promise<boolean> {
    const prompt = text.trim();
    if (!prompt) return false;
    const slash = parseSlashCommand(prompt);
    if (slash) return this.runSlash(slash);
    if (this.status !== "idle") { this.queue.push(prompt); this.onChange(); return true; }
    return this.runTurn(prompt, false);
  }

  private async runSlash(slash: NonNullable<ReturnType<typeof parseSlashCommand>>): Promise<boolean> {
    if ("unknown" in slash) {
      this.messages.push({ role: "error", text: unknownCommandMessage(slash.unknown) });
      this.onChange();
      return false;
    }
    switch (slash.command) {
      case "help": this.messages.push({ role: "help", text: helpText() }); this.onChange(); return true;
      case "new": await this.reset(NEW_CHAT_SEPARATOR); return true;
      case "reopen": await this.reset(); return true;
      case "logout":
        this.messages.push({ role: "separator", text: "Logged out" });
        this.onChange();
        await this.clearAuth();
        await this.reset();
        return true;
      case "login": await this.runLogin(); return true;
    }
  }

  private async runLogin(): Promise<void> {
    if (this.loginAbort) return;
    const previous = this.status;
    const ac = new AbortController();
    this.loginAbort = ac;
    this.status = "logging-in";
    this.onChange();
    try {
      await this.login({ signal: ac.signal, onProgress: (m) => { this.loginProgress = m; this.onChange(); } });
      this.messages.push({ role: "separator", text: "Logged in" });
      this.loginAbort = undefined;
      this.loginProgress = undefined;
      this.status = previous;
      await this.reset();
      return;
    } catch (err) {
      this.messages.push(
        err instanceof LoginAbortedError
          ? { role: "separator", text: "Login cancelled" }
          : { role: "error", text: err instanceof Error ? err.message : String(err) },
      );
      this.status = previous;
    } finally {
      this.loginAbort = undefined;
      this.loginProgress = undefined;
    }
    this.onChange();
  }

  /** Ctrl+C during `/login`. No-op otherwise. */
  cancelLogin(): void { this.loginAbort?.abort(); }

  reset(separator = SEPARATOR_TEXT): Promise<void> { /* pass separator into runReset */ }
```

`runReset(separator)`: `closeOrKill(old, ...)` only when `old !== undefined`; on failure use `this.describe(err)` for the error text. `sendPrompt` / `runShell` use `this.current` — they only run from `idle`, where `current` is defined; add a guard that throws `InvalidStateError` (from core) if it is undefined, to keep the type-checker honest. `reset()` while `logging-in` first calls `cancelLogin()` (the reset wins).

- [ ] **Step 5: Run all cli tests and check**

Run: `bun run build && bun test packages/cli && bun run check`
Expected: PASS after updating `chat-view.test.ts` / `run-interactive.test.ts` constructors (Step 1) — `run-interactive.ts` will not compile until Task 8; if `tsc --build` fails only there, do Task 8's `run-interactive.ts` change in this task's commit and say so in the issue comment.

- [ ] **Step 6: Commit and sync**

```bash
git add packages/cli
git commit -m "feat(cli): ChatModel opens eagerly; slash commands and /login (Refs #64)"
gh issue comment 64 --body "ChatModel: constructor opens the session itself (opening status, /login hint on auth failure), slash commands, /login with cancel. What's next: Task 8, ChatView statuses and run-interactive start-before-open."
```

---

### Task 8: `ChatView` statuses, Ctrl+C cancels login, TUI starts before the browser

**Files:**
- Modify: `packages/cli/src/tui/chat-view.ts`, `packages/cli/src/tui/chat-view.test.ts`, `packages/cli/src/tui/run-interactive.ts`, `packages/cli/src/tui/run-interactive.test.ts`, `packages/cli/src/create-cli.ts`, `packages/cli/README.md`

**Interfaces:**
- Consumes: `ChatModel` from Task 7 (`ready`, `loginProgress`, `cancelLogin`, `Role "help"`, statuses `opening` / `logging-in`).
- Produces: exported `OPENING_STATUS = "Opening browser..."`, `LOGIN_STATUS = "Log in in the browser window… (Ctrl+C cancel)"`, `LOGIN_GUIDE = "Ctrl+C cancel login"`; `GUIDE` gains `/ commands`.

- [ ] **Step 1: Failing view tests** (`chat-view.test.ts`, using the file's `createTestRenderer` harness and `modelWith` from Task 7)

- while `opening`, the status row shows `Opening browser...`;
- while `logging-in`, the status row shows `LOGIN_STATUS`, then the latest `loginProgress` when set;
- a `help` message renders its text verbatim (multi-line) with no role label;
- `DEAD_GUIDE` now reads `Ctrl+R reopen · /login · Ctrl+C quit`.

- [ ] **Step 2: Failing run-interactive tests**

- `waitForQuit`: Ctrl+C while `logging-in` calls `model.cancelLogin()` and does not resolve.
- `runInteractive` with `openSession` that throws `AuthRequiredError` (inject through a `createSession` test-only option, see Step 4) starts the renderer, ends `dead`, and after the renderer is destroyed resolves `{ fatal }` with that error.

- [ ] **Step 3: Implement the view**

`chat-view.ts`:

```ts
export const GUIDE = "Enter send · Ctrl+J newline · @ file · ! shell · / commands · Ctrl+R reopen · Ctrl+C quit";
export const DEAD_GUIDE = "Ctrl+R reopen · /login · Ctrl+C quit";
export const OPENING_STATUS = "Opening browser...";
export const LOGIN_STATUS = "Log in in the browser window… (Ctrl+C cancel)";
```

(Keep `GUIDE` within 80 columns; if it does not fit, drop `Ctrl+J newline` from it and mention Ctrl+J in the README instead.)

In `update()`'s switch add:

```ts
case "opening":
  this.stopSpinner();
  this.status.content = styled(theme.muted(OPENING_STATUS));
  break;
case "logging-in":
  this.stopSpinner();
  this.status.content = styled(theme.muted(this.model.loginProgress ?? LOGIN_STATUS));
  break;
```

In `messageBox`, before the label: `help` entries render one `TextRenderable` with `wrapMode: "none"` and muted text, no label. Add `help` to `LABELS`' `Exclude` list. The banner is replaced by the history on the first message as today, so `/help` on a fresh TUI shows the help instead of the banner — acceptable.

- [ ] **Step 4: Implement run-interactive**

`waitForQuit`: on Ctrl+C, `if (model.status === "logging-in") { model.cancelLogin(); return; }` before the `running` check.

`runInteractive`: reorder so the renderer starts first:

```ts
export interface InteractiveOptions extends ChatSessionOptions {
  // ...existing...
  /** Test-only: replaces ChatSession.open. */
  createSession?: () => Promise<ChatSessionLike>;
  /** Test-only: replaces runLogin. */
  login?: ChatModelOptions["login"];
}

const index = opts.index ?? (await FileIndex.build({ cwd: process.cwd() }));
const renderer = await (opts.createRenderer ?? (() => createCliRenderer({ exitOnCtrlC: false })))();
let view: ChatView | undefined;
let model: ChatModel | undefined;
try {
  const openSession = opts.createSession ?? (() => ChatSession.open(sessionOpts));
  model = new ChatModel({
    openSession,
    login: opts.login ?? ((o) => runLogin({ provider: opts.provider, authStore: opts.authStore, signal: o.signal, onProgress: o.onProgress })),
    clearAuth: () => opts.authStore.clear(),
    shell: opts.shell,
  });
  view = new ChatView(renderer, model, { ...as today... });
  const quit = waitForQuit(renderer, model);
  uiUp = true;
  renderer.start();
  const fatal = await quit;
  return fatal === undefined ? {} : { fatal };
} finally {
  model?.stopShell();
  model?.cancelLogin();
  view?.setStatus(CLOSING_STATUS);
  // The initial open or a reset may still be running: wait for whichever
  // is in flight (capped) so the session it produces is closed, not leaked.
  const settled = await settleReset(model?.pendingReset ?? model?.ready);
  const current = model?.session;
  const closed = settled && (current === undefined || (await closeWithTimeout(current, CLOSE_TIMEOUT_MS)));
  // ...rest unchanged...
}
```

`onProgress` buffering: since the UI is up before the open, the open's progress messages are buffered; that is fine (they were already shown by the status row via `opening`). Keep the buffer/flush as is.

`create-cli.ts`: no change needed beyond compiling (`runLogin` import stays in core). Update `packages/cli/README.md`'s interactive section: the TUI starts at once; if not logged in it shows the error and `/login` logs in from inside the TUI; list the slash commands.

- [ ] **Step 5: Run and check**

Run: `bun run build && bun test packages/cli && bun run check` — PASS. Then a manual smoke if a terminal is available: `bun run packages/cli/src/bin.ts` (or the example CLI) with no auth state → TUI appears, error with `/login` hint, `/login` opens a headed browser; note the outcome in the issue comment.

- [ ] **Step 6: Commit and sync**

```bash
git add packages/cli
git commit -m "feat(cli): TUI starts before the browser; /login status and cancel (Refs #64)"
gh issue comment 64 --body "TUI: renderer starts first, opening/logging-in statuses, Ctrl+C cancels /login, help entries render. What's next: Task 9, VSCode E2E and ROADMAP."
```

---

### Task 9: VSCode E2E, ROADMAP, docs

**Files:**
- Modify: `examples/vscode-dummy-chat/test/suite.ts`, `docs/ROADMAP.md`, `packages/vscode/README.md`, `packages/vscode/src/webview/main.ts` (comment only, if Task 6 could not record the MIME payload)

**Interfaces:**
- Consumes: `ExtensionApi.handlers` (Task 3), `controller.reopen/takeBack` (Task 2), `handlers.attachUris/pasted` (Task 5).

- [ ] **Step 1: Extend the E2E**

Append to `run()` in `suite.ts`, before `await controller.close()`:

```ts
// Queue: a second send while busy waits, then drains.
const busy = controller.send("first of two");
const queued = await controller.send("second of two");
assert.deepEqual(queued, { ok: true, queued: true });
assert.equal(controller.getState().queue.length, 1);
await busy;
await new Promise((r) => setTimeout(r, 2_000));
s = controller.getState();
assert.equal(s.queue.length, 0);
assert.match(s.messages.at(-1)?.text ?? "", /^Echo: second of two/);

// Reopen: the browser is replaced and the history marked.
await vscode.commands.executeCommand("chatbridge-dummy.reopen");
s = controller.getState();
assert.equal(s.status, "idle");
assert.deepEqual(s.messages.at(-1), { role: "separator", text: "reopened" });

// Drop: a workspace file URI becomes a chip.
const dropDoc = await vscode.workspace.openTextDocument({ language: "plaintext", content: "dropped\n" });
await handlers.attachUris([dropDoc.uri.toString()]);
assert.equal(controller.getState().pendingAttachments.length, 1);
controller.removeAttachment(0);

// Paste: the active editor's selection becomes a selection chip.
const pasteDoc = await vscode.workspace.openTextDocument({ language: "plaintext", content: "l1\nl2\nl3\n" });
const editor = await vscode.window.showTextDocument(pasteDoc);
editor.selection = new vscode.Selection(1, 0, 2, 2);
assert.equal(handlers.pasted("l2\nl3"), true);
assert.match(controller.getState().pendingAttachments[0]?.path ?? "", /:L2-L3$/);
assert.equal(handlers.pasted("unrelated\ntext"), false);
controller.removeAttachment(0);
```

Destructure `handlers` from `api` at the top: `const { controller, handlers } = api;`. The 2 s wait matches the dummy server's echo delay; if the drain is still busy, poll `getState().status` up to 10 s instead of a fixed sleep.

- [ ] **Step 2: Run the E2E**

Run: `bun run e2e:vscode` (needs a desktop; on CI the `vscode-e2e` job runs it under xvfb). If it cannot run locally, push the branch and open a draft PR so CI runs it, then report the result.

- [ ] **Step 3: ROADMAP and README**

`docs/ROADMAP.md`: after milestone 11 add

```
### 12. VSCode parity: queue, Ctrl+R, slash commands, drop/paste — done (issue #64)

`SessionController` gained the TUI's message queue (take back with Up) and
`reopen()`; `<id>.reopen` command with a recommended Ctrl+R keybinding.
Slash commands `/login /logout /new /reopen /help` defined once in core
(`@chatbridge/core/slash-commands`) and handled by both UIs; the TUI now
starts before the browser opens and `/login` runs the headful login from
inside it. Dropped files and pasted editor selections become attachment
chips in the webview. Ships as a 0.8.x patch.
Spec: `docs/superpowers/specs/2026-09-18-vscode-parity-design.md`.
```

(milestone 11's "left for later" list keeps Markdown rendering, history persistence, `@` completion, `!` shell mode and the Chat Participant API). In `packages/vscode/README.md` add a short **Composer** section: Enter sends or queues, Up takes the queue back, `/` commands, drop files, paste a selection.

- [ ] **Step 4: Check, commit, sync**

```bash
bun run check
git add examples/vscode-dummy-chat docs/ROADMAP.md packages/vscode/README.md
git commit -m "test(vscode): E2E for queue, reopen, drop and paste; roadmap milestone 12 (Refs #64)"
gh issue comment 64 --body "E2E covers queue/reopen/drop/paste through the extension API; ROADMAP has milestone 12. What's next: whole-branch review (Fable), then PR."
```

---

## Self-review notes

- Spec §1 queue → Task 2 (controller), Task 4 (webview). `SendResult.queued` → Tasks 2, 3.
- Spec §2 reopen → Tasks 2, 3 (command, keybinding, README, #59 item 9), 4 (button, Ctrl+R in webview).
- Spec §3 shared table → Task 1; TUI → Tasks 7, 8; webview → Task 4; TUI-starts-first → Tasks 7, 8.
- Spec §4 drop/paste → Tasks 5, 6; display unchanged.
- Spec §5 tests → each task's tests plus Task 9 E2E. The webview DOM itself has no automated test (spec's synthetic-drop E2E is replaced by the host-side `attachUris` / `pasted` calls through `ExtensionApi.handlers`; the DOM path is a manual smoke in Task 6).
- Names used consistently: `reopen`, `takeBack`, `removeQueued`, `attachUris`, `pasted`, `pasteResult`, `QueueEntry`, `ready`, `loginProgress`, `cancelLogin`, `REOPENED_SEPARATOR` / `SEPARATOR_TEXT` both equal `"reopened"`.
