# File mentions in the interactive TUI (milestone 6) — Design

Date: 2026-09-09
Status: Approved (brainstorming session)
Issue: https://github.com/7milch/chatbridge-cli/issues/27

## Goal

Let the user reference files from the interactive TUI by typing `@`. A
popup offers fuzzy matches from the working directory; on send, each
referenced file is appended to the prompt as a fenced code block. The web
chat service receives one long text. Core, runtime, and provider are
unchanged.

Out of scope: one-shot mode (`-p`) keeps its prompt verbatim. An opt-in
flag for one-shot expansion is a backlog item.

## Decisions (from brainstorming)

- **Candidates:** every file under the directory `chatbridge` was started
  in, recursively, honouring `.gitignore` (via the `ignore` package). `.git`
  and `node_modules` are always excluded. The index is built once at startup and capped at
  20,000 files. Hand-typed paths not in the index still work.
- **Prompt shape:** the body is sent unchanged, followed by one section
  per file in order of first appearance. Duplicate mentions expand once.
- **Mention syntax:** `@` counts only at the start of a line or after
  whitespace, so `foo@example.com` is not a mention. The path runs to the
  next whitespace.
- **History display:** the `You` entry shows the body plus one attachment
  line per file; the expanded text is not shown.
- **Errors block the send.** Missing paths, directories, binary / non-UTF-8
  content, size limits, and paths outside the working directory produce an
  `Error` entry in the history. They are not fatal and the textarea keeps
  its content so the user can fix and resend.
- **Placement:** everything lives in `@chatbridge/cli`. The mention modules
  do not import OpenTUI; the popup does.

## 1. Modules

```
packages/cli/src/mentions/            no OpenTUI import
  file-index.ts       FileIndex — listing + fuzzy search
  parse-mentions.ts   parseMentions(text) → Mention[]
  expand-mentions.ts  expandMentions(text, cwd) → Expansion | throws MentionError
packages/cli/src/tui/
  chat-model.ts       Message gains attachments; submit expands before send
  mention-popup.ts    MentionPopup — OpenTUI renderable for the candidate list
  chat-view.ts        opens/closes the popup, inserts the accepted path,
                      renders attachment lines
```

### `file-index.ts`

```typescript
export interface FileIndexOptions {
  cwd: string;
  /** Stop listing after this many files. Default 20_000. */
  limit?: number;
}
export class FileIndex {
  /** Walks cwd once. Honours every .gitignore on the path from cwd down;
   * always skips `.git`. Returns relative POSIX paths, sorted. */
  static build(opts: FileIndexOptions): Promise<FileIndex>;
  /** Test-only: an index over a fixed list. */
  static fromPaths(paths: string[]): FileIndex;
  /** Fuzzy search: every query character must appear in order. Score
   * favours matches at path-segment starts and shorter paths. Empty query
   * returns the first `limit` paths. */
  search(query: string, limit: number): string[];
}
```

Directory walk: `fs.promises.readdir` with `withFileTypes`, depth-first,
symlinks not followed. Each directory's `.gitignore` is added to an
`ignore` instance scoped to that directory (paths tested relative to
that directory). `.git` and `node_modules` directories are always
skipped, so the walk stays cheap outside a git repository too.

### `parse-mentions.ts`

```typescript
export interface Mention { path: string; start: number; end: number; }
/** `@path` at line start or after whitespace; path runs to the next
 * whitespace. A bare `@` yields nothing. Order of appearance, duplicates
 * kept (expandMentions dedupes). */
export function parseMentions(text: string): Mention[];
/** The mention whose range contains `cursor` (cursor may sit at `end`),
 * for the popup query. */
export function mentionAtCursor(text: string, cursor: number): Mention | undefined;
```

### `expand-mentions.ts`

```typescript
export interface Attachment { path: string; bytes: number; }
export interface Expansion { prompt: string; attachments: Attachment[]; }
export class MentionError extends Error {
  /** One line per problem, as shown to the user. */
  readonly problems: string[];
}
export const MAX_FILE_BYTES = 200 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024;
export function expandMentions(text: string, cwd: string): Promise<Expansion>;
```

Output when at least one mention exists:

````
<body, unchanged>

### src/foo.ts
```ts
<content>
```
````

- A blank line separates the body from the first section and sections
  from each other.
- Content is not trimmed; a missing trailing newline is added so the
  closing fence sits on its own line.
- Fence: three backticks, lengthened by one while the content contains a
  run of backticks that long at a line start.
- Language from a fixed extension table (`ts js tsx jsx json md py sh yaml
  yml toml html css rs go`); unknown → no language.
- Paths are resolved against `cwd` and rendered relative to it with `/`
  separators.
- With no mentions, `prompt === text` and `attachments` is empty.

All problems in one send are collected and thrown together:

