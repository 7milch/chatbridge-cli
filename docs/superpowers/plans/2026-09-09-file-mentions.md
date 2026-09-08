# File Mentions in the Interactive TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing `@` in the interactive TUI opens a fuzzy file popup over the working directory; on send, each referenced file is appended to the prompt as a fenced code block, and the history shows one attachment line per file.

**Architecture:** Three pure modules under `packages/cli/src/mentions/` (file index + fuzzy search, mention parsing, mention expansion) have no OpenTUI dependency. `ChatModel.submit` expands mentions before `session.send` and returns whether the message was accepted. `ChatView` owns a `MentionPopup` renderable, intercepts popup keys through a global `keypress` listener that calls `preventDefault()`, and refreshes the popup from the textarea's `onContentChange` / `onCursorChange` hooks. Core, runtime, and provider are untouched.

**Tech Stack:** TypeScript, Bun workspaces + `bun test`, OpenTUI (`@opentui/core` 0.5.10 + `@opentui/core/testing`), `ignore` 7.x, Biome.

**Spec:** `docs/superpowers/specs/2026-09-09-file-mentions-design.md`

## Global Constraints

- Branch `issue-27`; every commit message ends with `(Refs #27)` before the trailer, and `gh issue comment 27` (English) follows every commit with what landed and what is next.
- `bun run check` (Biome lint + `tsc --build` + `bun test`) must pass before every commit. Tests import cross-package code from `dist/`, so `bun run build` after editing another package.
- Dependency direction `cli → core → runtime → provider`; never import in reverse. `packages/cli/src/mentions/` never imports `@opentui/core`.
- Every document, comment, and commit message is in English.
- One-shot mode (`-p`) does not expand mentions; `create-cli.ts` is not modified.
- Limits, verbatim: `MAX_FILE_BYTES = 200 * 1024`, `MAX_TOTAL_BYTES = 1024 * 1024`, index cap 20,000 files, popup 8 rows.
- Problem lines, verbatim from the spec table: `@<path>: not found`, `@<path>: is a directory`, `@<path>: binary file`, `@<path>: <N> KB exceeds 200 KB`, `attachments total <N.N> MB exceeds 1 MB`, `@<path>: outside working directory`.
- `GUIDE` becomes exactly `Enter send · Shift+Enter (or Ctrl+J) newline · @ file · Ctrl+C quit`.
- Attachment line: `📎 <path> (<size>)` with size `N B` / `N.N KB` / `N.N MB`.
- Only `ignore` is added to `@chatbridge/cli` dependencies.

---

## Spike findings (OpenTUI 0.5.10, verified 2026-09-09 with a throwaway `bun test`)

The spec's section 3 listed two unknowns. Both are settled; no spike task remains.

1. **Key interception works.** A listener registered with `renderer.keyInput.on("keypress", ...)` runs before the focused renderable. Calling `key.preventDefault()` inside it stops `TextareaRenderable` from acting: with a `return` binding to `submit`, `onSubmit` did not fire and the text stayed unchanged. `InternalKeyHandler` documents this ordering ("global handlers can preventDefault before renderable handlers process events"). **Mechanism chosen:** global `keypress` listener + `preventDefault()`. The `keyBindings` swap fallback is not needed.
2. **Content-change hook exists.** `EditBufferRenderable` exposes `onContentChange` and `onCursorChange` setters (typed `(event) => void`; the event objects carry no useful fields). `onContentChange` fired once per typed character and `plainText` read inside it reflects the new content. **Mechanism chosen:** refresh the popup from both hooks.
3. Also verified: `position: "absolute"` + `bottom` + `zIndex` on a `BoxRenderable` added to the root draws over the history above the input box; `textarea.setSelection(start, end)` followed by `insertText(s)` replaces the range and leaves `cursorOffset` right after the inserted text; `cursorOffset` is a character offset into `plainText`; `TextRenderable` accepts `attributes: TextAttributes.INVERSE` and has an `attributes` setter; `mockInput.pressArrow("down")`, `pressTab()`, `pressEscape()` exist on the test renderer.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `packages/cli/package.json` | modify | add `"ignore": "^7.0.9"` |
| `packages/cli/src/mentions/parse-mentions.ts` | create | `parseMentions`, `mentionAtCursor` |
| `packages/cli/src/mentions/parse-mentions.test.ts` | create | parsing rules |
| `packages/cli/src/mentions/expand-mentions.ts` | create | `expandMentions`, `MentionError`, `Attachment`, `Expansion`, limits, `formatSize` |
| `packages/cli/src/mentions/expand-mentions.test.ts` | create | exact output, dedupe, fences, every error line |
| `packages/cli/src/mentions/file-index.ts` | create | `FileIndex.build`, `FileIndex.fromPaths`, `search` |
| `packages/cli/src/mentions/file-index.test.ts` | create | walk, `.gitignore`, limit, ranking |
| `packages/cli/src/tui/chat-model.ts` | modify | `attachments`, `expand` option, `submit(): Promise<boolean>` |
| `packages/cli/src/tui/chat-model.test.ts` | modify | expansion reaches `send`; `MentionError` path |
| `packages/cli/src/tui/mention-popup.ts` | create | `MentionPopup` renderable |
| `packages/cli/src/tui/mention-popup.test.ts` | create | show/hide/move/selected, rendering |
| `packages/cli/src/tui/chat-view.ts` | modify | `index` option, popup wiring, key interception, clear-on-accept, attachment lines, `GUIDE` |
| `packages/cli/src/tui/chat-view.test.ts` | modify | popup interaction, attachment line, textarea kept on error |
| `packages/cli/src/tui/run-interactive.ts` | modify | build the index at startup, pass to `ChatView` |
| `packages/cli/src/tui/run-interactive.test.ts` | modify | `ChatView` construction gains `index` |
| `README.md` | modify | document `@` mentions in "Interactive mode" |
| `docs/ROADMAP.md` | modify | add milestone 6 as done |

---

### Task 1: `parseMentions` and `mentionAtCursor`

**Files:**
- Create: `packages/cli/src/mentions/parse-mentions.ts`
- Test: `packages/cli/src/mentions/parse-mentions.test.ts`

**Interfaces:**
- Produces: `interface Mention { path: string; start: number; end: number }` where `start` is the index of `@` and `end` is the index after the last path character; `parseMentions(text: string): Mention[]` (bare `@` excluded, duplicates kept, order of appearance); `mentionAtCursor(text: string, cursor: number): Mention | undefined` (bare `@` **included** with `path: ""`, matches when `start < cursor && cursor <= end`).

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/mentions/parse-mentions.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mentionAtCursor, parseMentions } from "./parse-mentions.js";

describe("parseMentions", () => {
  test("mention at line start", () => {
    expect(parseMentions("@src/a.ts explain")).toEqual([
      { path: "src/a.ts", start: 0, end: 9 },
    ]);
  });

  test("mention after whitespace, including newline and tab", () => {
    expect(parseMentions("see @a.ts\n@b.ts\t@c.ts")).toEqual([
      { path: "a.ts", start: 4, end: 9 },
      { path: "b.ts", start: 10, end: 15 },
      { path: "c.ts", start: 16, end: 21 },
    ]);
  });

  test("an email address is not a mention", () => {
    expect(parseMentions("mail foo@example.com now")).toEqual([]);
  });

  test("a bare @ yields nothing", () => {
    expect(parseMentions("hello @ world @")).toEqual([]);
  });

  test("duplicates are kept in order of appearance", () => {
    expect(parseMentions("@a.ts and @a.ts").map((m) => m.path)).toEqual([
      "a.ts",
      "a.ts",
    ]);
  });

  test("path runs to the next whitespace", () => {
    expect(parseMentions("@dir/with-dash_and.dots/x.ts, ok")).toEqual([
      { path: "dir/with-dash_and.dots/x.ts,", start: 0, end: 28 },
    ]);
  });
});

