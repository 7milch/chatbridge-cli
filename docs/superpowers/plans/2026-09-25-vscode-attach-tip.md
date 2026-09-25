# VSCode Current-File Attach Tip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The VSCode chat composer shows the active editor's file as a dashed ghost chip in the attachment row; one click attaches it through the existing `attachUris` path.

**Architecture:** The extension host watches the active text editor through a new optional `VscodeUi.onDidChangeActiveEditor` and pushes a new `activeFile` host → webview message via `ChatViewBridge`. The webview keeps that value outside `State`, re-renders only the attachment row, and a click posts the existing `attachUris` message. Nothing downstream changes.

**Tech Stack:** TypeScript, Bun test runner, VSCode extension API, `@vscode/test-electron` E2E (`bun run e2e:vscode`, outside `bun run check`).

**Spec:** `docs/superpowers/specs/2026-09-25-vscode-attach-tip-design.md`

## Global Constraints

- Milestone 23, tracking issue #131, branch `issue-131`, ships as v0.12.0.
- `bun run check` (Biome lint + `tsc --build` + `bun test`) must pass before every commit. Tests import cross-package code from `dist/`, so run `bun run build` after editing another package (this plan touches only `packages/vscode` and `examples/vscode-dummy-chat`).
- Every commit message, comment and doc line is in English. After every commit: `gh issue comment 131 --body "<what was committed> + What's next: <remaining tasks>"`.
- Only the `file:` URI scheme yields a tip. `untitled:` and every other scheme yield `undefined`.
- The tip is never part of `State`; the webview must never call `render()` on an `activeFile` message.
- `VscodeUi.onDidChangeActiveEditor` is optional (like `pickFiles`); a `VscodeUi` without it builds and simply shows no tip.
- The click reuses `attachUris` unchanged; no new content-reading code.
- Model policy: Tasks 1, 3 and 6 are mechanical (Sonnet); Tasks 2, 4 and 5 touch the VSCode API, the E2E or the webview DOM (Opus).

---

### Task 1: `ActiveFile` type and the pure `attachTipState` rule

**Files:**
- Modify: `packages/vscode/src/protocol.ts` (add `ActiveFile`, extend `ToWebview`)
- Modify: `packages/vscode/src/webview/view-state.ts` (add `attachTipState`)
- Test: `packages/vscode/src/webview/view-state.test.ts`

**Interfaces:**
- Produces: `interface ActiveFile { uri: string; path: string; name: string }` exported from `protocol.ts`; `ToWebview` member `{ type: "activeFile"; file?: ActiveFile }`; `attachTipState(activeFile: ActiveFile | undefined, pending: Attachment[]): ActiveFile | undefined` exported from `webview/view-state.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/vscode/src/webview/view-state.test.ts` (add `attachTipState` to the existing import from `./view-state.js` and `import type { ActiveFile } from "../protocol.js";`):

```ts
describe("attachTipState", () => {
  const active: ActiveFile = {
    uri: "file:///ws/src/config/hogehoge.json",
    path: "src/config/hogehoge.json",
    name: "hogehoge.json",
  };

  test("no active file means no tip", () => {
    expect(attachTipState(undefined, [])).toBeUndefined();
  });

  test("an active file not yet pending is the tip", () => {
    expect(attachTipState(active, [file])).toEqual(active);
  });

  test("a file that is already a pending attachment hides the tip", () => {
    const pending = { path: active.path, bytes: 3, content: "{}\n" };
    expect(attachTipState(active, [file, pending])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/vscode/src/webview/view-state.test.ts`
Expected: FAIL — `attachTipState` is not exported (`SyntaxError` / `undefined is not a function`).

- [ ] **Step 3: Add the type and the message to `protocol.ts`**

After the `QueueEntry` interface in `packages/vscode/src/protocol.ts` add:

```ts
/** The file behind the active text editor, for the composer's attach tip.
 * Never part of `State`: an editor switch is not a session event. */
export interface ActiveFile {
  /** `vscode.Uri.toString()`, what `attachUris` takes. */
  uri: string;
  /** Workspace-relative, `/`-separated; absolute outside a workspace. */
  path: string;
  /** Basename, what the chip shows. */
  name: string;
}
```

Extend the `ToWebview` union (after the `partial` member):

```ts
  /** The active editor's file, or none. Posted on every editor switch and
   * once after `ready`, since VSCode recreates the webview. */
  | { type: "activeFile"; file?: ActiveFile };
```

- [ ] **Step 4: Add `attachTipState` to `view-state.ts`**

