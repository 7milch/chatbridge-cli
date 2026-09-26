# defineProvider, createCli and createExtension

This page is the vendor side of shipping a provider. It covers what `defineProvider` checks, the options of `createCli` and `createExtension`, the `contributes` block a VSCode extension must carry, how to package a `.vsix`, and where the per-version upgrade steps are.

The required `Provider` members are in [contract.md](contract.md). The optional ones are in [extension-points/](extension-points/README.md). What your users see and set (flags, `config.json` keys, VSCode settings) is in [../users/cli.md](../users/cli.md), [../users/configuration.md](../users/configuration.md) and [../users/vscode.md](../users/vscode.md).

## `defineProvider` and what it checks

```ts
import { defineProvider } from "@chatbridge/provider";

export default defineProvider({
  name: "acme-ai",
  chatUrl: "https://chat.example.com/",
  // navigateToLogin, isLoggedIn, startNewChat, sendMessage, waitForResponse
});
```

`defineProvider(provider)` returns its argument unchanged. It exists for type inference and to fail fast: it runs when your provider module is imported, so a bad command list or URL hook breaks at startup, not in the middle of a session. `@chatbridge/core` re-exports it.

It runs these checks in this order. Each failure throws a plain `Error` with the message shown.

| # | Checks | Message |
|---|---|---|
| 1 | Each `commands[].name` matches `/^[a-z]+$/` | `Provider command name "<n>" must match /^[a-z]+$/.` |
| 2 | No command uses a built-in name: `login`, `logout`, `new`, `reopen`, `copy`, `help` | `Provider command "/<n>" collides with a built-in command.` |
| 3 | No command name appears twice | `Provider command "/<n>" is defined twice.` |
| 4 | No `urlHooks[].match` RegExp has the `g` or `y` flag | `URL hook RegExp <re> must not use the g or y flag (it makes .test stateful).` |
| 5 | `browser.reducedMotion`, if set, is `"reduce"` or `"no-preference"` | `Provider browser.reducedMotion must be "reduce" or "no-preference", got <value>.` |
| 6 | `idle.timeoutMs`, if set, is a finite number `>= 0` | `Provider idle.timeoutMs must be a non-negative finite number, got <value>.` |
| 7 | `responseFormat`, if set, is `"markdown"` or `"text"` | `Provider responseFormat must be "markdown" or "text", got <value>.` |
| 8 | `streaming`, if set, has a `responseText` function | `Provider streaming.responseText must be a function.` |
| 9 | `streaming.pollIntervalMs`, if set, is a finite number `> 0` | `Provider streaming.pollIntervalMs must be a finite number greater than 0, got <value>.` |
| 10 | `conversation`, if set, has `handle` and `open` functions | `Provider conversation.handle must be a function.` (or `conversation.open`) |

Checks 1 to 3 run per command, in list order, so the first bad entry decides the message.

`defineProvider` does not check `name`, `chatUrl`, the five required methods or `open`. Other layers do:

| What | Checked by | When |
|---|---|---|
| `name`, `chatUrl`, the five methods | The CLI's provider loader | When a provider is loaded by `--provider` or `defaultProvider`. A provider pinned through `createCli({ provider })` skips this check. |
| `name` is usable as a file name | The auth store | When the store is created, before any browser starts. It must be 1 to 64 characters of lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit. |

Both failures exit 5 in the CLI. See [contract.md](contract.md) for what each member must guarantee.

## Shipping a CLI (`createCli`)

`createCli(options)` from `@chatbridge/cli` builds the whole command line: flags, `auth` subcommands, one-shot and interactive modes. The template's `src/bin.ts` has this shape:

```ts
#!/usr/bin/env bun
import { createCli } from "@chatbridge/cli";
import provider from "./provider.js";

process.exitCode = await createCli({
  name: "acme-ai",
  version: "1.0.0",
  provider,
}).run(process.argv);
```

It returns `{ run }`. `run(argv)` takes the full `process.argv` and resolves to the exit code.

| Option | Type | Default | Notes |
|---|---|---|---|
| `name` | `string` | required | Shown in help and error messages. Also the default `configDir`. |
| `version` | `string` | none | Printed by `--version` / `-V` as `<name> v<version>` (just `<name>` when unset). Also shown in the default banner. |
| `provider` | `Provider` | none | Pins the provider. `--provider` is then rejected, and `defaultProvider` in `config.json` is ignored. The `shell` section of `config.json` still applies. |
| `configDir` | `string` | `name` | Directory name under `~/.config`. Holds `config.json` and the auth state. |
| `banner` | `string[]` or `BannerOptions` | name, version and a one-line hint | Interactive startup banner, shown centred until the first message. |
| `spinner` | `SpinnerOptions` | see below | Busy status shown while a turn is in flight. |
| `shell` | `Partial<{ leadIn, autoSend }>` | `leadIn: "Please check the execution result."`, `autoSend: true` | Vendor defaults for `!` shell mode. The user's `config.json` overrides them key by key. |

