# Hardening + Publishability — Design

Date: 2026-09-07
Status: Approved (brainstorming session)
Issue: https://github.com/7milch/chatbridge-cli/issues/3

## Goal

Close the follow-ups deferred from milestone 1 and make the four packages
publishable to npm, so that milestone 4 (public providers repository) and
milestone 5 (company adoption) can consume released packages instead of a
git checkout.

Roadmap bullets covered:

1. `playwright-core` becomes a peerDependency of `@chatbridge/provider`
2. Config-file `defaultProvider` fallback
3. Tests for exit codes 3 / 4 / 5
4. Provider `name` sanitized before use as a file name
5. Pinned provider rejects an explicit `--provider`; unknown flags print usage
6. Widen Playwright `TimeoutError` mapping beyond `waitForResponse`; carry `cause`
7. Confirm or rename the `@chatbridge` npm scope; first publish

## Decisions (from brainstorming)

- **Publish built JS + `.d.ts`**, not TypeScript sources. Consumers may use
  Node or Bun.
- **CLI runs on Node and Bun.** `bin` shebang is `#!/usr/bin/env node`;
  `engines.node >= 20`. No Bun-specific APIs in `cli`, `core`, `runtime`,
  `provider`. (`examples/dummy-chat` stays private and may keep `Bun.serve`.)
- **Publishing runs in GitHub Actions** on a `v*` tag via npm Trusted
  Publishing (OIDC, no long-lived token).
- **Scope is unconfirmed.** The user checks `@chatbridge` on npm by hand. If it
  is unavailable, all packages move to the `@chatbridge-cli` scope and the CLI
  package becomes `chatbridge-cli` (see "Scope fallback").
- **License: MIT.**

## 1. Packaging and build

### Build output

Every package under `packages/` emits JS and declarations:

- `tsconfig.json` per package: `emitDeclarationOnly: false`, `declaration: true`,
  `outDir: dist`, `rootDir: src`, tests excluded. `tsc --build` at the root
  produces `dist/` for all four packages in dependency order.
- Root scripts: `build` is `tsc --build` (emits `dist/`, gitignored);
  `typecheck` is removed since with `composite` projects it is the same
  command. `test` is `bun run build && bun test`; `check` is
  `bun run lint && bun run test`.
- Node ESM needs explicit file extensions in relative imports, so all packages
  switch to `module: "NodeNext"` / `moduleResolution: "NodeNext"` and relative
  imports use the `.js` suffix (`./auth-store.js`). Bun resolves these to the
  `.ts` sources during tests.
- Tests run against `src/*.ts` under `bun test`, but cross-package imports
  (`@chatbridge/core` etc.) resolve through `exports` to `dist/`, so the root
  `test` script is `tsc --build && bun test`. `tsc --build` is incremental.

### Package manifests

`exports` always points at the build output (verified: `bun pm pack` 1.4.0
does not apply `publishConfig` overrides for `exports`/`bin`, so a dev/publish
split is not possible without custom tooling):

```json
{
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" }
}
```

The CLI package has `"bin": { "chatbridge": "./dist/bin.js" }`. `bin.ts` keeps
the top-level `await` (ESM) and switches its shebang to `#!/usr/bin/env node`.
`examples/dummy-chat` stays private and keeps exporting its `.ts` files.

Each published `package.json` gains: `description`, `license: "MIT"`,
`repository` (`git+https://github.com/7milch/chatbridge-cli.git`, with
`directory`), `engines: { "node": ">=20" }`, `keywords`.

### Published packages and versions

| Package | Published | Version |
|---|---|---|
| `@chatbridge/provider` | yes | 0.1.0 |
| `@chatbridge/runtime` | yes | 0.1.0 |
| `@chatbridge/core` | yes | 0.1.0 |
| `@chatbridge/cli` (CLI; unscoped `chatbridge` was rejected by npm as too similar to `chat-bridge`) | yes | 0.1.0 |
| `@chatbridge/example-dummy-chat` | no (`private: true`) | — |

Versions are kept identical across the four packages (lockstep).

### Playwright dependencies

- `@chatbridge/provider`: `peerDependencies: { "playwright-core": ">=1.48 <2" }`;
  `devDependencies: { "playwright-core": "1.63.0" }` (same as runtime).
- `@chatbridge/runtime`: `dependencies: { "playwright": "1.63.0" }` (unchanged).
  `playwright` bundles `playwright-core`, so a provider's `Page` type and the
  runtime's `Page` type are the same declaration at the same version.
- `examples/dummy-chat` adds `playwright-core` as a devDependency to satisfy the
  peer.

