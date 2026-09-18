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
  same table the TUI uses. Only the bare form on its own counts, so
  anything else (including `/usr/bin` style paths) is sent verbatim.
- **Drop files** onto the composer to add them as attachment chips.
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
- Settings `<id>.headless` (boolean) and `<id>.timeoutSec` (number)

Activation checks exactly three things and throws a message listing every
missing ID:

- `contributes.viewsContainers.activitybar[]` contains an entry with
  `id === <id>`
- `contributes.views.<id>[]` contains an entry with `id === <id>.chat`
- `contributes.commands[]` contains all eight `<id>.*` commands above

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

`contributes.configuration` is not validated: a missing `<id>.headless` or
`<id>.timeoutSec` setting simply falls back to the `createExtension`
default.

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