### `banner`

A plain `string[]` shows every row dim. The object form colours it:

| Field | Type | Default | Notes |
|---|---|---|---|
| `lines` | `string[]` | required | One string per row. Used verbatim. |
| `colors` | `(number \| string)[]` | none (all dim) | ANSI palette index 0 to 255, or `"#rrggbb"`. |
| `mode` | `"per-line"` \| `"per-char"` \| `"gradient"` | `"per-line"` | `per-line`: row `r` takes `colors[r % n]`. `per-char`: cell `(r, c)` takes `colors[(r + c) % n]`, a diagonal flow meant for ASCII art. `gradient`: a linear mix of the colours. |
| `direction` | `"vertical"` \| `"horizontal"` \| `"diagonal"` | `"vertical"` | Read only when `mode` is `"gradient"`. |

`createCli` validates the banner when it is called, so a mistake fails at startup. It throws a plain `Error`:

| Rule | Message |
|---|---|
| `direction` is one of the three values | `banner.direction: expected "vertical" \| "horizontal" \| "diagonal", got <value>` |
| `gradient` has at least two colours | `banner.colors: gradient needs at least two colours` |
| `per-line` / `per-char` have at least one colour | `banner.colors: <mode> needs at least one colour` |
| A string colour is `#rrggbb` | `banner.colors: not a "#rrggbb" colour: <value>` |
| `gradient` takes hex colours only | `banner.colors: gradient takes hex colours only, got <value>` |

Nothing is checked when `banner` is a plain array or has no `colors`. Numeric colours are not range-checked.

### `spinner`

| Field | Type | Default | Notes |
|---|---|---|---|
| `frames` | `string[]` | `["●○○", "○●○", "○○●", "○●○"]` | Cycled in order. Every frame must have the same display width, or the status row shifts. |
| `intervalMs` | `number` | `120` | Milliseconds between frames. Must be positive. |
| `label` | `string` or `string[]` | `"Thinking…"` | Text after the frame. An array picks one entry at random per turn. |
| `frameColor` | `number` or `string` | terminal foreground | ANSI index or `"#rrggbb"`. |
| `labelColor` | `number` or `string` | terminal foreground | ANSI index or `"#rrggbb"`. |

Unset fields keep their default. Nothing in `spinner` is validated.

## Shipping a VSCode extension (`createExtension`)

`createExtension(options)` from `@chatbridge/vscode` turns a provider into a sidebar chat view. The template's `vscode/src/extension.ts`:

```ts
import { createExtension } from "@chatbridge/vscode";
import provider from "../../src/provider.js";

export const { activate, deactivate } = createExtension({
  id: "acme-ai",
  displayName: "Acme AI",
  provider,
  configDir: "acme-ai",
});
```