### License

Add `LICENSE` (MIT, copyright holder: the repository owner) at the repository
root. Replace the README's `TBD` license section.

### Scope fallback

If `@chatbridge` cannot be obtained, rename before the first publish:

| From | To |
|---|---|
| `@chatbridge/provider` | `@chatbridge-cli/provider` |
| `@chatbridge/runtime` | `@chatbridge-cli/runtime` |
| `@chatbridge/core` | `@chatbridge-cli/core` |
| `@chatbridge/cli` | `@chatbridge-cli/cli` |

Places that reference package names (rename checklist): every `package.json`
(`name`, `dependencies`, `devDependencies`, `peerDependencies`), all `import`
specifiers under `packages/` and `examples/`, `README.md`, `CLAUDE.md`,
`docs/ROADMAP.md`, `docs/PUBLISHING.md`, `.github/workflows/*.yml`, the
`createCli({ name })` default in `bin.ts`. The rename is a single commit, done
by search-and-replace, verified by `bun install && bun run check`.

## 2. CLI behaviour

### Config file

Path: `<baseDir>/<configDir>/config.json`, where `baseDir` defaults to
`~/.config` (same base as `AuthStore`). Schema:

```json
{ "defaultProvider": "<npm-package | ./relative/path | /absolute/path>" }
```

Implemented in `packages/cli/src/config.ts`:

- `loadConfig({ configDir, baseDir }): Promise<CliConfig>`.
- Missing file → `{}`.
- Unparseable JSON or a non-object → `ChatBridgeError("INVALID_CONFIG", ...)`
  naming the file path; the parse error is attached as `cause`.
- Unknown keys are ignored (forward compatibility).
- A relative `defaultProvider` (`./` or `../`) is resolved against the config
  file's directory, not the process cwd. The resolved absolute path is what
  gets passed to `resolveProvider`.

### Provider resolution order

1. `createCli({ provider })` pinned provider (see below).
2. `--provider` flag.
3. `defaultProvider` from the config file.
4. Otherwise `ProviderLoadError` (exit 5). Message names both options:
   "Pass --provider <npm-package|./path> or set defaultProvider in
   <config path>."

### Pinned provider

When `createCli` was given `provider`:

- `--provider` present → `ChatBridgeError("INVALID_ARGUMENT", "<name> has a
  fixed provider; --provider is not accepted")`, exit 1. Checked before any
  browser launch or config read.
- The config file is not read at all.
- `--help` already omits `--provider` for pinned CLIs (unchanged).

### Unknown flags

`parseArgs` throws `ERR_PARSE_ARGS_UNKNOWN_OPTION` (and
`ERR_PARSE_ARGS_INVALID_OPTION_VALUE` for a missing value). `run` catches
errors whose `code` starts with `ERR_PARSE_ARGS_`, prints
`<name>: <message>` followed by the usage text to stderr, and returns 1.

### Exit codes

`EXIT_CODES` becomes the single source of truth:

| code | exit |
|---|---|
| `INVALID_ARGUMENT` | 1 |
| `INVALID_CONFIG` | 1 |
| `AUTH_REQUIRED` | 2 |
| `AUTH_EXPIRED` | 3 |
| `RESPONSE_TIMEOUT` | 4 |
| `PROVIDER_LOAD` | 5 |
| `INVALID_PROVIDER` | 5 |

An unknown `ChatBridgeError.code` still falls back to 1.

## 3. Error handling

### Provider name validation

`AuthStore`'s constructor validates `providerName` against
`^[a-z0-9][a-z0-9._-]{0,63}$` and throws
`InvalidProviderError` (`code: "INVALID_PROVIDER"`, a direct `ChatBridgeError`
subclass mapped to exit 5 like `PROVIDER_LOAD`) when it does not match. Names are rejected, never
rewritten, so the auth file location stays predictable for the user.

Because both the pinned path and `resolveProvider` construct an `AuthStore`
before touching the browser, this one check covers every entry point.
`resolveProvider`'s `isProvider` guard stays structural (string / function
checks); the format rule lives only in `AuthStore`.

Dependency direction matters here: `AuthStore` is in `@chatbridge/runtime`,
which must not import `@chatbridge/core`, where the error classes live. So:

- `runtime` exports `validateProviderName(name: string): void`, throwing a
  plain `RangeError` on mismatch. `AuthStore`'s constructor calls it, so
  direct runtime users are protected too.
