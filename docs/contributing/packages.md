# Packages

Five packages under `packages/*`, published to npm as `@chatbridge/*` in lockstep
versions. The dependency direction is one-way: `cli → core → runtime → provider`,
and `vscode → core`. Never import in the reverse direction.

| Package | Role | Depends on (workspace) | Key exports |
|---|---|---|---|
| `provider` | Provider contract: types plus the pieces a provider author calls directly. Peer dependency `playwright-core >=1.48 <2`. Ships the `creating-provider-repo` and `upgrading-provider-repo` skills. | (none) | `Provider`, `defineProvider`, `urlConversation`, `elementToMarkdown`, `BUILTIN_COMMAND_NAMES` |
| `runtime` | Playwright browser lifecycle and auth-state persistence. Depends on `playwright` (the full package, not `playwright-core`). | `provider` | `AuthStore`, `BrowserRuntime`, `validateProviderName`, browser-executable helpers |
| `core` | Session flows shared by every UI: errors, login/one-shot entry points, the interactive `ChatSession`, idle watch, the slash-command table, attachment helpers, URL-hook expansion, `closeOrKill`. Re-exports the `provider` and `runtime` surfaces a consumer needs. | `provider`, `runtime` | `runLogin`, `runOneShot`, `ChatSession`, `IdleWatch`, `expandUrlHooks`, `closeOrKill`, error classes; subpath `./slash-commands` for `SLASH_COMMANDS` and friends |
| `cli` | The `chatbridge` command: one-shot mode and the interactive TUI. Bin `chatbridge`. TUI code lives under `src/tui/`; `@opentui/core` is loaded lazily so one-shot mode never pays for it. Bundles tree-sitter grammars in `assets/` for code-block highlighting. | `core` | `createCli`, `resolveProvider`, `loadConfig`/`configPath` |
| `vscode` | Factory for a VSCode extension: a sidebar chat view on top of `ChatSession`. | `core` | `createExtension`, `SessionController`, the webview protocol types, `resolveUiConfig` |

See `packages/*/src/index.ts` for the full export list of each package; the
table above covers only the exports called out as load-bearing in the specs.

## What each export means

The `provider` package's types and helpers are the provider contract. Read
[`../providers/contract.md`](../providers/contract.md) for what a `Provider`
must implement, and
[`../providers/extension-points/README.md`](../providers/extension-points/README.md)
for the optional extension points (`streaming`, `conversation`, `detectBlock`,
`commands`/`urlHooks`, `open`/`browser`/`idle` defaults). This page does not
repeat that material.

## Examples

- `examples/dummy-chat` (`@chatbridge/example-dummy-chat`) — a chat server plus
  a reference `Provider` that exercises every extension point. Other packages'
  tests depend on it as a devDependency.
- `examples/vscode-dummy-chat` (`chatbridge-example-vscode-dummy-chat`) — a
  reference VSCode extension and manifest built with `@chatbridge/vscode`
  against the dummy chat. Its `package.json` `contributes` block is the
  minimum a vendor manifest must carry.

Both are private (`"private": true`) and never published.

## Working across packages

Tests import cross-package code from each package's `dist/`, not from `src/`.
After editing a package other than the one you're testing, run:

```bash
bun run build
```

first, or the consuming package's tests will see stale output.
