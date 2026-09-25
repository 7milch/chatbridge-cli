# Testing

## `bun run check`

Required before every commit and PR. Defined in the root `package.json`:

```bash
bun run check
```

It runs, in order: `biome check .` (lint), `tsc --build` plus the VSCode
webview build (`build:webview`), then `bun test`. See the `scripts` block in
[`../../package.json`](../../package.json) for the exact composition.

Run one package's tests on their own:

```bash
bun test packages/<name>
```

## TDD

House rule from [`../../CLAUDE.md`](../../CLAUDE.md): write the failing test
first, then the implementation. `bun run check` gates every commit, so a
red suite never lands.

## E2E tests

Files named `*.e2e.test.ts` drive real Chromium under Bun. They live in
`runtime`, `core`, and `cli`, plus a template copy under
`packages/provider/skills/creating-provider-repo/templates/`. They run as
part of `bun test` (and so as part of `bun run check`), not as a separate
step, but they need Chromium installed first:

```bash
./packages/runtime/node_modules/.bin/playwright install chromium
```

Run it once per machine (or after a `playwright` version bump).

## The VSCode E2E suite

```bash
bun run e2e:vscode
```

This runs the real-VS-Code suite under `examples/vscode-dummy-chat`
(`bun run build` then that example's own `e2e` script, which launches
`@vscode/test-electron`). It is **not** part of `bun run check` and does not
run on every push: it needs a display, is slow to set up, and only matters
when extension-facing code changed.

## CI

Two jobs in [`../../.github/workflows/ci.yml`](../../.github/workflows/ci.yml):

- **`check`** runs on every push and PR (docs-only diffs skip the heavy
  steps but still report success, since the job is required by the branch
  ruleset). When code changed it installs Chromium, runs `bun run check`,
  smoke-tests the built CLI (`node packages/cli/dist/bin.js --help`), and
  packs all five packages.
- **`vscode-e2e`** runs `xvfb-run -a bun run e2e:vscode` only when the diff
  touches `packages/vscode/`, `packages/core/`, `packages/runtime/`,
  `examples/vscode-dummy-chat/`, `examples/dummy-chat/`, or the CI workflow
  file itself. It then packages the example extension with `vsce`.

## Running things by hand

The interactive TUI (`chatbridge` with no `-p`) needs Bun >= 1.3 or
Node >= 26.4 to run directly; `@opentui/core` loads lazily so one-shot mode
has no such requirement.