- `core` adds `InvalidProviderError` and a factory
  `createAuthStore(opts): AuthStore` that calls `validateProviderName`,
  converts the `RangeError` into `InvalidProviderError`, then constructs the
  store. `cli` uses `createAuthStore` instead of `new AuthStore` in both the
  `auth` and one-shot paths.

### Timeout mapping

`runOneShot` wraps each provider call in `step(name, fn)`:

```ts
async function step<T>(name: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ResponseTimeoutError(
        `Timed out during ${name} after ${timeoutMs} ms.`, { cause: err });
    }
    throw err;
  }
}
```

Steps: `goto`, `isLoggedIn`, `startNewChat`, `sendMessage`, `waitForResponse`.
`runLogin` wraps `navigateToLogin` the same way; its polling loop has no
deadline (unchanged).

### `cause`

`ChatBridgeError`'s constructor gains `options?: { cause?: unknown }` and
passes it to `super(message, options)`. Subclasses forward it. Populated by:
`ResponseTimeoutError` (Playwright error), `ProviderLoadError` (import
failure), `INVALID_CONFIG` (JSON parse error).

The CLI prints only `message` by default. With `CHATBRIDGE_DEBUG=1` it also
prints `cause`'s stack (or `String(cause)`) to stderr. Auth-state content is
never part of any error message or cause.

## 4. Tests

All new behaviour is developed test-first. Browser-free tests use plain
`bun test`; browser tests are `*.e2e.test.ts` as today.

### Exit code 3 — auth expired (E2E)

`startDummyChat` returns `invalidateSessions()`. After it is called the server
treats `session=ok` as absent (redirects `/chat` to `/login`). Test: prepare
auth → invalidate → `-p hello` → expect 3.

### Exit code 4 — response timeout (E2E)

`startDummyChat` returns `setReplyDelayMs(ms)`; the chat page reads the delay
from a `<meta name="reply-delay">` value rendered by the server. Test: prepare
auth → `setReplyDelayMs(5000)` → `-p hello --timeout 1` → expect 4 within ~2 s.

### Exit code 5 — provider load (unit)

Three cases through `createCli` with a temp `baseDir`: non-existent path;
module whose default export lacks the required methods; module whose `name`
fails validation (e.g. `"../escape"`). Each expects 5 and no browser launch.

### Other unit tests

- `config.ts`: missing file, valid file, invalid JSON (expect `INVALID_CONFIG`
  and a `cause`), relative path resolved against the config directory.
- Pinned CLI + `--provider` → 1; unknown flag → 1 with usage on stderr.
- `validateProviderName`: accepted and rejected samples.
- `step` mapping: stub provider whose `sendMessage` throws an error with
  `name = "TimeoutError"`; expect `ResponseTimeoutError` whose message names
  `sendMessage` and whose `cause` is the original.
- `ChatBridgeError` keeps `cause`.

### Node smoke test (CI)

After `bun run build`, CI runs `node packages/cli/dist/bin.js --help` and
expects exit 0. The dummy-chat E2E is not run under Node (its server uses
`Bun.serve`).

## 5. Publish workflow

`.github/workflows/publish.yml`:

- Trigger: push of tag `v*`.
- `permissions: { id-token: write, contents: read }`.
- Steps: checkout → setup-bun 1.4.0 → `bun install --frozen-lockfile` →
  Playwright chromium install → `bun run check` → `bun run build` → verify
  every publishable `package.json` `version` equals the tag without `v` (fail
  otherwise) → publish in dependency order: provider, runtime, core, cli.
- Publish command: `bun pm pack` in each package directory (verified: it
  rewrites `workspace:*` to the concrete version), then
  `npm publish <tarball> --provenance --access public` using `actions/setup-node`
  with `registry-url` so npm's OIDC Trusted Publishing applies. Bun 1.4.0's
  `bun publish` has no documented OIDC support, so npm does the upload.

`docs/PUBLISHING.md` (English) documents: obtaining the scope, registering a
Trusted Publisher for each of the four packages (repository, workflow file
name), cutting a release (bump versions in lockstep, tag `vX.Y.Z`, push),
and the scope-fallback rename checklist. The first publish (`v0.1.0`) is
triggered by the user after the npm-side setup is done; the code work in this
milestone ends with the workflow merged and packing verified: PR CI runs
`scripts/pack-all.sh`, which packs all four packages and checks tarball
contents and `workspace:` rewriting — a stronger check than a dry run.

## Out of scope

- Interactive TUI, streaming, conversation continuation (milestone 3).
- Running the dummy-chat E2E under Node.
- Changesets or automated version bumping; versions are bumped by hand.
- Any company-specific configuration.
