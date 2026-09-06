# Hardening + Publishability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the milestone-1 follow-ups (peer deps, config fallback, exit-code tests, name validation, flag handling, timeout mapping) and make the four packages publishable to npm from GitHub Actions.

**Architecture:** Packages keep the one-way dependency chain `cli → core → runtime → provider`, but now emit JS + `.d.ts` into `dist/` with NodeNext resolution so both Node ≥ 20 and Bun can consume them. `exports` always targets `dist/`, so tests build first. Error classes gain `cause`; the CLI gains a config file, stricter argument handling, and a complete exit-code table. A tag-triggered workflow packs with `bun pm pack` and uploads with `npm publish --provenance` (Trusted Publishing).

**Tech Stack:** TypeScript (tsc --build, NodeNext), Bun 1.4.0 (workspaces, test runner), Playwright 1.63.0, Biome, GitHub Actions, npm Trusted Publishing.

**Spec:** `docs/superpowers/specs/2026-09-07-hardening-publishability-design.md`

## Global Constraints

- All committed documents, comments, and commit messages in English. Issue comments in English.
- Dependency direction is one-way: `cli → core → runtime → provider`. Never import in reverse.
- Auth-state files: mode `600`, parent directory mode `700`, content never logged and never part of an error message or `cause`.
- One-shot stdout carries the AI response body only; progress goes to stderr and only when stderr is a TTY.
- Package names: `@chatbridge/provider`, `@chatbridge/runtime`, `@chatbridge/core`, `chatbridge`. All at version `0.1.0` (lockstep). `@chatbridge/example-dummy-chat` stays `private: true`.
- `engines.node` is `>=20`. No Bun-specific APIs in `packages/*` (allowed in `examples/dummy-chat` and in `*.test.ts`).
- Relative imports inside `packages/*` use the `.js` suffix (NodeNext).
- Provider name rule: `^[a-z0-9][a-z0-9._-]{0,63}$`. Invalid names are rejected, never rewritten.
- Exit codes: `INVALID_ARGUMENT` 1, `INVALID_CONFIG` 1, `AUTH_REQUIRED` 2, `AUTH_EXPIRED` 3, `RESPONSE_TIMEOUT` 4, `PROVIDER_LOAD` 5, `INVALID_PROVIDER` 5; unknown code 1.
- Every commit: `bun run check` passes first. Commit trailer per repository policy. After each commit: `gh issue comment 3` (English) with what was committed and what is next.
- Work on branch `issue-3`.

---

### Task 1: Build pipeline — emit JS, NodeNext, `exports` → `dist`

**Files:**
- Modify: `tsconfig.json` (root, unchanged content; listed for context), `packages/provider/tsconfig.json`, `packages/runtime/tsconfig.json`, `packages/core/tsconfig.json`, `packages/cli/tsconfig.json`
- Modify: `packages/provider/package.json`, `packages/runtime/package.json`, `packages/core/package.json`, `packages/cli/package.json`, `package.json` (root)
- Modify: every relative import under `packages/*/src/**/*.ts` (add `.js`), `packages/cli/src/bin.ts` (shebang)
- Modify: `.github/workflows/ci.yml`, `CLAUDE.md` (commands section)

**Interfaces:**
- Consumes: nothing.
- Produces: `bun run build` emits `packages/*/dist/{index.js,index.d.ts,...}`; `bun run test` builds then tests; `node packages/cli/dist/bin.js --help` exits 0.

- [ ] **Step 1: Switch the four package tsconfigs to NodeNext and JS emit**

In each of `packages/provider/tsconfig.json`, `packages/runtime/tsconfig.json`, `packages/core/tsconfig.json`, `packages/cli/tsconfig.json`, replace `compilerOptions`, `include`, and `exclude` with the following and keep the file's existing `references` array untouched (provider has none; runtime: `../provider`; core: `../provider`, `../runtime`; cli: `../core`):

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["**/*.test.ts", "**/__fixtures__/**"]
}
```

Leave `examples/dummy-chat/tsconfig.json` as it is (private, declaration-only, bundler resolution).

- [ ] **Step 2: Add `.js` suffixes to relative imports**

Run from the repository root:

```bash
grep -rlE "from \"\./|from \"\.\./" packages/*/src | xargs sed -i '' -E 's#(from "\.\.?/[^"]+)"#\1.js"#g'
grep -rnE "from \"\.\.?/" packages/*/src
```

Every relative import must now end in `.js` (tests included, for consistency). Verify no line ends in `.js.js"`.

- [ ] **Step 3: Point `exports` at `dist` and update root scripts**

`packages/provider/package.json`, `packages/runtime/package.json`, `packages/core/package.json`: replace the `exports` field with

```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
}
```

`packages/cli/package.json`: same `exports`, and `"bin": { "chatbridge": "./dist/bin.js" }`.

Root `package.json` scripts:

```json
"scripts": {
  "lint": "biome check .",
  "build": "tsc --build",
  "test": "bun run build && bun test",
  "check": "bun run lint && bun run test"
}
```

- [ ] **Step 4: Switch the CLI shebang to Node**

`packages/cli/src/bin.ts` line 1: `#!/usr/bin/env node`.

- [ ] **Step 5: Build and run the test suite**

Run: `bun install && bun run check`
Expected: lint clean, `tsc --build` emits `packages/*/dist`, all 20 existing tests pass (E2E included).

If `tsc` reports "Relative import paths need explicit file extensions", a `.js` suffix was missed — fix and rerun.

- [ ] **Step 6: Node smoke test**

Run: `node packages/cli/dist/bin.js --help; echo "exit=$?"`
Expected: usage text and `exit=0`.

- [ ] **Step 7: Add the Node smoke test to CI and update CLAUDE.md**

`.github/workflows/ci.yml`: append after `bun run check`:

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: node packages/cli/dist/bin.js --help
```

`CLAUDE.md` "Current state" command list: replace the `bun run check` line with
`- \`bun run check\` — lint (Biome) + build (tsc --build, emits dist/) + tests (bun test); required before every commit/PR`
and add `- \`bun run build\` — emit JS + d.ts into each package's dist/ (tests import cross-package code from dist, so run this after editing another package)`.

- [ ] **Step 8: Commit and sync**

```bash
git add -A
git commit -m "build: emit JS + d.ts with NodeNext, exports target dist (Refs #3)"
gh issue comment 3 --body "Task 1 done: packages emit JS + d.ts (NodeNext, .js relative imports), exports point at dist, CLI shebang is node, CI runs a Node smoke test. Next: Task 2 (package metadata, peer deps, MIT license)."
```

---

### Task 2: Package metadata, `playwright-core` peer dependency, MIT license

**Files:**
- Modify: `packages/provider/package.json`, `packages/runtime/package.json`, `packages/core/package.json`, `packages/cli/package.json`, `examples/dummy-chat/package.json`
- Create: `LICENSE`
- Modify: `README.md` (License section)

**Interfaces:**
- Produces: publishable manifests at version `0.1.0`.

- [ ] **Step 1: Write the four manifests**

`packages/provider/package.json`:

```json
{
  "name": "@chatbridge/provider",
  "version": "0.1.0",
  "description": "Provider contract for chatbridge: service-specific browser behaviour behind one interface",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/7milch/chatbridge-cli.git",
    "directory": "packages/provider"
  },
  "keywords": ["chatbridge", "playwright", "chat", "provider"],
  "type": "module",
  "engines": { "node": ">=20" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" },
  "peerDependencies": { "playwright-core": ">=1.48 <2" },
  "devDependencies": { "playwright-core": "1.63.0" }
}
```