Change the import at the top of `packages/vscode/src/webview/view-state.ts` to
`import type { ActiveFile, State, Status } from "../protocol.js";` and add
`import type { Attachment } from "@chatbridge/core";` (the file already
imports from `../protocol.js`; `Attachment` comes from core as `protocol.ts`
does). Append:

```ts
/** The ghost chip in the attachment row: the active editor's file, unless
 * it is already a pending attachment. Compared by `path`, which is what
 * `attachUris` stores on the `Attachment`. */
export function attachTipState(
  activeFile: ActiveFile | undefined,
  pending: Attachment[],
): ActiveFile | undefined {
  if (!activeFile) return undefined;
  return pending.some((a) => a.path === activeFile.path)
    ? undefined
    : activeFile;
}
```

If the webview bundle (`packages/vscode/esbuild` config or the
`build:webview` script in `packages/vscode/package.json`) rejects a
type-only import from `@chatbridge/core`, use `import type` as shown; a
type import is erased and pulls nothing into the browser bundle.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/vscode/src/webview/view-state.test.ts`
Expected: PASS (all existing tests plus the three new ones).

- [ ] **Step 6: Run the full check and commit**

Run: `bun run check`
Expected: PASS.

```bash
git add packages/vscode/src/protocol.ts packages/vscode/src/webview/view-state.ts packages/vscode/src/webview/view-state.test.ts
git commit -m "feat(vscode): ActiveFile message type and attachTipState rule (Refs #131)"
gh issue comment 131 --body "Task 1 committed: ActiveFile type, the activeFile ToWebview message and the pure attachTipState rule with tests. What's next: Task 2 (VscodeUi.onDidChangeActiveEditor), Task 3 (bridge pushActiveFile), Task 4 (extension wiring + E2E), Task 5 (webview chip), Task 6 (upgrade guide)."
```

---

### Task 2: `VscodeUi.onDidChangeActiveEditor` and `activeFileOf`

**Files:**
- Modify: `packages/vscode/src/vscode-ui.ts`
- Create: `packages/vscode/src/vscode-ui.test.ts`

**Interfaces:**
- Consumes: `ActiveFile` from `./protocol.js` (Task 1).
- Produces: optional `VscodeUi.onDidChangeActiveEditor?(listener: (file: ActiveFile | undefined) => void): { dispose(): void }`; exported pure helper `activeFileOf(editor: { document: { uri: vscode.Uri } } | undefined, relPath: (uri: vscode.Uri) => string): ActiveFile | undefined`.

- [ ] **Step 1: Write the failing tests**

Create `packages/vscode/src/vscode-ui.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { activeFileOf } from "./vscode-ui.js";

/** The slice of vscode.Uri that activeFileOf reads. */
function uri(scheme: string, path: string) {
  return {
    scheme,
    path,
    toString: () => `${scheme}://${path}`,
  };
}

