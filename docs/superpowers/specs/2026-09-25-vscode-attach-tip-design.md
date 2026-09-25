# VSCode current-file attach tip — design

Milestone 23, issue #131. The VSCode chat view's composer shows the active
editor's file as a dashed "ghost" chip in the attachment row, and one click
turns it into a real attachment. Modelled on the built-in VSCode chat
composer. Ships as v0.12.0.

## What the user sees

Three UI treatments were mocked (muted text after the `+`, a dashed ghost
chip in the attachment row, a bordered pill fused to the `+`); the user chose
the ghost chip.

- With `src/config/hogehoge.json` active in the editor, the attachment row
  above the textarea shows a chip with a dashed border reading
  `+ hogehoge.json`, in the muted foreground colour. Its tooltip is the
  workspace-relative path. Hover and focus make it solid and bright, so it
  reads as a control.
- Clicking it attaches that file through the same path as a drop or the `+`
  picker, so it becomes a normal solid chip (`📎 src/config/hogehoge.json
  (1.2 KB)`) with its `×`. The ghost chip disappears while the file is
  pending and returns when the chip is removed.
- Switching editors changes the name. No active editor, an `untitled` buffer,
  or any non-`file` scheme (diff views, settings, the output panel) shows no
  ghost chip.
- The `+` button and the native picker are unchanged and remain the way to
  add other files.

## What is attached

The existing `attachUris` path is reused unchanged. Its `openDocument` calls
`workspace.openTextDocument(uri).getText()`, so for a file that is open in an
editor the text is the editor's current buffer, unsaved edits included. That
is what a drop or the `+` picker already does for an open file, and the user
chose to keep this path rather than add a second one, so the tip has the same
behaviour and no content code of its own.

## Data flow

```
window.onDidChangeActiveTextEditor
        │  (VscodeUi.onDidChangeActiveEditor, optional)
        ▼
create-extension.ts ── activeFileOf(editor) ──▶ bridge.pushActiveFile(file)
                                                       │  { type: "activeFile", file? }
                                                       ▼
                                      webview/main.ts keeps `activeFile`,
                                      re-renders only the attachment row
                                                       │  click
                                                       ▼
                                      { type: "attachUris", uris: [file.uri] }
                                                       │  existing path
                                                       ▼
                                      commands.attachUris → pending chip
```

