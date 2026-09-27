# Session Resume and Transcript Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every interactive session (TUI and VSCode) is saved under the config dir, and `/resume` reopens a saved one from a picker: its transcript replaces the one on screen and its conversation handle is handed to `ChatSession.open`.

**Architecture:** Core gains three UI-free units: `session-record.ts` (the on-disk shape, validation, summary), `SessionStore` (one JSON file per session, atomic write, pruning) and `SessionRecorder` (which session is current, serialised saves, the save-failure notice). The TUI `ChatModel` and the VSCode `SessionController` each own a recorder, convert their own `Message` to and from the stored shape, and call `record()` whenever the settled history changes. `/resume` swaps the history and goes through the reset/reopen path each UI already has. The TUI picks with its existing popup, VSCode with the native QuickPick.

**Tech Stack:** TypeScript, Bun (workspaces, `bun test`), `node:fs/promises`, Playwright (Chromium, E2E only), OpenTUI (TUI only), VSCode API (extension host only), Biome.

**Spec:** `docs/superpowers/specs/2026-09-27-session-resume-design.md` — read it first. Tracking issue: #119 (bundles #74). Branch: `issue-119`.

## Global Constraints

- Everything committed is English (docs, comments, commit messages, issue comments).
- `bun run check` passes before every commit. After editing one package, run `bun run build` before another package's tests: tests import cross-package code from `dist`.
- Format before checking: `bunx biome check --write <the files you touched>`.
- Commit trailer: `Co-Authored-By: <the model that made the commit> <noreply@anthropic.com>` and the `Claude-Session:` line. Commit messages end with `(Refs #119)`; tasks that save transcripts also name `#74`.
- After every commit: `gh issue comment 119 --body "<what was committed> + What's next: <…>"`.
- Dependency direction `cli → core → runtime → provider` and `vscode → core`. Never import in reverse. Core and provider never depend on a UI.
- The webview bundle imports nothing from `@chatbridge/core` except the `@chatbridge/core/slash-commands` subpath: the core index pulls in `node:fs`.
- Paths: `<base>/<configDir>/sessions/<provider>/<id>.json`. Directories `0700`, files `0600`.
- Retention constants, not configurable: 14 days, 50 sessions, temporary files 1 hour.
- The conversation handle and message text never appear in a log line, an error message or a progress message, `CHATBRIDGE_DEBUG=1` included.
- A failure to save, list, load or prune never stops the chat and never changes an exit code.
- Only an explicit logout deletes sessions: `auth logout`, the TUI `/logout`, the VSCode logout command. It deletes them whether or not saving is turned on. `AUTH_EXPIRED` deletes nothing.
- `runOneShot`, the `Provider` type, `createCli` options and `createExtension` options do not change.
- No startup flag is added.
- No vendor-specific material anywhere.
- Exact strings (all exported from core, never retyped in a UI):
  - `resumed · conversation restored`, `resumed · conversation could not be restored`, `resumed · transcript only` (separator ` · ` is space, U+00B7, space)
  - `Wait for the current step to finish before /resume.`
  - `Session saving is turned off.`
  - `No saved sessions.`
  - `That session could not be loaded.`
  - `Could not save this session.`
  - `Could not delete the saved sessions.`
  - `/resume` description: `Go back to a saved session`

## Review Focus

Input classes the spec implies but does not spell out. Each has its test in the task named.

1. **A saved title carrying terminal control characters** (an ESC sequence in the first prompt, or in a hand-edited file): the picker must show it with the control characters replaced, never write them to the terminal. Task 1.
2. **Two processes in the same directory** (a TUI and a VSCode window, both pruning): a file that vanishes between the directory listing and the read is skipped; nothing throws. Task 2.
3. **Saves settling out of order**: an older snapshot must never land on disk after a newer one. Saves are serialised. Task 3.
4. **An unwritable config dir or a full disk**: the chat continues, the notice appears once per session, and the next turn tries again. Tasks 3 and 5.
5. **A handle that no longer opens** (other account, deleted conversation): the resume falls back to a new chat, says so, and the handle is removed from the file so the next resume does not pay the restore budget again. Tasks 6 and 11.

## File Structure

```
packages/core/src/
  session-record.ts            NEW  stored shape, parseSessionRecord, summarize, isSessionId, formatSessionTime
  session-record.test.ts       NEW
  session-store.ts             NEW  SessionStore: save / load / list / prune / clear
  session-store.test.ts        NEW
  create-session-store.ts      NEW  maps a bad provider name to InvalidProviderError
  create-session-store.test.ts NEW
  session-recorder.ts          NEW  SessionRecorder: current session, serialised saves
  session-recorder.test.ts     NEW
  resume-messages.ts           NEW  the user-facing sentences
  conversation-note.ts         MOD  TRANSCRIPT_ONLY_NOTE, RESUMED_SEPARATOR, resumedSeparator
  conversation-note.test.ts    MOD
  slash-commands.ts            MOD  resume (Task 10)
  index.ts                     MOD  exports
packages/provider/src/
  index.ts                     MOD  BUILTIN_COMMAND_NAMES gains "resume" (Task 10)
packages/cli/src/
  config.ts                    MOD  sessions.enabled
  config.test.ts               MOD
  create-cli.ts                MOD  auth logout clears sessions; recorder for interactive mode
  cli.e2e.test.ts              MOD  resume, failed restore, logout
  tui/stored-messages.ts       NEW  toStored / fromStored for the TUI Message
  tui/stored-messages.test.ts  NEW
  tui/chat-model.ts            MOD  recorder, persist points, picker state, resume
  tui/chat-model.test.ts       MOD
  tui/mention-popup.ts         MOD  showAll (scrolling), PopupRow.plain
  tui/mention-popup.test.ts    MOD
  tui/chat-view.ts             MOD  picker, history rebuild on historyEpoch
  tui/chat-view.test.ts        MOD
  tui/run-interactive.ts       MOD  recorder wiring, flush at teardown
packages/vscode/src/
  stored-messages.ts           NEW  toStored / fromStored for the protocol Message
  stored-messages.test.ts      NEW
  session-controller.ts        MOD  recorder, persist points, resume, clearSessions
  session-controller.test.ts   MOD
  commands.ts                  MOD  resume handler, logout clears sessions
  commands.test.ts             MOD
  vscode-ui.ts                 MOD  pickSession (QuickPick)
  manifest.ts                  MOD  resume optional, title menu entry
  manifest.test.ts             MOD
  save-sessions-setting.ts     NEW  parseSaveSessions
  save-sessions-setting.test.ts NEW
  create-extension.ts          MOD  store, recorder, command registration, flush on deactivate
  protocol.ts                  MOD  WebviewCommand "resume" (Task 10)
  chat-view-bridge.ts          MOD  COMMAND_LIST (Task 10)
  webview/stream-state.test.ts MOD  replaced history
examples/vscode-dummy-chat/
  package.json                 MOD  resume command, saveSessions setting
  src/extension.ts             MOD  footer text
  test/suite.ts                MOD  resume
docs/…, README.md, upgrade guide, templates   MOD  Task 12
```

Model policy (CLAUDE.md): tasks marked **Sonnet** carry their full code here; tasks marked **Opus** change large existing files and need judgment. Reviews use the same model class as the task. Task 13 is **Fable**.

---

### Task 1: Core — the stored shape (Sonnet)

**Files:**
- Create: `packages/core/src/session-record.ts`, `packages/core/src/session-record.test.ts`
- Modify: `packages/core/src/index.ts` (exports)

**Interfaces:**
- Consumes: nothing.
- Produces: `SESSION_RECORD_VERSION`, `TITLE_MAX`, `NO_PROMPT_TITLE`, types `StoredShell`, `StoredRole`, `StoredMessage`, `SessionRecord`, `SessionSummary`, and functions `isSessionId(id: string): boolean`, `parseSessionRecord(value: unknown): SessionRecord | undefined`, `summarize(record: SessionRecord): SessionSummary`, `formatSessionTime(iso: string): string`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/session-record.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  NO_PROMPT_TITLE,
  type SessionRecord,
  TITLE_MAX,
  formatSessionTime,
  isSessionId,
  parseSessionRecord,
  summarize,
} from "./session-record.js";

const ID = "3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b";

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1,
    id: ID,
    provider: "dummy-chat",
    createdAt: "2026-09-26T05:00:00.000Z",
    updatedAt: "2026-09-26T05:32:00.000Z",
    messages: [
      { role: "user", text: "hello" },
      { role: "assistant", text: "Echo: hello", format: "markdown" },
    ],
    ...over,
  };
}

describe("isSessionId", () => {
  test("accepts a lowercase UUID", () => {
    expect(isSessionId(ID)).toBe(true);
  });

  test.each(["", "../x", "abc", `${ID}.json`, ID.toUpperCase(), `a/${ID}`])(
    "rejects %p",
    (id) => {
      expect(isSessionId(id)).toBe(false);
    },
  );
});

describe("parseSessionRecord", () => {
  test("round-trips a full record through JSON", () => {
    const full = record({
      conversation: "https://example.test/chat/c/abcd1234",
      messages: [
        {
          role: "user",
          text: "look",
          attachments: [{ path: "src/a.ts", bytes: 12 }],
        },
        { role: "assistant", text: "half", incomplete: true },
        { role: "error", text: "Timed out" },
        { role: "separator", text: "reopened" },
        {
          role: "shell",
          text: "ls",
          failed: true,
          shell: {
            command: "ls",
            output: "a\n",
            exitCode: null,
            interrupted: true,
            droppedBytes: 0,
            durationMs: 5,
            signal: "SIGTERM",
          },
        },
      ],
    });
    expect(parseSessionRecord(JSON.parse(JSON.stringify(full)))).toEqual(full);
  });

  test("drops fields it does not know", () => {
    const parsed = parseSessionRecord({
      ...record(),
      extra: 1,
      messages: [{ role: "user", text: "hi", held: true }],
    });
    expect(parsed).toEqual(
      record({ messages: [{ role: "user", text: "hi" }] }),
    );
  });

  test.each([
    ["not an object", "text"],
    ["an array", []],
    ["null", null],
    ["another version", { ...record(), version: 2 }],
    ["no version", { ...record(), version: undefined }],
    ["a bad id", { ...record(), id: "../escape" }],
    ["an empty provider", { ...record(), provider: "" }],
    ["a bad createdAt", { ...record(), createdAt: "yesterday" }],
    ["a numeric updatedAt", { ...record(), updatedAt: 5 }],
    ["an empty conversation", { ...record(), conversation: "" }],
    ["a numeric conversation", { ...record(), conversation: 7 }],
    ["messages that are not a list", { ...record(), messages: {} }],
    ["an unknown role", { ...record(), messages: [{ role: "help", text: "" }] }],
    ["a message without text", { ...record(), messages: [{ role: "user" }] }],
    [
      "a bad attachment",
      {
        ...record(),
        messages: [{ role: "user", text: "", attachments: [{ path: 1 }] }],
      },
    ],
    [
      "a bad format",
      { ...record(), messages: [{ role: "assistant", text: "", format: "x" }] },
    ],
    [
      "incomplete: false",
      {
        ...record(),
        messages: [{ role: "assistant", text: "", incomplete: false }],
      },
    ],
    [
      "a shell result without a command",
      {
        ...record(),
        messages: [{ role: "shell", text: "ls", shell: { output: "" } }],
      },
    ],
  ])("returns undefined for %s", (_name, value) => {
    expect(parseSessionRecord(value)).toBeUndefined();
  });
});

describe("summarize", () => {
  test("takes the first line of the first user message and counts turns", () => {
    const s = summarize(
      record({
        messages: [
          { role: "separator", text: "reopened" },
          { role: "user", text: "\n  first line  \nsecond line" },
          { role: "assistant", text: "a" },
          { role: "user", text: "again" },
        ],
      }),
    );
    expect(s).toEqual({
      id: ID,
      updatedAt: "2026-09-26T05:32:00.000Z",
      title: "first line",
      turns: 2,
    });
  });

  test("truncates a long title with an ellipsis", () => {
    const s = summarize(
      record({ messages: [{ role: "user", text: "x".repeat(200) }] }),
    );
    expect(Array.from(s.title)).toHaveLength(TITLE_MAX);
    expect(s.title.endsWith("…")).toBe(true);
  });

  test("does not split a surrogate pair when truncating", () => {
    const s = summarize(
      record({ messages: [{ role: "user", text: "😀".repeat(200) }] }),
    );
    expect(s.title).toBe(`${"😀".repeat(TITLE_MAX - 1)}…`);
  });

  test("falls back to the first shell command", () => {
    const s = summarize(
      record({
        messages: [
          { role: "shell", text: "git status" },
          { role: "assistant", text: "clean" },
        ],
      }),
    );
    expect(s.title).toBe("! git status");
    expect(s.turns).toBe(0);
  });

  test("has a placeholder when nothing was typed", () => {
    expect(summarize(record({ messages: [] })).title).toBe(NO_PROMPT_TITLE);
  });

  // Review Focus 1.
  test("replaces control characters in the title", () => {
    const s = summarize(
      record({
        messages: [{ role: "user", text: "a\u001b[31mb\u0007c\td\u007f" }],
      }),
    );
    expect(s.title).toBe("a [31mb c d");
  });
});