`packages/runtime/package.json`:

```json
{
  "name": "@chatbridge/runtime",
  "version": "0.1.0",
  "description": "Playwright runtime for chatbridge: browser lifecycle and auth-state persistence",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/7milch/chatbridge-cli.git",
    "directory": "packages/runtime"
  },
  "keywords": ["chatbridge", "playwright", "chat"],
  "type": "module",
  "engines": { "node": ">=20" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" },
  "dependencies": {
    "playwright": "1.63.0",
    "@chatbridge/provider": "workspace:*"
  },
  "devDependencies": {
    "@chatbridge/example-dummy-chat": "workspace:*"
  }
}
```

`packages/core/package.json`:

```json
{
  "name": "@chatbridge/core",
  "version": "0.1.0",
  "description": "Core session flows and errors for chatbridge",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/7milch/chatbridge-cli.git",
    "directory": "packages/core"
  },
  "keywords": ["chatbridge", "playwright", "chat"],
  "type": "module",
  "engines": { "node": ">=20" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" },
  "dependencies": {
    "@chatbridge/provider": "workspace:*",
    "@chatbridge/runtime": "workspace:*"
  },
  "devDependencies": {
    "@chatbridge/example-dummy-chat": "workspace:*"
  }
}
```

`packages/cli/package.json`:

```json
{
  "name": "chatbridge",
  "version": "0.1.0",
  "description": "Drive browser-only web chat AI services from the command line",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/7milch/chatbridge-cli.git",
    "directory": "packages/cli"
  },
  "keywords": ["chatbridge", "cli", "playwright", "chat", "ai"],
  "type": "module",
  "engines": { "node": ">=20" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "bin": { "chatbridge": "./dist/bin.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" },
  "dependencies": {
    "@chatbridge/core": "workspace:*"
  },
  "devDependencies": {
    "@chatbridge/example-dummy-chat": "workspace:*"
  }
}
```

`examples/dummy-chat/package.json`: add `"devDependencies": { "playwright-core": "1.63.0" }` (satisfies the peer; keep `private: true` and the `.ts` exports).

- [ ] **Step 2: Add the license file and README section**

Create `LICENSE`:

```
MIT License

Copyright (c) 2026 7milch

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`README.md`: replace the `## License` section body `TBD` with `MIT — see [LICENSE](LICENSE).`

Copy `LICENSE` into each package so `files` picks it up: `for p in provider runtime core cli; do cp LICENSE packages/$p/LICENSE; done`. Also create a one-paragraph `packages/<p>/README.md` per package (one line naming the package and linking to the repository README) so npm shows something on the package page.

- [ ] **Step 3: Reinstall and verify the pack contents**

Run:

```bash
bun install
bun run check
mkdir -p /tmp/cb-packs && for p in provider runtime core cli; do (cd packages/$p && bun pm pack --destination /tmp/cb-packs --quiet); done
for t in /tmp/cb-packs/*.tgz; do echo "== $t"; tar -tzf "$t" | grep -E 'dist/index\.js|dist/bin\.js|LICENSE'; tar -xOf "$t" package/package.json | grep -E '"(version|playwright|@chatbridge/[a-z]+)"'; done
```

Expected: every tarball lists `package/dist/index.js` and `package/LICENSE`; the cli tarball lists `package/dist/bin.js`; no `workspace:` string remains in any packed `package.json` (bun rewrites it to `0.1.0`); provider's packed manifest has `peerDependencies.playwright-core` `>=1.48 <2`.

- [ ] **Step 4: Commit and sync**

```bash
git add -A
git commit -m "chore: publishable manifests, playwright-core peer dep, MIT license (Refs #3)"
gh issue comment 3 --body "Task 2 done: versions 0.1.0, MIT LICENSE, repository/engines/files metadata, playwright-core is a peerDependency of @chatbridge/provider. Next: Task 3 (error cause + provider name validation)."
```

---

### Task 3: Error `cause`, `InvalidProviderError`, provider name validation

**Files:**
- Modify: `packages/core/src/errors.ts`, `packages/core/src/errors.test.ts`
- Create: `packages/runtime/src/provider-name.ts`, `packages/runtime/src/provider-name.test.ts`
- Modify: `packages/runtime/src/auth-store.ts`, `packages/runtime/src/auth-store.test.ts`, `packages/runtime/src/index.ts`
- Create: `packages/core/src/create-auth-store.ts`, `packages/core/src/create-auth-store.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/cli/src/resolve-provider.ts` (attach `cause`)

**Interfaces:**
- Produces:
  - `class ChatBridgeError extends Error { constructor(code: string, message: string, options?: ErrorOptions) }` — all subclasses take `(message, options?)`.
  - `class InvalidProviderError extends ChatBridgeError` with `code = "INVALID_PROVIDER"`.
  - `validateProviderName(name: string): void` from `@chatbridge/runtime` — throws `RangeError`.
  - `createAuthStore(opts: AuthStoreOptions): AuthStore` from `@chatbridge/core` — throws `InvalidProviderError`.

- [ ] **Step 1: Failing tests for `cause` and the new error class**

Append to `packages/core/src/errors.test.ts` (add `InvalidProviderError` to the import):

```ts
describe("cause", () => {
  test("is carried through to Error.cause", () => {
    const inner = new Error("root");
    const err = new ResponseTimeoutError("timed out", { cause: inner });
    expect(err.cause).toBe(inner);
  });

  test("InvalidProviderError maps to INVALID_PROVIDER", () => {
    const err = new InvalidProviderError("bad name");
    expect(err).toBeInstanceOf(ChatBridgeError);
    expect(err.code).toBe("INVALID_PROVIDER");
  });
});
```

Run: `bun test packages/core/src/errors.test.ts`
Expected: FAIL (`InvalidProviderError` not exported; `cause` undefined).

- [ ] **Step 2: Implement errors.ts**

Replace `packages/core/src/errors.ts`:

```ts
/** Base class for all framework errors. The CLI maps `code` to exit codes.
 * `options.cause` carries the underlying error (never auth content). */
export class ChatBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AuthRequiredError extends ChatBridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super("AUTH_REQUIRED", message, options);
  }
}

export class AuthExpiredError extends ChatBridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super("AUTH_EXPIRED", message, options);
  }
}

export class ResponseTimeoutError extends ChatBridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super("RESPONSE_TIMEOUT", message, options);
  }
}

export class ProviderLoadError extends ChatBridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super("PROVIDER_LOAD", message, options);
  }
}

/** The provider's `name` cannot be used as an auth-state file name. */
export class InvalidProviderError extends ChatBridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super("INVALID_PROVIDER", message, options);
  }
}
```

Run: `bun test packages/core/src/errors.test.ts` → PASS.

- [ ] **Step 3: Failing tests for `validateProviderName` and `AuthStore`**

Create `packages/runtime/src/provider-name.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { validateProviderName } from "./provider-name.js";

describe("validateProviderName", () => {
  test.each([["dummy-chat"], ["a"], ["x.y_z-1"], ["a".repeat(64)]])(
    "accepts %p",
    (name: string) => {
      expect(() => validateProviderName(name)).not.toThrow();
    },
  );

  test.each([
    [""],
    ["../escape"],
    ["a/b"],
    ["Upper"],
    [".hidden"],
    ["-dash"],
    ["with space"],
    ["a".repeat(65)],
  ])("rejects %p with RangeError", (name: string) => {
    expect(() => validateProviderName(name)).toThrow(RangeError);
  });
});
```