| Cause | Problem line |
|---|---|
| Not found | `@no/such.ts: not found` |
| Directory | `@src: is a directory` |
| Binary / invalid UTF-8 (NUL byte or decode failure) | `@a.png: binary file` |
| File > 200 KB | `@big.log: 312 KB exceeds 200 KB` |
| Total > 1 MB | `attachments total 1.4 MB exceeds 1 MB` |
| Resolves outside cwd | `@../x: outside working directory` |

## 2. Model and view changes

### `chat-model.ts`

```typescript
export interface Message { role: Role; text: string; attachments?: Attachment[]; }
export interface ChatModelOptions {
  /** Default: expandMentions with process.cwd(). Tests inject a fake. */
  expand?: (text: string) => Promise<Expansion>;
}
```

`submit(text)`:

1. Trim; ignore blank / busy / fatal as today.
2. `await expand(prompt)`. On `MentionError`, push
   `{ role: "error", text: problems.join("\n") }`, call `onChange`, and
   return **without** touching `status` or `fatal`. Nothing was sent.
3. Push `{ role: "user", text: prompt, attachments }`, set `busy`, and
   continue exactly as today with `session.send(expansion.prompt)`.

`submit` returns `Promise<boolean>`: `true` when the message was accepted
(so the view knows to clear the textarea), `false` otherwise.

### `chat-view.ts`

- `ChatViewOptions` gains `index: FileIndex`.
- `onSubmit`: when the popup is open, Enter is handled by the popup (see
  below) and never reaches submit. Otherwise call `model.submit(text)` and
  clear the textarea only when it resolves `true`. The current early clear
  is removed.
- After every keypress that reaches the textarea, read `plainText` and the
  cursor; if `mentionAtCursor` finds a mention, `index.search(path, 8)` and
  show the popup; otherwise hide it.
- On accept, replace the mention range with `@<path> ` and move the cursor
  after it.
- `messageBox` renders `📎 <path> (<size>)` per attachment under the body,
  size as `N B` / `N.N KB` / `N.N MB`.
- `GUIDE` becomes
  `Enter send · Shift+Enter (or Ctrl+J) newline · @ file · Ctrl+C quit`.

### `mention-popup.ts`

```typescript
export class MentionPopup {
  constructor(renderer: CliRenderer, parent: BoxRenderable);
  show(candidates: string[]): void;   // resets selection to 0; hides when empty
  hide(): void;
  readonly visible: boolean;
  move(delta: 1 | -1): void;          // wraps
  readonly selected: string | undefined;
}
```

Rendering: an absolutely positioned bordered `BoxRenderable` anchored to
the bottom of the history area, one `TextRenderable` per candidate, the
selected row drawn with inverted colours. Width is the longest candidate
plus padding, capped at the terminal width.

Key handling while visible: `up` / `down` move, `tab` / `return` /
`kpenter` accept, `escape` hides. Every other key goes to the textarea and
re-runs the search. Typing whitespace ends the mention, so the popup hides.

## 3. OpenTUI uncertainties (first plan task is a spike)

Two behaviours of `@opentui/core` 0.5.10 are unverified and decide the
implementation of key handling:

1. Whether a `keypress` listener on `renderer.keyInput` can consume a key
   before the focused textarea sees it. If not, the fallback is to swap
   the textarea's `keyBindings` while the popup is open so that `return`
   maps to no action and the popup handles it.
2. Whether the textarea exposes a content-change hook. If not, the view
   reads `plainText` after each keypress.

The spike records its findings in the plan and picks the mechanism; the
spec above is written so either outcome fits.

## 4. Testing

Same two layers as milestone 3a; no new E2E.

- `mentions/file-index.test.ts` — temp directory fixtures: nested
  `.gitignore`, `.git` skipped, limit respected, search ordering (segment
  start beats mid-word, shorter path wins ties), empty query.
- `mentions/parse-mentions.test.ts` — line start, after whitespace, email
  not a mention, bare `@`, `mentionAtCursor` at and inside the range.
- `mentions/expand-mentions.test.ts` — exact output for one and two files,
  dedupe, fence lengthening, language table, each error line, all problems
  collected in one error, outside-cwd rejection.
- `tui/chat-model.test.ts` — fake `expand`: expanded prompt reaches
  `send`; `MentionError` yields an error entry, no `send`, status idle,
  not fatal, `submit` resolves `false`.
- `tui/chat-view.test.ts` — OpenTUI test renderer with
  `FileIndex.fromPaths`: typing `@` shows candidates, `down` + `tab` inserts
  `@<path> `, `escape` hides, Enter with popup open does not submit,
  attachment line rendered, textarea kept after a mention error.

## 5. Dependencies

`ignore` added to `@chatbridge/cli` dependencies. No other additions.

## Backlog notes

- One-shot `-p` expansion behind an explicit flag.
- Highlighting matched characters in the popup and the popup's visual
  design are revisited in the TUI redesign milestone.
- Re-scanning the index while running (new files appear without restart).
