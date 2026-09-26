# VSCode extension (`@chatbridge/vscode` ≥ 0.7.0)

Copy `templates/vscode/` to `vscode/`, rename `vscodeignore` to
`.vscodeignore`, replace the placeholders: `package.json` (`id` everywhere
from `<vendor>` to the real vendor id; `<Vendor>` to the display name; set
`<publisher>`; `<latest>` dependency versions to the currently published
ones), `esbuild.mjs`, `media/icon.svg`, `src/extension.ts`. `src/extension.ts`
is `createExtension({ id: "<vendor>", displayName, provider, configDir:
"<vendor>" })` with the same `configDir` as the CLI so one `auth login`
serves both. Depend on `playwright` (not `playwright-core`): the Install
button spawns its CLI (`createExtension` also accepts `playwrightCliPath` to
point at a non-default `playwright/cli.js` location). Bundle with esbuild
(CJS, `vscode` and `playwright` external) to `dist/extension.cjs` — the
template keeps `"type": "module"` in its manifest, which is why the entry
point is `.cjs` and not `.js`. The template's `package` script runs the
full recipe below (`bun run package` → distributable `.vsix` in `dist/`);
`package:smoke` is `vsce package --no-dependencies`, a manifest check only.

Brand the view with the optional `ui` option (plain text only; the banner
path is relative to the extension root and must ship in the `.vsix` — a
missing file fails activation. The template ships a placeholder
`templates/vscode/media/banner.svg`; replace it or drop the `banner` line):

```ts
ui: {
  welcome: "Ask <Vendor> anything.",
  banner: "media/banner.svg",
  footer: "Conversations are not stored by this extension.",
  sendButton: { background: "#2f6f4f", foreground: "#ffffff" },
  userMessage: { borderColor: "#2f6f4f" },
}
```

Activation throws a message listing missing `contributes` IDs when the
manifest and `id` disagree. Vendor extensions on `@chatbridge/vscode` >=
0.8.1 must also declare `<id>.reopen` (and should bind it to Ctrl+R); a
manifest copied from an older example lacks it.

From 0.9.1 the session actions also live in the view title bar. Those
entries are recommended, not required: without them activation only logs a
warning and the title bar stays empty. The template manifest
(`templates/vscode/package.json`) already carries the `commands` icons, the
`<vendor>.help` command and the six `view/title` entries.

Verify by hand: F5 in VSCode → Log in → send → right-click a selection →
send → New Chat → Log out.

## Building the `.vsix`

The `.vsix` must ship `node_modules/playwright` (the Install Browser button
spawns its CLI; without it users see "playwright is not bundled with this
extension"). Verified recipe, run in the extension folder:

1. `package.json`: only `playwright` under `dependencies`;
   `@chatbridge/vscode`, `esbuild`, `@vscode/vsce` under `devDependencies`
   (esbuild inlines the `@chatbridge/*` packages).
2. `bun run build` → `dist/extension.cjs` + `dist/webview/`.
3. `rm -rf node_modules && npm install --omit=dev` — npm, not bun: vsce
   collects dependencies by walking npm's `node_modules` layout, and bun's
   symlinked tree makes that walk escape the folder. Leaves `playwright`
   and `playwright-core` only.
4. `npx --yes @vscode/vsce package` (vsce is a devDependency, gone after
   step 3, so npx fetches it); about 4 MB / 185 files. Check with `unzip -l *.vsix | grep node_modules/playwright/cli.js`.
5. `bun install` to restore the dev tree; `code --install-extension
   <file>.vsix` to try it. Chromium is downloaded by the Install Browser
   button on the user's machine, never packaged.