describe("formatSessionTime", () => {
  test("formats in local time as MM-DD HH:mm", () => {
    // Built from local components, so the assertion holds in any zone.
    const local = new Date(2026, 8, 6, 4, 7);
    expect(formatSessionTime(local.toISOString())).toBe("09-06 04:07");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/core/src/session-record.test.ts`
Expected: FAIL, `Cannot find module './session-record.js'`.

- [ ] **Step 3: Write the implementation**

`packages/core/src/session-record.ts`:

```ts
/** The shape of a saved interactive session. UI-neutral: the TUI and the
 * VSCode host each convert between this and their own message type. */
export const SESSION_RECORD_VERSION = 1;
/** Longest picker title, in code points, the ellipsis included. */
export const TITLE_MAX = 60;
export const NO_PROMPT_TITLE = "(no prompt)";

export interface StoredShell {
  command: string;
  output: string;
  /** null when the command was killed or stopped. */
  exitCode: number | null;
  interrupted: boolean;
  droppedBytes: number;
  durationMs: number;
  signal?: string;
}

export type StoredRole = "user" | "assistant" | "error" | "separator" | "shell";

export interface StoredMessage {
  role: StoredRole;
  text: string;
  attachments?: { path: string; bytes: number }[];
  format?: "markdown";
  incomplete?: true;
  failed?: true;
  shell?: StoredShell;
}

export interface SessionRecord {
  version: typeof SESSION_RECORD_VERSION;
  id: string;
  provider: string;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
  /** The provider's conversation handle as of the last successful turn.
   * Sensitive in the way a URL is: never log it. */
  conversation?: string;
  messages: StoredMessage[];
}

export interface SessionSummary {
  id: string;
  updatedAt: string;
  /** First line of the first user message, cleaned and truncated. */
  title: string;
  /** Number of user messages. */
  turns: number;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An id becomes a file name, so nothing but a lowercase UUID is one. */
export function isSessionId(id: string): boolean {
  return ID.test(id);
}

const ROLES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "error",
  "separator",
  "shell",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isTime(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

function parseShell(v: unknown): StoredShell | undefined {
  if (!isObject(v)) return undefined;
  const {
    command,
    output,
    exitCode,
    interrupted,
    droppedBytes,
    durationMs,
    signal,
  } = v;
  if (typeof command !== "string" || typeof output !== "string") {
    return undefined;
  }
  if (exitCode !== null && typeof exitCode !== "number") return undefined;
  if (typeof interrupted !== "boolean") return undefined;
  if (typeof droppedBytes !== "number" || typeof durationMs !== "number") {
    return undefined;
  }
  if (signal !== undefined && typeof signal !== "string") return undefined;
  return {
    command,
    output,
    exitCode,
    interrupted,
    droppedBytes,
    durationMs,
    ...(signal === undefined ? {} : { signal }),
  };
}

function parseMessage(v: unknown): StoredMessage | undefined {
  if (!isObject(v)) return undefined;
  const { role, text, attachments, format, incomplete, failed, shell } = v;
  if (typeof role !== "string" || !ROLES.has(role)) return undefined;
  if (typeof text !== "string") return undefined;
  const out: StoredMessage = { role: role as StoredRole, text };
  if (attachments !== undefined) {
    if (!Array.isArray(attachments)) return undefined;
    const list: { path: string; bytes: number }[] = [];
    for (const a of attachments) {
      if (
        !isObject(a) ||
        typeof a.path !== "string" ||
        typeof a.bytes !== "number"
      ) {
        return undefined;
      }
      list.push({ path: a.path, bytes: a.bytes });
    }
    out.attachments = list;
  }
  if (format !== undefined) {
    if (format !== "markdown") return undefined;
    out.format = "markdown";
  }
  if (incomplete !== undefined) {
    if (incomplete !== true) return undefined;
    out.incomplete = true;
  }
  if (failed !== undefined) {
    if (failed !== true) return undefined;
    out.failed = true;
  }
  if (shell !== undefined) {
    const parsed = parseShell(shell);
    if (parsed === undefined) return undefined;
    out.shell = parsed;
  }
  return out;
}

/** Validates what was read from disk, which is untrusted input. Returns a
 * copy holding only the known fields, or undefined for anything else: a
 * file this build cannot read is skipped, never repaired. */
export function parseSessionRecord(value: unknown): SessionRecord | undefined {
  if (!isObject(value)) return undefined;
  const { version, id, provider, createdAt, updatedAt, conversation, messages } =
    value;
  if (version !== SESSION_RECORD_VERSION) return undefined;
  if (typeof id !== "string" || !isSessionId(id)) return undefined;
  if (typeof provider !== "string" || provider === "") return undefined;
  if (!isTime(createdAt) || !isTime(updatedAt)) return undefined;
  if (
    conversation !== undefined &&
    (typeof conversation !== "string" || conversation === "")
  ) {
    return undefined;
  }
  if (!Array.isArray(messages)) return undefined;
  const list: StoredMessage[] = [];
  for (const m of messages) {
    const parsed = parseMessage(m);
    if (parsed === undefined) return undefined;
    list.push(parsed);
  }
  return {
    version: SESSION_RECORD_VERSION,
    id,
    provider,
    createdAt,
    updatedAt,
    ...(conversation === undefined ? {} : { conversation }),
    messages: list,
  };
}

function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** A title is drawn in a terminal and in a QuickPick: a control character
 * in it (an escape sequence in a prompt, a hand-edited file) becomes a
 * space. By code point, so a surrogate pair is never split. */
function clean(text: string): string[] {
  return Array.from(text, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? " " : ch;
  });
}

function titleOf(text: string): string {
  // Trimmed after cleaning: a trailing control character became a space.
  const chars = Array.from(clean(text).join("").trim());
  if (chars.length <= TITLE_MAX) return chars.join("");
  return `${chars.slice(0, TITLE_MAX - 1).join("")}…`;
}

export function summarize(record: SessionRecord): SessionSummary {
  let prompt: string | undefined;
  let shell: string | undefined;
  let turns = 0;
  for (const m of record.messages) {
    if (m.role === "user") {
      turns++;
      if (prompt === undefined) {
        const line = firstLine(m.text);
        if (line !== "") prompt = line;
      }
    } else if (m.role === "shell" && shell === undefined) {
      const line = firstLine(m.text);
      if (line !== "") shell = `! ${line}`;
    }
  }
  return {
    id: record.id,
    updatedAt: record.updatedAt,
    title: titleOf(prompt ?? shell ?? NO_PROMPT_TITLE),
    turns,
  };
}

/** `MM-DD HH:mm` in local time, for the pickers. */
export function formatSessionTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
```

Add to `packages/core/src/index.ts`, after the `conversation-note.js` export block:

```ts
export {
  NO_PROMPT_TITLE,
  SESSION_RECORD_VERSION,
  type SessionRecord,
  type SessionSummary,
  type StoredMessage,
  type StoredRole,
  type StoredShell,
  TITLE_MAX,
  formatSessionTime,
  isSessionId,
  parseSessionRecord,
  summarize,
} from "./session-record.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/core/src/session-record.test.ts`
Expected: PASS.

- [ ] **Step 5: Check and commit**

```bash
bunx biome check --write packages/core/src/session-record.ts packages/core/src/session-record.test.ts packages/core/src/index.ts
bun run check
git add packages/core/src/session-record.ts packages/core/src/session-record.test.ts packages/core/src/index.ts
git commit -m "feat(core): stored session shape, validation and summary (Refs #119, #74)"
gh issue comment 119 --body "Task 1 done: core/session-record.ts (stored shape, parseSessionRecord, summarize, formatSessionTime). What's next: Task 2, SessionStore."
```

---

### Task 2: Core — `SessionStore` (Sonnet)

**Files:**
- Create: `packages/core/src/session-store.ts`, `packages/core/src/session-store.test.ts`, `packages/core/src/create-session-store.ts`, `packages/core/src/create-session-store.test.ts`
- Modify: `packages/core/src/index.ts` (exports)

**Interfaces:**
- Consumes: from Task 1 `SessionRecord`, `SessionSummary`, `isSessionId`, `parseSessionRecord`, `summarize`; from `@chatbridge/runtime` `validateProviderName`; from `./errors.js` `InvalidProviderError`.
- Produces:

```ts
export const SESSION_MAX_AGE_MS: number; // 14 days
export const SESSION_MAX_COUNT: number; // 50
export const TEMP_MAX_AGE_MS: number; // 1 hour
export interface SessionStoreOptions {
  configDir: string;
  providerName: string;
  baseDir?: string;
  /** Milliseconds since the epoch; tests inject it. Default Date.now. */
  now?: () => number;
}
export class SessionStore {
  constructor(opts: SessionStoreOptions);
  /** The directory holding this provider's sessions. */
  dir(): string;
  save(record: SessionRecord): Promise<void>;
  load(id: string): Promise<SessionRecord | undefined>;
  /** Prunes, then returns what is left, newest first. */
  list(opts?: { current?: string }): Promise<SessionSummary[]>;
  prune(opts?: { current?: string }): Promise<void>;
  clear(): Promise<void>;
}
export function createSessionStore(opts: SessionStoreOptions): SessionStore;
```

- [ ] **Step 1: Write the failing tests**

`packages/core/src/session-store.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "./session-record.js";
import {
  SESSION_MAX_AGE_MS,
  SESSION_MAX_COUNT,
  SessionStore,
  TEMP_MAX_AGE_MS,
} from "./session-store.js";

const NOW = Date.parse("2026-09-27T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(now: () => number = () => NOW) {
  const baseDir = mkdtempSync(join(tmpdir(), "chatbridge-sessions-"));
  dirs.push(baseDir);
  const store = new SessionStore({
    configDir: "test-cli",
    providerName: "dummy-chat",
    baseDir,
    now,
  });
  return { baseDir, store };
}

/** A valid id whose last 12 hex digits are `n`. */
function idOf(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function record(n: number, updatedAt: number): SessionRecord {
  return {
    version: 1,
    id: idOf(n),
    provider: "dummy-chat",
    createdAt: new Date(updatedAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    conversation: `https://example.test/chat/c/${n}`,
    messages: [
      { role: "user", text: `prompt ${n}` },
      { role: "assistant", text: `reply ${n}` },
    ],
  };
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("SessionStore", () => {
  test("dir() is <base>/<configDir>/sessions/<provider>", () => {
    const { baseDir, store } = setup();
    expect(store.dir()).toBe(
      join(baseDir, "test-cli", "sessions", "dummy-chat"),
    );
  });

  test("rejects a provider name that is not a file name", () => {
    expect(
      () =>
        new SessionStore({ configDir: "test-cli", providerName: "../escape" }),
    ).toThrow();
  });

  test("save then load round-trips", async () => {
    const { store } = setup();
    const r = record(1, NOW);
    await store.save(r);
    expect(await store.load(r.id)).toEqual(r);
  });

  test("directories are 0700 and files 0600", async () => {
    const { baseDir, store } = setup();
    await store.save(record(1, NOW));
    expect(mode(join(baseDir, "test-cli", "sessions"))).toBe(0o700);
    expect(mode(store.dir())).toBe(0o700);
    expect(mode(join(store.dir(), `${idOf(1)}.json`))).toBe(0o600);
  });

  test("a second save replaces the file and leaves no temporary file", async () => {
    const { store } = setup();
    await store.save(record(1, NOW));
    const next = { ...record(1, NOW + 1000), messages: [] };
    await store.save(next);
    expect(await store.load(idOf(1))).toEqual(next);
    expect(readdirSync(store.dir())).toEqual([`${idOf(1)}.json`]);
  });

  test("save rejects a malformed id and writes nothing", async () => {
    const { store } = setup();
    await expect(
      store.save({ ...record(1, NOW), id: "../escape" }),
    ).rejects.toThrow("Invalid session id.");
    expect(await store.list()).toEqual([]);
  });

  test("load returns undefined for a malformed id", async () => {
    const { store } = setup();
    expect(await store.load("../../etc/passwd")).toBeUndefined();
  });

  test("load returns undefined for a missing file", async () => {
    const { store } = setup();
    expect(await store.load(idOf(9))).toBeUndefined();
  });

  test("load returns undefined for broken JSON, another version, another id, another provider", async () => {
    const { store } = setup();
    mkdirSync(store.dir(), { recursive: true });
    const write = (n: number, body: string) =>
      writeFileSync(join(store.dir(), `${idOf(n)}.json`), body);
    write(1, "{ not json");
    write(2, JSON.stringify({ ...record(2, NOW), version: 2 }));
    write(3, JSON.stringify(record(4, NOW)));
    write(5, JSON.stringify({ ...record(5, NOW), provider: "other" }));
    for (const n of [1, 2, 3, 5]) {
      expect(await store.load(idOf(n))).toBeUndefined();
    }
  });

  test("list is newest first and skips unreadable files", async () => {
    const { store } = setup();
    await store.save(record(1, NOW - 3 * DAY));
    await store.save(record(2, NOW - 1 * DAY));
    await store.save(record(3, NOW - 2 * DAY));
    writeFileSync(join(store.dir(), `${idOf(4)}.json`), "{ not json");
    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual([idOf(2), idOf(3), idOf(1)]);
    expect(list[0]).toEqual({
      id: idOf(2),
      updatedAt: new Date(NOW - 1 * DAY).toISOString(),
      title: "prompt 2",
      turns: 1,
    });
  });

  test("list on a directory that does not exist is empty", async () => {
    const { store } = setup();
    expect(await store.list()).toEqual([]);
  });

  test("prune deletes records older than the retention period", async () => {
    const { store } = setup();
    await store.save(record(1, NOW - SESSION_MAX_AGE_MS - 1));
    await store.save(record(2, NOW - SESSION_MAX_AGE_MS + 1000));
    await store.prune();
    expect(readdirSync(store.dir())).toEqual([`${idOf(2)}.json`]);
  });

  test("prune keeps the current session whatever its age", async () => {
    const { store } = setup();
    await store.save(record(1, NOW - SESSION_MAX_AGE_MS - DAY));
    await store.prune({ current: idOf(1) });
    expect(readdirSync(store.dir())).toEqual([`${idOf(1)}.json`]);
  });

  test("prune keeps the newest SESSION_MAX_COUNT records", async () => {
    const { store } = setup();
    for (let n = 1; n <= SESSION_MAX_COUNT + 3; n++) {
      await store.save(record(n, NOW - n * 1000));
    }
    const list = await store.list();
    expect(list).toHaveLength(SESSION_MAX_COUNT);
    expect(list[0]?.id).toBe(idOf(1));
    expect(list.at(-1)?.id).toBe(idOf(SESSION_MAX_COUNT));
  });

  test("the cap never deletes the current session", async () => {
    const { store } = setup();
    for (let n = 1; n <= SESSION_MAX_COUNT + 1; n++) {
      await store.save(record(n, NOW - n * 1000));
    }
    const oldest = idOf(SESSION_MAX_COUNT + 1);
    const list = await store.list({ current: oldest });
    expect(list.map((s) => s.id)).toContain(oldest);
  });

  test("an unreadable file goes by its mtime and is not counted", async () => {
    const { store } = setup();
    await store.save(record(1, NOW));
    const fresh = join(store.dir(), `${idOf(2)}.json`);
    const stale = join(store.dir(), `${idOf(3)}.json`);
    writeFileSync(fresh, "{ not json");
    writeFileSync(stale, "{ not json");
    const old = (NOW - SESSION_MAX_AGE_MS - DAY) / 1000;
    utimesSync(fresh, NOW / 1000, NOW / 1000);
    utimesSync(stale, old, old);
    await store.prune();
    expect(readdirSync(store.dir()).sort()).toEqual(
      [`${idOf(1)}.json`, `${idOf(2)}.json`].sort(),
    );
  });

  test("a stale temporary file is removed, a fresh one is left", async () => {
    const { store } = setup();
    await store.save(record(1, NOW));
    const fresh = join(store.dir(), `${idOf(1)}.aaaa.tmp`);
    const stale = join(store.dir(), `${idOf(1)}.bbbb.tmp`);
    writeFileSync(fresh, "x");
    writeFileSync(stale, "x");
    const old = (NOW - TEMP_MAX_AGE_MS - 1000) / 1000;
    utimesSync(fresh, NOW / 1000, NOW / 1000);
    utimesSync(stale, old, old);
    await store.prune();
    expect(readdirSync(store.dir()).sort()).toEqual(
      [`${idOf(1)}.json`, `${idOf(1)}.aaaa.tmp`].sort(),
    );
  });

  test("files that are neither .json nor .tmp are left alone", async () => {
    const { store } = setup();
    await store.save(record(1, NOW));
    writeFileSync(join(store.dir(), "README"), "x");
    await store.prune();
    expect(readdirSync(store.dir()).sort()).toEqual(
      ["README", `${idOf(1)}.json`].sort(),
    );
  });

  // Review Focus 2: another process deleted the file first.
  test("prune and list survive a directory another process emptied", async () => {
    const { store } = setup();
    await store.save(record(1, NOW - SESSION_MAX_AGE_MS - DAY));
    rmSync(store.dir(), { recursive: true, force: true });
    await store.prune();
    expect(await store.list()).toEqual([]);
  });

  test("clear deletes every session of the provider and nothing else", async () => {
    const { baseDir, store } = setup();
    await store.save(record(1, NOW));
    const other = new SessionStore({
      configDir: "test-cli",
      providerName: "other",
      baseDir,
      now: () => NOW,
    });
    await other.save({ ...record(2, NOW), provider: "other" });
    await store.clear();
    expect(await store.list()).toEqual([]);
    expect((await other.list()).map((s) => s.id)).toEqual([idOf(2)]);
  });

  test("clear on a directory that does not exist resolves", async () => {
    const { store } = setup();
    await store.clear();
  });
});
```

`packages/core/src/create-session-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createSessionStore } from "./create-session-store.js";
import { InvalidProviderError } from "./errors.js";
import { SessionStore } from "./session-store.js";

describe("createSessionStore", () => {
  test("builds a SessionStore", () => {
    expect(
      createSessionStore({ configDir: "test-cli", providerName: "dummy-chat" }),
    ).toBeInstanceOf(SessionStore);
  });

  test("maps an unusable provider name to InvalidProviderError", () => {
    expect(() =>
      createSessionStore({ configDir: "test-cli", providerName: "../escape" }),
    ).toThrow(InvalidProviderError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/src/session-store.test.ts packages/core/src/create-session-store.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementation**

`packages/core/src/session-store.ts`:

```ts
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateProviderName } from "@chatbridge/runtime";
import {
  type SessionRecord,
  type SessionSummary,
  isSessionId,
  parseSessionRecord,
  summarize,
} from "./session-record.js";

export const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_COUNT = 50;
export const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

const JSON_EXT = ".json";
const TEMP_EXT = ".tmp";

export interface SessionStoreOptions {
  /** Directory name under the base dir, e.g. "chatbridge". */
  configDir: string;
  /** Provider name; becomes the directory the sessions live in. */
  providerName: string;
  /** Base directory; defaults to ~/.config. Overridable for tests. */
  baseDir?: string;
  /** Milliseconds since the epoch. Default Date.now; tests inject it. */
  now?: () => number;
}

/** Saved interactive sessions of one provider, one JSON file each. The
 * content is what the user and the assistant wrote plus the conversation
 * handle: never log it. No method here logs anything. */
export class SessionStore {
  private readonly parent: string;
  private readonly root: string;
  private readonly provider: string;
  private readonly now: () => number;

  constructor(opts: SessionStoreOptions) {
    validateProviderName(opts.providerName);
    const base = opts.baseDir ?? join(homedir(), ".config");
    this.parent = join(base, opts.configDir, "sessions");
    this.root = join(this.parent, opts.providerName);
    this.provider = opts.providerName;
    this.now = opts.now ?? Date.now;
  }

  dir(): string {
    return this.root;
  }

  private fileOf(id: string): string {
    return join(this.root, `${id}${JSON_EXT}`);
  }

  /** Writes the whole record to a temporary file, syncs it, and renames it
   * over the target: a crash leaves the old content or the new, never a
   * truncated file. */
  async save(record: SessionRecord): Promise<void> {
    if (!isSessionId(record.id)) throw new Error("Invalid session id.");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by umask, and is not applied to a directory
    // that already existed; enforce both levels.
    await chmod(this.parent, 0o700);
    await chmod(this.root, 0o700);
    const temp = join(this.root, `${record.id}.${randomUUID()}${TEMP_EXT}`);
    try {
      const handle = await open(temp, "w", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temp, 0o600);
      await rename(temp, this.fileOf(record.id));
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /** Undefined for a malformed id, a missing file and an unreadable one:
   * the caller cannot do anything different about them. */
  async load(id: string): Promise<SessionRecord | undefined> {
    if (!isSessionId(id)) return undefined;
    let raw: string;
    try {
      raw = await readFile(this.fileOf(id), "utf8");
    } catch {
      return undefined;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const record = parseSessionRecord(doc);
    if (record === undefined) return undefined;
    // A file renamed by hand, or copied from another provider's directory.
    if (record.id !== id || record.provider !== this.provider) return undefined;
    return record;
  }

  async list(opts: { current?: string } = {}): Promise<SessionSummary[]> {
    const records = await this.sweep(opts.current);
    return records.map(summarize);
  }

  async prune(opts: { current?: string } = {}): Promise<void> {
    await this.sweep(opts.current);
  }

  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  private async mtimeOf(path: string): Promise<number | undefined> {
    try {
      return (await stat(path)).mtimeMs;
    } catch {
      return undefined;
    }
  }

  /** Best effort: another process may have deleted it first. */
  private async remove(path: string): Promise<void> {
    await rm(path, { force: true }).catch(() => {});
  }

  /** One pass over the directory: deletes what the retention rules say and
   * returns the records that remain, newest first. Never throws. */
  private async sweep(current: string | undefined): Promise<SessionRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const now = this.now();
    const records: SessionRecord[] = [];
    for (const name of names) {
      const path = join(this.root, name);
      if (name.endsWith(TEMP_EXT)) {
        const mtime = await this.mtimeOf(path);
        if (mtime !== undefined && now - mtime > TEMP_MAX_AGE_MS) {
          await this.remove(path);
        }
        continue;
      }
      if (!name.endsWith(JSON_EXT)) continue;
      const record = await this.load(name.slice(0, -JSON_EXT.length));
      if (record === undefined) {
        // Unreadable: never deleted on sight, since a newer build may have
        // written it. It goes by age, and the cap does not count it.
        const mtime = await this.mtimeOf(path);
        if (mtime !== undefined && now - mtime > SESSION_MAX_AGE_MS) {
          await this.remove(path);
        }
        continue;
      }
      if (
        record.id !== current &&
        now - Date.parse(record.updatedAt) > SESSION_MAX_AGE_MS
      ) {
        await this.remove(path);
        continue;
      }
      records.push(record);
    }
    records.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const kept: SessionRecord[] = [];
    for (const record of records) {
      if (kept.length < SESSION_MAX_COUNT || record.id === current) {
        kept.push(record);
      } else {
        await this.remove(this.fileOf(record.id));
      }
    }
    return kept;
  }
}
```

`packages/core/src/create-session-store.ts`:

```ts
import { validateProviderName } from "@chatbridge/runtime";
import { InvalidProviderError } from "./errors.js";
import { SessionStore, type SessionStoreOptions } from "./session-store.js";

/** Builds a SessionStore, translating an unusable provider name into the
 * framework error the CLI maps to exit code 5. */
export function createSessionStore(opts: SessionStoreOptions): SessionStore {
  try {
    validateProviderName(opts.providerName);
  } catch (err) {
    throw new InvalidProviderError(
      `Provider name ${JSON.stringify(opts.providerName)} cannot be used as a file name: use lowercase letters, digits, ".", "_" or "-" (1-64 chars, starting with a letter or digit).`,
      { cause: err },
    );
  }
  return new SessionStore(opts);
}
```

Add to `packages/core/src/index.ts`:

```ts
export {
  SESSION_MAX_AGE_MS,
  SESSION_MAX_COUNT,
  SessionStore,
  type SessionStoreOptions,
  TEMP_MAX_AGE_MS,
} from "./session-store.js";
export { createSessionStore } from "./create-session-store.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/core/src/session-store.test.ts packages/core/src/create-session-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Check and commit**

```bash
bunx biome check --write packages/core/src/session-store.ts packages/core/src/session-store.test.ts packages/core/src/create-session-store.ts packages/core/src/create-session-store.test.ts packages/core/src/index.ts
bun run check
git add packages/core/src
git commit -m "feat(core): SessionStore with atomic save and pruning (Refs #119, #74)"
gh issue comment 119 --body "Task 2 done: core SessionStore (atomic save, load, list, prune, clear) and createSessionStore. What's next: Task 3, SessionRecorder and the shared wording."
```

---

### Task 3: Core — `SessionRecorder` and the shared wording (Sonnet)

**Files:**
- Create: `packages/core/src/session-recorder.ts`, `packages/core/src/session-recorder.test.ts`, `packages/core/src/resume-messages.ts`
- Modify: `packages/core/src/conversation-note.ts`, `packages/core/src/conversation-note.test.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: from Task 1 `SessionRecord`, `SessionSummary`, `StoredMessage`, `SESSION_RECORD_VERSION`; from Task 2 the method shapes of `SessionStore`.
- Produces:

```ts
// session-recorder.ts
export interface SessionStoreLike {
  save(record: SessionRecord): Promise<void>;
  load(id: string): Promise<SessionRecord | undefined>;
  list(opts?: { current?: string }): Promise<SessionSummary[]>;
  prune(opts?: { current?: string }): Promise<void>;
  clear(): Promise<void>;
}
export interface SessionSnapshot {
  conversation: string | undefined;
  messages: StoredMessage[];
}
export interface SessionRecorderOptions {
  store: SessionStoreLike;
  provider: string;
  /** Read on every call, so a setting changed mid-session applies. Default: on. */
  enabled?: () => boolean;
  /** Called once per session, the first time a save fails. */
  onSaveFailed?: () => void;
  now?: () => number;
  newId?: () => string;
}
export class SessionRecorder {
  constructor(opts: SessionRecorderOptions);
  get enabled(): boolean;
  /** The current session's id; undefined until it has something to save. */
  get id(): string | undefined;
  /** Queues a save of the current session. Returns at once. */
  record(snapshot: SessionSnapshot): void;
  /** The next record() starts a new session. */
  startNew(): void;
  /** The current session becomes `record`'s: later saves rewrite its file. */
  adopt(record: SessionRecord): void;
  /** Saved sessions except the current one, newest first. */
  list(): Promise<SessionSummary[]>;
  load(id: string): Promise<SessionRecord | undefined>;
  /** Logout: deletes every session and starts a new one. Rejects when the
   * delete failed. Runs whether or not saving is enabled. */
  clear(): Promise<void>;
  /** Settles when every queued save has. Never rejects. */
  flush(): Promise<void>;
}

// conversation-note.ts
export const TRANSCRIPT_ONLY_NOTE = "transcript only";
export const RESUMED_SEPARATOR = "resumed";
export function resumedSeparator(restored: boolean | undefined): string;

// resume-messages.ts
export const RESUME_BUSY_MESSAGE = "Wait for the current step to finish before /resume.";
export const SESSIONS_OFF_MESSAGE = "Session saving is turned off.";
export const NO_SESSIONS_MESSAGE = "No saved sessions.";
export const SESSION_UNREADABLE_MESSAGE = "That session could not be loaded.";
export const SAVE_FAILED_MESSAGE = "Could not save this session.";
export const SESSIONS_NOT_DELETED_MESSAGE = "Could not delete the saved sessions.";
```

- [ ] **Step 1: Write the failing tests**

`packages/core/src/session-recorder.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  SessionRecorder,
  type SessionRecorderOptions,
  type SessionStoreLike,
} from "./session-recorder.js";
import type { SessionRecord, StoredMessage } from "./session-record.js";

const NOW = Date.parse("2026-09-27T00:00:00.000Z");

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An in-memory store that logs every call. `gate`, when set, holds the
 * next save until the test resolves it. */
function fakeStore() {
  const files = new Map<string, SessionRecord>();
  const log: string[] = [];
  const state = {
    failSave: false,
    failClear: false,
    gate: undefined as ReturnType<typeof deferred<void>> | undefined,
  };
  const store: SessionStoreLike = {
    async save(record) {
      log.push(`save:${record.id}:${record.messages.length}`);
      if (state.gate) {
        const gate = state.gate;
        state.gate = undefined;
        await gate.promise;
      }
      if (state.failSave) throw new Error("disk full");
      files.set(record.id, structuredClone(record));
    },
    async load(id) {
      log.push(`load:${id}`);
      return files.get(id);
    },
    async list(opts) {
      log.push(`list:${opts?.current ?? "-"}`);
      return [...files.values()]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .map((r) => ({
          id: r.id,
          updatedAt: r.updatedAt,
          title: r.messages[0]?.text ?? "",
          turns: r.messages.filter((m) => m.role === "user").length,
        }));
    },
    async prune(opts) {
      log.push(`prune:${opts?.current ?? "-"}`);
    },
    async clear() {
      log.push("clear");
      if (state.failClear) throw new Error("permission denied");
      files.clear();
    },
  };
  return { store, files, log, state };
}

function setup(over: Partial<SessionRecorderOptions> = {}) {
  const s = fakeStore();
  let clock = NOW;
  let next = 1;
  const failures: number[] = [];
  const recorder = new SessionRecorder({
    store: s.store,
    provider: "dummy-chat",
    now: () => clock,
    newId: () => `id-${next++}`,
    onSaveFailed: () => failures.push(1),
    ...over,
  });
  return {
    ...s,
    recorder,
    failures,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const user = (text: string): StoredMessage => ({ role: "user", text });
const reply = (text: string): StoredMessage => ({ role: "assistant", text });
const turn = (n: number): StoredMessage[] => [user(`q${n}`), reply(`a${n}`)];

describe("SessionRecorder", () => {
  test("saves nothing until there is a user or shell message", async () => {
    const t = setup();
    t.recorder.record({
      conversation: undefined,
      messages: [{ role: "separator", text: "reopened" }],
    });
    await t.recorder.flush();
    expect(t.log).toEqual([]);
    expect(t.recorder.id).toBeUndefined();
  });

  test("the first save creates the record and prunes once", async () => {
    const t = setup();
    t.recorder.record({ conversation: "H1", messages: turn(1) });
    await t.recorder.flush();
    expect(t.recorder.id).toBe("id-1");
    expect(t.files.get("id-1")).toEqual({
      version: 1,
      id: "id-1",
      provider: "dummy-chat",
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      conversation: "H1",
      messages: turn(1),
    });
    expect(t.log).toEqual(["save:id-1:2", "prune:id-1"]);
  });

  test("a shell message alone is enough to start a session", async () => {
    const t = setup();
    t.recorder.record({
      conversation: undefined,
      messages: [{ role: "shell", text: "ls" }],
    });
    await t.recorder.flush();
    expect(t.files.has("id-1")).toBe(true);
  });

  test("later saves rewrite the same file, keep createdAt, move updatedAt, and do not prune", async () => {
    const t = setup();
    t.recorder.record({ conversation: "H1", messages: turn(1) });
    await t.recorder.flush();
    t.tick(5000);
    t.recorder.record({
      conversation: "H2",
      messages: [...turn(1), ...turn(2)],
    });
    await t.recorder.flush();
    const saved = t.files.get("id-1");
    expect(saved?.createdAt).toBe(new Date(NOW).toISOString());
    expect(saved?.updatedAt).toBe(new Date(NOW + 5000).toISOString());
    expect(saved?.conversation).toBe("H2");
    expect(saved?.messages).toHaveLength(4);
    expect(t.log).toEqual(["save:id-1:2", "prune:id-1", "save:id-1:4"]);
  });

  test("a snapshot without a handle writes no conversation key", async () => {
    const t = setup();
    t.recorder.record({ conversation: "H1", messages: turn(1) });
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    await t.recorder.flush();
    expect("conversation" in (t.files.get("id-1") ?? {})).toBe(false);
  });

  test("the snapshot is copied: a later mutation does not reach the file", async () => {
    const t = setup();
    const messages = turn(1);
    t.recorder.record({ conversation: undefined, messages });
    messages.push(user("later"));
    await t.recorder.flush();
    expect(t.files.get("id-1")?.messages).toHaveLength(2);
  });

  // Review Focus 3.
  test("saves are serialised: the newer snapshot lands last", async () => {
    const t = setup();
    t.state.gate = deferred<void>();
    const gate = t.state.gate;
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    t.recorder.record({
      conversation: undefined,
      messages: [...turn(1), ...turn(2)],
    });
    // Only the first save has started; the second waits for it.
    await Promise.resolve();
    await Promise.resolve();
    expect(t.log).toEqual(["save:id-1:2"]);
    gate.resolve();
    await t.recorder.flush();
    expect(t.files.get("id-1")?.messages).toHaveLength(4);
  });

  test("startNew makes the next record a new session", async () => {
    const t = setup();
    t.recorder.record({ conversation: "H1", messages: turn(1) });
    t.recorder.startNew();
    expect(t.recorder.id).toBeUndefined();
    t.recorder.record({ conversation: undefined, messages: turn(2) });
    await t.recorder.flush();
    expect([...t.files.keys()]).toEqual(["id-1", "id-2"]);
    expect(t.files.get("id-1")?.messages).toEqual(turn(1));
  });

  test("adopt continues the adopted record", async () => {
    const t = setup();
    const old: SessionRecord = {
      version: 1,
      id: "old",
      provider: "dummy-chat",
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
      conversation: "H9",
      messages: turn(9),
    };
    t.files.set("old", old);
    t.recorder.adopt(old);
    expect(t.recorder.id).toBe("old");
    t.recorder.record({
      conversation: "H9",
      messages: [...turn(9), ...turn(10)],
    });
    await t.recorder.flush();
    expect(t.files.get("old")?.createdAt).toBe("2026-09-20T00:00:00.000Z");
    expect(t.files.get("old")?.updatedAt).toBe(new Date(NOW).toISOString());
    // Adopted, not created: no prune.
    expect(t.log).toEqual(["save:old:4"]);
  });

  test("list waits for queued saves and leaves the current session out", async () => {
    const t = setup();
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    t.recorder.startNew();
    t.tick(1000);
    t.recorder.record({ conversation: undefined, messages: turn(2) });
    const list = await t.recorder.list();
    expect(list.map((s) => s.id)).toEqual(["id-1"]);
    expect(t.log.at(-1)).toBe("list:id-2");
  });

  test("load passes through", async () => {
    const t = setup();
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    await t.recorder.flush();
    expect((await t.recorder.load("id-1"))?.id).toBe("id-1");
    expect(await t.recorder.load("nope")).toBeUndefined();
  });

  // Review Focus 4.
  test("a failed save reports once per session and the next save tries again", async () => {
    const t = setup();
    t.state.failSave = true;
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    await t.recorder.flush();
    expect(t.failures).toHaveLength(1);
    t.state.failSave = false;
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    await t.recorder.flush();
    expect(t.files.has("id-1")).toBe(true);
    // The first successful save of the session prunes.
    expect(t.log.at(-1)).toBe("prune:id-1");
  });

  test("a new session reports its own first failure", async () => {
    const t = setup();
    t.state.failSave = true;
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    t.recorder.startNew();
    t.recorder.record({ conversation: undefined, messages: turn(2) });
    await t.recorder.flush();
    expect(t.failures).toHaveLength(2);
  });

  test("a throwing prune is not a failed save", async () => {
    const t = setup();
    t.store.prune = async () => {
      throw new Error("boom");
    };
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    await t.recorder.flush();
    expect(t.failures).toEqual([]);
    expect(t.files.has("id-1")).toBe(true);
  });

  test("flush never rejects", async () => {
    const t = setup();
    t.state.failSave = true;
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    await t.recorder.flush();
  });

  test("clear runs after queued saves, deletes, and starts a new session", async () => {
    const t = setup();
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    await t.recorder.clear();
    expect(t.log).toEqual(["save:id-1:2", "prune:id-1", "clear"]);
    expect(t.files.size).toBe(0);
    expect(t.recorder.id).toBeUndefined();
  });

  test("clear rejects when the delete failed, and the recorder stays usable", async () => {
    const t = setup();
    t.state.failClear = true;
    await expect(t.recorder.clear()).rejects.toThrow("permission denied");
    t.recorder.record({ conversation: undefined, messages: turn(1) });
    await t.recorder.flush();
    expect(t.files.has("id-1")).toBe(true);
  });

  describe("when saving is off", () => {
    test("record and list do nothing", async () => {
      const t = setup({ enabled: () => false });
      expect(t.recorder.enabled).toBe(false);
      t.recorder.record({ conversation: undefined, messages: turn(1) });
      expect(await t.recorder.list()).toEqual([]);
      await t.recorder.flush();
      expect(t.log).toEqual([]);
    });

    test("clear still deletes", async () => {
      const t = setup({ enabled: () => false });
      await t.recorder.clear();
      expect(t.log).toEqual(["clear"]);
    });

    test("the setting is read on every call", async () => {
      let on = false;
      const t = setup({ enabled: () => on });
      t.recorder.record({ conversation: undefined, messages: turn(1) });
      on = true;
      t.recorder.record({ conversation: undefined, messages: turn(1) });
      await t.recorder.flush();
      expect(t.log).toEqual(["save:id-1:2", "prune:id-1"]);
    });
  });
});
```

Append to `packages/core/src/conversation-note.test.ts` (inside the file's top-level `describe`, or as a new `describe` at the end; keep the existing imports and add the three new names to them):

```ts
describe("resumedSeparator", () => {
  test("restored", () => {
    expect(resumedSeparator(true)).toBe("resumed · conversation restored");
  });

  test("could not be restored", () => {
    expect(resumedSeparator(false)).toBe(
      "resumed · conversation could not be restored",
    );
  });

  test("nothing to restore", () => {
    expect(resumedSeparator(undefined)).toBe("resumed · transcript only");
  });

  test("is built from the exported parts", () => {
    expect(resumedSeparator(undefined)).toBe(
      `${RESUMED_SEPARATOR} · ${TRANSCRIPT_ONLY_NOTE}`,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/src/session-recorder.test.ts packages/core/src/conversation-note.test.ts`
Expected: FAIL, module and names not found.

- [ ] **Step 3: Write the implementation**

`packages/core/src/resume-messages.ts`:

```ts
/** Sentences both interactive UIs show around saved sessions, so the TUI
 * and the VSCode view say the same thing. */
export const RESUME_BUSY_MESSAGE =
  "Wait for the current step to finish before /resume.";
export const SESSIONS_OFF_MESSAGE = "Session saving is turned off.";
export const NO_SESSIONS_MESSAGE = "No saved sessions.";
export const SESSION_UNREADABLE_MESSAGE = "That session could not be loaded.";
export const SAVE_FAILED_MESSAGE = "Could not save this session.";
export const SESSIONS_NOT_DELETED_MESSAGE =
  "Could not delete the saved sessions.";
```

Append to `packages/core/src/conversation-note.ts`:

```ts
/** A resume that had no handle to open, or a provider that cannot name its
 * conversations: the transcript is back, the service starts a new chat. */
export const TRANSCRIPT_ONLY_NOTE = "transcript only";
export const RESUMED_SEPARATOR = "resumed";

/** The separator a `/resume` leaves. Unlike a reopen it always carries a
 * note: a transcript on screen with no word on whether the service still
 * knows it would mislead. */
export function resumedSeparator(restored: boolean | undefined): string {
  return `${RESUMED_SEPARATOR} · ${restoreNote(restored) ?? TRANSCRIPT_ONLY_NOTE}`;
}
```

`packages/core/src/session-recorder.ts`:

```ts
import { randomUUID } from "node:crypto";
import {
  SESSION_RECORD_VERSION,
  type SessionRecord,
  type SessionSummary,
  type StoredMessage,
} from "./session-record.js";

/** What the recorder needs from a SessionStore; lets tests inject a fake. */
export interface SessionStoreLike {
  save(record: SessionRecord): Promise<void>;
  load(id: string): Promise<SessionRecord | undefined>;
  list(opts?: { current?: string }): Promise<SessionSummary[]>;
  prune(opts?: { current?: string }): Promise<void>;
  clear(): Promise<void>;
}

/** The settled history of the current session and its handle. */
export interface SessionSnapshot {
  conversation: string | undefined;
  messages: StoredMessage[];
}

export interface SessionRecorderOptions {
  store: SessionStoreLike;
  provider: string;
  /** Read on every call, so a setting changed mid-session applies.
   * Default: always on. */
  enabled?: () => boolean;
  /** Called once per session, the first time a save fails. */
  onSaveFailed?: () => void;
  /** Milliseconds since the epoch. Default Date.now. */
  now?: () => number;
  /** Default crypto.randomUUID. */
  newId?: () => string;
}

interface Current {
  id: string;
  createdAt: string;
  /** False until the first save landed: that one prunes. */
  created: boolean;
  /** The save-failure notice was raised for this session. */
  reported: boolean;
}

/** Which saved session the UI is in, and the queue of its saves. Shared by
 * the TUI model and the VSCode controller. No UI dependency; nothing here
 * logs, and no error carries message text or the handle. */
export class SessionRecorder {
  private current: Current | undefined;
  /** Every save chains on this, so they land in the order they were asked
   * for. It never rejects. */
  private tail: Promise<void> = Promise.resolve();
  private readonly store: SessionStoreLike;
  private readonly provider: string;
  private readonly isEnabled: () => boolean;
  private readonly onSaveFailed: () => void;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(opts: SessionRecorderOptions) {
    this.store = opts.store;
    this.provider = opts.provider;
    this.isEnabled = opts.enabled ?? (() => true);
    this.onSaveFailed = opts.onSaveFailed ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? randomUUID;
  }

  get enabled(): boolean {
    return this.isEnabled();
  }

  get id(): string | undefined {
    return this.current?.id;
  }

  record(snapshot: SessionSnapshot): void {
    if (!this.enabled) return;
    if (this.current === undefined) {
      // A session in which nothing was sent leaves no file.
      const started = snapshot.messages.some(
        (m) => m.role === "user" || m.role === "shell",
      );
      if (!started) return;
      this.current = {
        id: this.newId(),
        createdAt: new Date(this.now()).toISOString(),
        created: false,
        reported: false,
      };
    }
    const session = this.current;
    const record: SessionRecord = {
      version: SESSION_RECORD_VERSION,
      id: session.id,
      provider: this.provider,
      createdAt: session.createdAt,
      updatedAt: new Date(this.now()).toISOString(),
      ...(snapshot.conversation === undefined
        ? {}
        : { conversation: snapshot.conversation }),
      // Copied now: the caller's arrays keep changing while this waits.
      messages: structuredClone(snapshot.messages),
    };
    this.tail = this.tail.then(() => this.write(session, record));
  }

  private async write(session: Current, record: SessionRecord): Promise<void> {
    try {
      await this.store.save(record);
    } catch {
      if (!session.reported) {
        session.reported = true;
        this.onSaveFailed();
      }
      return;
    }
    if (session.created) return;
    session.created = true;
    // Housekeeping only: a failure here is not the user's problem.
    await this.store.prune({ current: session.id }).catch(() => {});
  }

  startNew(): void {
    this.current = undefined;
  }

  adopt(record: SessionRecord): void {
    this.current = {
      id: record.id,
      createdAt: record.createdAt,
      created: true,
      reported: false,
    };
  }

  async list(): Promise<SessionSummary[]> {
    if (!this.enabled) return [];
    await this.tail;
    const current = this.current?.id;
    const all = await this.store.list(
      current === undefined ? {} : { current },
    );
    return all.filter((s) => s.id !== current);
  }

  async load(id: string): Promise<SessionRecord | undefined> {
    await this.tail;
    return this.store.load(id);
  }

  clear(): Promise<void> {
    this.current = undefined;
    // After the queue, so a save still in flight cannot recreate a file.
    const run = this.tail.then(() => this.store.clear());
    this.tail = run.catch(() => {});
    return run;
  }

  flush(): Promise<void> {
    return this.tail;
  }
}
```

Add to `packages/core/src/index.ts`. Extend the existing `conversation-note.js` block with `RESUMED_SEPARATOR`, `TRANSCRIPT_ONLY_NOTE`, `resumedSeparator`, and add:

```ts
export {
  SessionRecorder,
  type SessionRecorderOptions,
  type SessionSnapshot,
  type SessionStoreLike,
} from "./session-recorder.js";
export {
  NO_SESSIONS_MESSAGE,
  RESUME_BUSY_MESSAGE,
  SAVE_FAILED_MESSAGE,
  SESSIONS_NOT_DELETED_MESSAGE,
  SESSIONS_OFF_MESSAGE,
  SESSION_UNREADABLE_MESSAGE,
} from "./resume-messages.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/core/src/session-recorder.test.ts packages/core/src/conversation-note.test.ts`
Expected: PASS.

- [ ] **Step 5: Check and commit**

```bash
bunx biome check --write packages/core/src
bun run check
git add packages/core/src
git commit -m "feat(core): SessionRecorder and the resume wording (Refs #119, #74)"
gh issue comment 119 --body "Task 3 done: core SessionRecorder (serialised saves, one failure notice per session), resumedSeparator, resume messages. What's next: Task 4, CLI config key, TUI message conversion, auth logout."
```

---

### Task 4: CLI — `sessions.enabled`, TUI message conversion, `auth logout` (Sonnet)

**Files:**
- Create: `packages/cli/src/tui/stored-messages.ts`, `packages/cli/src/tui/stored-messages.test.ts`
- Modify: `packages/cli/src/config.ts`, `packages/cli/src/config.test.ts`, `packages/cli/src/create-cli.ts` (the `auth logout` branch), `packages/cli/src/create-cli.test.ts`

**Interfaces:**
- Consumes: from core `StoredMessage`, `createSessionStore`, `SessionStore`; from `./tui/chat-model.js` the `Message` type; from `../shell/run-command.js` `ShellResult`.
- Produces:

```ts
// config.ts
export interface CliConfig {
  // …existing keys…
  /** Saved interactive sessions. `enabled: false` turns saving and
   * `/resume` off. Default: on. */
  sessions?: { enabled?: boolean };
}

// tui/stored-messages.ts
export function toStored(messages: readonly Message[]): StoredMessage[];
export function fromStored(stored: readonly StoredMessage[]): Message[];
```

Run `bun run build` first: this task imports names Task 1–3 added to core's `dist`.

- [ ] **Step 1: Write the failing tests**

Append to the `describe("loadConfig", …)` block of `packages/cli/src/config.test.ts`:

```ts
  test("reads sessions.enabled", async () => {
    writeFileSync(setup(), JSON.stringify({ sessions: { enabled: false } }));
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect(cfg.sessions).toEqual({ enabled: false });
  });

  test("an empty sessions object is accepted", async () => {
    writeFileSync(setup(), JSON.stringify({ sessions: {} }));
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect(cfg.sessions).toEqual({});
  });

  test.each([
    ["sessions that is not an object", { sessions: true }, '"sessions" must be an object'],
    ["sessions that is an array", { sessions: [] }, '"sessions" must be an object'],
    ["a string enabled", { sessions: { enabled: "no" } }, '"sessions.enabled" must be a boolean'],
    ["a numeric enabled", { sessions: { enabled: 0 } }, '"sessions.enabled" must be a boolean'],
  ])("%s is INVALID_CONFIG", async (_name, doc, why) => {
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

`packages/cli/src/tui/stored-messages.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { StoredMessage } from "@chatbridge/core";
import type { Message } from "./chat-model.js";
import { fromStored, toStored } from "./stored-messages.js";

const shellResult = {
  command: "ls",
  output: "a\n",
  droppedBytes: 3,
  exitCode: 0,
  interrupted: false,
  durationMs: 12,
};

describe("toStored", () => {
  test("keeps user, assistant, error and separator entries", () => {
    const messages: Message[] = [
      {
        role: "user",
        text: "look",
        attachments: [{ path: "src/a.ts", bytes: 12 }],
      },
      { role: "assistant", text: "**hi**", format: "markdown" },
      { role: "assistant", text: "half", incomplete: true },
      { role: "error", text: "Timed out" },
      { role: "separator", text: "reopened" },
    ];
    expect(toStored(messages)).toEqual([
      {
        role: "user",
        text: "look",
        attachments: [{ path: "src/a.ts", bytes: 12 }],
      },
      { role: "assistant", text: "**hi**", format: "markdown" },
      { role: "assistant", text: "half", incomplete: true },
      { role: "error", text: "Timed out" },
      { role: "separator", text: "reopened" },
    ]);
  });

  test("drops help entries", () => {
    expect(
      toStored([
        { role: "help", text: "/help …" },
        { role: "user", text: "hi" },
      ]),
    ).toEqual([{ role: "user", text: "hi" }]);
  });

  test("stores a shell result, with null for a missing exit code", () => {
    expect(
      toStored([
        {
          role: "shell",
          text: "sleep 9",
          held: true,
          result: {
            ...shellResult,
            command: "sleep 9",
            exitCode: undefined,
            interrupted: true,
            signal: "SIGTERM",
          },
        },
      ]),
    ).toEqual([
      {
        role: "shell",
        text: "sleep 9",
        shell: {
          command: "sleep 9",
          output: "a\n",
          droppedBytes: 3,
          exitCode: null,
          interrupted: true,
          durationMs: 12,
          signal: "SIGTERM",
        },
      },
    ]);
  });

  test("keeps failed, never held", () => {
    expect(
      toStored([{ role: "shell", text: "x", failed: true, held: false }]),
    ).toEqual([{ role: "shell", text: "x", failed: true }]);
  });

  test("copies attachments: the stored list is not the model's", () => {
    const attachments = [{ path: "a", bytes: 1 }];
    const [stored] = toStored([{ role: "user", text: "", attachments }]);
    expect(stored?.attachments).not.toBe(attachments);
  });

  test("an empty attachment list is left out", () => {
    expect(toStored([{ role: "user", text: "hi", attachments: [] }])).toEqual([
      { role: "user", text: "hi" },
    ]);
  });
});

describe("fromStored", () => {
  test("is the inverse of toStored for everything toStored keeps", () => {
    const messages: Message[] = [
      {
        role: "user",
        text: "look",
        attachments: [{ path: "src/a.ts", bytes: 12 }],
      },
      { role: "assistant", text: "**hi**", format: "markdown" },
      { role: "assistant", text: "half", incomplete: true },
      { role: "error", text: "Timed out" },
      { role: "separator", text: "reopened" },
      { role: "shell", text: "ls", result: shellResult },
      {
        role: "shell",
        text: "sleep 9",
        failed: true,
        result: {
          ...shellResult,
          exitCode: undefined,
          interrupted: true,
          signal: "SIGTERM",
        },
      },
    ];
    expect(fromStored(toStored(messages))).toEqual(messages);
  });

  test("a stored shell entry without a result has none", () => {
    const stored: StoredMessage[] = [{ role: "shell", text: "ls" }];
    expect(fromStored(stored)).toEqual([{ role: "shell", text: "ls" }]);
  });
});
```

Append to `packages/cli/src/create-cli.test.ts` (add `SessionStore` to the `@chatbridge/core` import):

```ts
describe("auth logout", () => {
  test("deletes the provider's saved sessions", async () => {
    const dir = setup();
    const store = new SessionStore({
      configDir: "test-cli",
      providerName: "stub",
      baseDir: dir,
    });
    await store.save({
      version: 1,
      id: "00000000-0000-4000-8000-000000000001",
      provider: "stub",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [{ role: "user", text: "hi" }],
    });
    const cli = createCli({
      name: "test-cli",
      provider: stubProvider(),
      baseDir: dir,
    });
    expect(await cli.run(["bun", "cli", "auth", "logout"])).toBe(0);
    expect(await store.list()).toEqual([]);
  });

  test("succeeds when there is nothing to delete", async () => {
    const dir = setup();
    const cli = createCli({
      name: "test-cli",
      provider: stubProvider(),
      baseDir: dir,
    });
    expect(await cli.run(["bun", "cli", "auth", "logout"])).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run build && bun test packages/cli/src/config.test.ts packages/cli/src/tui/stored-messages.test.ts packages/cli/src/create-cli.test.ts`
Expected: FAIL (`stored-messages.js` missing, `cfg.sessions` undefined, sessions still listed after logout).

- [ ] **Step 3: Write the implementation**

`packages/cli/src/config.ts` — add to `CliConfig`:

```ts
  /** Saved interactive sessions. `enabled: false` turns saving and
   * `/resume` off. Default: on. */
  sessions?: { enabled?: boolean };
```

In `loadConfig`, destructure `sessions` next to `idle` and add before `return cfg;`:

```ts
  if (sessions !== undefined) {
    if (
      typeof sessions !== "object" ||
      sessions === null ||
      Array.isArray(sessions)
    ) {
      throw invalid(file, '"sessions" must be an object');
    }
    const { enabled } = sessions as Record<string, unknown>;
    const out: NonNullable<CliConfig["sessions"]> = {};
    if (enabled !== undefined) {
      if (typeof enabled !== "boolean") {
        throw invalid(file, '"sessions.enabled" must be a boolean');
      }
      out.enabled = enabled;
    }
    cfg.sessions = out;
  }
```

`packages/cli/src/tui/stored-messages.ts`:

```ts
import type { StoredMessage, StoredShell } from "@chatbridge/core";
import type { ShellResult } from "../shell/run-command.js";
import type { Message } from "./chat-model.js";

function shellOf(result: ShellResult): StoredShell {
  return {
    command: result.command,
    output: result.output,
    droppedBytes: result.droppedBytes,
    // JSON has no undefined: a killed command's exit code is null on disk.
    exitCode: result.exitCode ?? null,
    interrupted: result.interrupted,
    durationMs: result.durationMs,
    ...(result.signal === undefined ? {} : { signal: result.signal }),
  };
}

function resultOf(shell: StoredShell): ShellResult {
  return {
    command: shell.command,
    output: shell.output,
    droppedBytes: shell.droppedBytes,
    exitCode: shell.exitCode ?? undefined,
    interrupted: shell.interrupted,
    durationMs: shell.durationMs,
    ...(shell.signal === undefined
      ? {}
      : { signal: shell.signal as NodeJS.Signals }),
  };
}

/** The TUI history as it is saved. `help` entries are left out: a command
 * listing is not part of the conversation. `held` is left out too: a
 * resumed session has no result waiting to be sent. */
export function toStored(messages: readonly Message[]): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (const m of messages) {
    if (m.role === "help") continue;
    const stored: StoredMessage = { role: m.role, text: m.text };
    if (m.attachments !== undefined && m.attachments.length > 0) {
      stored.attachments = m.attachments.map(({ path, bytes }) => ({
        path,
        bytes,
      }));
    }
    if (m.format === "markdown") stored.format = "markdown";
    if (m.incomplete === true) stored.incomplete = true;
    if (m.failed === true) stored.failed = true;
    if (m.result !== undefined) stored.shell = shellOf(m.result);
    out.push(stored);
  }
  return out;
}

/** A saved history as TUI messages. */
export function fromStored(stored: readonly StoredMessage[]): Message[] {
  return stored.map((s) => {
    const m: Message = { role: s.role, text: s.text };
    if (s.attachments !== undefined) {
      m.attachments = s.attachments.map(({ path, bytes }) => ({ path, bytes }));
    }
    if (s.format === "markdown") m.format = "markdown";
    if (s.incomplete === true) m.incomplete = true;
    if (s.failed === true) m.failed = true;
    if (s.shell !== undefined) m.result = resultOf(s.shell);
    return m;
  });
}
```

`packages/cli/src/create-cli.ts` — add `createSessionStore` to the `@chatbridge/core` import and replace the logout branch:

```ts
        if (sub === "logout") {
          await authStore.clear();
          // The saved sessions carry conversation handles of the account
          // that is being logged out of. Deleted whether or not saving is
          // turned on: logging out is the one explicit way to remove them.
          await createSessionStore({
            configDir,
            providerName: provider.name,
            baseDir: opts.baseDir,
          }).clear();
          progress("✓ Auth state and saved sessions deleted");
          return 0;
        }
```

If a test asserts the old progress line (`grep -rn "Auth state deleted" packages/`), update it to the new one.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/config.test.ts packages/cli/src/tui/stored-messages.test.ts packages/cli/src/create-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Check and commit**

```bash
bunx biome check --write packages/cli/src
bun run check
git add packages/cli/src
git commit -m "feat(cli): sessions.enabled, stored TUI messages, auth logout deletes sessions (Refs #119, #74)"
gh issue comment 119 --body "Task 4 done: config key sessions.enabled, TUI toStored/fromStored, auth logout deletes saved sessions. What's next: Task 5, the TUI model saves its session."
```

---

### Task 5: TUI — the model saves its session (Opus)

**Files:**
- Modify: `packages/cli/src/tui/chat-model.ts`, `packages/cli/src/tui/chat-model.test.ts`, `packages/cli/src/tui/run-interactive.ts`, `packages/cli/src/tui/run-interactive.test.ts` (only if it constructs `InteractiveOptions` in a way the new field breaks), `packages/cli/src/create-cli.ts` (interactive branch)

**Interfaces:**
- Consumes: from core `SessionRecorder`, `SAVE_FAILED_MESSAGE`, `SESSIONS_NOT_DELETED_MESSAGE`, `createSessionStore`; from Task 4 `toStored`, `CliConfig.sessions`.
- Produces:

```ts
// ChatModelOptions gains
  /** Saves the session as it proceeds and lists saved ones for `/resume`.
   * Absent: nothing is saved (tests, and a CLI that turned saving off
   * still passes one whose `enabled` is false). */
  recorder?: SessionRecorder;

// InteractiveOptions gains
  /** Absent: a recorder that is never enabled is not needed; nothing is saved. */
  recorder?: SessionRecorder;
```

The model keeps `private sessionStart = 0`: the index in `messages` where the current saved session begins. Both UIs keep earlier history on screen after `/new`, so the screen can hold several sessions; only `messages.slice(sessionStart)` is saved.

**What to implement in `chat-model.ts`:**

1. Store `opts.recorder` in `private readonly recorder: SessionRecorder | undefined`.
2. Two private helpers:

```ts
  /** Queues a save of the settled history of the current session. Cheap
   * and synchronous: the recorder copies the snapshot and writes later. */
  private persist(): void {
    this.recorder?.record({
      conversation: this.conversationHandle,
      messages: toStored(this.messages.slice(this.sessionStart)),
    });
  }

  /** What follows belongs to a new saved session. */
  private beginSession(): void {
    this.recorder?.startNew();
    this.sessionStart = this.messages.length;
  }
```

3. Call `this.persist()`:
   - as the first statement of `settle()`, before the `isLoggingIn` return (every turn end passes through `settle`, and it runs before `drain()` claims the next turn);
   - in `runShell`, in both stale paths (`generation !== this.generation`), right after the entry received its final state (`entry.failed = true` / `entry.result = result`) and before `this.onChange()`;
   - in `runReset`, after the `try`/`catch`, before the final `this.onChange()`;
   - in `runLogin`, in the `catch` branch after the separator or error entry was pushed.
4. `runReset`, when `forget` is true: call `this.persist()` and then `this.beginSession()` where the handle is forgotten today (before the status changes), and in the success branch set `this.sessionStart = this.messages.length` right after the separator is pushed, so the `new chat` separator is the last line of nothing and the new file starts with the first prompt.
5. `/logout` in `runSlash`, after `await this.clearAuth()` succeeded and before the reset:

```ts
        try {
          await this.recorder?.clear();
        } catch {
          // The auth state is gone, so the logout itself stands; say what
          // is left on disk. No detail: the error may name a session file.
          this.messages.push({
            role: "error",
            text: SESSIONS_NOT_DELETED_MESSAGE,
          });
          this.onChange();
        }
        // Before the reset below persists: what is on screen belongs to
        // the account that was logged out, and must not be saved again.
        this.beginSession();
```

**What to implement in `run-interactive.ts`:**

- `InteractiveOptions` gains `recorder?: SessionRecorder`; pass it to `new ChatModel({ …, recorder: opts.recorder })`.
- In the `finally` block, after the session close and before `view?.destroy()`: `await settleReset(opts.recorder?.flush());`. Its result is ignored: an unfinished save must not turn a clean quit into the hard exit.

**What to implement in `create-cli.ts`, interactive branch:**

```ts
        // Built even when saving is off, so `/resume` can say so and
        // `/logout` can still delete what an earlier run saved.
        let notifySaveFailed: () => void = () => {};
        const recorder = new SessionRecorder({
          store: createSessionStore({
            configDir,
            providerName: provider.name,
            baseDir: opts.baseDir,
          }),
          provider: provider.name,
          enabled: () => config.sessions?.enabled !== false,
          onSaveFailed: () => notifySaveFailed(),
        });
```

`runInteractive` needs a way to route the failure to the status line. Add to `InteractiveOptions`:

```ts
  /** Called once the model exists, with the function that puts a notice
   * on the status line; lets the caller route the recorder's save failure
   * there. */
  onNotifier?: (notify: (text: string) => void) => void;
```

and in `runInteractive`, right after `model = new ChatModel(…)`: `opts.onNotifier?.((text) => model?.notify(text));`. In `create-cli.ts` pass `recorder` and `onNotifier: (notify) => { notifySaveFailed = () => notify(SAVE_FAILED_MESSAGE); }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/tui/chat-model.test.ts`. Add to the imports: `SESSIONS_NOT_DELETED_MESSAGE`, `SessionRecorder`, `type SessionRecord`, `type SessionStoreLike` from `@chatbridge/core`.

```ts
/** A SessionRecorder over an in-memory store. `files` is what is on disk;
 * `at(i)` is the i-th file in creation order. */
function memoryRecorder(opts: { enabled?: () => boolean } = {}) {
  const files = new Map<string, SessionRecord>();
  const state = { failSave: false, failClear: false, cleared: 0 };
  let failures = 0;
  let next = 1;
  const store: SessionStoreLike = {
    async save(record) {
      if (state.failSave) throw new Error("disk full");
      files.set(record.id, structuredClone(record));
    },
    async load(id) {
      return files.get(id);
    },
    async list() {
      return [...files.values()].map((r) => ({
        id: r.id,
        updatedAt: r.updatedAt,
        title: r.messages.find((m) => m.role === "user")?.text ?? "",
        turns: r.messages.filter((m) => m.role === "user").length,
      }));
    },
    async prune() {},
    async clear() {
      state.cleared++;
      if (state.failClear) throw new Error("permission denied");
      files.clear();
    },
  };
  const recorder = new SessionRecorder({
    store,
    provider: "dummy-chat",
    newId: () => `id-${next++}`,
    onSaveFailed: () => {
      failures++;
    },
    ...opts,
  });
  return {
    recorder,
    files,
    state,
    failures: () => failures,
    at: (i: number) => [...files.values()][i],
  };
}

describe("ChatModel session saving", () => {
  test("nothing is saved before the first turn settles", async () => {
    const a = fakeSession();
    const r = memoryRecorder();
    const model = await modelWith(a.session, { ...noReopen, recorder: r.recorder });
    void model.submit("hello");
    await tick();
    await r.recorder.flush();
    expect(r.files.size).toBe(0);
    nth(a.replies, 0).resolve("hi");
    await tick();
    await r.recorder.flush();
    expect(r.at(0)?.messages).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ]);
  });

  test("the file follows the handle of the last successful turn", async () => {
    const a = fakeSession();
    const r = memoryRecorder();
    const model = await modelWith(a.session, { ...noReopen, recorder: r.recorder });
    void model.submit("one");
    await tick();
    a.state.conversation = "H1";
    nth(a.replies, 0).resolve("1");
    await tick();
    await r.recorder.flush();
    expect(r.at(0)?.conversation).toBe("H1");
  });

  test("a failed turn is saved with its error and its partial", async () => {
    let onPartial: ((text: string) => void) | undefined;
    const pending = deferred<string>();
    const session: ChatSessionLike = {
      send(_prompt, opts) {
        onPartial = opts?.onPartial;
        return pending.promise;
      },
      async close() {},
      async kill() {},
    };
    const r = memoryRecorder();
    const model = await modelWith(session, { ...noReopen, recorder: r.recorder });
    void model.submit("slow");
    await tick();
    onPartial?.("half a rep");
    pending.reject(new ResponseTimeoutError("Timed out"));
    await tick();
    await r.recorder.flush();
    expect(r.at(0)?.messages).toEqual([
      { role: "user", text: "slow" },
      { role: "assistant", text: "half a rep", incomplete: true },
      { role: "error", text: "Timed out" },
    ]);
  });

  test("help output is not saved", async () => {
    const a = fakeSession();
    const r = memoryRecorder();
    const model = await modelWith(a.session, { ...noReopen, recorder: r.recorder });
    await model.submit("/help");
    void model.submit("hello");
    await tick();
    nth(a.replies, 0).resolve("hi");
    await tick();
    await r.recorder.flush();
    expect(r.at(0)?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("a finished shell command is saved", async () => {
    const a = fakeSession();
    const r = memoryRecorder();
    const result: ShellResult = {
      command: "ls",
      output: "a\n",
      droppedBytes: 0,
      exitCode: 0,
      interrupted: false,
      durationMs: 3,
    };
    const model = await modelWith(a.session, {
      ...noReopen,
      recorder: r.recorder,
      shell: { leadIn: "Output:", autoSend: false },
      runCommand: (): RunningCommand => ({
        done: Promise.resolve(result),
        stop() {},
      }),
    });
    await model.runShell("ls");
    await r.recorder.flush();
    expect(r.at(0)?.messages).toEqual([
      {
        role: "shell",
        text: "ls",
        shell: { ...result, exitCode: 0 },
      },
    ]);
  });

  test("/reopen keeps the session and saves the separator", async () => {
    const a = fakeSession();
    const b = fakeSession();
    const r = memoryRecorder();
    const model = await modelWith(a.session, {
      openSession: async () => b.session,
      recorder: r.recorder,
      closeTimeoutMs: 20,
    });
    void model.submit("one");
    await tick();
    nth(a.replies, 0).resolve("1");
    await tick();
    await model.submit("/reopen");
    await r.recorder.flush();
    expect(r.files.size).toBe(1);
    expect(r.at(0)?.messages.at(-1)).toEqual({
      role: "separator",
      text: "reopened",
    });
  });

  test("/new starts a second file and leaves the first as it was", async () => {
    const a = fakeSession();
    const b = fakeSession();
    const r = memoryRecorder();
    const model = await modelWith(a.session, {
      openSession: async () => b.session,
      recorder: r.recorder,
      closeTimeoutMs: 20,
    });
    void model.submit("one");
    await tick();
    nth(a.replies, 0).resolve("1");
    await tick();
    await model.submit("/new");
    void model.submit("two");
    await tick();
    nth(b.replies, 0).resolve("2");
    await tick();
    await r.recorder.flush();
    expect(r.files.size).toBe(2);
    expect(r.at(0)?.messages).toEqual([
      { role: "user", text: "one" },
      { role: "assistant", text: "1" },
    ]);
    // The `new chat` separator belongs to neither file.
    expect(r.at(1)?.messages).toEqual([
      { role: "user", text: "two" },
      { role: "assistant", text: "2" },
    ]);
    // The screen still shows both.
    expect(model.messages.map((m) => m.text)).toEqual([
      "one",
      "1",
      NEW_CHAT_SEPARATOR,
      "two",
      "2",
    ]);
  });

  test("/logout deletes every saved session and does not save the screen again", async () => {
    const a = fakeSession();
    const b = fakeSession();
    const r = memoryRecorder();
    const model = await modelWith(a.session, {
      openSession: async () => b.session,
      recorder: r.recorder,
      closeTimeoutMs: 20,
    });
    void model.submit("one");
    await tick();
    nth(a.replies, 0).resolve("1");
    await tick();
    await model.submit("/logout");
    await r.recorder.flush();
    expect(r.state.cleared).toBe(1);
    expect(r.files.size).toBe(0);
  });

  test("/logout with a clearAuth that fails deletes no session", async () => {
    const a = fakeSession();
    const r = memoryRecorder();
    const model = await modelWith(a.session, {
      ...noReopen,
      recorder: r.recorder,
      clearAuth: async () => {
        throw new Error("EACCES");
      },
    });
    await model.submit("/logout");
    expect(r.state.cleared).toBe(0);
  });

  test("/logout says so when the sessions could not be deleted, and still logs out", async () => {
    const a = fakeSession();
    const b = fakeSession();
    const r = memoryRecorder();
    r.state.failClear = true;
    const model = await modelWith(a.session, {
      openSession: async () => b.session,
      recorder: r.recorder,
      closeTimeoutMs: 20,
    });
    await model.submit("/logout");
    const texts = model.messages.map((m) => m.text);
    expect(texts).toContain(SESSIONS_NOT_DELETED_MESSAGE);
    // No detail from the error reaches the history.
    expect(texts.join("\n")).not.toContain("permission denied");
    expect(model.status).toBe("idle");
  });

  // Review Focus 4.
  test("a save that fails does not disturb the turn", async () => {
    const a = fakeSession();
    const r = memoryRecorder();
    r.state.failSave = true;
    const model = await modelWith(a.session, { ...noReopen, recorder: r.recorder });
    void model.submit("one");
    await tick();
    nth(a.replies, 0).resolve("1");
    await tick();
    void model.submit("two");
    await tick();
    nth(a.replies, 1).resolve("2");
    await tick();
    await r.recorder.flush();
    expect(model.status).toBe("idle");
    expect(model.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(r.failures()).toBe(1);
  });

  test("with saving off nothing is written", async () => {
    const a = fakeSession();
    const r = memoryRecorder({ enabled: () => false });
    const model = await modelWith(a.session, { ...noReopen, recorder: r.recorder });
    void model.submit("one");
    await tick();
    nth(a.replies, 0).resolve("1");
    await tick();
    await r.recorder.flush();
    expect(r.files.size).toBe(0);
  });

  test("a model without a recorder works as before", async () => {
    const a = fakeSession();
    const model = await modelWith(a.session, noReopen);
    void model.submit("one");
    await tick();
    nth(a.replies, 0).resolve("1");
    await tick();
    expect(model.status).toBe("idle");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run build && bun test packages/cli/src/tui/chat-model.test.ts -t "session saving"`
Expected: FAIL (`recorder` is not a `ChatModelOptions` key; no file is written).

- [ ] **Step 3: Implement** as described under "What to implement" above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/tui/chat-model.test.ts packages/cli/src/tui/run-interactive.test.ts`
Expected: PASS, the whole files: the existing tests must not notice the change.

- [ ] **Step 5: Check and commit**

```bash
bunx biome check --write packages/cli/src
bun run check
git add packages/cli/src
git commit -m "feat(cli): the interactive TUI saves its session as it proceeds (Refs #119, #74)"
gh issue comment 119 --body "Task 5 done: ChatModel saves through SessionRecorder (turn end, shell, reopen, /new starts a new file, /logout deletes), wired in create-cli and flushed at teardown. What's next: Task 6, resume in the TUI model."
```

---

### Task 6: TUI — resume in the model (Opus)

The slash command itself arrives in Task 10. This task gives the model the three methods the command and the view will call, tested directly.

**Files:**
- Modify: `packages/cli/src/tui/chat-model.ts`, `packages/cli/src/tui/chat-model.test.ts`

**Interfaces:**
- Consumes: from core `SessionSummary`, `resumedSeparator`, `RESUMED_SEPARATOR`, `RESUME_BUSY_MESSAGE`, `SESSIONS_OFF_MESSAGE`, `NO_SESSIONS_MESSAGE`, `SESSION_UNREADABLE_MESSAGE`; from Task 4 `fromStored`; from Task 5 `recorder`, `persist()`, `sessionStart`.
- Produces, on `ChatModel`:

```ts
  /** The saved sessions the view is asked to show as a picker; undefined
   * when no picker is open. Set by openResumePicker, cleared by resume
   * and cancelResume. */
  picker: SessionSummary[] | undefined;
  /** Bumped whenever `messages` was replaced rather than appended to, so
   * the view knows its rendered rows are stale. */
  historyEpoch: number;
  /** `/resume`: opens the picker, or puts on the status line why not. */
  openResumePicker(): Promise<void>;
  /** Esc in the picker. */
  cancelResume(): void;
  /** Enter in the picker. */
  resume(id: string): Promise<void>;
```

**Behaviour:**

- `canResume` (private getter): `(status === "idle" || status === "dead") && queue.length === 0`. `idle` excludes a turn, a shell command, a login, a reset and the first open; `dead` is allowed because resuming is a way out of it, like `/new`.
- `openResumePicker()`:
  1. No recorder, or `recorder.enabled` false → `notify(SESSIONS_OFF_MESSAGE)`.
  2. `!canResume` → `notify(RESUME_BUSY_MESSAGE)`.
  3. `const list = await recorder.list().catch(() => [])`.
  4. `!canResume` again (the state may have moved during the await) → `notify(RESUME_BUSY_MESSAGE)`.
  5. Empty list → `notify(NO_SESSIONS_MESSAGE)`.
  6. Otherwise `this.picker = list; this.onChange()`.
- `cancelResume()`: `this.picker = undefined; this.onChange()`. A no-op when no picker is open.
- `resume(id)`:
  1. `this.picker = undefined; this.onChange()`.
  2. `!canResume` → `notify(RESUME_BUSY_MESSAGE)`; return.
  3. `const record = await recorder.load(id).catch(() => undefined)`; `undefined` → `notify(SESSION_UNREADABLE_MESSAGE)`; return. The current chat is untouched.
  4. `!canResume` again → `notify(RESUME_BUSY_MESSAGE)`; return.
  5. `this.persist()`: the session being left gets its final state.
  6. Swap, synchronously:

```ts
    this.messages.length = 0;
    this.messages.push(...fromStored(record.messages));
    this.sessionStart = 0;
    this.historyEpoch++;
    // Results held for the chat that was just left belong to it.
    this.heldResults.length = 0;
    this.recorder.adopt(record);
    this.conversationHandle = record.conversation;
```

  7. `await this.reset(RESUMED_SEPARATOR, { resumed: true })`.
- `reset` and `runReset` take a third mode. `reset(separator, opts: { forget?: boolean; resumed?: boolean })`; in `runReset`'s success branch the separator text is `resumed ? resumedSeparator(restored) : withRestoreNote(separator, restored)`. Everything else in `runReset` is unchanged, which gives the spec's table for free:
  - handle opened → `restored === true` → `resumed · conversation restored`;
  - handle did not open → `restored === false` → the existing line drops `conversationHandle`, and the `persist()` Task 5 added at the end of `runReset` writes the file without it;
  - no handle, or a provider without `conversation` → `restored === undefined` → `resumed · transcript only`;
  - the open failed → the existing `catch` leaves the model `dead` with the error entry, the swapped transcript stays, and `conversationHandle` is kept, so a later `/reopen` tries the restore again.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/tui/chat-model.test.ts`. Add to the imports from `@chatbridge/core`: `NO_SESSIONS_MESSAGE`, `RESUME_BUSY_MESSAGE`, `SESSIONS_OFF_MESSAGE`, `SESSION_UNREADABLE_MESSAGE`.

```ts
describe("ChatModel resume", () => {
  const OLD = "11111111-1111-4111-8111-111111111111";

  function saved(over: Partial<SessionRecord> = {}): SessionRecord {
    return {
      version: 1,
      id: OLD,
      provider: "dummy-chat",
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:10:00.000Z",
      conversation: "H-old",
      messages: [
        { role: "user", text: "old question" },
        { role: "assistant", text: "old answer", format: "markdown" },
      ],
      ...over,
    };
  }

  /** A model on session `a`, whose reopens are served by `b` and record
   * the handle they were given. */
  async function setup(
    opts: { enabled?: () => boolean; record?: SessionRecord | null } = {},
  ) {
    const a = fakeSession("a");
    const b = fakeSession("b");
    const r = memoryRecorder(
      opts.enabled === undefined ? {} : { enabled: opts.enabled },
    );
    if (opts.record !== null) {
      const record = opts.record ?? saved();
      r.files.set(record.id, record);
    }
    const openedWith: Array<string | undefined> = [];
    const model = await modelWith(a.session, {
      openSession: async (_report, _onIdle, conversation) => {
        openedWith.push(conversation);
        return b.session;
      },
      recorder: r.recorder,
      closeTimeoutMs: 20,
    });
    return { a, b, r, model, openedWith };
  }

  test("openResumePicker lists the saved sessions", async () => {
    const t = await setup();
    await t.model.openResumePicker();
    expect(t.model.picker).toEqual([
      {
        id: OLD,
        updatedAt: "2026-09-20T00:10:00.000Z",
        title: "old question",
        turns: 1,
      },
    ]);
  });

  test("the picker leaves the current session out", async () => {
    const t = await setup();
    void t.model.submit("now");
    await tick();
    nth(t.a.replies, 0).resolve("ok");
    await tick();
    await t.model.openResumePicker();
    expect(t.model.picker?.map((s) => s.id)).toEqual([OLD]);
  });

  test("cancelResume closes the picker and changes nothing else", async () => {
    const t = await setup();
    await t.model.openResumePicker();
    t.model.cancelResume();
    expect(t.model.picker).toBeUndefined();
    expect(t.model.messages).toEqual([]);
    expect(t.a.state.closed).toBe(0);
  });

  test("without saved sessions it says so", async () => {
    const t = await setup({ record: null });
    await t.model.openResumePicker();
    expect(t.model.picker).toBeUndefined();
    expect(t.model.notice).toBe(NO_SESSIONS_MESSAGE);
  });

  test("with saving off it says so", async () => {
    const t = await setup({ enabled: () => false });
    await t.model.openResumePicker();
    expect(t.model.picker).toBeUndefined();
    expect(t.model.notice).toBe(SESSIONS_OFF_MESSAGE);
  });

  test("without a recorder it says saving is off", async () => {
    const a = fakeSession();
    const model = await modelWith(a.session, noReopen);
    await model.openResumePicker();
    expect(model.notice).toBe(SESSIONS_OFF_MESSAGE);
  });

  test("a store that cannot list reads as no saved sessions", async () => {
    const t = await setup();
    t.r.recorder.list = async () => {
      throw new Error("EACCES");
    };
    await t.model.openResumePicker();
    expect(t.model.notice).toBe(NO_SESSIONS_MESSAGE);
  });

  test.each([
    ["a turn is in flight", async (t: Awaited<ReturnType<typeof setup>>) => {
      void t.model.submit("busy");
      await tick();
    }],
    ["the queue is not empty", async (t: Awaited<ReturnType<typeof setup>>) => {
      void t.model.submit("busy");
      await tick();
      void t.model.submit("queued");
      await tick();
    }],
  ])("refused while %s", async (_name, arrange) => {
    const t = await setup();
    await arrange(t);
    await t.model.openResumePicker();
    expect(t.model.picker).toBeUndefined();
    expect(t.model.notice).toBe(RESUME_BUSY_MESSAGE);
    await t.model.resume(OLD);
    expect(t.model.notice).toBe(RESUME_BUSY_MESSAGE);
    expect(t.openedWith).toEqual([]);
  });

  test("refused while the first open is in flight", async () => {
    const gate = deferred<void>();
    const a = fakeSession();
    const r = memoryRecorder();
    r.files.set(OLD, saved());
    const model = await modelWith(
      a.session,
      { ...noReopen, recorder: r.recorder },
      gate.promise,
    );
    await model.openResumePicker();
    expect(model.notice).toBe(RESUME_BUSY_MESSAGE);
    gate.resolve();
    await model.ready;
  });

  test("resume swaps the history, reopens with the handle and notes the restore", async () => {
    const t = await setup();
    void t.model.submit("now");
    await tick();
    nth(t.a.replies, 0).resolve("ok");
    await tick();
    const epoch = t.model.historyEpoch;
    t.b.state.restored = true;
    await t.model.openResumePicker();
    await t.model.resume(OLD);
    expect(t.model.picker).toBeUndefined();
    expect(t.openedWith).toEqual(["H-old"]);
    expect(t.a.state.closed).toBe(1);
    expect(t.model.historyEpoch).toBe(epoch + 1);
    expect(t.model.messages).toEqual([
      { role: "user", text: "old question" },
      { role: "assistant", text: "old answer", format: "markdown" },
      { role: "separator", text: "resumed · conversation restored" },
    ]);
    expect(t.model.status).toBe("idle");
  });

  test("the session that was left keeps its own file", async () => {
    const t = await setup();
    void t.model.submit("now");
    await tick();
    nth(t.a.replies, 0).resolve("ok");
    await tick();
    t.b.state.restored = true;
    await t.model.resume(OLD);
    await t.r.recorder.flush();
    expect(t.r.files.get("id-1")?.messages).toEqual([
      { role: "user", text: "now" },
      { role: "assistant", text: "ok" },
    ]);
  });

  test("turns after a resume are saved into the resumed file", async () => {
    const t = await setup();
    t.b.state.restored = true;
    await t.model.resume(OLD);
    void t.model.submit("next");
    await tick();
    t.b.state.conversation = "H-old";
    nth(t.b.replies, 0).resolve("fine");
    await tick();
    await t.r.recorder.flush();
    expect(t.r.files.size).toBe(1);
    const file = t.r.files.get(OLD);
    expect(file?.createdAt).toBe("2026-09-20T00:00:00.000Z");
    expect(file?.messages.map((m) => m.text)).toEqual([
      "old question",
      "old answer",
      "resumed · conversation restored",
      "next",
      "fine",
    ]);
  });

  // Review Focus 5.
  test("a handle that does not open is noted and removed from the file", async () => {
    const t = await setup();
    t.b.state.restored = false;
    await t.model.resume(OLD);
    expect(t.model.messages.at(-1)).toEqual({
      role: "separator",
      text: "resumed · conversation could not be restored",
    });
    await t.r.recorder.flush();
    expect("conversation" in (t.r.files.get(OLD) ?? {})).toBe(false);
    // The next reopen asks for a new chat, not for the dead handle.
    await t.model.reset();
    expect(t.openedWith).toEqual(["H-old", undefined]);
  });

  test("a record without a handle resumes the transcript only", async () => {
    const { conversation: _dropped, ...rest } = saved();
    const t = await setup({ record: rest });
    // Whatever the session claims, nothing was asked for.
    t.b.state.restored = true;
    await t.model.resume(OLD);
    expect(t.openedWith).toEqual([undefined]);
    expect(t.model.messages.at(-1)).toEqual({
      role: "separator",
      text: "resumed · transcript only",
    });
  });

  test("a provider that cannot name conversations resumes the transcript only", async () => {
    const t = await setup();
    // `restored` stays undefined: the provider has no `conversation`.
    await t.model.resume(OLD);
    expect(t.model.messages.at(-1)).toEqual({
      role: "separator",
      text: "resumed · transcript only",
    });
  });

  test("a session that cannot be loaded leaves the chat alone", async () => {
    const t = await setup();
    void t.model.submit("now");
    await tick();
    nth(t.a.replies, 0).resolve("ok");
    await tick();
    await t.model.resume("22222222-2222-4222-8222-222222222222");
    expect(t.model.notice).toBe(SESSION_UNREADABLE_MESSAGE);
    expect(t.model.messages.map((m) => m.text)).toEqual(["now", "ok"]);
    expect(t.openedWith).toEqual([]);
    expect(t.a.state.closed).toBe(0);
  });

  test("when the browser does not open, the transcript stays and the handle is kept", async () => {
    const a = fakeSession();
    const b = fakeSession();
    const r = memoryRecorder();
    r.files.set(OLD, saved());
    const openedWith: Array<string | undefined> = [];
    let fail = true;
    const model = await modelWith(a.session, {
      openSession: async (_report, _onIdle, conversation) => {
        openedWith.push(conversation);
        if (fail) throw new AuthRequiredError("No saved auth state.");
        return b.session;
      },
      recorder: r.recorder,
      closeTimeoutMs: 20,
    });
    await model.resume(OLD);
    expect(model.status).toBe("dead");
    expect(model.messages.slice(0, 2).map((m) => m.text)).toEqual([
      "old question",
      "old answer",
    ]);
    expect(model.messages.at(-1)?.role).toBe("error");
    fail = false;
    b.state.restored = true;
    await model.reset();
    expect(openedWith).toEqual(["H-old", "H-old"]);
    expect(model.messages.at(-1)).toEqual({
      role: "separator",
      text: "reopened · conversation restored",
    });
  });

  test("resume works from a dead model", async () => {
    const gateless = fakeSession();
    const b = fakeSession();
    const r = memoryRecorder();
    r.files.set(OLD, saved());
    const model = await modelWith(gateless.session, {
      openSession: async () => b.session,
      recorder: r.recorder,
      closeTimeoutMs: 20,
    });
    void model.submit("boom");
    await tick();
    nth(gateless.replies, 0).reject(new Error("page crashed"));
    await tick();
    expect(model.status).toBe("dead");
    b.state.restored = true;
    await model.resume(OLD);
    expect(model.status).toBe("idle");
    expect(model.fatal).toBeUndefined();
  });

  test("held shell results of the chat that was left are dropped", async () => {
    const t = await setup();
    t.model.heldResults.push({
      command: "ls",
      output: "",
      droppedBytes: 0,
      exitCode: 0,
      interrupted: false,
      durationMs: 1,
    });
    await t.model.resume(OLD);
    expect(t.model.heldResults).toEqual([]);
  });
});
```

Check `AuthRequiredError`'s constructor in `packages/core/src/errors.ts` before using it as written above and adapt the arguments if it takes more than a message.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/tui/chat-model.test.ts -t "ChatModel resume"`
Expected: FAIL, `openResumePicker is not a function`.

- [ ] **Step 3: Implement** as described under "Behaviour" above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/tui/chat-model.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 5: Check and commit**

```bash
bunx biome check --write packages/cli/src/tui
bun run check
git add packages/cli/src/tui
git commit -m "feat(cli): the TUI model resumes a saved session (Refs #119, #74)"
gh issue comment 119 --body "Task 6 done: ChatModel.openResumePicker / resume / cancelResume, history swap with historyEpoch, the three resumed separators. What's next: Task 7, the TUI picker."
```

---

### Task 7: TUI — the picker (Opus)

**Files:**
- Modify: `packages/cli/src/tui/mention-popup.ts`, `packages/cli/src/tui/mention-popup.test.ts`, `packages/cli/src/tui/chat-view.ts`, `packages/cli/src/tui/chat-view.test.ts`

**Interfaces:**
- Consumes: from Task 6 `model.picker`, `model.historyEpoch`, `model.resume(id)`, `model.cancelResume()`; from core `SessionSummary`, `formatSessionTime`.
- Produces:

```ts
// mention-popup.ts
export interface PopupRow {
  value: string;
  label: string;
  /** Draw the label as it is: no dimming of what precedes the last `/`.
   * For rows that are not paths. */
  plain?: true;
}
export class MentionPopup {
  // …existing members…
  /** Like show(), but keeps every row and scrolls: the visible window of
   * MAX_ROWS follows the selection. */
  showAll(rows: PopupRow[]): void;
}

// chat-view.ts
/** One picker row per saved session: `MM-DD HH:mm   <title>   N turns`,
 * titles padded to the longest so the turn counts line up. */
export function sessionRows(sessions: readonly SessionSummary[]): PopupRow[];
```

**Behaviour:**

- `MentionPopup.show()` is unchanged: it still truncates to `MAX_ROWS`, which the mention search and the command list rely on.
- `MentionPopup.showAll(rows)` stores all rows, selects the first, and paints rows `top … top + MAX_ROWS - 1`. `move()` wraps over the whole list and then adjusts `top` so the selection is inside the window (`if (index < top) top = index; if (index >= top + MAX_ROWS) top = index - MAX_ROWS + 1`). `show()` and `hide()` reset `top` to 0.
- `paint()` skips the path dimming for a row with `plain: true`: a title may contain `/`.
- `sessionRows`: `turns === 1` reads `1 turn`, otherwise `N turns`. The label is `${formatSessionTime(updatedAt)}   ${title.padEnd(widest)}   ${turns}`; `value` is the session id; `plain: true`.
- `ChatView`:
  - A private `picking = false`. In `update()`: when `model.picker !== undefined` and `!picking`, call `popup.showAll(sessionRows(model.picker))` and set `picking = true`; when `model.picker === undefined` and `picking`, call `popup.hide()` and set `picking = false`.
  - In `update()`, before the render loop: when `model.historyEpoch !== this.shownEpoch`, the history was replaced. Drop the pending row (`dropPending()`), remove and destroy every message box the view added to `this.history` (keep them in an array as they are added, the way `dropPending` removes its row: `this.history.remove(box); box.destroyRecursively()`), empty `this.shellEntries`, set `this.rendered = 0`, and store the epoch. The render loop that follows then draws the new history from the start.
  - The banner: a resume always yields a non-empty history, so the existing banner swap needs no change.
  - `handleKey`, first thing after the `torn` check, while `picking`:
    - `up` / `down` → `popup.move(∓1)`;
    - `return` / `kpenter` → `const id = popup.selected; if (id !== undefined) void this.model.resume(id);`
    - `escape` → `this.model.cancelResume()`;
    - Ctrl+C is left alone (quitting must always work): return without `preventDefault`;
    - every other key: `preventDefault()` and return. The picker is modal: nothing typed reaches the input, and Ctrl+R does not reset under it.
  - `refreshPopup()` returns at once while `picking`, so a cursor event cannot replace the picker with a mention list.
  - Shell mode: `openResumePicker` can only be reached through `/resume`, which is typed in message mode, so no shell-mode handling is needed.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/tui/mention-popup.test.ts`:

```ts
describe("MentionPopup.showAll", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      value: `v${i}`,
      label: `row ${String(i).padStart(2, "0")}`,
      plain: true as const,
    }));

  test("keeps every row and shows the first MAX_ROWS", async () => {
    const t = await setup();
    t.popup.showAll(many(12));
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("row 00");
    expect(frame).toContain(`row ${String(MAX_ROWS - 1).padStart(2, "0")}`);
    expect(frame).not.toContain(`row ${String(MAX_ROWS).padStart(2, "0")}`);
    expect(t.popup.selected).toBe("v0");
  });

  test("moving past the last visible row scrolls", async () => {
    const t = await setup();
    t.popup.showAll(many(12));
    for (let i = 0; i < MAX_ROWS; i++) t.popup.move(1);
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(t.popup.selected).toBe(`v${MAX_ROWS}`);
    expect(frame).toContain(`row ${String(MAX_ROWS).padStart(2, "0")}`);
    expect(frame).not.toContain("row 00");
  });

  test("moving up from the first row wraps to the last and scrolls there", async () => {
    const t = await setup();
    t.popup.showAll(many(12));
    t.popup.move(-1);
    await t.renderOnce();
    expect(t.popup.selected).toBe("v11");
    expect(t.captureCharFrame()).toContain("row 11");
  });

  test("moving down from the last row wraps to the first", async () => {
    const t = await setup();
    t.popup.showAll(many(12));
    t.popup.move(-1);
    t.popup.move(1);
    await t.renderOnce();
    expect(t.popup.selected).toBe("v0");
    expect(t.captureCharFrame()).toContain("row 00");
  });

  test("show() after showAll() starts at the top again", async () => {
    const t = await setup();
    t.popup.showAll(many(12));
    t.popup.move(-1);
    t.popup.show(paths("src/a.ts"));
    await t.renderOnce();
    expect(t.popup.selected).toBe("src/a.ts");
    expect(t.captureCharFrame()).toContain("src/a.ts");
  });

  test("a plain row is not dimmed before its last slash", async () => {
    const t = await setup();
    t.popup.showAll([
      { value: "a", label: "first" , plain: true },
      { value: "b", label: "compare a/b testing", plain: true },
    ]);
    await t.renderOnce();
    // Row 1 is not the selected one, so it takes the unselected branch.
    expect(t.chunks(1).some((c) => c.dim)).toBe(false);
  });

  test("an empty list hides", async () => {
    const t = await setup();
    t.popup.showAll([]);
    expect(t.popup.visible).toBe(false);
  });
});
```

Append to `packages/cli/src/tui/chat-view.test.ts`. Add to the imports: `sessionRows` from `./chat-view.js`; `SessionRecorder`, `type SessionRecord`, `type SessionStoreLike`, `formatSessionTime` from `@chatbridge/core`. Extend `setup()`'s options with `recorder?: SessionRecorder` and pass it to `modelWith` (`...(opts.recorder ? { recorder: opts.recorder } : {})`).

```ts
describe("sessionRows", () => {
  test("aligns the titles and pluralises the turns", () => {
    const rows = sessionRows([
      { id: "a", updatedAt: "2026-09-26T05:32:00.000Z", title: "short", turns: 1 },
      { id: "b", updatedAt: "2026-09-25T00:10:00.000Z", title: "a longer title", turns: 12 },
    ]);
    expect(rows).toEqual([
      {
        value: "a",
        label: `${formatSessionTime("2026-09-26T05:32:00.000Z")}   ${"short".padEnd(14)}   1 turn`,
        plain: true,
      },
      {
        value: "b",
        label: `${formatSessionTime("2026-09-25T00:10:00.000Z")}   a longer title   12 turns`,
        plain: true,
      },
    ]);
  });

  test("no sessions, no rows", () => {
    expect(sessionRows([])).toEqual([]);
  });
});

describe("ChatView session picker", () => {
  const idOf = (n: number) =>
    `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

  /** A recorder over `count` saved sessions, newest first by index. */
  function recorderWith(count: number) {
    const files = new Map<string, SessionRecord>();
    for (let n = 1; n <= count; n++) {
      files.set(idOf(n), {
        version: 1,
        id: idOf(n),
        provider: "dummy-chat",
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: new Date(Date.UTC(2026, 8, 26, 0, 60 - n)).toISOString(),
        messages: [
          { role: "user", text: `saved prompt ${n}` },
          { role: "assistant", text: `saved reply ${n}` },
        ],
      });
    }
    const store: SessionStoreLike = {
      async save(record) {
        files.set(record.id, structuredClone(record));
      },
      load: async (id) => files.get(id),
      list: async () =>
        [...files.values()].map((r) => ({
          id: r.id,
          updatedAt: r.updatedAt,
          title: r.messages[0]?.text ?? "",
          turns: 1,
        })),
      async prune() {},
      async clear() {
        files.clear();
      },
    };
    return new SessionRecorder({ store, provider: "dummy-chat" });
  }

  test("the picker lists the saved sessions between the input and the status row", async () => {
    const t = await setup({ recorder: recorderWith(2) });
    await t.model.openResumePicker();
    const frame = await t.frameWith("saved prompt 1");
    expect(frame).toContain("saved prompt 2");
    expect(frame).toContain(POPUP_HINT);
  });

  test("enter resumes the selected session and redraws the history", async () => {
    const t = await setup({ recorder: recorderWith(2) });
    await t.mockInput.typeText("before");
    t.mockInput.pressEnter();
    await t.frameWith("Echo: before");
    await t.model.openResumePicker();
    await t.frameWith("saved prompt 1");
    t.mockInput.pressArrow("down");
    t.mockInput.pressEnter();
    const frame = await t.frameWith("resumed · transcript only");
    expect(frame).toContain("saved prompt 2");
    expect(frame).toContain("saved reply 2");
    // The history was replaced, not appended to.
    expect(frame).not.toContain("Echo: before");
    expect(frame).not.toContain(POPUP_HINT);
  });

  test("escape closes the picker and keeps the chat", async () => {
    const t = await setup({ recorder: recorderWith(1) });
    await t.mockInput.typeText("before");
    t.mockInput.pressEnter();
    await t.frameWith("Echo: before");
    await t.model.openResumePicker();
    await t.frameWith("saved prompt 1");
    const frame = await t.escapePopup("saved prompt 1");
    expect(frame).toContain("Echo: before");
    expect(t.model.picker).toBeUndefined();
  });

  test("the picker is modal: typing reaches neither the input nor the model", async () => {
    const t = await setup({ recorder: recorderWith(1) });
    await t.model.openResumePicker();
    await t.frameWith("saved prompt 1");
    await t.mockInput.typeText("x@");
    await t.renderOnce();
    expect(t.view.inputText).toBe("");
    expect(t.captureCharFrame()).toContain("saved prompt 1");
  });

  test("more sessions than rows scroll", async () => {
    const t = await setup({ recorder: recorderWith(12) });
    await t.model.openResumePicker();
    const first = await t.frameWith("saved prompt 1 ");
    expect(first).not.toContain("saved prompt 12");
    for (let i = 0; i < 11; i++) t.mockInput.pressArrow("down");
    const last = await t.frameWith("saved prompt 12");
    expect(last).not.toContain("saved prompt 1 ");
  });

  test("the input works again after a resume", async () => {
    const t = await setup({ recorder: recorderWith(1) });
    await t.model.openResumePicker();
    await t.frameWith("saved prompt 1");
    t.mockInput.pressEnter();
    await t.frameWith("resumed · transcript only");
    await t.mockInput.typeText("after");
    t.mockInput.pressEnter();
    const frame = await t.frameWith("Echo: after");
    expect(frame).toContain("saved reply 1");
  });
});
```

The test `"more sessions than rows scroll"` matches `"saved prompt 1 "` with a trailing space so that it does not match `saved prompt 10`…`12`; the rows are padded, so the space is there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/tui/mention-popup.test.ts packages/cli/src/tui/chat-view.test.ts -t "showAll|sessionRows|session picker"`
Expected: FAIL (`showAll` and `sessionRows` do not exist).

- [ ] **Step 3: Implement** as described under "Behaviour" above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/tui`
Expected: PASS, every TUI test.

- [ ] **Step 5: Check and commit**

```bash
bunx biome check --write packages/cli/src/tui
bun run check
git add packages/cli/src/tui
git commit -m "feat(cli): session picker in the TUI (Refs #119, #74)"
gh issue comment 119 --body "Task 7 done: scrolling popup (showAll), the session picker in ChatView, history redraw on a replaced transcript. What's next: Task 8, the VSCode controller saves and resumes."
```

---

### Task 8: VSCode — the controller saves and resumes (Opus)

**Files:**
- Create: `packages/vscode/src/stored-messages.ts`, `packages/vscode/src/stored-messages.test.ts`
- Modify: `packages/vscode/src/session-controller.ts`, `packages/vscode/src/session-controller.test.ts`

**Interfaces:**
- Consumes: from core `SessionRecorder`, `SessionRecord`, `StoredMessage`, `resumedSeparator`.
- Produces:

```ts
// stored-messages.ts
/** Remembers the stored form of entries VSCode cannot express (a TUI
 * `shell` entry), so saving a resumed session does not lose them. */
export type Origins = WeakMap<Message, StoredMessage>;
export function toStored(
  messages: readonly Message[],
  origins: Origins,
): StoredMessage[];
export function fromStored(
  stored: readonly StoredMessage[],
  origins: Origins,
): Message[];

// SessionControllerOptions gains
  /** Saves the session as it proceeds. Absent: nothing is saved. */
  recorder?: SessionRecorder;

// SessionController gains
  /** True when a resume may start: no turn, no open, no reopen in flight
   * and nothing queued. */
  get canResume(): boolean;
  /** Replaces the history with `record`'s and reopens the browser on its
   * conversation. False, with nothing changed, when `canResume` is false. */
  resume(record: SessionRecord): Promise<boolean>;
  /** Logout: deletes every saved session. What is on screen is not saved
   * again. Rejects when the delete failed. */
  clearSessions(): Promise<void>;
```

**Behaviour of the conversion:**

- `toStored`: `help` entries are dropped. An entry found in `origins` is stored as the original it came from. Otherwise `user`, `assistant`, `error` and `separator` map one to one; `format: "text"` and an empty `attachments` list are left out; `format: "markdown"` and `incomplete: true` are kept.
- `fromStored`: `user`, `assistant`, `error`, `separator` map one to one (a `user` entry always gets an `attachments` array, empty when the stored one has none: that is the shape `startTurn` produces). A `shell` entry becomes `{ role: "user", text }` where `text` is `$ <command>` followed, when there is output, by a newline and the output; the new message is registered in `origins` with the stored entry.

**Behaviour of the controller:**

1. `private sessionStart = 0`, `private readonly origins: Origins = new WeakMap()`, and

```ts
  private persist(): void {
    this.opts.recorder?.record({
      conversation: this.conversationHandle,
      messages: toStored(this.messages.slice(this.sessionStart), this.origins),
    });
  }
```

2. Call `this.persist()` wherever the settled history changed, always before the `drain()` that may claim the next turn:
   - `runTurn`, success: after the assistant entry is pushed;
   - `fail()`: after `pushError`;
   - `runProviderCommand`, the `show` branch: after the `help` entry (it saves the typed `/command` line);
   - `startTurn`: in the stale branch and in the `UrlHookError` branch, after the error entry;
   - `idleExpired`: after the separator;
   - `markLoggedIn`: after the separator;
   - `runReopen`: after the separator in the success branch and after `pushError` in the `catch`.
3. `discard(separator)` (New chat and Logout): `this.persist()` first, then `this.opts.recorder?.startNew()`, then push the separator as today, then `this.sessionStart = this.messages.length`. The separator belongs to neither file.
4. `clearSessions()`:

```ts
  async clearSessions(): Promise<void> {
    // Before the delete: what is on screen belongs to the account being
    // logged out and must not be written back by the next persist().
    this.sessionStart = this.messages.length;
    await this.opts.recorder?.clear();
  }
```

5. `canResume`: `this.canStartTurn && this.queue.length === 0 && this.reopening === undefined && this.opening === undefined`.
6. `reopen()` and `resume()` share the reopen. Change `runReopen` to take how the separator is worded:

```ts
  reopen(): Promise<void> {
    if (this.reopening) return this.reopening;
    return this.startReopen((restored) =>
      withRestoreNote(REOPENED_SEPARATOR, restored),
    );
  }

  private startReopen(
    separatorOf: (restored: boolean | undefined) => string,
  ): Promise<void> {
    const run = this.runReopen(separatorOf).finally(() => {
      this.reopening = undefined;
    });
    this.reopening = run;
    return run;
  }

  async resume(record: SessionRecord): Promise<boolean> {
    if (!this.canResume) return false;
    // The session being left gets its final state.
    this.persist();
    this.messages = fromStored(record.messages, this.origins);
    this.sessionStart = 0;
    this.opts.recorder?.adopt(record);
    this.conversationHandle = record.conversation;
    // Neither belongs to the chat that is coming back.
    this.lastPrompt = undefined;
    this.lastError = undefined;
    await this.startReopen(resumedSeparator);
    return true;
  }
```

   `runReopen(separatorOf)` pushes `separatorOf(restored)` where it pushes `withRestoreNote(REOPENED_SEPARATOR, restored)` today. It already drops a handle that did not restore, and step 2 makes it persist, so the file loses the dead handle. When the open fails, the controller is `dead`, the swapped history stays and the handle is kept.
7. Pending attachments survive a resume: they are what the user is about to send, not part of any chat.

- [ ] **Step 1: Write the failing tests**

`packages/vscode/src/stored-messages.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { StoredMessage } from "@chatbridge/core";
import type { Message } from "./protocol.js";
import { type Origins, fromStored, toStored } from "./stored-messages.js";

const origins = (): Origins => new WeakMap();

describe("toStored", () => {
  test("maps the entries VSCode produces", () => {
    const messages: Message[] = [
      { role: "user", text: "look", attachments: [{ path: "a.ts", bytes: 3 }] },
      { role: "user", text: "plain", attachments: [] },
      { role: "assistant", text: "**hi**", format: "markdown" },
      { role: "assistant", text: "plain text", format: "text" },
      { role: "assistant", text: "half", incomplete: true },
      { role: "error", text: "Timed out" },
      { role: "separator", text: "reopened" },
      { role: "help", text: "/help …" },
    ];
    expect(toStored(messages, origins())).toEqual([
      { role: "user", text: "look", attachments: [{ path: "a.ts", bytes: 3 }] },
      { role: "user", text: "plain" },
      { role: "assistant", text: "**hi**", format: "markdown" },
      { role: "assistant", text: "plain text" },
      { role: "assistant", text: "half", incomplete: true },
      { role: "error", text: "Timed out" },
      { role: "separator", text: "reopened" },
    ]);
  });
});

describe("fromStored", () => {
  test("maps the entries back", () => {
    const stored: StoredMessage[] = [
      { role: "user", text: "look", attachments: [{ path: "a.ts", bytes: 3 }] },
      { role: "user", text: "plain" },
      { role: "assistant", text: "**hi**", format: "markdown" },
      { role: "assistant", text: "half", incomplete: true },
      { role: "error", text: "Timed out" },
      { role: "separator", text: "reopened" },
    ];
    expect(fromStored(stored, origins())).toEqual([
      { role: "user", text: "look", attachments: [{ path: "a.ts", bytes: 3 }] },
      { role: "user", text: "plain", attachments: [] },
      { role: "assistant", text: "**hi**", format: "markdown" },
      { role: "assistant", text: "half", incomplete: true },
      { role: "error", text: "Timed out" },
      { role: "separator", text: "reopened" },
    ]);
  });

  test("shows a TUI shell entry as plain text", () => {
    const shell: StoredMessage = {
      role: "shell",
      text: "ls",
      shell: {
        command: "ls",
        output: "a\nb\n",
        exitCode: 0,
        interrupted: false,
        droppedBytes: 0,
        durationMs: 3,
      },
    };
    expect(fromStored([shell], origins())).toEqual([
      { role: "user", text: "$ ls\na\nb\n", attachments: [] },
    ]);
  });

  test("a shell entry without output is the command alone", () => {
    expect(fromStored([{ role: "shell", text: "true" }], origins())).toEqual([
      { role: "user", text: "$ true", attachments: [] },
    ]);
  });

  test("a shell entry survives the round trip unchanged", () => {
    const shell: StoredMessage = {
      role: "shell",
      text: "ls",
      failed: true,
      shell: {
        command: "ls",
        output: "a\n",
        exitCode: null,
        interrupted: true,
        droppedBytes: 9,
        durationMs: 3,
        signal: "SIGTERM",
      },
    };
    const o = origins();
    const shown = fromStored([shell, { role: "user", text: "next" }], o);
    expect(toStored(shown, o)).toEqual([shell, { role: "user", text: "next" }]);
  });

  test("a copy of a shown shell entry is an ordinary message", () => {
    // getState() hands out copies; only the controller's own objects carry
    // an origin.
    const o = origins();
    const [shown] = fromStored([{ role: "shell", text: "ls" }], o);
    expect(toStored([{ ...(shown as Message) }], o)).toEqual([
      { role: "user", text: "$ ls" },
    ]);
  });
});
```

Append to `packages/vscode/src/session-controller.test.ts`. Add to the imports from `@chatbridge/core`: `SessionRecorder`, `type SessionRecord`, `type SessionStoreLike`.

```ts
describe("SessionController: saved sessions", () => {
  const OLD = "11111111-1111-4111-8111-111111111111";

  function saved(over: Partial<SessionRecord> = {}): SessionRecord {
    return {
      version: 1,
      id: OLD,
      provider: "dummy-chat",
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:10:00.000Z",
      conversation: "H-old",
      messages: [
        { role: "user", text: "old question" },
        { role: "assistant", text: "old answer", format: "markdown" },
      ],
      ...over,
    };
  }

  function memoryRecorder() {
    const files = new Map<string, SessionRecord>();
    const state = { failSave: false, failClear: false, cleared: 0 };
    let next = 1;
    let failures = 0;
    const store: SessionStoreLike = {
      async save(record) {
        if (state.failSave) throw new Error("disk full");
        files.set(record.id, structuredClone(record));
      },
      load: async (id) => files.get(id),
      list: async () => [],
      async prune() {},
      async clear() {
        state.cleared++;
        if (state.failClear) throw new Error("permission denied");
        files.clear();
      },
    };
    const recorder = new SessionRecorder({
      store,
      provider: "dummy-chat",
      newId: () => `id-${next++}`,
      onSaveFailed: () => {
        failures++;
      },
    });
    return { recorder, files, state, failures: () => failures };
  }

  /** A controller whose every open yields a fresh fake session and records
   * the handle it was given. `next` configures the session the next open
   * returns. */
  function setup() {
    const r = memoryRecorder();
    const openedWith: Array<string | undefined> = [];
    const replies: Array<ReturnType<typeof deferred<string>>> = [];
    const next = {
      restored: undefined as boolean | undefined,
      conversation: undefined as string | undefined,
      openError: undefined as Error | undefined,
    };
    let closed = 0;
    const controller = new SessionController({
      recorder: r.recorder,
      closeTimeoutMs: 20,
      openSession: async (_onIdle, conversation) => {
        openedWith.push(conversation);
        if (next.openError) throw next.openError;
        const restored = next.restored;
        return {
          restored,
          get conversation() {
            return next.conversation;
          },
          async send() {
            const d = deferred<string>();
            replies.push(d);
            return d.promise;
          },
          async close() {
            closed++;
          },
          async kill() {},
        };
      },
    });
    /** One settled turn. */
    async function turn(text: string, reply: string) {
      const before = replies.length;
      const p = controller.send(text);
      // The reply of this turn, not the settled one of an earlier turn.
      await waitFor(() => replies.length > before);
      replies.at(-1)?.resolve(reply);
      await p;
    }
    return { r, controller, openedWith, replies, next, turn, closed: () => closed };
  }

  test("a settled turn is saved with the handle", async () => {
    const t = setup();
    t.next.conversation = "H1";
    await t.turn("hello", "hi");
    await t.r.recorder.flush();
    expect([...t.r.files.values()]).toEqual([
      expect.objectContaining({
        id: "id-1",
        conversation: "H1",
        messages: [
          { role: "user", text: "hello" },
          { role: "assistant", text: "hi" },
        ],
      }),
    ]);
  });

  test("New chat starts a second file; the separator is in neither", async () => {
    const t = setup();
    await t.turn("one", "1");
    expect(await t.controller.newChat()).toBe(true);
    await t.turn("two", "2");
    await t.r.recorder.flush();
    expect([...t.r.files.values()].map((f) => f.messages)).toEqual([
      [
        { role: "user", text: "one" },
        { role: "assistant", text: "1" },
      ],
      [
        { role: "user", text: "two" },
        { role: "assistant", text: "2" },
      ],
    ]);
  });

  test("a reopen keeps the file and saves its separator", async () => {
    const t = setup();
    await t.turn("one", "1");
    await t.controller.reopen();
    await t.r.recorder.flush();
    expect(t.r.files.size).toBe(1);
    expect(t.r.files.get("id-1")?.messages.at(-1)).toEqual({
      role: "separator",
      text: REOPENED_SEPARATOR,
    });
  });

  test("a failed turn is saved with its error", async () => {
    const t = setup();
    const p = t.controller.send("slow");
    await waitFor(() => t.replies.length > 0);
    t.replies[0]?.reject(new ResponseTimeoutError("Timed out"));
    await p;
    await t.r.recorder.flush();
    expect(t.r.files.get("id-1")?.messages.map((m) => m.role)).toEqual([
      "user",
      "error",
    ]);
  });

  test("help output is not saved", async () => {
    const t = setup();
    t.controller.pushHelp("/help …");
    await t.turn("one", "1");
    await t.r.recorder.flush();
    expect(t.r.files.get("id-1")?.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  test("clearSessions deletes and what is on screen is not saved again", async () => {
    const t = setup();
    await t.turn("one", "1");
    await t.controller.clearSessions();
    expect(await t.controller.discard("Logged out")).toBe(true);
    await t.r.recorder.flush();
    expect(t.r.state.cleared).toBe(1);
    expect(t.r.files.size).toBe(0);
  });

  test("clearSessions rejects when the delete failed", async () => {
    const t = setup();
    t.r.state.failClear = true;
    await expect(t.controller.clearSessions()).rejects.toThrow();
  });

  test("a save that fails does not disturb the turn", async () => {
    const t = setup();
    t.r.state.failSave = true;
    await t.turn("one", "1");
    await t.turn("two", "2");
    await t.r.recorder.flush();
    expect(t.controller.getState().status).toBe("idle");
    expect(t.r.failures()).toBe(1);
  });

  test("resume swaps the history, reopens with the handle and notes the restore", async () => {
    const t = setup();
    await t.turn("now", "ok");
    t.next.restored = true;
    expect(t.controller.canResume).toBe(true);
    expect(await t.controller.resume(saved())).toBe(true);
    const s = t.controller.getState();
    expect(s.status).toBe("idle");
    expect(s.messages).toEqual([
      { role: "user", text: "old question", attachments: [] },
      { role: "assistant", text: "old answer", format: "markdown" },
      { role: "separator", text: "resumed · conversation restored" },
    ]);
    expect(t.openedWith).toEqual([undefined, "H-old"]);
    expect(t.closed()).toBe(1);
  });

  test("the session that was left keeps its own file, and later turns go to the resumed one", async () => {
    const t = setup();
    t.r.files.set(OLD, saved());
    await t.turn("now", "ok");
    t.next.restored = true;
    t.next.conversation = "H-old";
    await t.controller.resume(saved());
    await t.turn("next", "fine");
    await t.r.recorder.flush();
    expect(t.r.files.get("id-1")?.messages).toEqual([
      { role: "user", text: "now" },
      { role: "assistant", text: "ok" },
    ]);
    expect(t.r.files.get(OLD)?.createdAt).toBe("2026-09-20T00:00:00.000Z");
    expect(t.r.files.get(OLD)?.messages.map((m) => m.text)).toEqual([
      "old question",
      "old answer",
      "resumed · conversation restored",
      "next",
      "fine",
    ]);
  });

  // Review Focus 5.
  test("a handle that does not open is noted and removed from the file", async () => {
    const t = setup();
    t.next.restored = false;
    await t.controller.resume(saved());
    expect(t.controller.getState().messages.at(-1)).toEqual({
      role: "separator",
      text: "resumed · conversation could not be restored",
    });
    await t.r.recorder.flush();
    expect("conversation" in (t.r.files.get(OLD) ?? {})).toBe(false);
    await t.controller.reopen();
    expect(t.openedWith).toEqual(["H-old", undefined]);
  });

  test("a record without a handle resumes the transcript only", async () => {
    const { conversation: _dropped, ...rest } = saved();
    const t = setup();
    t.next.restored = true;
    await t.controller.resume(rest);
    expect(t.openedWith).toEqual([undefined]);
    expect(t.controller.getState().messages.at(-1)).toEqual({
      role: "separator",
      text: "resumed · transcript only",
    });
  });

  test("when the browser does not open, the transcript stays and the handle is kept", async () => {
    const t = setup();
    t.next.openError = new AuthRequiredError("No saved auth state.");
    expect(await t.controller.resume(saved())).toBe(true);
    const s = t.controller.getState();
    expect(s.status).toBe("dead");
    expect(s.messages.slice(0, 2).map((m) => m.text)).toEqual([
      "old question",
      "old answer",
    ]);
    expect(s.messages.at(-1)?.role).toBe("error");
    t.next.openError = undefined;
    t.next.restored = true;
    await t.controller.reopen();
    expect(t.openedWith).toEqual(["H-old", "H-old"]);
  });

  test("refused while a turn is in flight", async () => {
    const t = setup();
    const p = t.controller.send("busy");
    await waitFor(() => t.replies.length > 0);
    expect(t.controller.canResume).toBe(false);
    expect(await t.controller.resume(saved())).toBe(false);
    expect(t.controller.getState().messages[0]?.text).toBe("busy");
    t.replies[0]?.resolve("done");
    await p;
  });

  test("refused while something is queued", async () => {
    const t = setup();
    const p = t.controller.send("busy");
    await waitFor(() => t.replies.length > 0);
    await t.controller.send("queued");
    expect(t.controller.canResume).toBe(false);
    t.replies[0]?.resolve("done");
    await p;
    await waitFor(() => t.replies.length > 1);
    t.replies[1]?.resolve("done too");
    await waitFor(() => t.controller.getState().status === "idle");
    expect(t.controller.canResume).toBe(true);
  });

  test("pending attachments survive a resume", async () => {
    const t = setup();
    t.controller.addAttachment({ path: "a.ts", bytes: 3, content: "abc" });
    await t.controller.resume(saved());
    expect(t.controller.getState().pendingAttachments).toEqual([
      { path: "a.ts", bytes: 3 },
    ]);
  });

  test("a resumed TUI shell entry is shown as text and saved unchanged", async () => {
    const shell = {
      role: "shell" as const,
      text: "ls",
      shell: {
        command: "ls",
        output: "a\n",
        exitCode: 0,
        interrupted: false,
        droppedBytes: 0,
        durationMs: 3,
      },
    };
    const t = setup();
    await t.controller.resume(saved({ messages: [shell] }));
    expect(t.controller.getState().messages[0]).toEqual({
      role: "user",
      text: "$ ls\na\n",
      attachments: [],
    });
    await t.r.recorder.flush();
    expect(t.r.files.get(OLD)?.messages[0]).toEqual(shell);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run build && bun test packages/vscode/src/stored-messages.test.ts packages/vscode/src/session-controller.test.ts -t "toStored|fromStored|saved sessions"`
Expected: FAIL (module missing; `recorder` is not an option; `resume` is not a function).

- [ ] **Step 3: Implement**

`packages/vscode/src/stored-messages.ts`:

```ts
import type { StoredMessage } from "@chatbridge/core";
import type { Message } from "./protocol.js";

/** The stored form of the entries this view cannot express. Keyed by the
 * controller's own message objects, so an entry that leaves the history
 * is forgotten with it. */
export type Origins = WeakMap<Message, StoredMessage>;

export function toStored(
  messages: readonly Message[],
  origins: Origins,
): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (const m of messages) {
    // A command listing is not part of the conversation.
    if (m.role === "help") continue;
    const origin = origins.get(m);
    if (origin !== undefined) {
      out.push(origin);
      continue;
    }
    const stored: StoredMessage = { role: m.role, text: m.text };
    if (m.attachments !== undefined && m.attachments.length > 0) {
      stored.attachments = m.attachments.map(({ path, bytes }) => ({
        path,
        bytes,
      }));
    }
    if (m.format === "markdown") stored.format = "markdown";
    if (m.incomplete === true) stored.incomplete = true;
    out.push(stored);
  }
  return out;
}

/** A TUI `!` command: this view has no shell role, so it reads as what
 * was typed and what came back. */
function shellText(stored: StoredMessage): string {
  const command = `$ ${stored.shell?.command ?? stored.text}`;
  const output = stored.shell?.output ?? "";
  return output === "" ? command : `${command}\n${output}`;
}

export function fromStored(
  stored: readonly StoredMessage[],
  origins: Origins,
): Message[] {
  return stored.map((s) => {
    if (s.role === "shell") {
      const shown: Message = {
        role: "user",
        text: shellText(s),
        attachments: [],
      };
      origins.set(shown, s);
      return shown;
    }
    const m: Message = { role: s.role, text: s.text };
    if (s.role === "user") {
      m.attachments = (s.attachments ?? []).map(({ path, bytes }) => ({
        path,
        bytes,
      }));
    }
    if (s.format === "markdown") m.format = "markdown";
    if (s.incomplete === true) m.incomplete = true;
    return m;
  });
}
```

Then change `session-controller.ts` as described under "Behaviour of the controller".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/vscode/src`
Expected: PASS, every VSCode unit test.

- [ ] **Step 5: Check and commit**

```bash
bunx biome check --write packages/vscode/src
bun run check
git add packages/vscode/src
git commit -m "feat(vscode): the chat view saves and resumes sessions (Refs #119, #74)"
gh issue comment 119 --body "Task 8 done: VSCode SessionController saves through SessionRecorder and gains resume / canResume / clearSessions; TUI shell entries survive a round trip through VSCode. What's next: Task 9, the VSCode command, QuickPick, setting and manifest."
```

---

### Task 9: VSCode — command, QuickPick, setting, manifest (Opus)

**Files:**
- Create: `packages/vscode/src/save-sessions-setting.ts`, `packages/vscode/src/save-sessions-setting.test.ts`
- Modify: `packages/vscode/src/commands.ts`, `packages/vscode/src/commands.test.ts`, `packages/vscode/src/vscode-ui.ts`, `packages/vscode/src/manifest.ts`, `packages/vscode/src/manifest.test.ts`, `packages/vscode/src/create-extension.ts`, `packages/vscode/src/index.ts`

**Interfaces:**
- Consumes: from Task 8 `controller.canResume`, `controller.resume(record)`, `controller.clearSessions()`; from core `SessionRecorder`, `SessionSummary`, `createSessionStore`, `formatSessionTime`, and the messages of `resume-messages.ts`.
- Produces:

```ts
// save-sessions-setting.ts
/** `<id>.saveSessions`: unset means on. `invalid` is true when a value was
 * set that is not a boolean, so the caller can warn once; saving stays on. */
export function parseSaveSessions(raw: unknown): {
  enabled: boolean;
  invalid: boolean;
};

// vscode-ui.ts — VscodeUi gains
  /** Native picker over the saved sessions; resolves to the chosen id, or
   * undefined when dismissed. Optional: a vendor's own VscodeUi written
   * against an earlier release has none, and resume is then a no-op. */
  pickSession?(sessions: readonly SessionSummary[]): Promise<string | undefined>;

// commands.ts — CommandDeps gains
  /** The saved sessions. Optional, so a vendor's older wiring still
   * type-checks; resume then reports that saving is off. */
  sessions?: SessionRecorder;
// CommandHandlers gains
  /** `/resume` and the `<id>.resume` command. */
  resume(): Promise<void>;

// manifest.ts
export const OPTIONAL_COMMAND_NAMES = ["help", "resume"] as const;

// create-extension.ts — ExtensionApi gains
  /** The E2E reads and seeds saved sessions through it. */
  sessions: SessionRecorder;
```

**Behaviour:**

- `handlers.resume()`, in this order:
  1. `deps.sessions === undefined || !deps.sessions.enabled` → `ui.showInformationMessage(SESSIONS_OFF_MESSAGE)`.
  2. `!controller.canResume` → `ui.showWarningMessage(RESUME_BUSY_MESSAGE)`.
  3. `const list = await deps.sessions.list().catch(() => [])`; empty → `ui.showInformationMessage(NO_SESSIONS_MESSAGE)`.
  4. `ui.pickSession === undefined` → return. Otherwise `const id = await ui.pickSession(list)`; `undefined` (dismissed) → return.
  5. `const record = await deps.sessions.load(id).catch(() => undefined)`; `undefined` → `ui.showWarningMessage(SESSION_UNREADABLE_MESSAGE)`.
  6. `ui.focusView()`, then `if (!(await controller.resume(record))) ui.showWarningMessage(RESUME_BUSY_MESSAGE)`: a turn may have started while the picker was open.
- `handlers.logout()`: after `await deps.clearAuth()` and before `controller.discard("Logged out")`:

```ts
      try {
        await controller.clearSessions();
      } catch {
        // The auth state is gone, so the logout itself stands. No detail:
        // the error may name a session file.
        ui.showWarningMessage(SESSIONS_NOT_DELETED_MESSAGE);
      }
```

- `createVscodeUi().pickSession`:

```ts
    pickSession: async (sessions) => {
      const picked = await api.window.showQuickPick(
        sessions.map((s) => ({
          label: s.title,
          description: s.turns === 1 ? "1 turn" : `${s.turns} turns`,
          detail: formatSessionTime(s.updatedAt),
          id: s.id,
        })),
        { placeHolder: "Resume a saved session", matchOnDetail: true },
      );
      return picked?.id;
    },
```

- `manifest.ts`: `OPTIONAL_COMMAND_NAMES` becomes `["help", "resume"]`, and `TITLE_MENU` gains `{ name: "resume", group: "0_session@1" }` as its third entry, after the two `navigation` ones. The group sorts before `1_auth`, so Resume is the first entry of the `...` overflow. `COMMAND_NAMES` does not change: a manifest without the command keeps activating.
- `create-extension.ts`:
  - Build the store and the recorder before the controller:

```ts
    let warnedSaveSessions = false;
    const sessions = new SessionRecorder({
      store: createSessionStore({
        configDir: opts.configDir ?? opts.id,
        providerName: opts.provider.name,
        baseDir: opts.baseDir,
      }),
      provider: opts.provider.name,
      enabled: () => {
        const cfg = vscode.workspace.getConfiguration(opts.id);
        const { enabled, invalid } = parseSaveSessions(
          userSetting(cfg.inspect<unknown>("saveSessions")),
        );
        if (invalid && !warnedSaveSessions) {
          warnedSaveSessions = true;
          void vscode.window.showWarningMessage(
            `${opts.displayName}: "${opts.id}.saveSessions" must be true or false; sessions are saved.`,
          );
        }
        return enabled;
      },
      onSaveFailed: () =>
        void vscode.window.showWarningMessage(
          `${opts.displayName}: ${SAVE_FAILED_MESSAGE}`,
        ),
    });
```

  - Pass `recorder: sessions` to `new SessionController({…})` and `sessions` to `createCommands({…})`.
  - Register `${opts.id}.resume` next to `${opts.id}.help`, with the same comment about optional commands: `vscode.commands.registerCommand(\`${opts.id}.resume\`, () => handlers.resume())`.
  - `deactivate`: `await controller?.close();` then `await sessions?.flush();` (hoist `sessions` next to `controller` as `let sessions: SessionRecorder | undefined`).
  - Return `{ controller, handlers, bridge, sessions }`.
- The webview does not change in this task: `/resume` typed in the composer arrives with Task 10.

- [ ] **Step 1: Write the failing tests**

`packages/vscode/src/save-sessions-setting.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseSaveSessions } from "./save-sessions-setting.js";

describe("parseSaveSessions", () => {
  test("unset means on", () => {
    expect(parseSaveSessions(undefined)).toEqual({
      enabled: true,
      invalid: false,
    });
  });

  test.each([true, false])("%p is taken as it is", (value) => {
    expect(parseSaveSessions(value)).toEqual({
      enabled: value,
      invalid: false,
    });
  });

  test.each(["false", 0, null, {}])(
    "%p is invalid and saving stays on",
    (value) => {
      expect(parseSaveSessions(value)).toEqual({
        enabled: true,
        invalid: true,
      });
    },
  );
});
```

In `packages/vscode/src/manifest.test.ts`:

- add `{ command: "acme.resume", title: "Resume" }` to `upgraded.contributes.commands` and `"resume"` to the list that builds `upgraded`'s `view/title` menu;
- in `"a 0.9.0-style manifest has no fatal findings, only recommended ones"` the expected list becomes:

```ts
    expect(recommendedContributions(full, "acme")).toEqual([
      "commands: acme.help",
      "commands: acme.resume",
      "commands.icon: acme.newChat",
      "commands.icon: acme.reopen",
      "menus.view/title: acme.newChat (navigation@1)",
      "menus.view/title: acme.reopen (navigation@2)",
      "menus.view/title: acme.resume (0_session@1)",
      "menus.view/title: acme.login (1_auth@1)",
      "menus.view/title: acme.logout (1_auth@2)",
      "menus.view/title: acme.installBrowser (2_setup@1)",
      "menus.view/title: acme.help (3_help@1)",
    ]);
```

- in `"a view/title entry bound to another view does not count"` add `"menus.view/title: acme.resume (0_session@1)"` after the `acme.reopen` line;
- `"a manifest without contributes recommends everything"` expects length `11`;
- add:

```ts
  test("resume is optional: a manifest without it is not missing anything", () => {
    expect(missingContributions(full, "acme")).toEqual([]);
    expect(COMMAND_NAMES).not.toContain("resume");
    expect(OPTIONAL_COMMAND_NAMES).toContain("resume");
  });
```

In `packages/vscode/src/commands.test.ts`, extend the fake. `Fake` gains:

```ts
  /** What the fake session picker returns; undefined is a dismissed picker. */
  pickedSession: string | undefined;
  /** Drives `controller.canResume` and what `controller.resume` returns. */
  canResume: boolean;
  /** Makes `controller.clearSessions` reject. */
  clearSessionsFails: boolean;
```

Initialise them in `fake()` (`pickedSession: undefined`, `canResume: true`, `clearSessionsFails: false`), add `"canResume" | "resume" | "clearSessions"` to the `Pick<SessionController, …>` of `controller`, add to `f.ui`:

```ts
    pickSession: async (sessions) => {
      f.log.push(`pickSession:${sessions.map((s) => s.title).join(",")}`);
      return f.pickedSession;
    },
```

and to `f.controller`:

```ts
    get canResume() {
      return f.canResume;
    },
    resume: async (record) => {
      f.log.push(`resume:${record.id}`);
      return f.canResume;
    },
    clearSessions: async () => {
      f.log.push("clearSessions");
      if (f.clearSessionsFails) throw new Error("permission denied");
    },
```

Then append (add `SessionRecorder`, `type SessionRecord`, `type SessionStoreLike` and the six messages to the `@chatbridge/core` import):

```ts
describe("commands: resume", () => {
  const OLD = "11111111-1111-4111-8111-111111111111";
  const record: SessionRecord = {
    version: 1,
    id: OLD,
    provider: "dummy-chat",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:10:00.000Z",
    messages: [{ role: "user", text: "old question" }],
  };

  function sessions(
    opts: { records?: SessionRecord[]; enabled?: boolean; broken?: boolean } = {},
  ) {
    const files = new Map((opts.records ?? [record]).map((r) => [r.id, r]));
    const store: SessionStoreLike = {
      async save() {},
      load: async (id) => (opts.broken ? undefined : files.get(id)),
      list: async () =>
        [...files.values()].map((r) => ({
          id: r.id,
          updatedAt: r.updatedAt,
          title: r.messages[0]?.text ?? "",
          turns: 1,
        })),
      async prune() {},
      async clear() {},
    };
    return new SessionRecorder({
      store,
      provider: "dummy-chat",
      enabled: () => opts.enabled ?? true,
    });
  }

  test("picks a session, focuses the view and resumes it", async () => {
    const f = fake();
    f.pickedSession = OLD;
    await commands(f, { sessions: sessions() }).resume();
    expect(f.log).toEqual([
      "pickSession:old question",
      "focus",
      `resume:${OLD}`,
    ]);
  });

  test("a dismissed picker changes nothing", async () => {
    const f = fake();
    await commands(f, { sessions: sessions() }).resume();
    expect(f.log).toEqual(["pickSession:old question"]);
  });

  test("without saved sessions it says so", async () => {
    const f = fake();
    await commands(f, { sessions: sessions({ records: [] }) }).resume();
    expect(f.log).toEqual([`info:${NO_SESSIONS_MESSAGE}`]);
  });

  test("with saving off it says so", async () => {
    const f = fake();
    await commands(f, { sessions: sessions({ enabled: false }) }).resume();
    expect(f.log).toEqual([`info:${SESSIONS_OFF_MESSAGE}`]);
  });

  test("without a recorder it says saving is off", async () => {
    const f = fake();
    await commands(f).resume();
    expect(f.log).toEqual([`info:${SESSIONS_OFF_MESSAGE}`]);
  });

  test("refused while the controller cannot resume, before any picker", async () => {
    const f = fake();
    f.canResume = false;
    await commands(f, { sessions: sessions() }).resume();
    expect(f.log).toEqual([`warn:${RESUME_BUSY_MESSAGE}`]);
  });

  test("a session that cannot be loaded is reported and nothing is resumed", async () => {
    const f = fake();
    f.pickedSession = OLD;
    await commands(f, { sessions: sessions({ broken: true }) }).resume();
    expect(f.log).toEqual([
      "pickSession:old question",
      `warn:${SESSION_UNREADABLE_MESSAGE}`,
    ]);
  });

  test("a turn that started while the picker was open refuses the resume", async () => {
    const f = fake();
    f.pickedSession = OLD;
    f.ui.pickSession = async () => {
      f.canResume = false;
      return OLD;
    };
    await commands(f, { sessions: sessions() }).resume();
    expect(f.log).toEqual([
      "focus",
      `resume:${OLD}`,
      `warn:${RESUME_BUSY_MESSAGE}`,
    ]);
  });

  test("a UI without a session picker does nothing", async () => {
    const f = fake();
    f.ui.pickSession = undefined;
    await commands(f, { sessions: sessions() }).resume();
    expect(f.log).toEqual([]);
  });
});

describe("commands: logout and saved sessions", () => {
  test("deletes the auth state, then the sessions, then discards", async () => {
    const f = fake();
    await commands(f).logout();
    expect(f.log).toEqual(["clearAuth", "clearSessions", "discard:Logged out"]);
  });

  test("a busy controller deletes nothing", async () => {
    const f = fake();
    f.busy = true;
    await commands(f).logout();
    expect(f.log).not.toContain("clearSessions");
    expect(f.cleared).toBe(0);
  });

  test("sessions that cannot be deleted are reported and the logout stands", async () => {
    const f = fake();
    f.clearSessionsFails = true;
    await commands(f).logout();
    expect(f.log).toEqual([
      "clearAuth",
      "clearSessions",
      `warn:${SESSIONS_NOT_DELETED_MESSAGE}`,
      "discard:Logged out",
    ]);
    expect(f.log.join("\n")).not.toContain("permission denied");
  });
});
```

Existing logout tests in `commands.test.ts` that assert the exact log (`["clearAuth", "discard:Logged out"]`) gain `"clearSessions"` between the two.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/vscode/src/save-sessions-setting.test.ts packages/vscode/src/manifest.test.ts packages/vscode/src/commands.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/vscode/src/save-sessions-setting.ts`:

```ts
/** `<id>.saveSessions`: unset means on. `invalid` is true when a value was
 * set that is not a boolean, so the caller can warn once; saving stays on,
 * which is what an unset value does. */
export function parseSaveSessions(raw: unknown): {
  enabled: boolean;
  invalid: boolean;
} {
  if (raw === undefined) return { enabled: true, invalid: false };
  if (typeof raw !== "boolean") return { enabled: true, invalid: true };
  return { enabled: raw, invalid: false };
}
```

Then change `commands.ts`, `vscode-ui.ts`, `manifest.ts` and `create-extension.ts` as described under "Behaviour". Export `parseSaveSessions` and `OPTIONAL_COMMAND_NAMES` from `packages/vscode/src/index.ts` only if the neighbouring helpers of the same kind are exported there (`parseTimeoutSec` is not, so `parseSaveSessions` is not either).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/vscode/src`
Expected: PASS.

- [ ] **Step 5: Check and commit**

```bash
bunx biome check --write packages/vscode/src
bun run check
git add packages/vscode/src
git commit -m "feat(vscode): resume command with a QuickPick, saveSessions setting (Refs #119, #74)"
gh issue comment 119 --body "Task 9 done: VSCode <id>.resume command (optional in the manifest), QuickPick, <id>.saveSessions, logout deletes sessions, flush on deactivate. What's next: Task 10, /resume as a built-in slash command."
```

---

### Task 10: `/resume` becomes a built-in (Opus)

Adding the name changes three packages at once: `defineProvider` rejects it, the TUI's `switch` must handle it, and the webview posts it. They land in one commit so the build never breaks.

**Files:**
- Modify: `packages/provider/src/index.ts`, `packages/provider/src/index.test.ts`, `packages/core/src/slash-commands.ts`, `packages/core/src/slash-commands.test.ts`, `packages/cli/src/tui/chat-model.ts`, `packages/cli/src/tui/chat-model.test.ts`, `packages/cli/src/tui/chat-view.test.ts`, `packages/vscode/src/protocol.ts`, `packages/vscode/src/chat-view-bridge.ts`, `packages/vscode/src/chat-view-bridge.test.ts`, `packages/vscode/src/webview/command-menu.test.ts`, `packages/vscode/src/webview/stream-state.test.ts`, and `packages/vscode/src/webview/main.ts` only if Step 3's reading finds a gap

**Interfaces:**
- Consumes: from Task 6 `model.openResumePicker()`; from Task 9 `handlers.resume()`.
- Produces: `BUILTIN_COMMAND_NAMES` and `SLASH_COMMANDS` contain `resume`; `WebviewCommand` and `COMMAND_LIST` contain `"resume"`.

**What to change:**

- `packages/provider/src/index.ts`: `BUILTIN_COMMAND_NAMES` becomes `["login", "logout", "new", "reopen", "resume", "copy", "help"]`.
- `packages/core/src/slash-commands.ts`: add `{ name: "resume", description: "Go back to a saved session" }` after the `reopen` entry. After, not before: the popups complete the first match in table order, and `/re` followed by Tab must keep completing to `/reopen`.
- `packages/cli/src/tui/chat-model.ts`, `runSlash`: 

```ts
      case "resume":
        await this.openResumePicker();
        return true;
```

- `packages/vscode/src/protocol.ts`: `WebviewCommand` gains `| "resume"` with the comment `/** The host shows the saved sessions in a native picker. */`.
- `packages/vscode/src/chat-view-bridge.ts`: `COMMAND_LIST` gains `"resume"`. `create-extension.ts` already dispatches `handlers[name]()`, and `CommandHandlers` has `resume` since Task 9.
- The webview's `main.ts` maps a built-in to a `command` message by name (`slash.command === "new" ? "newChat" : slash.command`), so `/resume` needs no code there.

- [ ] **Step 1: Write the failing tests**

`packages/provider/src/index.test.ts`, after the test `"rejects /copy, a built-in since the clipboard milestone"` (`baseProvider` and `cmd` are that file's fixtures):

```ts
  test("rejects /resume, a built-in since the session milestone", () => {
    expect(() =>
      defineProvider({ ...baseProvider, commands: [cmd("resume")] }),
    ).toThrow('Provider command "/resume" collides with a built-in command.');
  });
```

`packages/core/src/slash-commands.test.ts`:

```ts
  test("resume is a built-in that takes no arguments", () => {
    expect(parseSlashCommand("/resume")).toEqual({ command: "resume" });
    expect(parseSlashCommand("/resume now")).toEqual({
      error: "/resume takes no arguments.",
    });
  });

  test("help lists resume between reopen and copy", () => {
    const lines = helpText().split("\n");
    const at = (name: string) =>
      lines.findIndex((l) => l.startsWith(`/${name} `));
    expect(at("reopen")).toBeGreaterThanOrEqual(0);
    expect(at("reopen")).toBeLessThan(at("resume"));
    expect(at("resume")).toBeLessThan(at("copy"));
    expect(lines[at("resume")]).toContain("Go back to a saved session");
  });

  test("the first match of /re is still reopen", () => {
    expect(matchCommands("re", []).map((c) => c.name)).toEqual([
      "reopen",
      "resume",
    ]);
  });
```

`packages/cli/src/tui/chat-model.test.ts`, inside `describe("ChatModel resume", …)`:

```ts
  test("/resume opens the picker and is not sent", async () => {
    const t = await setup();
    expect(await t.model.submit("/resume")).toBe(true);
    expect(t.model.picker?.map((s) => s.id)).toEqual([OLD]);
    expect(t.a.calls).toEqual([]);
    expect(t.model.messages).toEqual([]);
  });

  test("/resume with arguments is an error and opens nothing", async () => {
    const t = await setup();
    expect(await t.model.submit("/resume 1")).toBe(false);
    expect(t.model.picker).toBeUndefined();
    expect(t.model.messages.at(-1)).toEqual({
      role: "error",
      text: "/resume takes no arguments.",
    });
  });

  test("/resume typed during a turn is refused, not queued", async () => {
    const t = await setup();
    void t.model.submit("busy");
    await tick();
    expect(await t.model.submit("/resume")).toBe(true);
    expect(t.model.queue).toEqual([]);
    expect(t.model.notice).toBe(RESUME_BUSY_MESSAGE);
  });
```

`packages/cli/src/tui/chat-view.test.ts`, inside `describe("ChatView session picker", …)`:

```ts
  test("typing /resume and Enter opens the picker", async () => {
    const t = await setup({ recorder: recorderWith(2) });
    await t.mockInput.typeText("/resume");
    t.mockInput.pressEnter();
    const frame = await t.frameWith("saved prompt 1");
    expect(frame).toContain("saved prompt 2");
    expect(t.view.inputText).toBe("");
  });
```

`packages/vscode/src/chat-view-bridge.test.ts`, after the test `"a /copy command is accepted and routed"` (`fakeWebview`, `state` and `noopHandlers` are that file's fixtures):

```ts
  test("a /resume command is accepted and routed", () => {
    const calls: string[] = [];
    const bridge = new ChatViewBridge(() => state, {
      ...noopHandlers,
      command: (n) => calls.push(`cmd:${n}`),
    });
    const w = fakeWebview();
    bridge.attach(w.webview);
    w.receive({ type: "command", name: "resume" });
    expect(calls).toEqual(["cmd:resume"]);
  });

  test("COMMAND_LIST names resume", () => {
    expect(COMMAND_LIST).toContain("resume");
  });
```

`packages/vscode/src/webview/stream-state.test.ts`:

```ts
  test("a replaced history shares no prefix with the one before it", () => {
    const before = [
      messageKey({ role: "user", text: "now", attachments: [] }),
      messageKey({ role: "assistant", text: "ok" }),
    ];
    const after = [
      messageKey({ role: "user", text: "old question", attachments: [] }),
      messageKey({ role: "assistant", text: "old answer", format: "markdown" }),
      messageKey({ role: "separator", text: "resumed · transcript only" }),
    ];
    expect(commonPrefix(before, after)).toBe(0);
  });

  test("a replaced history that is shorter keeps only what matches", () => {
    const same = messageKey({ role: "user", text: "hi", attachments: [] });
    const before = [same, messageKey({ role: "assistant", text: "a" }), messageKey({ role: "error", text: "e" })];
    const after = [same, messageKey({ role: "assistant", text: "b" })];
    expect(commonPrefix(before, after)).toBe(1);
  });
```

`packages/vscode/src/webview/command-menu.test.ts`, inside `describe("buildSections: filtering", …)` (`custom` is that file's fixture):

```ts
  test("resume is offered with the built-ins", () => {
    const sections = buildSections("Dummy Chat", custom, "res");
    expect(sections.map((s) => s.title)).toEqual(["Commands"]);
    expect(sections[0]?.items).toEqual([
      { name: "resume", description: "Go back to a saved session" },
    ]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/provider packages/core/src/slash-commands.test.ts`
Expected: FAIL (`/resume` parses as `{ unknown: "resume" }`).

- [ ] **Step 3: Implement**, then read `packages/vscode/src/webview/main.ts`'s history rendering (search for `commonPrefix`). Confirm that when the new state has fewer messages than were rendered, or differs from index 0, the nodes past the common prefix are removed before the new ones are appended. If they are, no change. If a shrinking history leaves stale nodes, fix it there and cover the decision in `stream-state.ts` as a pure function with a test; do not add a DOM test.

- [ ] **Step 4: Run everything**

Run: `bun run build && bun test`
Expected: PASS. Two kinds of existing tests may need their expectations updated, and only these:
- tests that assert the full `/help` text or the full list of built-ins;
- TUI view tests that count popup rows after typing `/`: there are now seven built-ins, and the popup shows at most eight rows.

- [ ] **Step 5: Check and commit**

```bash
bunx biome check --write packages
bun run check
git add packages
git commit -m "feat: /resume is a built-in command in the TUI and the VSCode view (Refs #119, #74)"
gh issue comment 119 --body "Task 10 done: resume is a reserved built-in name (provider, core), wired in the TUI and the VSCode webview protocol. What's next: Task 11, E2E against the dummy chat."
```

---

### Task 11: E2E against the dummy chat (Opus)

**Files:**
- Modify: `packages/cli/src/cli.e2e.test.ts`, `examples/vscode-dummy-chat/test/suite.ts`

**Interfaces:**
- Consumes: everything above. The dummy chat keeps its conversations in memory for the life of the server, answers `turns?` with `Echo: turns? (turn N)`, puts the conversation in the URL as `/chat/c/<8 chars>` and redirects an unknown id to `/chat`.

**What the CLI E2E proves:** two `ChatModel`s over the same base dir stand for two processes. The second has no memory of the first except what is on disk.

- [ ] **Step 1: Write the tests**

In `packages/cli/src/cli.e2e.test.ts`, add `SessionRecorder`, `SessionStore` and `createSessionStore` to the `@chatbridge/core` import, and change `openModel` inside `describe("interactive model against the dummy chat", …)` so that it saves sessions and honours the handle it is given:

```ts
  async function openModel(
    baseDir: string,
    serverUrl: string,
    opts: { prepared?: boolean } = {},
  ) {
    const provider = opts.prepared
      ? createDummyProvider(serverUrl)
      : await prepareAuth(baseDir, serverUrl);
    const authStore = new AuthStore({
      configDir: "test-cli",
      providerName: provider.name,
      baseDir,
    });
    const recorder = new SessionRecorder({
      store: createSessionStore({
        configDir: "test-cli",
        providerName: provider.name,
        baseDir,
      }),
      provider: provider.name,
    });
    const timeoutMs = 30_000;
    const model = new ChatModel({
      openSession: (_report, _onIdleExpired, conversation) =>
        ChatSession.open({
          provider,
          authStore,
          headless: true,
          timeoutMs,
          conversation,
        }),
      login: async () => {},
      clearAuth: () => authStore.clear(),
      recorder,
      commands: commandInfoOf(provider),
      expand: (text) =>
        expandInput(text, {
          cwd: baseDir,
          hooks: provider.urlHooks ?? [],
          timeoutMs,
        }),
    });
    cleanups.push(() => model.session?.close());
    await model.ready;
    expect(model.status).toBe("idle");
    return { model, provider, recorder };
  }
```

The four existing tests of that block keep working: they ignore the new return value.

Append to the same `describe`:

```ts
  test("a session saved by one process is resumed by another", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();

    const first = await openModel(baseDir, server.url);
    expect(await first.model.submit("hello")).toBe(true);
    expect(await first.model.submit("again")).toBe(true);
    await first.recorder.flush();
    await first.model.session?.close();

    const second = await openModel(baseDir, server.url, { prepared: true });
    await second.model.openResumePicker();
    expect(second.model.picker).toHaveLength(1);
    expect(second.model.picker?.[0]?.title).toBe("hello");
    expect(second.model.picker?.[0]?.turns).toBe(2);

    await second.model.resume(second.model.picker?.[0]?.id ?? "");
    expect(second.model.status).toBe("idle");
    expect(second.model.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "separator",
    ]);
    expect(second.model.messages[0]?.text).toBe("hello");
    expect(second.model.messages.at(-1)?.text).toBe(
      "resumed · conversation restored",
    );

    // The service side came back too: its turn counter carries on.
    expect(await second.model.submit("turns?")).toBe(true);
    expect(second.model.messages.at(-1)?.text).toBe(
      "Echo: turns? (turn 3)",
    );

    // And the resumed file, not a new one, received the turn.
    await second.recorder.flush();
    const store = new SessionStore({
      configDir: "test-cli",
      providerName: second.provider.name,
      baseDir,
    });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.turns).toBe(3);
  }, 120_000);

  // Review Focus 5.
  test("a handle the service no longer knows falls back to a new chat", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const { model, provider, recorder } = await openModel(
      baseDir,
      server.url,
    );
    const id = "11111111-1111-4111-8111-111111111111";
    const store = new SessionStore({
      configDir: "test-cli",
      providerName: provider.name,
      baseDir,
    });
    await store.save({
      version: 1,
      id,
      provider: provider.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Well-formed, but the server never issued it.
      conversation: `${server.url}/chat/c/zzzzzzzz`,
      messages: [
        { role: "user", text: "from another life" },
        { role: "assistant", text: "Echo: from another life (turn 1)" },
      ],
    });

    await model.resume(id);
    expect(model.status).toBe("idle");
    expect(model.messages.at(-1)).toEqual({
      role: "separator",
      text: "resumed · conversation could not be restored",
    });
    expect(await model.submit("turns?")).toBe(true);
    expect(model.messages.at(-1)?.text).toBe("Echo: turns? (turn 1)");

    await recorder.flush();
    const after = await store.load(id);
    // The dead handle is gone; the new conversation's handle took its place.
    expect(after?.conversation).not.toBe(`${server.url}/chat/c/zzzzzzzz`);
    expect(after?.conversation).toMatch(/\/chat\/c\/[a-z0-9]{8}$/);
  }, 120_000);

  test("/logout deletes the saved sessions", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const { model, provider, recorder } = await openModel(
      baseDir,
      server.url,
    );
    expect(await model.submit("hello")).toBe(true);
    await recorder.flush();
    const store = new SessionStore({
      configDir: "test-cli",
      providerName: provider.name,
      baseDir,
    });
    expect(await store.list()).toHaveLength(1);

    await model.submit("/logout");
    await recorder.flush();
    expect(await store.list()).toEqual([]);
    // Logged out: the reopen has no auth state to open with.
    expect(model.status).toBe("dead");
  }, 120_000);
```

In the existing test `"auth logout deletes the saved state"` of `describe("createCli", …)`, save a session before the logout and assert it is gone after it:

```ts
    const sessions = new SessionStore({
      configDir: "test-cli",
      providerName: provider.name,
      baseDir,
    });
    await sessions.save({
      version: 1,
      id: "11111111-1111-4111-8111-111111111111",
      provider: provider.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [{ role: "user", text: "hi" }],
    });
    // …existing logout call and auth assertion…
    expect(await sessions.list()).toEqual([]);
```

In `examples/vscode-dummy-chat/test/suite.ts`, take `sessions` from the API (`const { controller, handlers, bridge, sessions } = api;`) and append, before the function returns. The separators are hardcoded for the reason the file already gives for `RESTORED_SEPARATOR`:

```ts
  // Saved sessions: every settled turn above is on disk under the base dir
  // the runner passed. "New chat" split the run into two saved sessions.
  await sessions.flush();
  await waitForIdle(controller);
  assert.equal(await controller.newChat(), true);
  const saved = await sessions.list();
  assert.ok(
    saved.length >= 2,
    `expected at least two saved sessions, got ${saved.length}`,
  );
  const firstSession = saved.find((x) => x.title === "hello from vscode");
  assert.ok(firstSession, "the first session of this run is listed");

  // Resume through the controller: the QuickPick itself cannot be driven
  // from here, and the handler only chooses which record to pass.
  const record = await sessions.load(firstSession.id);
  assert.ok(record, "the saved session loads");
  assert.equal(await controller.resume(record), true);
  s = controller.getState();
  assert.equal(s.status, "idle");
  assert.equal(s.messages[0]?.text, "hello from vscode");
  assert.deepEqual(s.messages.at(-1), {
    role: "separator",
    text: "resumed · conversation restored",
  });
  // One turn was settled in that conversation before "New chat".
  const resumedTurn = await controller.send("turns?");
  assert.deepEqual(resumedTurn, { ok: true });
  await waitForIdle(controller);
  s = controller.getState();
  assert.match(s.messages.at(-1)?.text ?? "", /^Echo: turns\? \(turn 2\)$/);

  // The command is registered even though it is optional in a manifest.
  const all = await vscode.commands.getCommands(true);
  assert.ok(all.includes("chatbridge-dummy.resume"));

  // Logout deletes what was saved.
  await handlers.logout();
  await sessions.flush();
  assert.deepEqual(await sessions.list(), []);
```

If the suite continues after this point with steps that need a logged-in session, place this block last.

- [ ] **Step 2: Run the CLI E2E**

Run: `bun run build && bun test packages/cli/src/cli.e2e.test.ts`
Expected: PASS. If `turn 3` reads `turn 1`, the handle was not passed to `ChatSession.open`; if the failed-restore test says `transcript only`, the saved handle did not reach the model.

- [ ] **Step 3: Run the VSCode E2E**

Run: `bun run e2e:vscode`
Expected: PASS. It needs a display (`xvfb-run -a bun run e2e:vscode` on a headless machine). If it cannot run on this machine, say so in the issue comment and leave it to CI; do not mark it as passed.

- [ ] **Step 4: Check and commit**

```bash
bunx biome check --write packages/cli/src/cli.e2e.test.ts examples/vscode-dummy-chat/test/suite.ts
bun run check
git add packages/cli/src/cli.e2e.test.ts examples/vscode-dummy-chat/test/suite.ts
git commit -m "test: E2E for session resume, failed restore and logout (Refs #119, #74)"
gh issue comment 119 --body "Task 11 done: E2E against the dummy chat (resume across two models, unknown handle falls back, logout deletes) in the CLI and the VSCode example. What's next: Task 12, documentation, upgrade guide, templates."
```

---

### Task 12: Documentation, upgrade guide, templates (Sonnet)

**Files:**
- Modify: `docs/users/interactive-mode.md`, `docs/users/configuration.md`, `docs/users/vscode.md`, `docs/users/cli.md`, `docs/providers/extension-points/conversation.md`, `docs/providers/define-provider.md`, `README.md`, `docs/superpowers/specs/2026-09-27-session-resume-design.md`
- Modify: `packages/provider/skills/upgrading-provider-repo/upgrade-guide.md`
- Modify: `packages/provider/skills/creating-provider-repo/templates/vscode/package.json`, `packages/provider/skills/creating-provider-repo/templates/vscode/src/extension.ts`, `packages/provider/skills/creating-provider-repo/templates/src/bin.ts`, `packages/provider/skills/creating-provider-repo/vscode-extension.md`
- Modify: `examples/vscode-dummy-chat/package.json`, `examples/vscode-dummy-chat/src/extension.ts`

No test cycle: this task changes prose and manifests. `bun run check` still runs, because the template and example manifests are read by tests.

- [ ] **Step 1: User documentation**

`docs/users/interactive-mode.md`:

- In the slash command table, after the `/reopen` row: `| /resume | Go back to a saved session. Opens a list of this provider's saved sessions; Up/Down to move, Enter to resume, Esc to cancel. |` (match the table's existing column layout).
- Replace the sentence in "Idle close and reopen" that says the handle "lives only in memory" with: `The handle is kept in memory and saved with the session, so /resume can return to the conversation in a later run.`
- Add a section after "Idle close and reopen":

```markdown
## Saved sessions and /resume

Every interactive session is saved as it proceeds, one file per session, under
`~/.config/<configDir>/sessions/<provider name>/`. A session in which nothing
was sent leaves no file. `/new` starts a new saved session; `/reopen` and the
reopen after an idle close stay in the same one.

`/resume` lists the saved sessions of the current provider, newest first, each
with its last update, the first line of its first prompt and its number of
turns. The session you are in is not listed. Resuming replaces the history on
screen with the saved one and reopens the browser. The separator that follows
says what came back:

| Separator | Meaning |
|---|---|
| `resumed · conversation restored` | The service reopened the conversation. It continues where it stopped. |
| `resumed · conversation could not be restored` | The service did not reopen it. The history is on screen, but the assistant starts a new chat and does not know it. |
| `resumed · transcript only` | The session had no conversation to reopen, or the provider cannot name its conversations. Same consequence as above. |

`/resume` waits its turn: while a reply, a shell command, a login or a reopen is
in flight, or while messages are queued, it answers
`Wait for the current step to finish before /resume.` and does nothing.

Saved sessions need no housekeeping. Sessions not updated for 14 days are
deleted, and only the 50 most recent are kept. `/logout` and `auth logout`
delete every saved session of the provider. An expired login deletes nothing.

What is saved: the messages as the history shows them, the output of `!`
commands, the paths and sizes of attached files, and the conversation handle.
Not saved: the content of attached files, `/help` output, and a reply still
being written.

To turn saving off, see `sessions.enabled` in
[configuration](configuration.md). One-shot mode (`-p`) never saves.
```

`docs/users/configuration.md`:

- In "Keys", add `sessions.enabled` in the table's existing format: type boolean, default `true`, "Save interactive sessions and offer them to `/resume`. `false` saves nothing and leaves existing files alone; logging out still deletes them."
- In the example `config.json`, if the page has a full example, add `"sessions": { "enabled": true }`.
- In "Files on disk", add the row: `| ~/.config/<configDir>/sessions/<provider name>/<id>.json | One saved interactive session: its messages and the conversation handle. | The interactive TUI and the VSCode view, after every settled turn. | Automatically after 14 days without an update or beyond the 50 most recent; and by auth logout, /logout and the VSCode Log out command. |` with backticks as in the neighbouring rows.
- After the paragraph about the auth directory's modes, add: `The sessions directories are created with mode 0700 and each session file with mode 0600. A session file holds what you and the assistant wrote. It is not a credential, but treat it as private.`

`docs/users/vscode.md`:

- Commands: add `Resume` (`<id>.resume`): "Pick a saved session and go back to it. In the view's `...` menu and the palette when the extension's manifest declares it."
- Slash commands: add `/resume`.
- Settings: add `<id>.saveSessions` (boolean, default `true`).
- Add a short "Saved sessions" section that links to the section in `interactive-mode.md` and states the two differences: the picker is VSCode's own QuickPick (type to filter), and a `!` command saved by the TUI is shown as plain text (`$ command` and its output).

`docs/users/cli.md`: in the `auth logout` description add "and the provider's saved interactive sessions".

`README.md`: one line in the feature list: "Interactive sessions are saved locally and `/resume` goes back to one, conversation included when the provider supports it."

- [ ] **Step 2: Provider documentation**

`docs/providers/extension-points/conversation.md`: replace the lines that say core stores the handle in memory only and that cross-process resume is not implemented (#119) with:

```markdown
Core keeps the handle in memory and saves it with the interactive session
(`~/.config/<configDir>/sessions/<provider name>/<id>.json`, mode `0600`), so
`/resume` can hand it back to `open` in a later process. It is never logged.

Because the handle reaches the disk, it must never embed a credential: no
token, no signed URL, no session id of the login. A conversation URL or id is
what it is for. `open` may be called with a handle from days ago, from before
a logout and a new login, or for a conversation that was deleted since: throw,
and the framework starts a new chat and says so.
```

Add the three `resumed · …` separators to the page's Outcomes table next to the `reopened · …` rows.

`docs/providers/define-provider.md`:

- In the verbatim `contributes` block, add the `<vendor>.resume` command, its `view/title` entry (`"group": "0_session@1"`) and the `<vendor>.saveSessions` setting, identical to the template (Step 4).
- In the table of entries, add `| commands | <id>.resume | Recommended |` and `| menus.view/title | <id>.resume | Recommended |` in the table's format.
- In the "Recommended" paragraph, change "`<id>.help` is registered whether or not it is declared" to "`<id>.help` and `<id>.resume` are registered whether or not they are declared".
- In the section on built-in command names, add `resume` to the list.

- [ ] **Step 3: Upgrade guide**

In `packages/provider/skills/upgrading-provider-repo/upgrade-guide.md`, add above `## 0.12.1`. The version is the next minor; if the release turns out to carry another number, the release commit renames the heading.

```markdown
## 0.13.0

**Required:**

1. If your provider defines a command named `resume`, rename it. `resume` is
   now a built-in, and `defineProvider` throws
   `Provider command "/resume" collides with a built-in command.`
   Check: `grep -n '"resume"' src/`.
2. Interactive sessions are now saved on the user's machine by default, under
   `~/.config/<configDir>/sessions/<provider name>/`. If your banner, footer or
   documentation says that conversations are not stored, that sentence is no
   longer true. Change it. The templates now say
   `Conversations are saved on this machine only. Log out to delete them.`
   Check: `grep -rn "not stored" src/ vscode/ README.md`.

**Optional:**

### Resume in the VSCode title bar and palette

Needs DOM observation: no.

Change: in the extension's `package.json`, add to `contributes.commands`

    { "command": "<vendor>.resume", "title": "Resume", "category": "<Vendor>" }

to `contributes.menus["view/title"]`

    { "command": "<vendor>.resume", "when": "view == <vendor>.chat", "group": "0_session@1" }

and to `contributes.configuration.properties`

    "<vendor>.saveSessions": {
      "type": "boolean",
      "default": true,
      "description": "Save chat sessions on this machine so that Resume can go back to them."
    }

Without these, `/resume` typed in the composer still works and saving is on;
only the menu entry, the palette entry and the Settings UI row are missing.

Verify: reload the extension, send a message, run New chat, open the view's
`...` menu, choose Resume and pick the session. The history comes back and
ends with a `resumed · …` separator.

### Conversation handles are now saved to disk

Needs DOM observation: no.

Change: none, if your `conversation.handle` returns a conversation URL or id.
If it returns anything that carries a credential, change it: the handle is
written to the session file.

Verify: send a message, quit, start again, `/resume`, pick the session. The
separator reads `resumed · conversation restored`.

**VSCode manifest:** optional additions above; nothing required.
```

- [ ] **Step 4: Templates and the example**

`packages/provider/skills/creating-provider-repo/templates/vscode/package.json` and `examples/vscode-dummy-chat/package.json` (ids `<vendor>` / `chatbridge-dummy`, titles `<Vendor>` / `Dummy Chat`): add the command after the `reopen` command entry, the `view/title` entry after the `reopen` one, and the setting after `idleTimeoutMinutes`, exactly as in the upgrade guide entry. Follow the neighbouring entries for any key they carry that the snippet does not (`category`, `icon` is not needed).

Replace the footer and banner sentence `Conversations are not stored by this extension.` / `Conversations are not stored by this CLI.` with `Conversations are saved on this machine only. Log out to delete them.` in:

- `packages/provider/skills/creating-provider-repo/templates/vscode/src/extension.ts`
- `packages/provider/skills/creating-provider-repo/templates/src/bin.ts`
- `packages/provider/skills/creating-provider-repo/vscode-extension.md`
- `examples/vscode-dummy-chat/src/extension.ts`

Then `grep -rn "not stored" packages examples docs/users docs/providers README.md` must print nothing. Earlier plans and mocks under `docs/superpowers/` are history and stay as they are.

- [ ] **Step 5: Spec check**

Read `docs/superpowers/specs/2026-09-27-session-resume-design.md` once more against what was built. Where a task review or the implementation changed a decision the spec records, amend the spec in this commit and name the change in the issue comment. Where nothing changed, leave it.

- [ ] **Step 6: Check and commit**

```bash
bun run check
git add docs README.md packages/provider/skills examples/vscode-dummy-chat
git commit -m "docs: saved sessions and /resume for users and vendors (Refs #119, #74)"
gh issue comment 119 --body "Task 12 done: user and provider docs, upgrade guide entry 0.13.0, templates and example manifest. What's next: Task 13, whole-branch review and the PR."
```

---

### Task 13: Whole-branch review and PR (Fable)

- [ ] **Step 1: Review the whole branch** with superpowers:requesting-code-review against the spec and this plan. The review checks, beyond correctness:

  - No log line, error message or progress message can carry a handle or message text. `grep -rn "conversation" packages/*/src --include=*.ts | grep -i "log\|console\|progress\|message:"` is a starting point, not the proof.
  - Every path that ends up in `join(this.root, …)` comes from `isSessionId` or from `readdir`.
  - Every `persist()` call site named in Tasks 5 and 8 exists, and no `persist()` sits after a `drain()` in the same function.
  - `docs/users/` matches what a user sees, `docs/providers/` and the upgrade guide match what a vendor sees (CLAUDE.md, "Pull requests").
  - Dependency direction: nothing in `packages/core` imports from `cli` or `vscode`; the webview bundle does not import the core index (`grep -rn '"@chatbridge/core"' packages/vscode/src/webview` prints nothing).
  - The five Review Focus lines each have a passing test.

- [ ] **Step 2: Fix what the review found**, one commit per finding, each followed by an issue comment.

- [ ] **Step 3: Verify**

```bash
bun run check
bun run e2e:vscode   # or state that it was left to CI
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create --base main --head issue-119 \
  --title "Saved sessions and /resume in the TUI and the VSCode view" \
  --label enhancement \
  --body "$(cat <<'EOF'
Interactive sessions are saved under the config dir as they proceed, and
`/resume` goes back to one from a picker: the transcript, and the service-side
conversation when the provider can reopen it.

- Core: `SessionStore` (one JSON file per session, atomic write, pruned after
  14 days and beyond 50 sessions) and `SessionRecorder`.
- TUI: `/resume` with a scrolling picker; `/new` starts a new saved session;
  `/logout` deletes them.
- VSCode: `/resume` and an optional `<id>.resume` command with a QuickPick;
  `<id>.saveSessions`.
- `sessions.enabled` in `config.json` turns saving off.
- Vendor-visible: `resume` is a reserved command name; see the upgrade guide.

Not included, by decision: a startup flag and chaining one-shot runs.

Closes #119
Closes #74

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: After the merge** (squash): verify that #119 and #74 are both closed, append the heading `### 26. Session resume and transcript persistence — done (issue #119, PR #<p>, <YYYY-MM-DD>)` with two or three lines to `docs/ROADMAP.md`, and close the milestone.