The tip is not part of `State`. A state frame carries the whole conversation
and is pushed on session events; an editor switch is not one, and pushing the
history again for it would be wasted work and a re-render risk (#121, #122).

## Components

### `protocol.ts`

```ts
/** The file behind the active text editor, for the composer's attach tip. */
export interface ActiveFile {
  /** `vscode.Uri.toString()`, what `attachUris` takes. */
  uri: string;
  /** Workspace-relative, `/`-separated; absolute outside a workspace. */
  path: string;
  /** Basename, what the chip shows. */
  name: string;
}
```

`ToWebview` gains `{ type: "activeFile"; file?: ActiveFile }`. `file` absent
means "no tip".

### `vscode-ui.ts`

`VscodeUi` gains an optional method, optional for the same reason `pickFiles`
is: a vendor's own `VscodeUi` written against an older release must keep
building, and without it there is simply no tip.

```ts
/** Fires with the active editor's file, or `undefined` when there is no
 * editor or its document is not a `file:` URI; also called once with the
 * current value on subscribe. Optional: without it the composer shows no
 * attach tip. */
onDidChangeActiveEditor?(
  listener: (file: ActiveFile | undefined) => void,
): { dispose(): void };
```

`createVscodeUi` implements it with `api.window.activeTextEditor` for the
initial value and `api.window.onDidChangeActiveTextEditor` for changes,
mapping through a pure `activeFileOf(editor)` helper: `undefined` unless
`document.uri.scheme === "file"`, otherwise `{ uri: uri.toString(), path:
relPath(uri), name: basename(uri.path) }`.

Focus moving into the chat view does not fire the event: `activeTextEditor`
stays the editor that last had focus in an editor group, which is exactly the
file the user means.

### `chat-view-bridge.ts`

- `pushActiveFile(file: ActiveFile | undefined)` posts the `activeFile`
  message and remembers the value.
- On `ready` the bridge posts the remembered value after `config` and the
  first `state`, because VSCode recreates the webview and the new page starts
  with no tip.

### `create-extension.ts`

Subscribes `ui.onDidChangeActiveEditor?.((file) => bridge.pushActiveFile(file))`
and pushes the disposable into `context.subscriptions`.

### `webview/view-state.ts`

A pure function keeps the show/hide rule testable without a DOM:

```ts
export interface AttachTip { uri: string; name: string; path: string }
/** The ghost chip to show, or undefined: no active file, or that file is
 * already a pending attachment. */
export function attachTipState(
  activeFile: ActiveFile | undefined,
  pendingAttachments: Attachment[],
): AttachTip | undefined;
```

"Already pending" compares `path`, which is what `attachUris` stores on the
`Attachment`.

### `webview/main.ts`

- Keeps `let activeFile: ActiveFile | undefined`.
- `renderAttachments(s)` renders the ghost chip first when `attachTipState`
  returns one: a `<button type="button" class="chip ghost">` with the plus
  icon and `name`, `title` = `path`, `aria-label` = `Attach <path>`. Click
  posts `{ type: "attachUris", uris: [tip.uri] }`.
- The `activeFile` message handler sets `activeFile` and, when a state has
  been received, calls `renderAttachments(lastState)` only. It never calls
  `render()`, so the history DOM and any selection in it are untouched.
- The send button's `disabled` rule is unchanged: a ghost chip is not an
  attachment, so an empty prompt with only the tip stays unsendable. The
  existing empty-check uses `attachments.childElementCount`; it must count
  pending chips only, so the ghost chip is excluded from that count (query
  `.chip:not(.ghost)`).

### `webview/style.css`

```css
.chip.ghost {
  background: transparent;
  color: var(--vscode-descriptionForeground);
  border: 1px dashed var(--vscode-badge-background);
  cursor: pointer;
  font: inherit;
  font-size: 90%;
}
.chip.ghost:hover, .chip.ghost:focus-visible {
  color: var(--vscode-foreground);
  border-style: solid;
  outline: none;
}
```

## Testing

- `chat-view-bridge.test.ts`: `pushActiveFile` posts `{ type: "activeFile",
  file }`; a later `ready` re-posts the remembered value; `undefined` posts
  the message without `file`.
- `vscode-ui.test.ts` (new, or in `commands.test.ts` if a fake API already
  lives there): `activeFileOf` returns `undefined` for no editor and for
  `untitled:`/`vscode-userdata:` schemes, and the expected triple for a
  `file:` URI, with `\` normalised to `/`.
- `view-state.test.ts`: `attachTipState` hides when there is no file, hides
  when the path is already pending, shows otherwise.
- `examples/vscode-dummy-chat/test/suite.ts` (`bun run e2e:vscode`, outside
  `bun run check`): write a file into the test workspace, open it, and assert
  the bridge posted an `activeFile` whose `name` matches; then feed that
  `uri` to `handlers.attachUris` and assert one pending attachment. Opening
  an `untitled` document afterwards yields `activeFile` without `file`.
- `no-html-injection.test.ts` already covers `main.ts`; the chip uses
  `textContent`, never `innerHTML`.

## Vendor impact

`VscodeUi.onDidChangeActiveEditor` is a new optional member and `ToWebview`
grows one message. No `Provider`, `createExtension` option, manifest or
template change. `packages/provider/skills/upgrading-provider-repo/upgrade-guide.md`
gets a 0.12.0 entry: bump only; a vendor with its own `VscodeUi` may add the
method to get the tip.

## Out of scope

- Attaching the selection rather than the file (`sendSelection` already
  exists as a command).
- A tip for multiple visible editors or for the TUI.
- Reading the file from disk when the buffer is dirty.