Append to `packages/runtime/src/auth-store.test.ts` inside `describe("AuthStore")`:

```ts
  test("rejects a provider name that is not a safe file name", () => {
    expect(
      () =>
        new AuthStore({
          configDir: "chatbridge",
          providerName: "../escape",
          baseDir: tmpdir(),
        }),
    ).toThrow(RangeError);
  });
```

(`afterEach` there removes `dir`; it is still set by earlier tests, so leave it. If `dir` is `undefined` when this test runs alone, guard the cleanup with `if (dir)`.)

Run: `bun test packages/runtime` → FAIL (module missing / no throw).

- [ ] **Step 4: Implement validation in runtime**

Create `packages/runtime/src/provider-name.ts`:

```ts
const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Provider names become auth-state file names, so they must be plain,
 * lowercase, and free of path separators. Rejected, never rewritten. */
export function validateProviderName(name: string): void {
  if (!PROVIDER_NAME.test(name)) {
    throw new RangeError(
      `Invalid provider name ${JSON.stringify(name)}: must match ${PROVIDER_NAME}`,
    );
  }
}
```

In `packages/runtime/src/auth-store.ts` add `import { validateProviderName } from "./provider-name.js";` and as the first line of the constructor: `validateProviderName(opts.providerName);`.

`packages/runtime/src/index.ts`: add `export * from "./provider-name.js";`.

Run: `bun run build && bun test packages/runtime` → PASS.

- [ ] **Step 5: Failing test for `createAuthStore`**

Create `packages/core/src/create-auth-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createAuthStore } from "./create-auth-store.js";
import { InvalidProviderError } from "./errors.js";

describe("createAuthStore", () => {
  test("returns a store for a valid name", () => {
    const store = createAuthStore({
      configDir: "chatbridge",
      providerName: "dummy-chat",
      baseDir: tmpdir(),
    });
    expect(store.path().endsWith("dummy-chat.json")).toBe(true);
  });

  test("wraps an invalid name in InvalidProviderError with cause", () => {
    let caught: unknown;
    try {
      createAuthStore({
        configDir: "chatbridge",
        providerName: "../escape",
        baseDir: tmpdir(),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidProviderError);
    expect((caught as InvalidProviderError).cause).toBeInstanceOf(RangeError);
  });
});
```

Run: `bun test packages/core/src/create-auth-store.test.ts` → FAIL.

- [ ] **Step 6: Implement `createAuthStore`**

Create `packages/core/src/create-auth-store.ts`:

```ts
import {
  AuthStore,
  type AuthStoreOptions,
  validateProviderName,
} from "@chatbridge/runtime";
import { InvalidProviderError } from "./errors.js";

/** Builds an AuthStore, translating an unusable provider name into the
 * framework error the CLI maps to exit code 5. */
export function createAuthStore(opts: AuthStoreOptions): AuthStore {
  try {
    validateProviderName(opts.providerName);
  } catch (err) {
    throw new InvalidProviderError(
      `Provider name ${JSON.stringify(opts.providerName)} cannot be used as a file name: use lowercase letters, digits, ".", "_" or "-" (1-64 chars, starting with a letter or digit).`,
      { cause: err },
    );
  }
  return new AuthStore(opts);
}
```

`packages/core/src/index.ts`: add `export { createAuthStore } from "./create-auth-store.js";` and change the runtime re-export line to `export { AuthStore, type AuthStoreOptions, BrowserRuntime, validateProviderName } from "@chatbridge/runtime";`.

Run: `bun run build && bun test packages/core/src/create-auth-store.test.ts` → PASS.

- [ ] **Step 7: Attach `cause` in `resolveProvider`**

In `packages/cli/src/resolve-provider.ts`, the import failure branch becomes:

```ts
    throw new ProviderLoadError(
      `Could not load provider "${spec}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
```

- [ ] **Step 8: Full check, commit, sync**

Run: `bun run check` → all pass.

```bash
git add -A
git commit -m "feat: carry error cause, validate provider names (Refs #3)"
gh issue comment 3 --body "Task 3 done: ChatBridgeError carries cause; InvalidProviderError (exit 5); runtime validateProviderName + AuthStore guard; core createAuthStore. Next: Task 4 (timeout mapping for every provider step)."
```

---

### Task 4: Map Playwright `TimeoutError` on every provider step

**Files:**
- Modify: `packages/core/src/session.ts`
- Create: `packages/core/src/session.test.ts`

**Interfaces:**
- Produces: `runStep<T>(name: string, timeoutMs: number, fn: () => Promise<T>): Promise<T>` exported from `session.ts` (internal helper, exported for tests; not re-exported from the package index).

- [ ] **Step 1: Failing unit test**

Create `packages/core/src/session.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ResponseTimeoutError } from "./errors.js";
import { runStep } from "./session.js";

function playwrightTimeout(): Error {
  const err = new Error("Timeout 1000ms exceeded.");
  err.name = "TimeoutError";
  return err;
}

describe("runStep", () => {
  test("returns the step result", async () => {
    expect(await runStep("goto", 1000, async () => 42)).toBe(42);
  });

  test("maps TimeoutError to ResponseTimeoutError naming the step", async () => {
    const inner = playwrightTimeout();
    let caught: unknown;
    try {
      await runStep("sendMessage", 1000, async () => {
        throw inner;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResponseTimeoutError);
    const e = caught as ResponseTimeoutError;
    expect(e.message).toContain("sendMessage");
    expect(e.message).toContain("1000 ms");
    expect(e.cause).toBe(inner);
  });

  test("passes other errors through unchanged", async () => {
    const inner = new Error("boom");
    await expect(
      runStep("goto", 1000, async () => {
        throw inner;
      }),
    ).rejects.toBe(inner);
  });
});
```

Run: `bun test packages/core/src/session.test.ts` → FAIL (`runStep` not exported).

- [ ] **Step 2: Implement `runStep` and use it everywhere**

Replace `packages/core/src/session.ts`:

```ts
import type { Provider } from "@chatbridge/provider";
import { type AuthStore, BrowserRuntime } from "@chatbridge/runtime";
import {
  AuthExpiredError,
  AuthRequiredError,
  ResponseTimeoutError,
} from "./errors.js";

export interface OneShotOptions {
  provider: Provider;
  authStore: AuthStore;
  prompt: string;
  headless: boolean;
  timeoutMs: number;
  /** Progress messages (stderr in the CLI). Never receives auth content. */
  onProgress?: (message: string) => void;
}

/** Runs one browser step; a Playwright TimeoutError becomes a framework
 * ResponseTimeoutError that names the step and keeps the original as cause. */
export async function runStep<T>(
  name: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ResponseTimeoutError(
        `Timed out during ${name} after ${timeoutMs} ms.`,
        { cause: err },
      );
    }
    throw err;
  }
}