const relPath = (u: { path: string }) =>
  u.path.replace(/^\/ws\//, "").split("\\").join("/");

describe("activeFileOf", () => {
  test("no editor means no file", () => {
    expect(activeFileOf(undefined, relPath)).toBeUndefined();
  });

  test("a file: URI yields uri, relative path and basename", () => {
    const editor = { document: { uri: uri("file", "/ws/src/config/hogehoge.json") } };
    // biome-ignore lint/suspicious/noExplicitAny: the test passes a Uri-shaped stub
    expect(activeFileOf(editor as any, relPath as any)).toEqual({
      uri: "file:///ws/src/config/hogehoge.json",
      path: "src/config/hogehoge.json",
      name: "hogehoge.json",
    });
  });

  test("untitled and other schemes yield nothing", () => {
    for (const scheme of ["untitled", "vscode-userdata", "output"]) {
      const editor = { document: { uri: uri(scheme, "/Untitled-1") } };
      // biome-ignore lint/suspicious/noExplicitAny: Uri-shaped stub
      expect(activeFileOf(editor as any, relPath as any)).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/vscode/src/vscode-ui.test.ts`
Expected: FAIL — `activeFileOf` is not exported.

- [ ] **Step 3: Add the helper and the optional method**

In `packages/vscode/src/vscode-ui.ts`, add `import type { ActiveFile } from "./protocol.js";` at the top. Add the optional member to the `VscodeUi` interface after `pickFiles`:

```ts
  /** Fires with the active editor's file, or `undefined` when there is no
   * editor or its document is not a `file:` URI; also called once with the
   * current value on subscribe. Optional: without it the composer shows no
   * attach tip. */
  onDidChangeActiveEditor?(
    listener: (file: ActiveFile | undefined) => void,
  ): { dispose(): void };
```

Add the exported pure helper above `createVscodeUi`:

```ts
/** The tip's view of an editor: only a `file:` document has a file. Pure,
 * so the mapping is unit-tested without a VSCode host. */
export function activeFileOf(
  editor: Pick<vscode.TextEditor, "document"> | undefined,
  relPath: (uri: vscode.Uri) => string,
): ActiveFile | undefined {
  const uri = editor?.document.uri;
  if (!uri || uri.scheme !== "file") return undefined;
  const name = uri.path.slice(uri.path.lastIndexOf("/") + 1);
  return { uri: uri.toString(), path: relPath(uri), name };
}
```

Implement it in the object returned by `createVscodeUi`, after `pickFiles`:

```ts
    onDidChangeActiveEditor: (listener) => {
      listener(activeFileOf(api.window.activeTextEditor, relPath));
      return api.window.onDidChangeActiveTextEditor((editor) =>
        listener(activeFileOf(editor, relPath)),
      );
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/vscode/src/vscode-ui.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full check and commit**

Run: `bun run check`
Expected: PASS. `commands.test.ts`'s fake `VscodeUi` still type-checks because the new member is optional.

```bash
git add packages/vscode/src/vscode-ui.ts packages/vscode/src/vscode-ui.test.ts
git commit -m "feat(vscode): optional VscodeUi.onDidChangeActiveEditor with a pure activeFileOf (Refs #131)"
gh issue comment 131 --body "Task 2 committed: VscodeUi.onDidChangeActiveEditor (optional) and the pure activeFileOf mapping, file: scheme only, with tests. What's next: Task 3 (bridge pushActiveFile), Task 4 (extension wiring + E2E), Task 5 (webview chip), Task 6 (upgrade guide)."
```

---

### Task 3: `ChatViewBridge.pushActiveFile` and the `ready` re-post

**Files:**
- Modify: `packages/vscode/src/chat-view-bridge.ts`
- Test: `packages/vscode/src/chat-view-bridge.test.ts`

**Interfaces:**
- Consumes: `ActiveFile` from `./protocol.js` (Task 1).
- Produces: `ChatViewBridge.pushActiveFile(file: ActiveFile | undefined): void`; `ChatViewBridge.activeFile: ActiveFile | undefined` (read-only getter, used by the E2E in Task 4).

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("ChatViewBridge", ...)` block of `packages/vscode/src/chat-view-bridge.test.ts` (add `ActiveFile` to the type import from `./protocol.js`):

```ts
  test("pushActiveFile posts the file and ready re-posts it after config and state", () => {
    const bridge = new ChatViewBridge(() => state, noopHandlers);
    const w = fakeWebview();
    bridge.attach(w.webview, { welcome: "hi" });
    const file: ActiveFile = {
      uri: "file:///ws/a.ts",
      path: "a.ts",
      name: "a.ts",
    };
    bridge.pushActiveFile(file);
    expect(w.posted.at(-1)).toEqual({ type: "activeFile", file });
    expect(bridge.activeFile).toEqual(file);

    // VSCode recreated the page: the new one starts with no tip.
    w.posted.length = 0;
    w.receive({ type: "ready" });
    expect(w.posted.map((m) => m.type)).toEqual([
      "config",
      "state",
      "activeFile",
    ]);
    expect(w.posted.at(-1)).toEqual({ type: "activeFile", file });
  });

  test("pushActiveFile(undefined) posts the message without a file", () => {
    const bridge = new ChatViewBridge(() => state, noopHandlers);
    const w = fakeWebview();
    bridge.attach(w.webview);
    bridge.pushActiveFile(undefined);
    expect(w.posted.at(-1)).toEqual({ type: "activeFile" });
    expect(bridge.activeFile).toBeUndefined();
  });

  test("ready with no active file known posts no activeFile message", () => {
    const bridge = new ChatViewBridge(() => state, noopHandlers);
    const w = fakeWebview();
    bridge.attach(w.webview);
    w.receive({ type: "ready" });
    expect(w.posted.map((m) => m.type)).toEqual(["state"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/vscode/src/chat-view-bridge.test.ts`
Expected: FAIL — `bridge.pushActiveFile is not a function`.

- [ ] **Step 3: Implement**

In `packages/vscode/src/chat-view-bridge.ts`, add `ActiveFile` to the type import from `./protocol.js`. Add a field next to `private webview`:

```ts
  /** The last active file pushed; re-posted after `ready` because VSCode
   * recreates the webview and the new page starts with no tip. */
  private lastActiveFile: ActiveFile | undefined;
  private hasActiveFile = false;
```

In the `ready` case, after `this.pushState(this.getState());` add:

```ts
          if (this.hasActiveFile) this.postActiveFile();
```

Add the methods after `pushState`:

```ts
  get activeFile(): ActiveFile | undefined {
    return this.lastActiveFile;
  }

  /** The active editor's file for the composer's attach tip; `undefined`
   * clears it. Not a state frame: an editor switch is not a session event
   * and must not re-send the history. */
  pushActiveFile(file: ActiveFile | undefined): void {
    this.lastActiveFile = file;
    this.hasActiveFile = true;
    this.postActiveFile();
  }

  private postActiveFile(): void {
    const file = this.lastActiveFile;
    void this.webview?.postMessage(
      file ? { type: "activeFile", file } : { type: "activeFile" },
    );
  }
```

`hasActiveFile` distinguishes "never subscribed" (a vendor `VscodeUi` without the method: post nothing) from "subscribed, currently no file" (post the empty message so a stale chip from before a reload clears).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/vscode/src/chat-view-bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full check and commit**

Run: `bun run check`
Expected: PASS.

```bash
git add packages/vscode/src/chat-view-bridge.ts packages/vscode/src/chat-view-bridge.test.ts
git commit -m "feat(vscode): ChatViewBridge.pushActiveFile with re-post on ready (Refs #131)"
gh issue comment 131 --body "Task 3 committed: ChatViewBridge.pushActiveFile, the activeFile getter and the re-post after ready, with tests. What's next: Task 4 (extension wiring + E2E), Task 5 (webview chip), Task 6 (upgrade guide)."
```

---

### Task 4: Extension wiring and the real-VSCode E2E

**Files:**
- Modify: `packages/vscode/src/create-extension.ts` (subscribe; expose `bridge` on `ExtensionApi`)
- Modify: `examples/vscode-dummy-chat/test/suite.ts`

**Interfaces:**
- Consumes: `VscodeUi.onDidChangeActiveEditor` (Task 2), `ChatViewBridge.pushActiveFile` / `.activeFile` (Task 3).
- Produces: `ExtensionApi.bridge: ChatViewBridge`.

- [ ] **Step 1: Extend the E2E (it fails until the wiring exists)**

In `examples/vscode-dummy-chat/test/suite.ts`, add `import * as os from "node:os";` and `import * as path from "node:path";` at the top, and destructure `bridge` too: `const { controller, handlers, bridge } = api;`. Insert before the `// Paste: the active editor's selection becomes a selection chip.` block:

```ts
  // Attach tip: opening a file: document publishes it as the active file,
  // and its uri goes through attachUris like a drop.
  const tipUri = vscode.Uri.file(
    path.join(os.tmpdir(), `chatbridge-tip-${process.pid}.json`),
  );
  await vscode.workspace.fs.writeFile(tipUri, Buffer.from('{"a":1}\n'));
  const tipDoc = await vscode.workspace.openTextDocument(tipUri);
  await vscode.window.showTextDocument(tipDoc);
  await waitFor(() => bridge.activeFile?.uri === tipUri.toString());
  assert.equal(bridge.activeFile?.name, path.basename(tipUri.fsPath));
  await handlers.attachUris([bridge.activeFile?.uri ?? ""]);
  assert.equal(controller.getState().pendingAttachments.length, 1);
  assert.equal(
    controller.getState().pendingAttachments[0]?.path,
    bridge.activeFile?.path,
  );
  controller.removeAttachment(0);

  // An untitled buffer is not a file: the tip clears.
  const untitled = await vscode.workspace.openTextDocument({
    language: "plaintext",
    content: "scratch\n",
  });
  await vscode.window.showTextDocument(untitled);
  await waitFor(() => bridge.activeFile === undefined);
  await vscode.workspace.fs.delete(tipUri);
```

Add the helper next to `waitForIdle` at the bottom of the file:

```ts
/** `onDidChangeActiveTextEditor` fires asynchronously after
 * `showTextDocument` resolves, so poll the bridge rather than assert at once. */
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition not met within 5s");
}
```

- [ ] **Step 2: Wire the extension**

In `packages/vscode/src/create-extension.ts`:

Extend `ExtensionApi`:

```ts
export interface ExtensionApi {
  controller: SessionController;
  /** The E2E drives the command handlers directly. */
  handlers: CommandHandlers;
  /** The E2E reads the last active file the host pushed to the view. */
  bridge: ChatViewBridge;
}
```

`createVscodeUi(vscode, opts.id)` is currently called inline at line ~223 inside the `createCommandHandlers({ ... ui: ... })` call. Hoist it: just above that call add `const ui = createVscodeUi(vscode, opts.id);` and pass `ui,` instead. Then, after the `registerWebviewViewProvider` push, add:

```ts
    // The composer's attach tip. Optional on VscodeUi: a vendor's own
    // implementation without it simply shows no tip.
    const tipSub = ui.onDidChangeActiveEditor?.((file) =>
      bridge.pushActiveFile(file),
    );
    if (tipSub) context.subscriptions.push(tipSub);
```

Change the return to `return { controller, handlers, bridge };`.

- [ ] **Step 3: Run the check, then the E2E**

Run: `bun run check`
Expected: PASS.

Run: `bun run e2e:vscode`
Expected: PASS, with the new assertions. This downloads VSCode on first run and takes a few minutes. If it fails at `waitFor` for the file, check whether `showTextDocument` opened a preview in a different editor group; passing `{ preview: false }` to `showTextDocument` is the fix.

- [ ] **Step 4: Commit**

```bash
git add packages/vscode/src/create-extension.ts examples/vscode-dummy-chat/test/suite.ts
git commit -m "feat(vscode): push the active editor's file to the chat view; E2E covers the tip (Refs #131)"
gh issue comment 131 --body "Task 4 committed: create-extension subscribes ui.onDidChangeActiveEditor and pushes through the bridge; ExtensionApi exposes bridge; the real-VSCode E2E opens a file: document, sees it as the active file, attaches its uri, then sees an untitled buffer clear it. bun run e2e:vscode passes locally. What's next: Task 5 (webview ghost chip), Task 6 (upgrade guide)."
```

---

### Task 5: The ghost chip in the webview

**Files:**
- Modify: `packages/vscode/src/webview/main.ts`
- Modify: `packages/vscode/src/webview/style.css`
- Test: `packages/vscode/src/webview/no-html-injection.test.ts` (existing; must still pass)

**Interfaces:**
- Consumes: `ActiveFile`, the `activeFile` message (Task 1), `attachTipState` (Task 1), the existing `attachUris` `ToHost` message.

The webview has no DOM test harness (#102 is backlog), so this task is verified by the unit tests that guard `main.ts` (no `innerHTML`), the type check, and a manual pass in the Extension Host. Keep the change small and mirror the existing `renderAttachments` style.

- [ ] **Step 1: Add the tip to `renderAttachments`**

In `packages/vscode/src/webview/main.ts`:

Add `ActiveFile` to the type import from `../protocol.js` and `attachTipState` to the import from `./view-state.js`.

Next to `let lastState: State | undefined;` add:

```ts
/** The active editor's file, from the host's `activeFile` message. Kept
 * outside `State`: it changes on every editor switch and must never trigger
 * a history render. */
let activeFile: ActiveFile | undefined;
```

Replace `renderAttachments`:

```ts
function renderAttachments(s: State): void {
  attachments.replaceChildren();
  const tip = attachTipState(activeFile, s.pendingAttachments);
  if (tip) {
    const ghost = button(
      `+ ${tip.name}`,
      () => vscode.postMessage({ type: "attachUris", uris: [tip.uri] }),
      "chip ghost",
    );
    ghost.title = tip.path;
    ghost.setAttribute("aria-label", `Attach ${tip.path}`);
    attachments.appendChild(ghost);
  }
  s.pendingAttachments.forEach((a, index) => {
    const chip = el("span", "chip", `📎 ${a.path} (${formatSize(a.bytes)})`);
    const x = button(
      "×",
      () => vscode.postMessage({ type: "removeAttachment", index }),
      "chip-remove",
    );
    chip.appendChild(x);
    attachments.appendChild(chip);
  });
}
```

- [ ] **Step 2: Keep the ghost chip out of the empty-prompt check**

In `submit()` the line

```ts
  if (text.trim() === "" && attachments.childElementCount === 0) return;
```

becomes

```ts
  // The ghost tip is not an attachment: a prompt that is empty apart from
  // it stays unsendable.
  if (
    text.trim() === "" &&
    attachments.querySelector(".chip:not(.ghost)") === null
  )
    return;
```

- [ ] **Step 3: Handle the message**

In the `window.addEventListener("message", ...)` handler add a branch after the `tookBack` branch:

```ts
  } else if (m.type === "activeFile") {
    activeFile = m.file;
    // Only the attachment row: `render()` would rebuild the history diff and
    // can collapse a selection in it (#121, #122).
    if (lastState) renderAttachments(lastState);
  }
```

- [ ] **Step 4: Style it**

Append to `packages/vscode/src/webview/style.css` after the `.chip-remove` rule:

```css
/* The attach tip: the active editor's file, one click from being a chip. */
.chip.ghost {
  background: transparent;
  color: var(--vscode-descriptionForeground);
  border: 1px dashed var(--vscode-badge-background);
  cursor: pointer;
  font: inherit;
  font-size: 90%;
}
.chip.ghost:hover,
.chip.ghost:focus-visible {
  color: var(--vscode-foreground);
  border-style: solid;
  outline: none;
}
```

- [ ] **Step 5: Run the check**

Run: `bun run check`
Expected: PASS. `no-html-injection.test.ts` still passes since the chip uses `textContent` through `el()`.

- [ ] **Step 6: Manual pass in the Extension Host**

Run the dummy example in the Extension Host (`examples/vscode-dummy-chat`, F5 or `code --extensionDevelopmentPath=examples/vscode-dummy-chat`), open the chat view and check:

1. Open any file in the workspace: the attachment row shows `+ <name>` with a dashed border; the tooltip is the relative path.
2. Click it: it becomes a `📎 <path> (<size>)` chip and the ghost disappears. `×` brings the ghost back.
3. Switch to another file: the name changes. Open an untitled buffer: the ghost disappears.
4. Click inside the chat view: the ghost stays.
5. With the ghost showing and an empty prompt, Enter does nothing; type text and Enter sends without the file.
6. Reload the window (`Developer: Reload Window`): the ghost is back after the view loads.

Note anything off in the issue comment; if a step fails, fix before committing.

- [ ] **Step 7: Commit**

```bash
git add packages/vscode/src/webview/main.ts packages/vscode/src/webview/style.css
git commit -m "feat(vscode): ghost chip for the active editor's file in the composer (Refs #131)"
gh issue comment 131 --body "Task 5 committed: the webview renders the active file as a dashed ghost chip in the attachment row; a click posts attachUris; the activeFile message re-renders only the attachment row; the empty-prompt check ignores the ghost. Manual pass in the Extension Host: <results>. What's next: Task 6 (upgrade guide), then the whole-branch review and the PR."
```

---

### Task 6: Upgrade guide entry

**Files:**
- Modify: `packages/provider/skills/upgrading-provider-repo/upgrade-guide.md`

- [ ] **Step 1: Add the 0.12.0 entry**

Insert above the `## 0.11.3` heading:

```markdown
## 0.12.0

**Required:** none. VSCode only: the chat composer shows the active editor's
file as a dashed `+ <name>` chip in the attachment row, and one click attaches
it through the same path as a drop or the `+` picker. Nothing a vendor
repository built on `createExtension` sees changes.

**Optional:** a repository that supplies its own `VscodeUi` (rather than the
`createVscodeUi` the framework wires in) may implement the new optional
`onDidChangeActiveEditor(listener)` method to get the tip; without it the
composer shows no tip and everything else is unchanged. The listener takes an
`ActiveFile | undefined` (`{ uri, path, name }`, `file:` URIs only) and is
called once on subscribe.

**VSCode manifest:** none.
```

- [ ] **Step 2: Run the check and commit**

Run: `bun run check`
Expected: PASS.

```bash
git add packages/provider/skills/upgrading-provider-repo/upgrade-guide.md
git commit -m "docs(provider): upgrade guide entry for the 0.12.0 attach tip (Refs #131)"
gh issue comment 131 --body "Task 6 committed: upgrade-guide 0.12.0 entry (bump only; optional VscodeUi.onDidChangeActiveEditor for a vendor-supplied VscodeUi). What's next: whole-branch review (Fable), then the PR titled for the release notes with label enhancement, Closes #131."
```

---

## Finishing

After Task 6: whole-branch review with Fable per CLAUDE.md, fix findings, then open the PR against `main`:

- Title: `The VSCode chat composer offers the active editor's file as a one-click attachment`
- Label: `enhancement`
- Body: what changed for the user, `Closes #131`, and the required attribution footer.

The release (v0.12.0, a minor bump the user named up front) follows the tag-push flow in `docs/PUBLISHING.md` after the squash-merge.
