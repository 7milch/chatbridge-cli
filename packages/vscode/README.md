# @chatbridge/vscode

VSCode extension factory for [chatbridge](https://github.com/7milch/chatbridge-cli).
It turns a chatbridge Provider into a sidebar chat view: a webview talks to a
`vscode`-free `SessionController` that owns the conversation history, the
pending attachments and the underlying `ChatSession` lifecycle. A provider
package wires it up and ships its own extension.

## Usage

```ts
import { createExtension } from "@chatbridge/vscode";
import provider from "./provider.js";
export const { activate, deactivate } = createExtension({
  id: "company-ai", displayName: "Company AI", provider, configDir: "company-ai",
});
```

## Options

- `id` — prefix for the view, commands and settings the manifest must
  declare (see below). Also used as the config directory name unless
  `configDir` is given.
- `displayName` — shown in progress notifications and command titles.
- `provider` — a chatbridge Provider, same shape as `createCli`'s.
- `configDir` — auth-state directory name; pass the CLI's `configDir` so one
  `auth login` serves both.
- `playwrightCliPath` — override for the `playwright/cli.js` location the
  Install Browser command spawns; only needed when Playwright is not
  resolvable from the extension's own `node_modules`.
- `timeoutMs` — per-step timeout default, in milliseconds (default
  `120000`). The user's `<id>.timeoutSec` setting overrides it.
- The idle close has no `createExtension` option: it comes from the
  provider's `idle.timeoutMs` (default 24 h), and the user's
  `<id>.idleTimeoutMinutes` setting overrides it (`0` disables). When it
  fires, the chat view shows a `closed after idle` separator and the next
  message reopens the browser as a new chat. Do not give the setting a
  `default` in your manifest: VS Code then always hands back a value, which
  overrides the provider's (the same is true of `<id>.timeoutSec`).
- `headless` — whether sessions launch a headless browser (default `true`).
  The user's `<id>.headless` setting overrides it.
- `ui` — optional vendor branding, all fields plain text (no HTML, no
  Markdown):
  - `welcome` — shown centred above the history while it is empty; `\n`
    makes a line break. Hidden once the first message arrives.
  - `banner` — image (png/svg) shown above `welcome`, same lifetime. The
    path is relative to the extension root, must not escape it, and must
    exist at activation — a missing file throws — so ship it in the
    `.vsix` (keep it out of `.vscodeignore`).
  - `footer` — one line under the composer, always visible.
  - `sendButton` — `{ background, foreground }` CSS colour strings for the
    Send button; each defaults to the VSCode button theme colour.
  - `userMessage` — `{ borderColor }`, the CSS colour of the border drawn
    around the user's own messages; defaults to the theme's focus border.

  ```ts
  createExtension({
    id: "company-ai", displayName: "Company AI", provider,
    ui: {
      welcome: "Ask Company AI anything.",
      banner: "media/banner.svg",
      footer: "Conversations are not stored by this extension.",
      sendButton: { background: "#2f6f4f", foreground: "#ffffff" },
      userMessage: { borderColor: "#2f6f4f" },
    },
  });
  ```
- `baseDir` — test-only override for the base directory of the config /
  auth-state store.

## Composer

- **Enter** sends. While a turn is in flight the message is queued instead
  and drains in order once the turn finishes; Shift+Enter inserts a newline.
- **Up** on an empty composer takes the last queued message back for
  editing; queued entries can also be removed individually.
- **`/` commands** — `/login`, `/logout`, `/new`, `/reopen`, `/help`, the
  same table the TUI uses, plus whatever the provider adds. Type `/` in the
  composer and the menu opens, filtered as you type: **↑/↓** select, **Tab**
  completes the word to `/name ` so arguments can follow, **Enter**
  completes too — unless what you typed is already the whole command, in
  which case it runs — and **Esc** closes. The `/` button in the action row
  opens the same menu unfiltered. Completing never runs the command. Only
  the bare form on its own counts when you send, so anything else (including
  `/usr/bin` style paths) is sent verbatim.
- **`+`** opens the native file picker; the chosen files become the same
  attachment chips a drop produces.
- The send button is `↑` and turns into a queue icon while a turn is in
  flight; it is disabled when there is nothing to send.
- **Drop files** onto the composer to add them as attachment chips. Hold
  **Shift** while dropping: without it VSCode keeps the drag for itself and
  opens the file in an editor instead (the same rule as dropping into a text
  editor).
- **Paste** text copied from an editor selection and it becomes a selection
  chip (`path:L2-L3`) instead of inline text; unrelated clipboard text is
  pasted as usual.

## Manifest

The vendor's `package.json` must contribute, with `<id>` replaced by the
`id` passed to `createExtension`:

- View `<id>.chat` (a webview, typically under its own `viewsContainers`
  entry)
- Commands `<id>.login`, `<id>.logout`, `<id>.newChat`, `<id>.reopen`,
  `<id>.installBrowser`, `<id>.sendSelection`, `<id>.sendFile`, `<id>.focus`
- Settings `<id>.headless` (boolean), `<id>.timeoutSec` (number) and
  `<id>.idleTimeoutMinutes` (number; `0` disables the idle close)

Activation checks exactly three things and throws a message listing every
missing ID:

- `contributes.viewsContainers.activitybar[]` contains an entry with
  `id === <id>`
- `contributes.views.<id>[]` contains an entry with `id === <id>.chat`
- `contributes.commands[]` contains all eight `<id>.*` commands above

### View title bar (recommended, never fatal)

The session actions live in VSCode's own view title bar. They are declared
by the manifest, so an extension that does not declare them simply shows an
empty title bar — activation logs one `console.warn` naming each missing
entry and carries on, and the composer's `/` menu still reaches every
action. `<id>.help` is a tenth command: it focuses the view and prints the
same listing `/help` does. It is registered whether or not the manifest
declares it; declaring it only adds it to the palette and the menu.

```json
"commands": [
  { "command": "<id>.newChat", "title": "New Chat", "category": "<Name>", "icon": "$(add)" },
  { "command": "<id>.reopen", "title": "Reopen Browser", "category": "<Name>", "icon": "$(refresh)" },
  { "command": "<id>.help", "title": "Help", "category": "<Name>" }
],
"menus": {
  "view/title": [
    { "command": "<id>.newChat", "when": "view == <id>.chat", "group": "navigation@1" },
    { "command": "<id>.reopen", "when": "view == <id>.chat", "group": "navigation@2" },
    { "command": "<id>.login", "when": "view == <id>.chat", "group": "1_auth@1" },
    { "command": "<id>.logout", "when": "view == <id>.chat", "group": "1_auth@2" },
    { "command": "<id>.installBrowser", "when": "view == <id>.chat", "group": "2_setup@1" },
    { "command": "<id>.help", "when": "view == <id>.chat", "group": "3_help@1" }
  ]
}
```

The `navigation` group renders as icons and VSCode folds them into `…` by
itself when the view is narrow; the other groups always live in `…`. Only
the two `navigation` commands need an `icon`.

A `keybindings` entry is recommended so Ctrl+R (Cmd+R on macOS) reopens the
browser while the chat view is focused; it is not validated. The webview
also handles the shortcut itself when the composer has focus.

```json
"keybindings": [
  {
    "command": "<id>.reopen",
    "key": "ctrl+r",
    "mac": "cmd+r",
    "when": "focusedView == <id>.chat"
  }
]
```

`contributes.configuration` is not validated: a missing `<id>.headless`,
`<id>.timeoutSec` or `<id>.idleTimeoutMinutes` setting simply falls back to
the `createExtension` default.

`<id>.idleTimeoutMinutes` is how long the chat may sit without a turn before
the browser is closed; the next message reopens it, with a `closed after
idle` separator marking the new conversation. Unset means the provider's own
`idle.timeoutMs`, then 24 hours. `0` disables the idle close.

"Unset" means the user has not set it *and* your manifest declares no
`default` for it: a `contributes.configuration` `default` is what VS Code
returns when the user has set nothing, so declaring one overrides the
provider's `idle.timeoutMs` for every user. The same holds for
`<id>.timeoutSec` and the `createExtension` `timeoutMs` default. Describe the
intended fallback in the setting's `description` instead, as
`examples/vscode-dummy-chat` does.

## Packaging

Bundle with esbuild as CJS, with `vscode` and `playwright` marked external.
`examples/vscode-dummy-chat` keeps `"type": "module"` in its manifest, so
its bundle is `dist/extension.cjs`, not `.js` — match that if you copy the
example's `esbuild.mjs`. Its `package` script runs
`vsce package --no-dependencies`, which is only a CI packaging smoke test
(its `workspace:*` dependencies cannot be npm-installed). A distributable
`.vsix` must ship `node_modules/playwright` so the Install Browser button
works for end users; without it the button reports "playwright is not
bundled with this extension".

### Building a distributable `.vsix` (vendor repo)

1. In the extension's `package.json`, keep only `playwright` under
   `dependencies`. `@chatbridge/vscode` (and everything it pulls in) is
   inlined by esbuild, so it belongs in `devDependencies` together with
   `esbuild` and `@vscode/vsce`.
2. Build the bundle: `bun run build` (esbuild → `dist/extension.cjs` and
   `dist/webview/`).
3. Create a plain production `node_modules` with npm, not bun:
   `rm -rf node_modules && npm install --omit=dev`. vsce discovers
   dependencies by walking npm's layout; bun's symlinked workspace tree
   makes that walk escape the folder. The result is just `playwright` and
   `playwright-core`.
4. `npx @vscode/vsce package` (no `--no-dependencies`). Expect roughly 4 MB
   and about 185 files.
5. Verify: `unzip -l *.vsix | grep node_modules/playwright/cli.js`. Then
   restore the dev tree with `bun install`.
6. Install locally with `code --install-extension <file>.vsix`. Chromium is
   never inside the `.vsix`: end users get it from the Install Browser
   button (or `npx playwright install chromium`).

`examples/vscode-dummy-chat` in the framework repo is the reference
implementation to copy into a vendor repo.

## License

MIT