/** One-shot flow: restore auth -> new chat -> send -> wait -> return text. */
export async function runOneShot(opts: OneShotOptions): Promise<string> {
  const { provider, authStore, onProgress, timeoutMs } = opts;
  if (!authStore.has()) {
    throw new AuthRequiredError(
      `No saved auth state for provider "${provider.name}". Run \`auth login\` first.`,
    );
  }
  onProgress?.("Opening browser...");
  const rt = await BrowserRuntime.launch({
    headless: opts.headless,
    provider,
    authStore,
  });
  try {
    rt.page.setDefaultTimeout(timeoutMs);
    await runStep("goto", timeoutMs, () => rt.page.goto(provider.chatUrl));
    const loggedIn = await runStep("isLoggedIn", timeoutMs, () =>
      provider.isLoggedIn(rt.page),
    );
    if (!loggedIn) {
      throw new AuthExpiredError(
        `Auth state for "${provider.name}" is no longer valid. Run \`auth login\` again.`,
      );
    }
    await runStep("startNewChat", timeoutMs, () =>
      provider.startNewChat(rt.page),
    );
    onProgress?.("Sending prompt...");
    await runStep("sendMessage", timeoutMs, () =>
      provider.sendMessage(rt.page, opts.prompt),
    );
    onProgress?.("Waiting for response...");
    return await runStep("waitForResponse", timeoutMs, () =>
      provider.waitForResponse(rt.page),
    );
  } finally {
    await rt.close();
  }
}

export interface LoginOptions {
  provider: Provider;
  authStore: AuthStore;
  onProgress?: (message: string) => void;
}

const LOGIN_NAVIGATION_TIMEOUT_MS = 30_000;

/** Headful login flow: the user logs in manually; we poll for completion. */
export async function runLogin(opts: LoginOptions): Promise<void> {
  const { provider, authStore, onProgress } = opts;
  onProgress?.("Opening browser...");
  const rt = await BrowserRuntime.launch({
    headless: false,
    provider,
    authStore,
  });
  try {
    rt.page.setDefaultTimeout(LOGIN_NAVIGATION_TIMEOUT_MS);
    await runStep("navigateToLogin", LOGIN_NAVIGATION_TIMEOUT_MS, () =>
      provider.navigateToLogin(rt.page),
    );
    onProgress?.(`Please log in to ${provider.name}.`);
    // Poll until the provider reports completion. No overall deadline:
    // the user may need time for MFA; Ctrl-C aborts.
    while (!(await provider.isLoggedIn(rt.page))) {
      await rt.page.waitForTimeout(1000);
    }
    onProgress?.("✓ Login detected");
    await rt.saveAuthState();
    onProgress?.("✓ Session saved");
  } finally {
    await rt.close();
  }
}
```

- [ ] **Step 3: Verify**

Run: `bun run check` → all pass (the two `session.e2e.test.ts` cases must still pass).

- [ ] **Step 4: Commit and sync**

```bash
git add -A
git commit -m "feat: map Playwright TimeoutError on every provider step (Refs #3)"
gh issue comment 3 --body "Task 4 done: runStep wraps goto/isLoggedIn/startNewChat/sendMessage/waitForResponse (and navigateToLogin) so any Playwright TimeoutError becomes RESPONSE_TIMEOUT with the step name and cause. Next: Task 5 (config file loader)."
```

---

### Task 5: Config file loader

**Files:**
- Create: `packages/cli/src/config.ts`, `packages/cli/src/config.test.ts`

**Interfaces:**
- Produces:
  - `interface CliConfig { defaultProvider?: string }` (already resolved: relative `./`/`../` values become absolute paths against the config file's directory).
  - `configPath(opts: { configDir: string; baseDir?: string }): string`
  - `loadConfig(opts: { configDir: string; baseDir?: string }): Promise<CliConfig>` — missing file → `{}`; bad JSON / non-object → `ChatBridgeError` with `code = "INVALID_CONFIG"` and `cause`.

- [ ] **Step 1: Failing tests**

Create `packages/cli/src/config.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatBridgeError } from "@chatbridge/core";
import { configPath, loadConfig } from "./config.js";

let baseDir: string;
function setup(): string {
  baseDir = mkdtempSync(join(tmpdir(), "chatbridge-config-"));
  mkdirSync(join(baseDir, "test-cli"), { recursive: true });
  return join(baseDir, "test-cli", "config.json");
}
afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