It returns `{ activate, deactivate }`. `activate(context)` checks the manifest, registers the view and the commands, and resolves to `{ controller, handlers, bridge }` (the framework's own E2E tests drive these). `deactivate()` closes the browser.

| Option | Type | Default | Notes |
|---|---|---|---|
| `id` | `string` | required | Prefix of every contributed id: view, commands, settings. Also the default `configDir`. |
| `displayName` | `string` | required | View title, notifications, the Output channel name. |
| `provider` | `Provider` | required | Always pinned. The extension never loads a provider dynamically. |
| `configDir` | `string` | `id` | Directory name under `~/.config`. Pass the CLI's `configDir` so one `auth login` serves both. |
| `timeoutMs` | `number` | `120000` | Per-step timeout. A `<id>.timeoutSec` value the user set overrides it. |
| `headless` | `boolean` | `true` | Whether sessions launch a headless browser. A `<id>.headless` value the user set overrides it. |
| `playwrightCliPath` | `string` | `<extension>/node_modules/playwright/cli.js` | What the Install Browser command runs. Set it only when Playwright is not in the extension's own `node_modules`. |
| `ui` | `ExtensionUiOptions` | none | Vendor branding; see below. |
| `baseDir` | `string` | `~/.config` | Test-only override for the directory that holds `<configDir>/`. Do not set it in a shipped extension. |

There is no idle option. The idle close comes from the provider's `idle.timeoutMs` (24 hours when unset), and the user's `<id>.idleTimeoutMinutes` setting overrides it.

### `ui`

All text is plain: no HTML, no Markdown.

| Field | Type | Notes |
|---|---|---|
| `welcome` | `string` | Centred in the empty history until the first message. `\n` breaks the line. |
| `banner` | `string` | A png or svg path relative to the extension root, shown above `welcome`. Ship it in the `.vsix`. |
| `footer` | `string` | One line under the composer, always visible. |
| `sendButton` | `{ background?, foreground? }` | CSS colours for the Send button. Default: the VSCode button theme colours. |
| `userMessage` | `{ borderColor? }` | CSS colour of the border around the user's own messages. Default: the theme's focus border. |

`banner` is validated at activation. Activation throws:

```
<path>: banner path must be relative to the extension root
<path>: banner image not found (looked for <absolute path>)
```

The first fires for an empty, absolute or escaping (`..`) path.

### The manifest

`createExtension` registers commands and a view, but VSCode only shows what the extension's `package.json` declares. Scaffold from `packages/provider/skills/creating-provider-repo/templates/vscode/package.json`. Its `contributes` block, verbatim (`<vendor>` is your `id`, `<Vendor>` your display name):

```json
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "<vendor>",
          "title": "<Vendor>",
          "icon": "media/icon.svg"
        }
      ]
    },
    "views": {
      "<vendor>": [
        {
          "id": "<vendor>.chat",
          "name": "Chat",
          "type": "webview"
        }
      ]
    },
    "commands": [
      {
        "command": "<vendor>.login",
        "title": "Log in",
        "category": "<Vendor>"
      },
      {
        "command": "<vendor>.logout",
        "title": "Log out",
        "category": "<Vendor>"
      },
      {
        "command": "<vendor>.newChat",
        "title": "New Chat",
        "category": "<Vendor>",
        "icon": "$(add)"
      },
      {
        "command": "<vendor>.reopen",
        "title": "Reopen Browser",
        "category": "<Vendor>",
        "icon": "$(refresh)"
      },
      {
        "command": "<vendor>.installBrowser",
        "title": "Install Browser",
        "category": "<Vendor>"
      },
      {
        "command": "<vendor>.sendSelection",
        "title": "Send Selection to <Vendor>",
        "category": "<Vendor>"
      },
      {
        "command": "<vendor>.sendFile",
        "title": "Send File to <Vendor>",
        "category": "<Vendor>"
      },
      {
        "command": "<vendor>.focus",
        "title": "Focus Chat",
        "category": "<Vendor>"
      },
      {
        "command": "<vendor>.help",
        "title": "Help",
        "category": "<Vendor>"
      }
    ],
    "keybindings": [
      {
        "command": "<vendor>.reopen",
        "key": "ctrl+r",
        "mac": "cmd+r",
        "when": "focusedView == <vendor>.chat"
      }
    ],
    "menus": {
      "view/title": [
        {
          "command": "<vendor>.newChat",
          "when": "view == <vendor>.chat",
          "group": "navigation@1"
        },
        {
          "command": "<vendor>.reopen",
          "when": "view == <vendor>.chat",
          "group": "navigation@2"
        },
        {
          "command": "<vendor>.login",
          "when": "view == <vendor>.chat",
          "group": "1_auth@1"
        },
        {
          "command": "<vendor>.logout",
          "when": "view == <vendor>.chat",
          "group": "1_auth@2"
        },
        {
          "command": "<vendor>.installBrowser",
          "when": "view == <vendor>.chat",
          "group": "2_setup@1"
        },
        {
          "command": "<vendor>.help",
          "when": "view == <vendor>.chat",
          "group": "3_help@1"
        }
      ],
      "editor/context": [
        {
          "command": "<vendor>.sendSelection",
          "group": "chatbridge"
        }
      ],
      "explorer/context": [
        {
          "command": "<vendor>.sendFile",
          "when": "!explorerResourceIsFolder",
          "group": "chatbridge"
        }
      ]
    },
    "configuration": {
      "title": "<Vendor>",
      "properties": {
        "<vendor>.headless": {
          "type": "boolean",
          "default": true,
          "description": "Run the browser without a window. Unset: the extension's own value, normally true."
        },
        "<vendor>.timeoutSec": {
          "type": "number",
          "description": "Seconds to wait for each browser step. Unset: the extension's own value, normally 120."
        },
        "<vendor>.idleTimeoutMinutes": {
          "type": "number",
          "description": "Minutes of inactivity before the browser is closed; 0 disables. Unset: the provider's own value, normally 1440."
        }
      }
    }
  }
```

What each part does, and what happens without it:

| Part | Entries | Checked at activation |
|---|---|---|
| `viewsContainers.activitybar` | container `<id>` | Required |
| `views.<id>` | webview `<id>.chat` | Required |
| `commands` | `<id>.login`, `<id>.logout`, `<id>.newChat`, `<id>.reopen`, `<id>.installBrowser`, `<id>.sendSelection`, `<id>.sendFile`, `<id>.focus` | Required |
| `commands` | `<id>.help` | Recommended |
| `commands[].icon` | `$(add)` on `<id>.newChat`, `$(refresh)` on `<id>.reopen` | Recommended |
| `menus.view/title` | `newChat` `navigation@1`, `reopen` `navigation@2`, `login` `1_auth@1`, `logout` `1_auth@2`, `installBrowser` `2_setup@1`, `help` `3_help@1`, each with `when: "view == <id>.chat"` | Recommended |
| `keybindings` | `ctrl+r` / `cmd+r` on `<id>.reopen` when `focusedView == <id>.chat` | Not checked |
| `menus.editor/context` | `<id>.sendSelection` | Not checked |
| `menus.explorer/context` | `<id>.sendFile` with `when: "!explorerResourceIsFolder"` | Not checked |
| `configuration` | `<id>.headless`, `<id>.timeoutSec`, `<id>.idleTimeoutMinutes` | Not checked |

**Required.** A missing entry stops activation. The error lists every missing id:

```
<displayName>: package.json lacks contributes entries for "<id>": commands: <id>.focus, views.<id>: <id>.chat
```

**Recommended.** A missing entry logs one `console.warn` and activation carries on. The view title bar stays empty, and the composer's `/` menu still reaches every action. `<id>.help` is registered whether or not it is declared; declaring it adds it to the palette and the title bar. Only the two `navigation` commands render as icons, so only they need an `icon`. The check matches `view/title` entries by their `when`; it does not check `group`.

**Not checked.** The keybinding and the two context menus only add shortcuts. The webview also handles Ctrl+R itself when the composer has focus.

**Settings.** The extension reads only values the user set, at folder, workspace or global scope. A `default` declared in the manifest is ignored at runtime, so `<id>.headless` falls back to your `headless` option, `<id>.timeoutSec` to your `timeoutMs` option, and `<id>.idleTimeoutMinutes` to the provider's `idle.timeoutMs`. Declare a `default` only where it helps the Settings UI, as the template does for `<id>.headless`, and keep it in step with the option you pass. State the real fallback in each `description`.

The user-facing view of these commands and settings is in [../users/vscode.md](../users/vscode.md).

### Packaging a `.vsix`

The template's `esbuild.mjs` bundles `src/extension.ts` as CommonJS to `dist/extension.cjs`, with `vscode` and `playwright` external, and copies the webview assets from `@chatbridge/vscode` to `dist/webview/`. The manifest keeps `"type": "module"`, so the bundle must end in `.cjs`.

A distributable `.vsix` must carry `node_modules/playwright`, or the Install Browser command reports `playwright is not bundled with this extension`. Chromium is never inside the `.vsix`; users get it from Install Browser or `npx playwright install chromium`.

1. In the extension's `package.json`, keep only `playwright` in `dependencies`. `@chatbridge/vscode` is inlined by esbuild, so it goes in `devDependencies` with `esbuild` and `@vscode/vsce`.
2. Build the bundle:

   ```sh
   bun run build
   ```

3. Make a plain production `node_modules` with npm, not bun. vsce walks npm's layout; bun's symlinked tree makes it escape the folder.

   ```sh
   rm -rf node_modules && npm install --omit=dev
   ```

4. Package:

   ```sh
   npx --yes @vscode/vsce package
   ```

5. Check that Playwright is inside, then restore the dev tree:

   ```sh
   unzip -l *.vsix | grep node_modules/playwright/cli.js
   bun install
   ```

6. Install it locally:

   ```sh
   code --install-extension <file>.vsix
   ```

The template's `package` script runs steps 2 to 5 in one go, so `bun run package` in the extension folder produces a distributable `.vsix` under `dist/`. `package:smoke` runs `vsce package --no-dependencies` alone; that is a quick manifest check and its `.vsix` has no Playwright, so never hand it to users.

## Upgrading between versions

Every released version that changed anything a vendor repository sees has an entry in `packages/provider/skills/upgrading-provider-repo/upgrade-guide.md`. Each entry lists required steps, optional features and VSCode manifest changes, with a verify command. Apply the entries above your old version, oldest first. Release notes are not a substitute.

Two changes from 0.10 are worth knowing even if you never read that file:

- `copy` is a built-in command name. A provider command named `copy` is rejected by `defineProvider` (check 2 above).
- For code that embeds `@chatbridge/core` directly: `ChatSessionOptions.onIdleExpired` receives the in-flight close, `(closing: Promise<void>) => void`. `closing` settles once the idle close has finished and never rejects. A UI that tears itself down should await it, capped at its own teardown budget, so a process exit does not race the auth-state save.
