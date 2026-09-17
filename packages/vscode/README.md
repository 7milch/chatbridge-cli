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
- `baseDir` — test-only override for the base directory of the config /
  auth-state store.

## Manifest

The vendor's `package.json` must contribute, with `<id>` replaced by the
`id` passed to `createExtension`:

- View `<id>.chat` (a webview, typically under its own `viewsContainers`
  entry)
- Commands `<id>.login`, `<id>.logout`, `<id>.newChat`,
  `<id>.installBrowser`, `<id>.sendSelection`, `<id>.sendFile`, `<id>.focus`
- Settings `<id>.headless` (boolean) and `<id>.timeoutSec` (number)

Activation checks exactly three things and throws a message listing every
missing ID:

- `contributes.viewsContainers.activitybar[]` contains an entry with
  `id === <id>`
- `contributes.views.<id>[]` contains an entry with `id === <id>.chat`
- `contributes.commands[]` contains all seven `<id>.*` commands above

`contributes.configuration` is not validated: a missing `<id>.headless` or
`<id>.timeoutSec` setting simply falls back to the `createExtension`
default.

## Packaging

Bundle with esbuild as CJS, with `vscode` and `playwright` marked external.
`examples/vscode-dummy-chat` keeps `"type": "module"` in its manifest, so
its bundle is `dist/extension.cjs`, not `.js` — match that if you copy the
example's `esbuild.mjs`. Its `package` script runs
`vsce package --no-dependencies`, which is only a CI packaging smoke test.
A real vendor `.vsix` must ship `node_modules/playwright` so the Install
Browser button works for end users: drop `--no-dependencies` when
packaging for distribution, or vendors get "playwright is not bundled with
this extension" from the Install button.

`examples/vscode-dummy-chat` in the framework repo is the reference
implementation to copy into a vendor repo.

## License

MIT