describe("mentionAtCursor", () => {
  test("cursor right after a bare @ yields an empty path", () => {
    expect(mentionAtCursor("hi @", 4)).toEqual({ path: "", start: 3, end: 4 });
  });

  test("cursor at the end of the path", () => {
    expect(mentionAtCursor("hi @src/a", 9)).toEqual({
      path: "src/a",
      start: 3,
      end: 9,
    });
  });

  test("cursor inside the path", () => {
    expect(mentionAtCursor("hi @src/a rest", 6)).toEqual({
      path: "src/a",
      start: 3,
      end: 9,
    });
  });

  test("cursor before the @ or after the trailing space is not a mention", () => {
    expect(mentionAtCursor("hi @src/a ", 3)).toBeUndefined();
    expect(mentionAtCursor("hi @src/a ", 10)).toBeUndefined();
  });

  test("email is not a mention at the cursor", () => {
    expect(mentionAtCursor("foo@example.com", 15)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/mentions/parse-mentions.test.ts`
Expected: FAIL — cannot resolve `./parse-mentions.js`.

- [ ] **Step 3: Implement**

Create `packages/cli/src/mentions/parse-mentions.ts`:

```typescript
/** One `@path` occurrence. `start` is the index of `@`; `end` is the index
 * just after the last path character. */
export interface Mention {
  path: string;
  start: number;
  end: number;
}

/** `@` counts only at the start of the text or right after whitespace, so
 * `foo@example.com` is not a mention. The path runs to the next whitespace. */
const MENTION = /(?<=^|\s)@(\S*)/g;

/** Every non-empty mention, in order of appearance, duplicates kept. */
export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(MENTION)) {
    const path = m[1] ?? "";
    if (!path) continue;
    out.push({ path, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** The mention the cursor is typing into, for the popup query. A bare `@`
 * counts here (empty path) so the popup opens as soon as `@` is typed. The
 * cursor must sit after the `@` and no further than the end of the path. */
export function mentionAtCursor(
  text: string,
  cursor: number,
): Mention | undefined {
  for (const m of text.matchAll(MENTION)) {
    const start = m.index;
    const end = start + m[0].length;
    if (start < cursor && cursor <= end) {
      return { path: m[1] ?? "", start, end };
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/mentions/parse-mentions.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Check and commit**

```bash
bun run check
git add packages/cli/src/mentions/parse-mentions.ts packages/cli/src/mentions/parse-mentions.test.ts
git commit -m "feat(cli): parse @file mentions (Refs #27)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 27 --body "Task 1 done: parseMentions / mentionAtCursor in packages/cli/src/mentions with tests. Next: Task 2 expandMentions (fenced sections, limits, error collection)."
```

---

### Task 2: `expandMentions`

**Files:**
- Create: `packages/cli/src/mentions/expand-mentions.ts`
- Test: `packages/cli/src/mentions/expand-mentions.test.ts`

**Interfaces:**
- Consumes: `parseMentions` from Task 1.
- Produces: `interface Attachment { path: string; bytes: number }`; `interface Expansion { prompt: string; attachments: Attachment[] }`; `class MentionError extends Error { readonly problems: string[] }` whose `message` is `problems.join("\n")`; `MAX_FILE_BYTES`, `MAX_TOTAL_BYTES`; `expandMentions(text: string, cwd: string): Promise<Expansion>`; `formatSize(bytes: number): string` (`N B` / `N.N KB` / `N.N MB`, used by the view in Task 6).

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/mentions/expand-mentions.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  MentionError,
  expandMentions,
  formatSize,
} from "./expand-mentions.js";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "mentions-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function file(rel: string, content: string | Uint8Array) {
  const abs = join(cwd, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

async function problemsOf(text: string): Promise<string[]> {
  try {
    await expandMentions(text, cwd);
  } catch (err) {
    if (err instanceof MentionError) return err.problems;
    throw err;
  }
  throw new Error("expected MentionError");
}

describe("expandMentions", () => {
  test("no mentions: prompt unchanged, no attachments", async () => {
    const r = await expandMentions("plain text", cwd);
    expect(r).toEqual({ prompt: "plain text", attachments: [] });
  });

  test("one file: body, blank line, heading, fenced content", async () => {
    await file("src/foo.ts", "const a = 1;\n");
    const r = await expandMentions("explain @src/foo.ts please", cwd);
    expect(r.prompt).toBe(
      "explain @src/foo.ts please\n\n### src/foo.ts\n```ts\nconst a = 1;\n```",
    );
    expect(r.attachments).toEqual([{ path: "src/foo.ts", bytes: 13 }]);
  });

  test("two files in order of first appearance; duplicates expand once", async () => {
    await file("a.md", "# A\n");
    await file("b.json", "{}\n");
    const r = await expandMentions("@b.json then @a.md then @b.json", cwd);
    expect(r.prompt).toBe(
      "@b.json then @a.md then @b.json\n\n### b.json\n```json\n{}\n```\n\n### a.md\n```md\n# A\n```",
    );
    expect(r.attachments.map((a) => a.path)).toEqual(["b.json", "a.md"]);
  });

  test("a missing trailing newline is added; content is not trimmed", async () => {
    await file("x.txt", "  two spaces");
    const r = await expandMentions("@x.txt", cwd);
    expect(r.prompt).toBe("@x.txt\n\n### x.txt\n```\n  two spaces\n```");
  });

  test("fence grows past the longest backtick run at a line start", async () => {
    await file("doc.md", "text\n````\ncode\n````\n");
    const r = await expandMentions("@doc.md", cwd);
    expect(r.prompt).toBe(
      "@doc.md\n\n### doc.md\n`````md\ntext\n````\ncode\n````\n`````",
    );
  });

  test("backticks not at a line start do not lengthen the fence", async () => {
    await file("n.md", "use ```js``` inline\n");
    const r = await expandMentions("@n.md", cwd);
    expect(r.prompt).toContain("\n```md\nuse ```js``` inline\n```");
  });

  test("language table", async () => {
    const cases: Array<[string, string]> = [
      ["a.ts", "ts"],
      ["a.js", "js"],
      ["a.tsx", "tsx"],
      ["a.jsx", "jsx"],
      ["a.json", "json"],
      ["a.md", "md"],
      ["a.py", "py"],
      ["a.sh", "sh"],
      ["a.yaml", "yaml"],
      ["a.yml", "yml"],
      ["a.toml", "toml"],
      ["a.html", "html"],
      ["a.css", "css"],
      ["a.rs", "rs"],
      ["a.go", "go"],
      ["Makefile", ""],
      ["a.unknownext", ""],
    ];
    for (const [name, lang] of cases) {
      await file(name, "x\n");
      const r = await expandMentions(`@${name}`, cwd);
      expect(r.prompt).toContain(`### ${name}\n\`\`\`${lang}\nx\n\`\`\``);
    }
  });

  test("dedupe is by resolved path", async () => {
    await file("a.ts", "x\n");
    const r = await expandMentions("@a.ts @./a.ts", cwd);
    expect(r.attachments).toEqual([{ path: "a.ts", bytes: 2 }]);
    expect(r.prompt.match(/### a\.ts/g)).toHaveLength(1);
  });

  test("not found", async () => {
    expect(await problemsOf("@no/such.ts")).toEqual(["@no/such.ts: not found"]);
  });

  test("directory", async () => {
    await mkdir(join(cwd, "src"));
    expect(await problemsOf("@src")).toEqual(["@src: is a directory"]);
  });

  test("binary: NUL byte", async () => {
    await file("a.png", new Uint8Array([0x89, 0x50, 0x00, 0x47]));
    expect(await problemsOf("@a.png")).toEqual(["@a.png: binary file"]);
  });

  test("binary: invalid UTF-8", async () => {
    await file("bad.txt", new Uint8Array([0xff, 0xfe, 0x41]));
    expect(await problemsOf("@bad.txt")).toEqual(["@bad.txt: binary file"]);
  });

  test("file over the per-file limit", async () => {
    await file("big.log", "x".repeat(312 * 1024));
    expect(await problemsOf("@big.log")).toEqual([
      "@big.log: 312 KB exceeds 200 KB",
    ]);
  });

  test("file exactly at the per-file limit is accepted", async () => {
    await file("edge.log", "x".repeat(MAX_FILE_BYTES));
    const r = await expandMentions("@edge.log", cwd);
    expect(r.attachments[0]?.bytes).toBe(MAX_FILE_BYTES);
  });

  test("total over the limit", async () => {
    for (let i = 0; i < 8; i++) {
      await file(`p${i}.log`, "x".repeat(180 * 1024));
    }
    const text = Array.from({ length: 8 }, (_, i) => `@p${i}.log`).join(" ");
    expect(await problemsOf(text)).toEqual([
      "attachments total 1.4 MB exceeds 1 MB",
    ]);
    expect(8 * 180 * 1024).toBeGreaterThan(MAX_TOTAL_BYTES);
  });

  test("outside the working directory", async () => {
    expect(await problemsOf("@../x")).toEqual([
      "@../x: outside working directory",
    ]);
  });

  test("all problems are collected in one error, in mention order", async () => {
    await mkdir(join(cwd, "dir"));
    const err = await expandMentions("@missing @dir @../out", cwd).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(MentionError);
    expect((err as MentionError).problems).toEqual([
      "@missing: not found",
      "@dir: is a directory",
      "@../out: outside working directory",
    ]);
    expect((err as MentionError).message).toBe(
      "@missing: not found\n@dir: is a directory\n@../out: outside working directory",
    );
  });
});

describe("formatSize", () => {
  test("bytes, KB, MB", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(1.4 * 1024 * 1024)).toBe("1.4 MB");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/mentions/expand-mentions.test.ts`
Expected: FAIL — cannot resolve `./expand-mentions.js`.

- [ ] **Step 3: Implement**

Create `packages/cli/src/mentions/expand-mentions.ts`:

```typescript
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseMentions } from "./parse-mentions.js";

export interface Attachment {
  /** Path relative to cwd, `/`-separated. */
  path: string;
  bytes: number;
}

export interface Expansion {
  /** The text to send: body, then one fenced section per file. */
  prompt: string;
  attachments: Attachment[];
}

/** Every problem found in one send, thrown together so the user fixes all
 * of them at once. */
export class MentionError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "MentionError";
    this.problems = problems;
  }
}

export const MAX_FILE_BYTES = 200 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024;

const LANGUAGES: Record<string, string> = {
  ts: "ts",
  js: "js",
  tsx: "tsx",
  jsx: "jsx",
  json: "json",
  md: "md",
  py: "py",
  sh: "sh",
  yaml: "yaml",
  yml: "yml",
  toml: "toml",
  html: "html",
  css: "css",
  rs: "rs",
  go: "go",
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** `N B` under 1 KiB, otherwise one decimal in KB or MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function languageOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot === -1 || dot <= slash) return "";
  return LANGUAGES[path.slice(dot + 1)] ?? "";
}

/** Three backticks, or one more than the longest backtick run that starts
 * a line in the content, so the fence can never be closed early. */
function fenceFor(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/^`+/gm)) {
    longest = Math.max(longest, m[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function section(path: string, content: string): string {
  const body = content.endsWith("\n") ? content : `${content}\n`;
  const fence = fenceFor(body);
  return `### ${path}\n${fence}${languageOf(path)}\n${body}${fence}`;
}

interface Loaded {
  path: string;
  bytes: number;
  content: string;
}

type LoadResult = { problem: string } | { abs: string; ok: Loaded };

/** Resolves one mention to its content, or returns the problem line. */
async function load(mention: string, cwd: string): Promise<LoadResult> {
  const abs = resolve(cwd, mention);
  const rel = relative(cwd, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { problem: `@${mention}: outside working directory` };
  }
  const path = rel.split(sep).join("/");
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(abs);
  } catch {
    return { problem: `@${mention}: not found` };
  }
  if (info.isDirectory()) return { problem: `@${mention}: is a directory` };
  if (info.size > MAX_FILE_BYTES) {
    const kb = Math.ceil(info.size / 1024);
    const limit = MAX_FILE_BYTES / 1024;
    return { problem: `@${mention}: ${kb} KB exceeds ${limit} KB` };
  }
  const buf = await readFile(abs);
  if (buf.includes(0)) return { problem: `@${mention}: binary file` };
  let content: string;
  try {
    content = utf8.decode(buf);
  } catch {
    return { problem: `@${mention}: binary file` };
  }
  return { abs, ok: { path, bytes: buf.byteLength, content } };
}

/** Appends every mentioned file to `text` as a fenced section. Throws
 * `MentionError` with every problem when any mention cannot be attached. */
export async function expandMentions(
  text: string,
  cwd: string,
): Promise<Expansion> {
  const mentions = parseMentions(text);
  if (mentions.length === 0) return { prompt: text, attachments: [] };

  const problems: string[] = [];
  const loaded: Loaded[] = [];
  const seen = new Set<string>();
  for (const m of mentions) {
    const r = await load(m.path, cwd);
    if ("problem" in r) {
      problems.push(r.problem);
      continue;
    }
    if (seen.has(r.abs)) continue;
    seen.add(r.abs);
    loaded.push(r.ok);
  }
  const total = loaded.reduce((n, f) => n + f.bytes, 0);
  if (total > MAX_TOTAL_BYTES) {
    problems.push(
      `attachments total ${formatSize(total)} exceeds ${formatSize(MAX_TOTAL_BYTES).replace(".0", "")}`,
    );
  }
  if (problems.length > 0) throw new MentionError(problems);

  const sections = loaded.map((f) => section(f.path, f.content));
  return {
    prompt: [text, ...sections].join("\n\n"),
    attachments: loaded.map((f) => ({ path: f.path, bytes: f.bytes })),
  };
}
```

Notes for the implementer:
- `resolve(cwd, "")` cannot happen because `parseMentions` drops bare `@`; the `rel === ""` guard rejects `@.` (cwd itself), which would otherwise report "is a directory" — either wording is acceptable, keep the guard.
- `"problem" in r` discriminates the `LoadResult` union; the success branch always carries `abs` for deduplication.
- `formatSize(MAX_TOTAL_BYTES)` is `1.0 MB`; the spec wants `1 MB` in the total line, hence the `.replace(".0", "")`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/mentions/expand-mentions.test.ts`
Expected: PASS (19 tests). If `languageOf` misfires on `Makefile`, note that `dot === -1` must return `""` before any slicing.

- [ ] **Step 5: Check and commit**

```bash
bun run check
git add packages/cli/src/mentions/expand-mentions.ts packages/cli/src/mentions/expand-mentions.test.ts
git commit -m "feat(cli): expand @file mentions into fenced sections (Refs #27)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 27 --body "Task 2 done: expandMentions with size limits, binary detection, fence lengthening, and collected MentionError problems. Next: Task 3 FileIndex (gitignore-aware walk + fuzzy search)."
```

---

### Task 3: `FileIndex`

**Files:**
- Modify: `packages/cli/package.json` (add dependency)
- Create: `packages/cli/src/mentions/file-index.ts`
- Test: `packages/cli/src/mentions/file-index.test.ts`

**Interfaces:**
- Produces: `interface FileIndexOptions { cwd: string; limit?: number }`; `class FileIndex` with `static build(opts): Promise<FileIndex>`, `static fromPaths(paths: string[]): FileIndex`, `search(query: string, limit: number): string[]`, and `readonly size: number`.

- [ ] **Step 1: Add the dependency**

In `packages/cli/package.json`, change `dependencies` to:

```json
  "dependencies": {
    "@chatbridge/core": "workspace:*",
    "@opentui/core": "0.5.10",
    "ignore": "^7.0.9"
  },
```

Run: `bun install`
Expected: `ignore` appears under `node_modules` (Bun hoists it to the root `node_modules/ignore` or `node_modules/.bun/ignore@7.x`); `bun.lock` changes.

- [ ] **Step 2: Write the failing tests**

Create `packages/cli/src/mentions/file-index.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileIndex } from "./file-index.js";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "file-index-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function file(rel: string, content = "") {
  const abs = join(cwd, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

describe("FileIndex.build", () => {
  test("lists files recursively as sorted POSIX paths", async () => {
    await file("b.ts");
    await file("src/a.ts");
    await file("src/deep/c.ts");
    const index = await FileIndex.build({ cwd });
    expect(index.search("", 10)).toEqual(["b.ts", "src/a.ts", "src/deep/c.ts"]);
  });

  test("always skips .git and node_modules", async () => {
    await file(".git/HEAD");
    await file("node_modules/pkg/index.js");
    await file("src/node_modules/x.js");
    await file("keep.ts");
    const index = await FileIndex.build({ cwd });
    expect(index.search("", 10)).toEqual(["keep.ts"]);
  });

  test("honours the root .gitignore for files and directories", async () => {
    await file(".gitignore", "dist/\n*.log\n");
    await file("dist/out.js");
    await file("app.log");
    await file("src/app.ts");
    const index = await FileIndex.build({ cwd });
    expect(index.search("", 10)).toEqual([".gitignore", "src/app.ts"]);
  });

  test("a nested .gitignore applies to its own subtree only", async () => {
    await file("sub/.gitignore", "*.tmp\n");
    await file("sub/a.tmp");
    await file("sub/a.ts");
    await file("root.tmp");
    const index = await FileIndex.build({ cwd });
    expect(index.search("", 10)).toEqual([
      "root.tmp",
      "sub/.gitignore",
      "sub/a.ts",
    ]);
  });

  test("does not follow symlinks", async () => {
    await file("real/a.ts");
    await symlink(join(cwd, "real"), join(cwd, "link"));
    const index = await FileIndex.build({ cwd });
    expect(index.search("", 10)).toEqual(["real/a.ts"]);
  });

  test("stops at the limit", async () => {
    for (let i = 0; i < 5; i++) await file(`f${i}.ts`);
    const index = await FileIndex.build({ cwd, limit: 3 });
    expect(index.size).toBe(3);
  });
});

describe("FileIndex.search", () => {
  const index = FileIndex.fromPaths([
    "src/chat-view.ts",
    "src/xab.ts",
    "src/ab.ts",
    "ab.ts",
    "docs/README.md",
    "packages/cli/src/tui/chat-view.test.ts",
  ]);

  test("empty query returns the first `limit` paths in index order", () => {
    expect(index.search("", 2)).toEqual(["ab.ts", "docs/README.md"]);
  });

  test("every query character must appear in order", () => {
    expect(index.search("zzz", 10)).toEqual([]);
    expect(index.search("readme", 10)).toEqual(["docs/README.md"]);
  });

  test("a match at a path-segment start beats a mid-word match", () => {
    const r = index.search("ab", 10);
    expect(r.indexOf("src/ab.ts")).toBeLessThan(r.indexOf("src/xab.ts"));
  });

  test("shorter path wins ties", () => {
    const r = index.search("ab", 10);
    expect(r.indexOf("ab.ts")).toBeLessThan(r.indexOf("src/ab.ts"));
  });

  test("matching is case-insensitive", () => {
    expect(index.search("ReAdMe", 10)).toEqual(["docs/README.md"]);
  });

  test("respects the limit", () => {
    expect(index.search("ts", 2)).toHaveLength(2);
  });

  test("segment-start bonus ranks the short view file first", () => {
    expect(index.search("chatview", 10)[0]).toBe("src/chat-view.ts");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/cli/src/mentions/file-index.test.ts`
Expected: FAIL — cannot resolve `./file-index.js`.

- [ ] **Step 4: Implement**

Create `packages/cli/src/mentions/file-index.ts`:

```typescript
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

export interface FileIndexOptions {
  cwd: string;
  /** Stop listing after this many files. Default 20_000. */
  limit?: number;
}

const DEFAULT_LIMIT = 20_000;
/** Skipped everywhere, so the walk stays cheap outside a git repository. */
const ALWAYS_SKIP = new Set([".git", "node_modules"]);

interface Scope {
  /** Absolute directory the .gitignore lives in. */
  dir: string;
  ig: Ignore;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** Snapshot of the files under a directory plus a fuzzy search over them. */
export class FileIndex {
  private constructor(private readonly paths: string[]) {}

  get size(): number {
    return this.paths.length;
  }

  /** Walks cwd once, depth-first, honouring every .gitignore on the path
   * from cwd down. Always skips `.git` and `node_modules`; never follows
   * symlinks. Returns relative POSIX paths, sorted. */
  static async build(opts: FileIndexOptions): Promise<FileIndex> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const paths: string[] = [];
    await walk(opts.cwd, opts.cwd, [], paths, limit);
    paths.sort();
    return new FileIndex(paths);
  }

  /** Test-only: an index over a fixed list (kept in the given order after
   * sorting, like `build`). */
  static fromPaths(paths: string[]): FileIndex {
    return new FileIndex([...paths].sort());
  }

  /** Every query character must appear in order (case-insensitive). Score
   * favours matches at path-segment starts, then shorter paths, then
   * alphabetical order. Empty query returns the first `limit` paths. */
  search(query: string, limit: number): string[] {
    if (query === "") return this.paths.slice(0, limit);
    const q = query.toLowerCase();
    const scored: Array<{ path: string; score: number }> = [];
    for (const path of this.paths) {
      const score = scoreMatch(q, path.toLowerCase());
      if (score !== undefined) scored.push({ path, score });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.path.length - b.path.length ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    return scored.slice(0, limit).map((s) => s.path);
  }
}

/** Greedy left-to-right subsequence match. Returns undefined when some
 * query character is missing. A character matched at a segment start
 * (index 0 or right after `/`) scores 3, after `.`, `-`, `_` scores 2,
 * elsewhere 1. */
function scoreMatch(query: string, path: string): number | undefined {
  let score = 0;
  let from = 0;
  for (const ch of query) {
    const at = path.indexOf(ch, from);
    if (at === -1) return undefined;
    const prev = at === 0 ? "/" : path[at - 1];
    score += prev === "/" ? 3 : prev === "." || prev === "-" || prev === "_" ? 2 : 1;
    from = at + 1;
  }
  return score;
}

async function walk(
  cwd: string,
  dir: string,
  scopes: Scope[],
  out: string[],
  limit: number,
): Promise<void> {
  if (out.length >= limit) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory: skip silently, the index is best effort
  }
  let here = scopes;
  const gitignore = entries.find(
    (e) => e.isFile() && e.name === ".gitignore",
  );
  if (gitignore) {
    const content = await readFile(join(dir, ".gitignore"), "utf8");
    here = [...scopes, { dir, ig: ignore().add(content) }];
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.isSymbolicLink()) continue;
    const isDir = entry.isDirectory();
    if (!isDir && !entry.isFile()) continue;
    if (isDir && ALWAYS_SKIP.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (isIgnored(abs, isDir, here)) continue;
    if (isDir) {
      await walk(cwd, abs, here, out, limit);
    } else {
      out.push(toPosix(relative(cwd, abs)));
    }
  }
}

/** A path is ignored when any enclosing .gitignore matches it, tested
 * relative to that .gitignore's directory (trailing `/` for directories,
 * which is how `ignore` distinguishes `dist/` from `dist`). */
function isIgnored(abs: string, isDir: boolean, scopes: Scope[]): boolean {
  for (const { dir, ig } of scopes) {
    const rel = toPosix(relative(dir, abs)) + (isDir ? "/" : "");
    if (ig.ignores(rel)) return true;
  }
  return false;
}
```

Notes for the implementer:
- `ignore` 7.x ships its own types; `import ignore, { type Ignore } from "ignore"` is the documented form. If `tsc` complains about the default import under `NodeNext`, use `import ignore from "ignore"; type Ignore = ReturnType<typeof ignore>;`.
- `walk` sorts entries by name and `build` sorts the final list again; the second sort is what the contract promises, the first only makes the `limit` cut deterministic.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/cli/src/mentions/file-index.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 6: Check and commit**

```bash
bun run check
git add packages/cli/package.json bun.lock packages/cli/src/mentions/file-index.ts packages/cli/src/mentions/file-index.test.ts
git commit -m "feat(cli): gitignore-aware FileIndex with fuzzy search (Refs #27)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 27 --body "Task 3 done: FileIndex.build walks cwd honouring nested .gitignore (ignore ^7.0.9 added to @chatbridge/cli), skips .git/node_modules/symlinks, caps at 20,000; search ranks segment-start matches then shorter paths. Next: Task 4 ChatModel attachments + expand hook."
```

---

### Task 4: `ChatModel` expands mentions before sending

**Files:**
- Modify: `packages/cli/src/tui/chat-model.ts`
- Modify: `packages/cli/src/tui/chat-model.test.ts`

**Interfaces:**
- Consumes: `expandMentions`, `MentionError`, `Attachment`, `Expansion` from Task 2.
- Produces: `interface Message { role: Role; text: string; attachments?: Attachment[] }`; `interface ChatModelOptions { expand?: (text: string) => Promise<Expansion> }`; `new ChatModel(session, opts?)`; `submit(text): Promise<boolean>` — `true` when the message was accepted and sent, `false` when ignored or blocked by a `MentionError`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/tui/chat-model.test.ts` (inside the existing `describe("ChatModel.submit")`, before its closing `});`):

```typescript
  test("resolves true when accepted and false when ignored", async () => {
    const { session, replies } = fakeSession();
    const model = new ChatModel(session);
    expect(await model.submit("   ")).toBe(false);
    const p = model.submit("one");
    expect(await model.submit("two")).toBe(false); // busy
    replies[0]?.resolve("ok");
    expect(await p).toBe(true);
  });

  test("sends the expanded prompt and records attachments on the user message", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session, {
      expand: async (text) => ({
        prompt: `${text}\n\n### a.ts\n\`\`\`ts\nx\n\`\`\``,
        attachments: [{ path: "a.ts", bytes: 2 }],
      }),
    });
    const p = model.submit("look @a.ts");
    replies[0]?.resolve("ok");
    expect(await p).toBe(true);
    expect(calls).toEqual(["look @a.ts\n\n### a.ts\n```ts\nx\n```"]);
    expect(model.messages[0]).toEqual({
      role: "user",
      text: "look @a.ts",
      attachments: [{ path: "a.ts", bytes: 2 }],
    });
  });

  test("omits the attachments key when there are none", async () => {
    const { session, replies } = fakeSession();
    const model = new ChatModel(session);
    const p = model.submit("hello");
    replies[0]?.resolve("ok");
    await p;
    expect(model.messages[0]).toEqual({ role: "user", text: "hello" });
  });

  test("a MentionError shows the problems, sends nothing, stays idle and not fatal", async () => {
    const { session, calls } = fakeSession();
    const model = new ChatModel(session, {
      expand: async () => {
        throw new MentionError(["@x: not found", "@d: is a directory"]);
      },
    });
    const changes: string[] = [];
    model.onChange = () => changes.push(model.status);
    expect(await model.submit("@x @d")).toBe(false);
    expect(calls).toEqual([]);
    expect(model.messages).toEqual([
      { role: "error", text: "@x: not found\n@d: is a directory" },
    ]);
    expect(model.status).toBe("idle");
    expect(model.fatal).toBeUndefined();
    expect(changes).toEqual(["idle"]);
  });

  test("a non-Mention error from expand is fatal", async () => {
    const { session, calls } = fakeSession();
    const boom = new Error("disk on fire");
    const model = new ChatModel(session, {
      expand: async () => {
        throw boom;
      },
    });
    expect(await model.submit("@x")).toBe(false);
    expect(calls).toEqual([]);
    expect(model.messages).toEqual([{ role: "error", text: "disk on fire" }]);
    expect(model.fatal).toBe(boom);
  });
```

Add the import at the top of the test file:

```typescript
import { MentionError } from "../mentions/expand-mentions.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/tui/chat-model.test.ts`
Expected: FAIL — `ChatModel` constructor takes one argument / `submit` resolves `undefined`.

- [ ] **Step 3: Implement**

Replace `packages/cli/src/tui/chat-model.ts` with:

```typescript
import { ResponseTimeoutError } from "@chatbridge/core";
import {
  type Attachment,
  type Expansion,
  MentionError,
  expandMentions,
} from "../mentions/expand-mentions.js";

/** What the model needs from a ChatSession; lets tests inject a fake. */
export interface ChatSessionLike {
  send(prompt: string): Promise<string>;
  close(): Promise<void>;
}

export type Role = "user" | "assistant" | "error";
export interface Message {
  role: Role;
  text: string;
  /** Files appended to the prompt; the history shows one line per entry. */
  attachments?: Attachment[];
}
export type Status = "idle" | "busy";

export interface ChatModelOptions {
  /** Turns the typed text into the prompt to send. Default: expandMentions
   * against process.cwd(). Tests inject a fake. */
  expand?: (text: string) => Promise<Expansion>;
}

/** Conversation state for the interactive UI. No OpenTUI dependency. */
export class ChatModel {
  readonly messages: Message[] = [];
  status: Status = "idle";
  /** Set when submit hit an unrecoverable error; the app must exit. */
  fatal: unknown = undefined;
  /** Called after every state change. */
  onChange: () => void = () => {};
  private readonly expand: (text: string) => Promise<Expansion>;

  constructor(
    private readonly session: ChatSessionLike,
    opts: ChatModelOptions = {},
  ) {
    this.expand =
      opts.expand ?? ((text) => expandMentions(text, process.cwd()));
  }

  /** Sends one turn. Resolves true when the message was accepted (the view
   * clears the textarea), false when it was ignored — blank input, input
   * while busy, input after a fatal error — or blocked by a mention
   * problem, which is shown as an error entry without sending anything. */
  async submit(text: string): Promise<boolean> {
    const prompt = text.trim();
    if (!prompt || this.status === "busy" || this.fatal !== undefined) {
      return false;
    }
    let expansion: Expansion;
    try {
      expansion = await this.expand(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({ role: "error", text: message });
      // A mention problem is the user's to fix; anything else is a bug.
      if (!(err instanceof MentionError)) this.fatal = err;
      this.onChange();
      return false;
    }
    const message: Message = { role: "user", text: prompt };
    if (expansion.attachments.length > 0) {
      message.attachments = expansion.attachments;
    }
    this.messages.push(message);
    this.status = "busy";
    this.onChange();
    try {
      const reply = await this.session.send(expansion.prompt);
      this.messages.push({ role: "assistant", text: reply });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({ role: "error", text: message });
      // A timeout leaves the browser usable; anything else ends the session.
      if (!(err instanceof ResponseTimeoutError)) this.fatal = err;
    } finally {
      this.status = "idle";
      this.onChange();
    }
    return true;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/tui/chat-model.test.ts`
Expected: PASS (10 tests). The existing "user message, busy, then assistant message and idle" test still passes because `expandMentions` on `"hello"` returns the text unchanged and the message has no `attachments` key.

Also run: `bun test packages/cli/src/tui/chat-view.test.ts`
Expected: PASS — the view still calls `void this.model.submit(text)` and ignores the boolean; Task 6 changes that.

- [ ] **Step 5: Check and commit**

```bash
bun run check
git add packages/cli/src/tui/chat-model.ts packages/cli/src/tui/chat-model.test.ts
git commit -m "feat(cli): ChatModel expands mentions and reports acceptance (Refs #27)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 27 --body "Task 4 done: ChatModel.submit expands mentions before send (injectable expand), records attachments on the user message, turns MentionError into a non-fatal error entry, and resolves a boolean. Next: Task 5 MentionPopup renderable."
```

---

### Task 5: `MentionPopup` renderable

**Files:**
- Create: `packages/cli/src/tui/mention-popup.ts`
- Test: `packages/cli/src/tui/mention-popup.test.ts`

**Interfaces:**
- Produces: `class MentionPopup` with `constructor(renderer: CliRenderer, parent: BoxRenderable, opts: { bottom: number })`, `show(candidates: string[]): void`, `hide(): void`, `readonly visible: boolean`, `move(delta: 1 | -1): void`, `readonly selected: string | undefined`, `destroy(): void`. `MAX_ROWS = 8` exported.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/tui/mention-popup.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { MAX_ROWS, MentionPopup } from "./mention-popup.js";

let teardown: (() => void) | undefined;
afterEach(() => {
  teardown?.();
  teardown = undefined;
});

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
  root.add(
    new BoxRenderable(t.renderer, { id: "input-box", border: true, height: 4 }),
  );
  t.renderer.root.add(root);
  const popup = new MentionPopup(t.renderer, root, { bottom: 4 });
  teardown = () => {
    popup.destroy();
    t.renderer.destroy();
  };
  await t.renderOnce();
  return { ...t, popup };
}

describe("MentionPopup", () => {
  test("starts hidden and draws nothing", async () => {
    const t = await setup();
    expect(t.popup.visible).toBe(false);
    expect(t.popup.selected).toBeUndefined();
    expect(t.captureCharFrame()).not.toContain("┌");
  });

  test("show lists candidates above the input box with the first selected", async () => {
    const t = await setup();
    t.popup.show(["src/a.ts", "src/b.ts"]);
    await t.renderOnce();
    expect(t.popup.visible).toBe(true);
    expect(t.popup.selected).toBe("src/a.ts");
    const rows = t.captureCharFrame().split("\n");
    const a = rows.findIndex((r) => r.includes("src/a.ts"));
    const b = rows.findIndex((r) => r.includes("src/b.ts"));
    // The input box's bottom border is the last "└" in the frame; the popup
    // rows sit above it, adjacent, over the history area.
    const inputBottom = rows.map((r) => r.includes("└")).lastIndexOf(true);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBe(a + 1);
    expect(inputBottom).toBeGreaterThan(b);
    expect(rows[a - 1]).toContain("┌");
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

  test("hide removes the rows from the frame", async () => {
    const t = await setup();
    t.popup.show(["src/a.ts"]);
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("src/a.ts");
    t.popup.hide();
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("src/a.ts");
    expect(t.captureCharFrame()).toContain("HISTORY LINE");
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

  test("width is capped at the terminal width", async () => {
    const t = await setup();
    t.popup.show(["x".repeat(100)]);
    await t.renderOnce();
    for (const row of t.captureCharFrame().split("\n")) {
      expect(row.length).toBeLessThanOrEqual(40);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/tui/mention-popup.test.ts`
Expected: FAIL — cannot resolve `./mention-popup.js`.

- [ ] **Step 3: Implement**

Create `packages/cli/src/tui/mention-popup.ts`:

```typescript
import {
  BoxRenderable,
  type CliRenderer,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";

/** Rows shown at once; the search already caps candidates to this. */
export const MAX_ROWS = 8;
/** Left/right border cells. */
const BORDER = 2;

export interface MentionPopupOptions {
  /** Distance from the parent's bottom edge, in rows — the height of
   * everything below the history area (input box + status line). */
  bottom: number;
}

/** Candidate list for an `@` mention, drawn over the bottom of the history
 * area. Purely presentational: the view decides what the keys do. Rows are
 * created once and re-labelled, so show/hide never churns renderables. */
export class MentionPopup {
  private readonly box: BoxRenderable;
  private readonly rows: TextRenderable[] = [];
  private candidates: string[] = [];
  private index = 0;

  constructor(
    private readonly renderer: CliRenderer,
    parent: BoxRenderable,
    opts: MentionPopupOptions,
  ) {
    this.box = new BoxRenderable(renderer, {
      id: "mention-popup",
      position: "absolute",
      bottom: opts.bottom,
      left: 0,
      zIndex: 10,
      border: true,
      flexDirection: "column",
      visible: false,
    });
    for (let i = 0; i < MAX_ROWS; i++) {
      const row = new TextRenderable(renderer, { content: "", visible: false });
      this.rows.push(row);
      this.box.add(row);
    }
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
    const inner = Math.max(
      1,
      Math.min(
        this.renderer.terminalWidth - BORDER,
        Math.max(...this.candidates.map((c) => c.length)),
      ),
    );
    this.box.width = inner + BORDER;
    this.box.visible = true;
    this.paint(inner);
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
    this.paint(this.box.width - BORDER);
  }

  destroy(): void {
    this.box.visible = false;
  }

  private paint(inner: number): void {
    this.rows.forEach((row, i) => {
      const label = this.candidates[i];
      if (label === undefined) {
        row.visible = false;
        return;
      }
      row.visible = true;
      row.content = label.slice(0, inner).padEnd(inner);
      row.attributes =
        i === this.index ? TextAttributes.INVERSE : TextAttributes.NONE;
    });
  }
}
```

Notes for the implementer:
- `this.box.width` is typed `number | "auto" | \`${number}%\``. If `tsc` rejects `this.box.width - BORDER`, keep the inner width in a private field (`private inner = 0`) set in `show` and read in `move`.
- `visible` is a `RenderableOptions` field and a setter on `Renderable`, verified in the 0.5.10 typings (`Renderable.d.ts` `get visible()` / `set visible()`).
- The box is added to `parent` (the view's root) so `bottom` is measured from the root's bottom edge, not from the history box.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/tui/mention-popup.test.ts`
Expected: PASS (7 tests). If the placement assertion in "show lists candidates" is brittle on the captured frame, loosen it to "the rows containing `src/a.ts` and `src/b.ts` are adjacent and both lie above the input box's top border", which is what it is meant to check.

- [ ] **Step 5: Check and commit**

```bash
bun run check
git add packages/cli/src/tui/mention-popup.ts packages/cli/src/tui/mention-popup.test.ts
git commit -m "feat(cli): MentionPopup renderable for @file candidates (Refs #27)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 27 --body "Task 5 done: MentionPopup (absolute box over the history, 8 fixed rows, inverted selected row, wrap-around move, width capped at terminal width). Next: Task 6 wire popup + key interception + attachment lines into ChatView and build the index in runInteractive."
```

---

### Task 6: `ChatView` wiring and startup index

**Files:**
- Modify: `packages/cli/src/tui/chat-view.ts`
- Modify: `packages/cli/src/tui/chat-view.test.ts`
- Modify: `packages/cli/src/tui/run-interactive.ts`
- Modify: `packages/cli/src/tui/run-interactive.test.ts`

**Interfaces:**
- Consumes: `FileIndex` (Task 3), `mentionAtCursor` (Task 1), `formatSize` (Task 2), `ChatModel.submit(): Promise<boolean>` and `Message.attachments` (Task 4), `MentionPopup` (Task 5).
- Produces: `ChatViewOptions.index: FileIndex` (required); `GUIDE` string updated; `runInteractive` builds `FileIndex.build({ cwd: process.cwd() })` before creating the renderer.

- [ ] **Step 1: Write the failing view tests**

In `packages/cli/src/tui/chat-view.test.ts`:

Add imports:

```typescript
import { type Expansion, MentionError } from "../mentions/expand-mentions.js";
import { FileIndex } from "../mentions/file-index.js";
```

Change `setup` so it passes an index and an optional `expand`:

```typescript
async function setup(
  opts: {
    kittyKeyboard?: boolean;
    delayMs?: number;
    session?: ChatSessionLike;
    paths?: string[];
    expand?: (text: string) => Promise<Expansion>;
  } = {},
) {
  const t = await createTestRenderer({
    width: 60,
    height: 20,
    kittyKeyboard: opts.kittyKeyboard ?? false,
  });
  const model = new ChatModel(opts.session ?? echoSession(opts.delayMs ?? 100), {
    expand: opts.expand ?? (async (text) => ({ prompt: text, attachments: [] })),
  });
  const view = new ChatView(t.renderer, model, {
    title: "test-cli",
    providerName: "dummy-chat",
    timeoutMs: 2_000,
    index: FileIndex.fromPaths(
      opts.paths ?? ["src/chat-view.ts", "src/chat-model.ts", "README.md"],
    ),
  });
  // ... rest unchanged
```

The "error messages are labelled Error" test builds its own `ChatView`; add `index: FileIndex.fromPaths([])` to that options object too.

Append these tests inside `describe("ChatView")`:

```typescript
  test("typing @ opens the popup with candidates", async () => {
    const t = await setup();
    await t.mockInput.typeText("see @");
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("README.md");
    expect(frame).toContain("src/chat-view.ts");
  });

  test("the query after @ filters the candidates", async () => {
    const t = await setup();
    await t.mockInput.typeText("@model");
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("src/chat-model.ts");
    expect(frame).not.toContain("README.md");
  });

  test("down then tab inserts the selected path followed by a space", async () => {
    const t = await setup({ paths: ["a.ts", "b.ts"] });
    await t.mockInput.typeText("look @");
    t.mockInput.pressArrow("down");
    t.mockInput.pressTab();
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("look @b.ts ");
    expect(t.model.messages).toEqual([]);
    // Popup is gone once the mention ends with a space: "a.ts" was only
    // ever visible as a popup row.
    expect(frame).not.toContain("a.ts");
  });

  test("enter with the popup open accepts and does not send", async () => {
    const t = await setup({ paths: ["a.ts"] });
    await t.mockInput.typeText("@");
    t.mockInput.pressEnter();
    await t.renderOnce();
    expect(t.model.messages).toEqual([]);
    expect(t.captureCharFrame()).toContain("@a.ts ");
    // A second Enter, popup closed, sends (submit is async: wait for the
    // "You" entry rather than a single render pass).
    t.mockInput.pressEnter();
    await t.frameWith("You");
    expect(t.model.messages[0]?.text).toBe("@a.ts");
  });

  test("escape closes the popup and keeps the text", async () => {
    const t = await setup({ paths: ["a.ts"] });
    await t.mockInput.typeText("hi @a");
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("a.ts");
    t.mockInput.pressEscape();
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("hi @a");
    expect(frame).not.toContain("a.ts");
    // Enter now reaches the textarea again rather than the popup.
    t.mockInput.pressEnter();
    await t.frameWith("You");
    expect(t.model.messages[0]?.text).toBe("hi @a");
  });

  test("popup closes when the cursor leaves the mention", async () => {
    const t = await setup({ paths: ["a.ts"] });
    await t.mockInput.typeText("@a ");
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("a.ts");
  });

  test("no popup for an email address", async () => {
    const t = await setup({ paths: ["example.com"] });
    await t.mockInput.typeText("mail foo@example");
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("example.com");
  });

  test("attachment lines are rendered under the user message", async () => {
    const t = await setup({
      delayMs: 10,
      expand: async (text) => ({
        prompt: `${text}\n\n### a.ts\n\`\`\`ts\nx\n\`\`\``,
        attachments: [
          { path: "a.ts", bytes: 512 },
          { path: "docs/big.md", bytes: 3 * 1024 * 1024 },
        ],
      }),
    });
    await t.mockInput.typeText("look @a.ts");
    // Close the popup first so Enter sends.
    t.mockInput.pressEscape();
    t.mockInput.pressEnter();
    const frame = await t.frameWith("Echo:");
    expect(frame).toContain("📎 a.ts (512 B)");
    expect(frame).toContain("📎 docs/big.md (3.0 MB)");
    expect(frame).not.toContain("### a.ts");
  });

  test("a mention error is shown and the textarea keeps its text", async () => {
    const t = await setup({
      expand: async () => {
        throw new MentionError(["@nope.ts: not found"]);
      },
    });
    await t.mockInput.typeText("read @nope.ts");
    t.mockInput.pressEscape();
    t.mockInput.pressEnter();
    const frame = await t.frameWith("@nope.ts: not found");
    expect(frame).toContain("Error");
    expect(frame).toContain("read @nope.ts");
    expect(t.model.status).toBe("idle");
    expect(t.model.fatal).toBeUndefined();
  });

  test("the guide mentions @ file", async () => {
    const t = await setup();
    expect(GUIDE).toBe(
      "Enter send · Shift+Enter (or Ctrl+J) newline · @ file · Ctrl+C quit",
    );
    expect(t.captureCharFrame()).toContain("@ file");
  });
```

Also update the existing test `"Enter submits, clears the box, shows spinner, then the reply"`: after `t.mockInput.pressEnter()` the model's user message is now pushed asynchronously (after `await expand`). Replace

```typescript
    t.mockInput.pressEnter();
    await t.renderOnce();
    expect(t.model.messages[0]).toEqual({ role: "user", text: "hello" });
```

with

```typescript
    t.mockInput.pressEnter();
    await t.frameWith("You");
    expect(t.model.messages[0]).toEqual({ role: "user", text: "hello" });
```

Apply the same change to the four newline tests (`"Shift+Enter inserts a newline..."`, `"Ctrl+J inserts a newline..."` ×2) and to `"destroy() during a turn..."`: replace the `await t.renderOnce()` that follows `pressEnter()` with `await t.frameWith("You")` before asserting on `t.model.messages` / `t.model.status`. In `"Enter while busy keeps the typed text"` and `"Enter after a fatal error keeps the typed text"` the second `pressEnter()` is expected to be ignored, so leave them as they are.

- [ ] **Step 2: Update the runner test**

In `packages/cli/src/tui/run-interactive.test.ts`, add `import { FileIndex } from "../mentions/file-index.js";` and give the `ChatView` in the `waitForQuit` test `index: FileIndex.fromPaths([])`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/cli/src/tui/chat-view.test.ts packages/cli/src/tui/run-interactive.test.ts`
Expected: FAIL — `index` is not a known option; new tests fail on missing popup.

- [ ] **Step 4: Implement the view**

Replace `packages/cli/src/tui/chat-view.ts` with:

```typescript
import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { formatSize } from "../mentions/expand-mentions.js";
import type { FileIndex } from "../mentions/file-index.js";
import { mentionAtCursor } from "../mentions/parse-mentions.js";
import type { ChatModel, Message, Role } from "./chat-model.js";
import { MAX_ROWS, MentionPopup } from "./mention-popup.js";

export const GUIDE =
  "Enter send · Shift+Enter (or Ctrl+J) newline · @ file · Ctrl+C quit";
/** Three fixed cells so legacy terminals keep the line aligned. */
const FRAMES = ["●○○", "○●○", "○○●", "○●○"];
const FRAME_INTERVAL_MS = 120;
const LABELS: Record<Role, string> = {
  user: "You",
  assistant: "Assistant",
  error: "Error",
};
/** Input box (border + 4 lines) and the status line below the history. */
const INPUT_BOX_HEIGHT = 6;
const STATUS_HEIGHT = 1;

export interface ChatViewOptions {
  title: string;
  providerName: string;
  /** Response timeout budget shown next to the elapsed time. */
  timeoutMs: number;
  /** Candidates for `@` mentions. */
  index: FileIndex;
}

/** KeyHandler's `on` is typed through a generic EventEmitter that does not
 * type-check under our config; this is the shape we rely on at runtime. */
interface KeypressSource {
  on(event: "keypress", handler: (key: KeyEvent) => void): unknown;
  off(event: "keypress", handler: (key: KeyEvent) => void): unknown;
}

/** Builds the OpenTUI tree for one ChatModel and mirrors its state.
 * Layout: header / scrolling history / 4-line textarea / status line, plus
 * a mention popup drawn over the bottom of the history while the cursor is
 * inside an `@` mention. */
export class ChatView {
  private readonly history: ScrollBoxRenderable;
  private readonly input: TextareaRenderable;
  private readonly status: TextRenderable;
  private readonly popup: MentionPopup;
  private readonly index: FileIndex;
  private readonly onKeypress: (key: KeyEvent) => void;
  private rendered = 0;
  private spinner: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private readonly budgetSec: number;
  private startedAt = 0;
  private destroyed = false;
  private statusPinned = false;

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
        content: `${opts.title} · ${opts.providerName}`,
        marginBottom: 1,
      }),
    );
    this.history = new ScrollBoxRenderable(renderer, {
      id: "history",
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    root.add(this.history);

    const inputBox = new BoxRenderable(renderer, {
      id: "input-box",
      border: true,
      height: INPUT_BOX_HEIGHT,
    });
    this.input = new TextareaRenderable(renderer, {
      id: "input",
      height: INPUT_BOX_HEIGHT - 2,
      placeholder: "Type a message",
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

    this.status = new TextRenderable(renderer, {
      id: "status",
      content: GUIDE,
    });
    root.add(this.status);
    renderer.root.add(root);

    this.popup = new MentionPopup(renderer, root, {
      bottom: INPUT_BOX_HEIGHT + STATUS_HEIGHT,
    });

    this.input.onSubmit = () => {
      // The textarea keeps its content until the model accepts the message,
      // so input the model drops (blank, busy, fatal, mention error) stays
      // editable.
      void this.model.submit(this.input.plainText).then((accepted) => {
        if (accepted && !this.destroyed) this.input.clear();
      });
    };
    // Global listener: runs before the focused textarea and can stop it.
    this.onKeypress = (key) => this.handlePopupKey(key);
    (renderer.keyInput as unknown as KeypressSource).on(
      "keypress",
      this.onKeypress,
    );
    this.input.onContentChange = () => this.refreshPopup();
    this.input.onCursorChange = () => this.refreshPopup();
    this.model.onChange = () => this.update();
    this.input.focus();
    this.update();
  }

  /** Appends messages not yet drawn and syncs the status line. */
  update(): void {
    // A turn still in flight when the view is destroyed would otherwise
    // write to renderables the renderer has already torn down.
    if (this.destroyed) return;
    for (; this.rendered < this.model.messages.length; this.rendered++) {
      const message = this.model.messages[this.rendered];
      if (message) this.history.add(this.messageBox(message));
    }
    if (this.statusPinned) return;
    if (this.model.status === "busy") {
      this.startSpinner();
    } else {
      this.stopSpinner();
      this.status.content = GUIDE;
    }
  }

  /** Pins a message on the status line (e.g. "Closing browser...") so the
   * user sees that teardown started. Later model changes leave it alone. */
  setStatus(text: string): void {
    if (this.destroyed) return;
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

  /** While the popup is open, navigation and accept keys belong to it and
   * never reach the textarea. Everything else falls through and the
   * content/cursor hooks re-run the search. */
  private handlePopupKey(key: KeyEvent): void {
    if (this.destroyed || !this.popup.visible) return;
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

  /** Reads the textarea and shows or hides the popup accordingly. */
  private refreshPopup(): void {
    if (this.destroyed) return;
    const mention = mentionAtCursor(this.input.plainText, this.input.cursorOffset);
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
    const mention = mentionAtCursor(this.input.plainText, this.input.cursorOffset);
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
    box.add(
      new TextRenderable(this.renderer, { content: LABELS[message.role] }),
    );
    box.add(
      new TextRenderable(this.renderer, {
        content: message.text,
        wrapMode: "word",
      }),
    );
    for (const a of message.attachments ?? []) {
      box.add(
        new TextRenderable(this.renderer, {
          content: `📎 ${a.path} (${formatSize(a.bytes)})`,
        }),
      );
    }
    return box;
  }

  private startSpinner(): void {
    if (this.spinner) return;
    this.startedAt = Date.now();
    const tick = () => {
      this.frame = (this.frame + 1) % FRAMES.length;
      const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
      this.status.content = `${FRAMES[this.frame]} Thinking…  ${elapsed}s / ${this.budgetSec}s`;
    };
    tick();
    this.spinner = setInterval(tick, FRAME_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = undefined;
  }
}
```

Notes for the implementer:
- `waitForQuit` in `run-interactive.ts` also listens on `keyInput` for Ctrl+C; the popup handler ignores `c` and never calls `preventDefault` for it, so quitting still works with the popup open.
- If `insertText` after `setSelection` does not replace the selection in some edge case (the spike showed it does), fall back to `this.input.setSelection(start, end); this.input.insertText("")` is **not** a thing — instead, rebuild the text: `const t = this.input.plainText; this.input.clear(); this.input.insertText(t.slice(0, start) + \`@${path} \` + t.slice(end)); this.input.cursorOffset = start + path.length + 2;`.
- `refreshPopup` hides the popup whenever the mention ends (whitespace typed) or the cursor moves out, which covers the spec's "typing whitespace ends the mention".

- [ ] **Step 5: Implement the runner change**

In `packages/cli/src/tui/run-interactive.ts`:

Add the import:

```typescript
import { FileIndex } from "../mentions/file-index.js";
```

Extend `InteractiveOptions`:

```typescript
export interface InteractiveOptions extends ChatSessionOptions {
  /** Shown in the header, e.g. the CLI name. */
  title: string;
  /** Test-only: replaces createCliRenderer. */
  createRenderer?: () => Promise<CliRenderer>;
  /** Test-only: replaces the working-directory index. */
  index?: FileIndex;
}
```

In `runInteractive`, build the index right after the session opens and before the renderer is created (so a slow walk never blocks a visible UI, and a failure surfaces like any other startup error):

```typescript
  const session = await ChatSession.open(opts);
  let index: FileIndex;
  let renderer: CliRenderer;
  try {
    index = opts.index ?? (await FileIndex.build({ cwd: process.cwd() }));
    renderer = await (
      opts.createRenderer ?? (() => createCliRenderer({ exitOnCtrlC: false }))
    )();
  } catch (err) {
    // The session is already open; nothing else would ever close it.
    await closeWithTimeout(session, CLOSE_TIMEOUT_MS);
    throw err;
  }
```

and pass it to the view:

```typescript
    view = new ChatView(renderer, model, {
      title: opts.title,
      providerName: opts.provider.name,
      timeoutMs: opts.timeoutMs,
      index,
    });
```

In `run-interactive.test.ts`, the `"closes the session when the renderer fails to start"` test now walks the real cwd unless given an index; add `index: FileIndex.fromPaths([])` to its options so it stays fast.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test packages/cli/src/tui`
Expected: PASS. Known adjustment points:
- If `"typing @ opens the popup"` fails because `onContentChange` runs before the cursor moved, add `queueMicrotask(() => this.refreshPopup())` in both hooks instead of calling it synchronously, and add `await t.renderOnce()` twice in the tests (or use `frameWith`).
- If `off` is missing on `KeyHandler` (it extends `EventEmitter`, so it is there), remove the `off` line from `destroy()` and guard `handlePopupKey` with `this.destroyed` — already done.

- [ ] **Step 7: Check and commit**

```bash
bun run check
git add packages/cli/src/tui/chat-view.ts packages/cli/src/tui/chat-view.test.ts packages/cli/src/tui/run-interactive.ts packages/cli/src/tui/run-interactive.test.ts
git commit -m "feat(cli): @file popup in the interactive TUI (Refs #27)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 27 --body "Task 6 done: ChatView opens the MentionPopup from onContentChange/onCursorChange, intercepts up/down/tab/enter/escape via keyInput preventDefault, inserts '@path ', clears the textarea only when submit resolves true, renders attachment lines; runInteractive builds the FileIndex at startup. Next: Task 7 README + ROADMAP, then whole-branch review and PR."
```

---

### Task 7: Docs

**Files:**
- Modify: `README.md` (Interactive mode section)
- Modify: `docs/ROADMAP.md` (add milestone 6)

- [ ] **Step 1: README**

In `README.md`, in the "Interactive mode" bullet list, insert after the first bullet (the one about Enter / Shift+Enter / Ctrl+C):

```markdown
- Type **`@`** to attach a file from the directory you started `chatbridge`
  in. A popup lists fuzzy matches (`.gitignore`d files, `.git`, and
  `node_modules` are left out); **↑/↓** select, **Tab** or **Enter** insert
  `@path `, **Esc** closes. On send, each mentioned file is appended to
  the prompt as a fenced code block under a `### path` heading, and the
  history shows `📎 path (size)` for each one. Limits: 200 KB per file,
  1 MB per message, text files only, paths inside the working directory.
  Problems are shown as an error and nothing is sent; fix the message and
  press Enter again. One-shot mode (`-p`) sends the prompt verbatim.
```

- [ ] **Step 2: ROADMAP**

In `docs/ROADMAP.md`, insert before `### 5. Company adoption`:

```markdown
### 6. @file mentions in the interactive TUI — done (issue #27, 2026-09-09)

Typing `@` in the TUI opens a fuzzy popup over a `.gitignore`-aware index
of the working directory; on send the mentioned files are appended to the
prompt as fenced sections and the history shows one attachment line per
file. Everything lives in `@chatbridge/cli`; core, runtime, and provider
are unchanged. One-shot expansion stays in the backlog behind a flag.
Spec: `docs/superpowers/specs/2026-09-09-file-mentions-design.md`.
```

Add to the Backlog list:

```markdown
- **`@file` mentions in one-shot mode.** Behind an explicit flag; `-p`
  stays verbatim by default.
- **Live re-scan of the mention index.** New files appear without a
  restart.
```

- [ ] **Step 3: Check and commit**

```bash
bun run check
git add README.md docs/ROADMAP.md
git commit -m "docs: @file mentions in README and ROADMAP; mark milestone 6 done (Refs #27)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
gh issue comment 27 --body "Task 7 done: README documents @ mentions; ROADMAP adds milestone 6 as done and two backlog items. Next: whole-branch review (Fable), then PR."
```

---

## Self-review

- **Spec coverage.** §1 `file-index.ts` → Task 3; `parse-mentions.ts` → Task 1; `expand-mentions.ts` (output shape, fence rule, language table, relative POSIX paths, every problem line, collected errors) → Task 2. §2 `chat-model.ts` (attachments, `expand` option, error entry without status/fatal change, boolean result) → Task 4; `chat-view.ts` (`index` option, popup-owns-Enter, clear-only-on-true, refresh on keypress, accept inserts `@path `, `📎` lines, `GUIDE`) → Task 6; `mention-popup.ts` (show/hide/visible/move/selected, absolute bordered box, inverted row, width cap) → Task 5. §3 spike → resolved in "Spike findings"; mechanism 1 (global listener + `preventDefault`) and mechanism 2 (`onContentChange`/`onCursorChange`) implemented in Task 6. §4 tests → Tasks 1, 2, 3, 4, 5, 6 (one test file each; the spec's `chat-view.test.ts` list is covered item by item). §5 `ignore` dependency → Task 3. Backlog notes → Task 7 ROADMAP. Two deviations from the spec text, both intentional: `mentionAtCursor` includes a bare `@` (empty path) so the popup opens on `@` as the spec's view test requires, and `MentionPopup` takes a `{ bottom }` option because it is added to the root rather than to the history box.
- **Placeholders.** None; every code step is complete. The "notes for the implementer" describe fallbacks with concrete code, not open questions.
- **Type consistency.** `Mention { path, start, end }` (T1) consumed by T2 and T6. `Attachment { path, bytes }` and `Expansion { prompt, attachments }` (T2) consumed by T4 and T6. `formatSize` (T2) used by T6. `FileIndex.fromPaths` / `search(query, limit)` / `size` (T3) used by T5 tests indirectly and T6. `ChatModel(session, { expand })` and `submit(): Promise<boolean>` (T4) used by T6. `MentionPopup(renderer, parent, { bottom })`, `show/hide/move/selected/visible/destroy`, `MAX_ROWS` (T5) used by T6. `ChatViewOptions.index` (T6) set in `run-interactive.ts` and both test files.