describe("loadConfig", () => {
  test("configPath is <baseDir>/<configDir>/config.json", () => {
    const file = setup();
    expect(configPath({ configDir: "test-cli", baseDir })).toBe(file);
  });

  test("returns {} when the file does not exist", async () => {
    setup();
    expect(await loadConfig({ configDir: "test-cli", baseDir })).toEqual({});
  });

  test("reads defaultProvider as an npm package name", async () => {
    writeFileSync(setup(), JSON.stringify({ defaultProvider: "@x/prov" }));
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect(cfg.defaultProvider).toBe("@x/prov");
  });

  test("resolves a relative defaultProvider against the config directory", async () => {
    writeFileSync(setup(), JSON.stringify({ defaultProvider: "./prov.ts" }));
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect(cfg.defaultProvider).toBe(join(baseDir, "test-cli", "prov.ts"));
  });

  test("ignores unknown keys", async () => {
    writeFileSync(setup(), JSON.stringify({ future: 1 }));
    expect(await loadConfig({ configDir: "test-cli", baseDir })).toEqual({});
  });

  test("invalid JSON becomes INVALID_CONFIG with cause and the file path", async () => {
    const file = setup();
    writeFileSync(file, "{ not json");
    let caught: unknown;
    try {
      await loadConfig({ configDir: "test-cli", baseDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ChatBridgeError);
    const e = caught as ChatBridgeError;
    expect(e.code).toBe("INVALID_CONFIG");
    expect(e.message).toContain(file);
    expect(e.cause).toBeInstanceOf(SyntaxError);
  });

  test("a non-object document is INVALID_CONFIG", async () => {
    writeFileSync(setup(), "[1,2]");
    await expect(
      loadConfig({ configDir: "test-cli", baseDir }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  test("a non-string defaultProvider is INVALID_CONFIG", async () => {
    writeFileSync(setup(), JSON.stringify({ defaultProvider: 5 }));
    await expect(
      loadConfig({ configDir: "test-cli", baseDir }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
});
```

Run: `bun test packages/cli/src/config.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement**

Create `packages/cli/src/config.ts`:

```ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ChatBridgeError } from "@chatbridge/core";

export interface CliConfig {
  /** Provider spec used when --provider is absent. Relative paths are
   * already resolved against the config file's directory. */
  defaultProvider?: string;
}

export interface ConfigLocation {
  /** Directory name under the base dir, e.g. "chatbridge". */
  configDir: string;
  /** Base directory; defaults to ~/.config. Overridable for tests. */
  baseDir?: string;
}

export function configPath(loc: ConfigLocation): string {
  const base = loc.baseDir ?? join(homedir(), ".config");
  return join(base, loc.configDir, "config.json");
}

function invalid(file: string, why: string, cause?: unknown): ChatBridgeError {
  return new ChatBridgeError("INVALID_CONFIG", `Invalid config ${file}: ${why}`, {
    cause,
  });
}

/** Reads <base>/<configDir>/config.json. Missing file → {}. */
export async function loadConfig(loc: ConfigLocation): Promise<CliConfig> {
  const file = configPath(loc);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw invalid(file, "could not read the file", err);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw invalid(file, "not valid JSON", err);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw invalid(file, "top level must be a JSON object");
  }
  const { defaultProvider } = doc as Record<string, unknown>;
  const cfg: CliConfig = {};
  if (defaultProvider !== undefined) {
    if (typeof defaultProvider !== "string") {
      throw invalid(file, '"defaultProvider" must be a string');
    }
    const isRelative =
      defaultProvider.startsWith("./") || defaultProvider.startsWith("../");
    cfg.defaultProvider = isRelative
      ? resolve(dirname(file), defaultProvider)
      : defaultProvider;
  }
  return cfg;
}
```

`packages/cli/src/index.ts`: add `export { type CliConfig, configPath, loadConfig } from "./config.js";`.

Run: `bun run build && bun test packages/cli/src/config.test.ts` → PASS.

- [ ] **Step 3: Check, commit, sync**

Run: `bun run check` → PASS.

```bash
git add -A
git commit -m "feat(cli): load defaultProvider from config.json (Refs #3)"
gh issue comment 3 --body "Task 5 done: packages/cli/src/config.ts loads ~/.config/<configDir>/config.json (defaultProvider; relative paths resolved against the config dir; INVALID_CONFIG on bad JSON). Not wired into createCli yet. Next: Task 6 (createCli: resolution order, pinned --provider rejection, unknown flags, exit-code table, CHATBRIDGE_DEBUG)."
```

---

### Task 6: `createCli` — resolution order, argument errors, exit codes, debug output

**Files:**
- Modify: `packages/cli/src/create-cli.ts`, `packages/cli/src/create-cli.test.ts`
- Create: `packages/cli/src/__fixtures__/not-a-provider.ts`, `packages/cli/src/__fixtures__/bad-name-provider.ts`

**Interfaces:**
- Consumes: `loadConfig`, `configPath` (Task 5); `createAuthStore`, `InvalidProviderError` (Task 3).
- Produces: `createCli(opts).run(argv): Promise<number>` with the behaviour below. `CreateCliOptions` unchanged.

- [ ] **Step 1: Fixtures**

`packages/cli/src/__fixtures__/not-a-provider.ts`:

```ts
// Default export deliberately lacks the Provider methods.
export default { name: "nope", chatUrl: "http://127.0.0.1:1/" };
```

`packages/cli/src/__fixtures__/bad-name-provider.ts`:

```ts
import { defineProvider } from "@chatbridge/core";

const unreachable = () => {
  throw new Error("provider must not be used");
};

// Structurally valid, but the name cannot be a file name.
export default defineProvider({
  name: "../escape",
  chatUrl: "http://127.0.0.1:1/chat",
  navigateToLogin: unreachable,
  isLoggedIn: unreachable,
  startNewChat: unreachable,
  sendMessage: unreachable,
  waitForResponse: unreachable,
});
```

(`__fixtures__` is excluded from `tsc` by Task 1's tsconfig.)

- [ ] **Step 2: Failing tests**

Replace `packages/cli/src/create-cli.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Provider, defineProvider } from "@chatbridge/core";
import { createCli } from "./create-cli.js";

const fixtures = resolve(import.meta.dir, "__fixtures__");

/** Provider stub whose methods must never be reached: argument validation
 * happens before any browser is launched. */
function stubProvider(): Provider {
  const unreachable = () => {
    throw new Error("provider must not be used");
  };
  return defineProvider({
    name: "stub",
    chatUrl: "http://127.0.0.1:1/chat",
    navigateToLogin: unreachable,
    isLoggedIn: unreachable,
    startNewChat: unreachable,
    sendMessage: unreachable,
    waitForResponse: unreachable,
  });
}

let baseDir: string;
function setup(): string {
  baseDir = mkdtempSync(join(tmpdir(), "chatbridge-cli-"));
  return baseDir;
}

const stderrChunks: string[] = [];
const originalStderr = process.stderr.write.bind(process.stderr);
function captureStderr() {
  stderrChunks.length = 0;
  process.stderr.write = ((chunk: string) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
}
afterEach(() => {
  process.stderr.write = originalStderr;
  if (baseDir) rmSync(baseDir, { recursive: true, force: true });
});

describe("--timeout validation", () => {
  test("rejects a non-numeric value without launching a browser", async () => {
    const cli = createCli({ name: "test-cli", provider: stubProvider() });
    const code = await cli.run(["bun", "cli", "-p", "x", "--timeout", "abc"]);
    expect(code).toBe(1);
  });

  test.each([["--timeout=0"], ["--timeout=-5"], ["--timeout=Infinity"]])(
    "rejects %p",
    async (arg: string) => {
      const cli = createCli({ name: "test-cli", provider: stubProvider() });
      const code = await cli.run(["bun", "cli", "-p", "x", arg]);
      expect(code).toBe(1);
    },
  );
});

describe("argument errors", () => {
  test("unknown flag exits 1 and prints usage to stderr", async () => {
    captureStderr();
    const cli = createCli({ name: "test-cli", provider: stubProvider() });
    const code = await cli.run(["bun", "cli", "-p", "x", "--bogus"]);
    expect(code).toBe(1);
    const out = stderrChunks.join("");
    expect(out).toContain("--bogus");
    expect(out).toContain("Usage:");
  });

  test("pinned provider rejects --provider with exit 1", async () => {
    captureStderr();
    const cli = createCli({ name: "test-cli", provider: stubProvider() });
    const code = await cli.run([
      "bun",
      "cli",
      "-p",
      "x",
      "--provider",
      "./x.ts",
    ]);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("fixed provider");
  });
});

describe("provider resolution (exit 5)", () => {
  test("no --provider and no config exits 5 and names the config file", async () => {
    captureStderr();
    const cli = createCli({ name: "test-cli", baseDir: setup() });
    expect(await cli.run(["bun", "cli", "-p", "x"])).toBe(5);
    expect(stderrChunks.join("")).toContain("config.json");
  });

  test("non-existent provider path exits 5", async () => {
    const cli = createCli({ name: "test-cli", baseDir: setup() });
    const code = await cli.run([
      "bun",
      "cli",
      "-p",
      "x",
      "--provider",
      resolve(fixtures, "missing.ts"),
    ]);
    expect(code).toBe(5);
  });

  test("module without Provider methods exits 5", async () => {
    const cli = createCli({ name: "test-cli", baseDir: setup() });
    const code = await cli.run([
      "bun",
      "cli",
      "-p",
      "x",
      "--provider",
      resolve(fixtures, "not-a-provider.ts"),
    ]);
    expect(code).toBe(5);
  });

  test("provider with an unsafe name exits 5", async () => {
    const cli = createCli({ name: "test-cli", baseDir: setup() });
    const code = await cli.run([
      "bun",
      "cli",
      "auth",
      "status",
      "--provider",
      resolve(fixtures, "bad-name-provider.ts"),
    ]);
    expect(code).toBe(5);
  });

  test("config defaultProvider is used when --provider is absent", async () => {
    const dir = setup();
    mkdirSync(join(dir, "test-cli"), { recursive: true });
    writeFileSync(
      join(dir, "test-cli", "config.json"),
      JSON.stringify({
        defaultProvider: resolve(fixtures, "bad-name-provider.ts"),
      }),
    );
    const cli = createCli({ name: "test-cli", baseDir: dir });
    // Reaching the name check proves the config was read and the module loaded.
    expect(await cli.run(["bun", "cli", "auth", "status"])).toBe(5);
  });

  test("broken config exits 1", async () => {
    const dir = setup();
    mkdirSync(join(dir, "test-cli"), { recursive: true });
    writeFileSync(join(dir, "test-cli", "config.json"), "{ nope");
    const cli = createCli({ name: "test-cli", baseDir: dir });
    expect(await cli.run(["bun", "cli", "auth", "status"])).toBe(1);
  });
});

describe("CHATBRIDGE_DEBUG", () => {
  test("prints the cause when set", async () => {
    captureStderr();
    const previous = process.env.CHATBRIDGE_DEBUG;
    process.env.CHATBRIDGE_DEBUG = "1";
    try {
      const cli = createCli({ name: "test-cli", baseDir: setup() });
      await cli.run([
        "bun",
        "cli",
        "-p",
        "x",
        "--provider",
        resolve(fixtures, "missing.ts"),
      ]);
    } finally {
      if (previous === undefined) delete process.env.CHATBRIDGE_DEBUG;
      else process.env.CHATBRIDGE_DEBUG = previous;
    }
    expect(stderrChunks.join("")).toContain("Caused by:");
  });
});
```

Run: `bun test packages/cli/src/create-cli.test.ts` → the new cases FAIL (unknown flag gives "unexpected error" without usage; pinned `--provider` is silently accepted; no config; no "Caused by").

- [ ] **Step 3: Implement**

Replace `packages/cli/src/create-cli.ts`:

```ts
import { parseArgs } from "node:util";
import {
  ChatBridgeError,
  type Provider,
  ProviderLoadError,
  createAuthStore,
  runLogin,
  runOneShot,
} from "@chatbridge/core";
import { configPath, loadConfig } from "./config.js";
import { resolveProvider } from "./resolve-provider.js";

export interface CreateCliOptions {
  /** CLI name shown in help and errors, e.g. "chatbridge" or "company-ai-cli". */
  name: string;
  /** Pinned provider. When set, --provider is rejected and config is not read. */
  provider?: Provider;
  /** Config directory name under ~/.config; defaults to `name`. */
  configDir?: string;
  /** Test-only: overrides the config/auth-store base directory. */
  baseDir?: string;
}

/** Single source of truth for `ChatBridgeError.code` → process exit code. */
const EXIT_CODES: Record<string, number> = {
  INVALID_ARGUMENT: 1,
  INVALID_CONFIG: 1,
  AUTH_REQUIRED: 2,
  AUTH_EXPIRED: 3,
  RESPONSE_TIMEOUT: 4,
  PROVIDER_LOAD: 5,
  INVALID_PROVIDER: 5,
};

const DEFAULT_TIMEOUT_SEC = 120;

/** Validates --timeout before any browser is launched. */
function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_SEC * 1000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ChatBridgeError(
      "INVALID_ARGUMENT",
      "--timeout must be a positive number of seconds",
    );
  }
  return seconds * 1000;
}

function isParseArgsError(err: unknown): err is Error & { code: string } {
  return (
    err instanceof Error &&
    typeof (err as { code?: unknown }).code === "string" &&
    (err as { code: string }).code.startsWith("ERR_PARSE_ARGS_")
  );
}

export function createCli(opts: CreateCliOptions) {
  const configDir = opts.configDir ?? opts.name;
  const location = { configDir, baseDir: opts.baseDir };

  function help(): string {
    const providerFlag = opts.provider ? "" : " [--provider <name|path>]";
    return [
      "Usage:",
      `  ${opts.name} -p <prompt>${providerFlag} [--headful] [--timeout <sec>]`,
      `  ${opts.name} auth login${providerFlag}`,
      `  ${opts.name} auth logout${providerFlag}`,
      `  ${opts.name} auth status${providerFlag}`,
      "",
      "One-shot mode prints the AI response to stdout.",
      ...(opts.provider
        ? []
        : [
            "",
            `Without --provider, "defaultProvider" from ${configPath(location)} is used.`,
          ]),
    ].join("\n");
  }

  // Progress goes to stderr, and only when stderr is a TTY (stdout stays
  // pipe-safe: response body only).
  function progress(message: string): void {
    if (process.stderr.isTTY) process.stderr.write(`${message}\n`);
  }

  /** Resolution order: pinned provider → --provider → config defaultProvider. */
  async function getProvider(flag: string | undefined): Promise<Provider> {
    if (opts.provider) {
      if (flag !== undefined) {
        throw new ChatBridgeError(
          "INVALID_ARGUMENT",
          `${opts.name} has a fixed provider; --provider is not accepted`,
        );
      }
      return opts.provider;
    }
    const spec = flag ?? (await loadConfig(location)).defaultProvider;
    if (!spec) {
      throw new ProviderLoadError(
        `No provider specified. Pass --provider <npm-package|./path> or set "defaultProvider" in ${configPath(location)}.`,
      );
    }
    return resolveProvider(spec);
  }

  function reportError(err: unknown): number {
    if (isParseArgsError(err)) {
      process.stderr.write(`${opts.name}: ${err.message}\n\n${help()}\n`);
      return 1;
    }
    if (err instanceof ChatBridgeError) {
      process.stderr.write(`${opts.name}: ${err.message}\n`);
      if (process.env.CHATBRIDGE_DEBUG === "1" && err.cause !== undefined) {
        const cause = err.cause;
        const detail =
          cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
        process.stderr.write(`Caused by: ${detail}\n`);
      }
      return EXIT_CODES[err.code] ?? 1;
    }
    process.stderr.write(
      `${opts.name}: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  async function run(argv: string[]): Promise<number> {
    try {
      const { values, positionals } = parseArgs({
        args: argv.slice(2),
        options: {
          prompt: { type: "string", short: "p" },
          provider: { type: "string" },
          headful: { type: "boolean", default: false },
          timeout: { type: "string" },
          help: { type: "boolean", short: "h", default: false },
        },
        allowPositionals: true,
      });

      if (values.help) {
        console.log(help());
        return 0;
      }

      const [cmd, sub] = positionals;

      if (
        cmd === "auth" &&
        (sub === "login" || sub === "logout" || sub === "status")
      ) {
        const provider = await getProvider(values.provider);
        const authStore = createAuthStore({
          configDir,
          providerName: provider.name,
          baseDir: opts.baseDir,
        });
        if (sub === "login") {
          await runLogin({ provider, authStore, onProgress: progress });
          return 0;
        }
        if (sub === "logout") {
          await authStore.clear();
          progress("✓ Auth state deleted");
          return 0;
        }
        console.log(
          authStore.has()
            ? `Auth state present for "${provider.name}" (${authStore.path()})`
            : `No auth state for "${provider.name}"`,
        );
        return 0;
      }

      if (typeof values.prompt === "string") {
        const timeoutMs = parseTimeoutMs(values.timeout);
        const provider = await getProvider(values.provider);
        const authStore = createAuthStore({
          configDir,
          providerName: provider.name,
          baseDir: opts.baseDir,
        });
        const reply = await runOneShot({
          provider,
          authStore,
          prompt: values.prompt,
          headless: !values.headful,
          timeoutMs,
          onProgress: progress,
        });
        // stdout: response body only.
        process.stdout.write(`${reply}\n`);
        return 0;
      }

      console.log(help());
      return cmd === undefined ? 0 : 1;
    } catch (err) {
      return reportError(err);
    }
  }

  return { run };
}
```

- [ ] **Step 4: Verify**

Run: `bun run build && bun test packages/cli/src/create-cli.test.ts` → PASS. Then `bun run check` → PASS (the E2E in `cli.e2e.test.ts` still passes: it uses pinned providers without `--provider`).

- [ ] **Step 5: Commit and sync**

```bash
git add -A
git commit -m "feat(cli): config fallback, pinned --provider rejection, usage on unknown flags, exit-code table (Refs #3)"
gh issue comment 3 --body "Task 6 done: createCli resolves pinned → --provider → config defaultProvider; pinned CLIs reject --provider (exit 1); unknown flags print usage (exit 1); EXIT_CODES covers INVALID_ARGUMENT/INVALID_CONFIG/INVALID_PROVIDER; CHATBRIDGE_DEBUG=1 prints cause. Unit tests cover exit 5 paths. Next: Task 7 (dummy chat: session invalidation and reply delay)."
```

---

### Task 7: Dummy chat — session invalidation and reply delay

**Files:**
- Modify: `examples/dummy-chat/server.ts`, `examples/dummy-chat/server.test.ts`

**Interfaces:**
- Produces: `startDummyChat(port?)` resolves to `{ url: string; stop(): void; invalidateSessions(): void; setReplyDelayMs(ms: number): void }`.

- [ ] **Step 1: Failing tests**

Append to `examples/dummy-chat/server.test.ts` inside the `describe`:

```ts
  test("invalidateSessions makes /chat redirect even with the cookie", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    s.invalidateSessions();
    const res = await fetch(`${s.url}/chat`, {
      headers: { cookie: "session=ok" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
  });

  test("setReplyDelayMs is rendered into the chat page", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    s.setReplyDelayMs(1500);
    const chat = await fetch(`${s.url}/chat`, {
      headers: { cookie: "session=ok" },
    });
    expect(await chat.text()).toContain('name="reply-delay" content="1500"');
  });
```

Run: `bun test examples/dummy-chat` → FAIL.

- [ ] **Step 2: Implement**

Replace `examples/dummy-chat/server.ts`:

```ts
/** Minimal dummy web chat used for E2E verification of the framework.
 * Not a real service: fixed echo responses, cookie-based fake login.
 * Test hooks: invalidateSessions() (simulates an expired login) and
 * setReplyDelayMs() (simulates a slow response). */

const LOGIN_HTML = `<!doctype html>
<title>Dummy Chat — Login</title>
<h1>Dummy Chat</h1>
<form method="post" action="/do-login">
  <button id="login-button" type="submit">Log in</button>
</form>`;

function chatHtml(replyDelayMs: number): string {
  return `<!doctype html>
<title>Dummy Chat</title>
<meta name="reply-delay" content="${replyDelayMs}">
<h1>Dummy Chat</h1>
<div id="chat-log" data-state="idle"></div>
<textarea id="message-input"></textarea>
<button id="send-button" type="button">Send</button>
<script>
  const delay = Number(document.querySelector('meta[name="reply-delay"]').content);
  const log = document.getElementById("chat-log");
  const input = document.getElementById("message-input");
  document.getElementById("send-button").addEventListener("click", () => {
    const text = input.value;
    if (!text) return;
    input.value = "";
    const you = document.createElement("div");
    you.className = "message user";
    you.textContent = text;
    log.appendChild(you);
    log.dataset.state = "busy";
    setTimeout(() => {
      const reply = document.createElement("div");
      reply.className = "message assistant";
      reply.textContent = "Echo: " + text;
      log.appendChild(reply);
      log.dataset.state = "idle";
    }, delay);
  });
</script>`;
}

export interface DummyChat {
  url: string;
  stop(): void;
  /** After this call, existing session cookies are rejected (auth expired). */
  invalidateSessions(): void;
  /** Delay between send and the assistant reply; default 300 ms. */
  setReplyDelayMs(ms: number): void;
}

export async function startDummyChat(port = 8735): Promise<DummyChat> {
  let sessionsValid = true;
  let replyDelayMs = 300;

  function hasSession(req: Request): boolean {
    return (
      sessionsValid && (req.headers.get("cookie") ?? "").includes("session=ok")
    );
  }

  const server = Bun.serve({
    port,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/login") {
        return new Response(LOGIN_HTML, {
          headers: { "content-type": "text/html" },
        });
      }
      if (pathname === "/do-login" && req.method === "POST") {
        sessionsValid = true;
        return new Response(null, {
          status: 302,
          headers: {
            location: "/chat",
            "set-cookie": "session=ok; Path=/; HttpOnly",
          },
        });
      }
      if (pathname === "/chat") {
        if (!hasSession(req)) {
          return new Response(null, {
            status: 302,
            headers: { location: "/login" },
          });
        }
        return new Response(chatHtml(replyDelayMs), {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
    invalidateSessions: () => {
      sessionsValid = false;
    },
    setReplyDelayMs: (ms: number) => {
      replyDelayMs = ms;
    },
  };
}
```

Run: `bun run check` → PASS (existing E2E unchanged: default delay stays 300 ms).

- [ ] **Step 3: Commit and sync**

```bash
git add -A
git commit -m "test(dummy-chat): session invalidation and reply delay hooks (Refs #3)"
gh issue comment 3 --body "Task 7 done: dummy chat exposes invalidateSessions() and setReplyDelayMs() for exit-code E2E. Next: Task 8 (E2E tests for exit codes 3 and 4)."
```

---

### Task 8: E2E tests for exit codes 3 and 4

**Files:**
- Modify: `packages/cli/src/cli.e2e.test.ts`

**Interfaces:**
- Consumes: `invalidateSessions`, `setReplyDelayMs` (Task 7); exit mapping (Task 6); step timeout mapping (Task 4).

- [ ] **Step 1: Add the tests**

Append inside `describe("createCli")` in `packages/cli/src/cli.e2e.test.ts`:

```ts
  test("expired auth exits 3", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const provider = await prepareAuth(baseDir, server.url);
    server.invalidateSessions();
    const cli = createCli({ name: "test-cli", provider, baseDir });
    expect(await cli.run(["bun", "cli", "-p", "hello"])).toBe(3);
  }, 60_000);

  test("slow response exits 4 within the --timeout budget", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const provider = await prepareAuth(baseDir, server.url);
    server.setReplyDelayMs(5000);
    const cli = createCli({ name: "test-cli", provider, baseDir });
    const started = Date.now();
    const code = await cli.run(["bun", "cli", "-p", "hello", "--timeout", "1"]);
    expect(code).toBe(4);
    expect(Date.now() - started).toBeLessThan(4000);
  }, 60_000);
```

- [ ] **Step 2: Run**

Run: `bun run build && bun test packages/cli/src/cli.e2e.test.ts`
Expected: both new tests PASS. If the exit-4 test returns 0, the dummy page ignored the delay meta (check Task 7); if it returns 1, the `TimeoutError` was not mapped (check Task 4's `runStep` covers `waitForResponse`).

- [ ] **Step 3: Check, commit, sync**

Run: `bun run check` → PASS.

```bash
git add -A
git commit -m "test(cli): E2E coverage for exit codes 3 and 4 (Refs #3)"
gh issue comment 3 --body "Task 8 done: E2E tests prove exit 3 (expired auth) and exit 4 (response timeout); exit 5 is covered by unit tests from Task 6. Next: Task 9 (publish workflow + PUBLISHING.md)."
```

---

### Task 9: Publish workflow and release documentation

**Files:**
- Create: `.github/workflows/publish.yml`, `scripts/check-versions.sh`, `scripts/pack-all.sh`, `docs/PUBLISHING.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: pushing tag `vX.Y.Z` publishes the four packages; CI verifies packing on every PR.

- [ ] **Step 1: Scripts**

`scripts/check-versions.sh`:

```bash
#!/usr/bin/env bash
# Fails unless every publishable package.json has version == $1.
set -euo pipefail
expected="$1"
status=0
for dir in packages/provider packages/runtime packages/core packages/cli; do
  actual=$(node -p "require('./$dir/package.json').version")
  if [ "$actual" != "$expected" ]; then
    echo "$dir: version $actual != $expected" >&2
    status=1
  fi
done
exit $status
```

`scripts/pack-all.sh`:

```bash
#!/usr/bin/env bash
# Packs the four publishable packages into $1 (default: ./packs) in
# dependency order and sanity-checks each tarball.
set -euo pipefail
out=$(cd "$(dirname "${1:-packs}")" && pwd)/$(basename "${1:-packs}")
mkdir -p "$out"
for dir in packages/provider packages/runtime packages/core packages/cli; do
  (cd "$dir" && bun pm pack --destination "$out" --quiet)
done
for tgz in "$out"/*.tgz; do
  tar -tzf "$tgz" | grep -q 'package/dist/index.js' || { echo "$tgz: missing dist/index.js" >&2; exit 1; }
  tar -tzf "$tgz" | grep -q 'package/LICENSE' || { echo "$tgz: missing LICENSE" >&2; exit 1; }
  if tar -xOf "$tgz" package/package.json | grep -q 'workspace:'; then
    echo "$tgz: unresolved workspace: dependency" >&2; exit 1
  fi
done
ls -1 "$out"
```

Run `chmod +x scripts/*.sh`. Add `packs/` to `.gitignore`.

- [ ] **Step 2: Publish workflow**

Create `.github/workflows/publish.yml`:

```yaml
name: Publish
on:
  push:
    tags: ["v*"]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - run: npm install -g npm@latest # Trusted Publishing needs npm >= 11.5
      - run: bun install --frozen-lockfile
      - run: ./packages/runtime/node_modules/.bin/playwright install --with-deps chromium
      - run: bun run check
      - run: scripts/check-versions.sh "${GITHUB_REF_NAME#v}"
      - run: scripts/pack-all.sh packs
      - name: Publish in dependency order
        run: |
          set -euo pipefail
          for name in chatbridge-provider chatbridge-runtime chatbridge-core chatbridge; do
            # "<name>-<digit>..." so "chatbridge-" does not match "chatbridge-core-".
            tgz=$(ls packs/${name}-[0-9]*.tgz)
            npm publish "$tgz" --provenance --access public
          done
```

`bun pm pack` names scoped tarballs like `chatbridge-provider-0.1.0.tgz` and the unscoped CLI `chatbridge-0.1.0.tgz`; the `[0-9]` in the glob keeps the CLI pattern from matching the scoped packages.

- [ ] **Step 3: CI packs on every run**

`.github/workflows/ci.yml`: append `- run: scripts/pack-all.sh packs` after the Node smoke step.

- [ ] **Step 4: Release documentation**

Create `docs/PUBLISHING.md`:

````markdown
# Publishing

Packages: `@chatbridge/provider`, `@chatbridge/runtime`, `@chatbridge/core`,
`chatbridge`. Versions move in lockstep.

## One-time setup (npm side, done by a maintainer)

1. Confirm the `@chatbridge` scope: sign in to npmjs.com and create the
   organization `chatbridge` (Add Organization → free). If the name is taken,
   follow "Scope fallback" below before anything else.
2. Trusted Publishing: for each of the four packages, open
   Package → Settings → Trusted Publisher and register
   - Provider: GitHub Actions
   - Repository: `7milch/chatbridge-cli`
   - Workflow file: `publish.yml`
   Packages that do not exist yet cannot be configured; the very first
   publish of each package therefore happens once by hand:
   `scripts/pack-all.sh packs && for t in packs/chatbridge-provider-* packs/chatbridge-runtime-* packs/chatbridge-core-* packs/chatbridge-[0-9]*; do npm publish "$t" --access public; done`
   (in dependency order, with a granular access token). After that,
   register the trusted publisher and use the workflow.

## Cutting a release

1. On `main`, bump `version` in the four `package.json` files to the same
   value. Commit: `chore: release vX.Y.Z`.
2. `git tag vX.Y.Z && git push origin main vX.Y.Z`.
3. The `Publish` workflow runs `bun run check`, verifies the tag matches
   every package version, packs with `bun pm pack` (rewrites `workspace:*`),
   and runs `npm publish --provenance` in dependency order.

## Scope fallback

If `@chatbridge` is unavailable, rename in one commit:

| From | To |
|---|---|
| `@chatbridge/provider` | `@chatbridge-cli/provider` |
| `@chatbridge/runtime` | `@chatbridge-cli/runtime` |
| `@chatbridge/core` | `@chatbridge-cli/core` |
| `chatbridge` | `chatbridge-cli` |

Checklist: every `package.json` (`name`, `dependencies`, `devDependencies`,
`peerDependencies`), all `import` specifiers under `packages/` and
`examples/`, `README.md`, `CLAUDE.md`, `docs/ROADMAP.md`, this file,
`.github/workflows/*.yml` (tarball name prefixes), `scripts/pack-all.sh`,
`scripts/check-versions.sh`, and `createCli({ name })` in
`packages/cli/src/bin.ts`. Verify with `bun install && bun run check`.
````

- [ ] **Step 5: Verify locally**

Run: `bun run check && scripts/check-versions.sh 0.1.0 && scripts/pack-all.sh packs`
Expected: four tarballs listed, no error lines. `rm -rf packs` afterwards.

- [ ] **Step 6: Commit and sync**

```bash
git add -A
git commit -m "ci: tag-triggered npm publish with provenance; release docs (Refs #3)"
gh issue comment 3 --body "Task 9 done: publish.yml (v* tags → check → version guard → bun pm pack → npm publish --provenance), pack sanity check in CI, docs/PUBLISHING.md with Trusted Publishing setup and scope fallback. Next: Task 10 (README/ROADMAP updates), then the whole-branch review."
```

---

### Task 10: User-facing docs

**Files:**
- Modify: `README.md`, `docs/ROADMAP.md`

- [ ] **Step 1: README**

In `README.md`:

- Update "Status" to: `Milestone 1 (one-shot vertical slice) and milestone 2 (hardening + publishability) implemented. Packages are published to npm; interactive TUI is not built yet.`
- After "Quick start", add:

````markdown
## Install (npm)

```bash
npm install -g chatbridge            # CLI (Node >= 20 or Bun)
npm install @chatbridge/provider     # to write a provider
```

Providers are loaded with `--provider <npm-package|./path>` or from
`~/.config/chatbridge/config.json`:

```json
{ "defaultProvider": "@your-scope/your-provider" }
```

Exit codes: 1 invalid argument or config, 2 not logged in, 3 auth expired,
4 response timeout, 5 provider could not be loaded. Set `CHATBRIDGE_DEBUG=1`
to print the underlying error.
````

- [ ] **Step 2: ROADMAP**

Leave the milestone-2 heading as `— in progress (issue #3)`; it is switched to `done` by the merge step, not here.

- [ ] **Step 3: Check, commit, sync**

Run: `bun run check` → PASS.

```bash
git add -A
git commit -m "docs: npm install, config file, exit codes in README (Refs #3)"
gh issue comment 3 --body "Task 10 done: README documents npm install, config.json, exit codes, CHATBRIDGE_DEBUG. All plan tasks complete. Next: whole-branch review, then PR."
```

---

## Completion

After Task 10: whole-branch review (Fable) per repository policy, open a PR from `issue-3` to `main` titled `Milestone 2: hardening + publishability (#3)`, and after merge update `docs/ROADMAP.md` heading 2 to `— done (PR #<n>, <date>)`. The first actual `v0.1.0` publish is a user action following `docs/PUBLISHING.md`.
