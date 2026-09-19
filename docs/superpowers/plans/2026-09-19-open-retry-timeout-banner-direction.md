# Browser-open retry/timeout and banner gradient direction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the "Opening browser..." phase its own per-step timeout and a retry count, resolved built-in → provider → config.json → env, and add `direction` to the banner gradient mode.

**Architecture:** `Provider` gains an optional `open` field. `ChatSession.open()` (core) loops its launch→goto→isLoggedIn→startNewChat body up to `retries + 1` times under `open.timeoutMs`, closing the browser between attempts. `@chatbridge/cli` resolves the layers in a new `open-options.ts` and passes the result through `runOneShot` / `runInteractive`. The banner change is confined to `banner-options.ts` and `banner.ts`.

**Tech Stack:** TypeScript, Bun workspaces, `bun test`, Biome. Dependency direction `cli → core → runtime → provider`.

**Spec:** `docs/superpowers/specs/2026-09-19-open-retry-timeout-banner-direction-design.md`

## Global Constraints

- Every document, comment and commit message is in English.
- `bun run check` (Biome + `tsc --build` + `bun test`) must pass before every commit. Tests import cross-package code from `dist/`, so run `bun run build` after editing another package.
- Never import against the dependency direction `cli → core → runtime → provider`.
- Built-in defaults: opening timeout 120 000 ms, retries 0. Existing providers and CLIs must behave exactly as before.
- Env variable names: `CHATBRIDGE_OPEN_TIMEOUT` (seconds), `CHATBRIDGE_OPEN_RETRIES`. Config keys: `open.timeoutSec`, `open.retries`.
- Progress copy: first attempt `Opening browser...`, later attempts `Opening browser... (attempt k/n)`.
- Deviation from the spec, recorded here: `ChatSessionOptions.open` is **optional**, defaulting to `{ timeoutMs: opts.timeoutMs, retries: 0 }`, because `packages/vscode/src/create-extension.ts` also calls `ChatSession.open` and must keep working unchanged.
- Commit messages end with `(Refs #42)` (or `(Refs #81)` for the banner task) and the attribution trailer given in the session.

---

### Task 1: `Provider.open` field

**Files:**
- Modify: `packages/provider/src/index.ts:26-32`
- Test: `packages/provider/src/index.test.ts`

**Interfaces:**
- Produces: `Provider.open?: { timeoutMs?: number; retries?: number }` and exported type `ProviderOpenDefaults`.

- [ ] **Step 1: Write the failing test**

Append to `packages/provider/src/index.test.ts`:

```ts
test("defineProvider keeps the optional open defaults", () => {
  const p = defineProvider({
    name: "x",
    chatUrl: "http://127.0.0.1:1/",
    async navigateToLogin() {},
    async isLoggedIn() {
      return true;
    },
    async startNewChat() {},
    async sendMessage() {},
    async waitForResponse() {
      return "";
    },
    open: { timeoutMs: 5_000, retries: 2 },
  });
  expect(p.open).toEqual({ timeoutMs: 5_000, retries: 2 });
});
```

(Reuse the file's existing imports of `defineProvider`, `expect`, `test`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/provider`
Expected: FAIL — tsc/bun complains `open` does not exist in type `Provider`.

- [ ] **Step 3: Add the field**

In `packages/provider/src/index.ts`, before `export interface Provider`:

```ts
/** Provider defaults for the opening phase (launch → goto → isLoggedIn →
 * startNewChat). Users override both via config.json and env vars. */
export interface ProviderOpenDefaults {
  /** Per-step timeout in milliseconds. Built-in default 120 000. */
  timeoutMs?: number;
  /** How many times the whole phase is re-run after a launch or
   * navigation failure. Built-in default 0. */
  retries?: number;
}
```

Inside `Provider`, after `detectBlock?`:

```ts
  /** Optional. A slow service may raise the opening timeout; a flaky one
   * may ask for retries. See ProviderOpenDefaults. */
  open?: ProviderOpenDefaults;
```

- [ ] **Step 4: Run tests and build**

Run: `bun test packages/provider && bun run build`
Expected: PASS; `dist/` updated so core can see the type.

- [ ] **Step 5: Commit**

```bash
git add packages/provider
git commit -m "feat(provider): optional open defaults (timeoutMs, retries) (Refs #42)"
```

---

### Task 2: Retry loop in `ChatSession.open`

**Files:**
- Modify: `packages/core/src/chat-session.ts:23-38, 92-120`
- Modify: `packages/core/src/session.ts:12-20` (doc only: `OneShotOptions` inherits `open` via the spread)
- Test: `packages/core/src/chat-session.test.ts`

**Interfaces:**
- Consumes: nothing new (the loop is self-contained).
- Produces: `ChatSessionOptions.open?: { timeoutMs: number; retries: number }`, exported type `OpenOptions` from `@chatbridge/core` (re-exported in `packages/core/src/index.ts`). `runOneShot(opts)` forwards `open` because it passes `opts` whole.

- [ ] **Step 1: Write the failing tests**

Append inside the top-level `describe` of `packages/core/src/chat-session.test.ts` (after the existing `open` tests; the helpers `harness`, `opts`, `store` already exist):

```ts
describe("open retries", () => {
  function flakyLaunch(h: Harness, failures: number, err: () => Error) {
    let calls = 0;
    const real = h.launch;
    h.launch = async (o) => {
      calls++;
      if (calls <= failures) throw err();
      return real(o);
    };
    return () => calls;
  }

  test("retries 0 launches once and rethrows the launch error", async () => {
    const h = harness();
    const calls = flakyLaunch(h, 1, () => new Error("boom"));
    await expect(
      ChatSession.open({ ...opts(h), open: { timeoutMs: 1000, retries: 0 } }),
    ).rejects.toThrow("boom");
    expect(calls()).toBe(1);
  });

  test("a failed launch is retried and reports the attempt", async () => {
    const h = harness();
    const calls = flakyLaunch(h, 1, () => new Error("boom"));
    const progress: string[] = [];
    const s = await ChatSession.open({
      ...opts(h),
      open: { timeoutMs: 1000, retries: 1 },
      onProgress: (m) => progress.push(m),
    });
    expect(calls()).toBe(2);
    expect(progress).toEqual([
      "Opening browser...",
      "Opening browser... (attempt 2/2)",
    ]);
    await s.kill();
  });

  test("a timeout after launch closes the browser and retries", async () => {
    const h = harness();
    let gotos = 0;
    const real = h.launch;
    h.launch = async (o) => {
      const rt = await real(o);
      rt.page.goto = (async () => {
        gotos++;
        if (gotos === 1) {
          const e = new Error("t/o");
          e.name = "TimeoutError";
          throw e;
        }
        return null;
      }) as unknown as typeof rt.page.goto;
      return rt;
    };
    const s = await ChatSession.open({
      ...opts(h),
      open: { timeoutMs: 1000, retries: 2 },
    });
    expect(gotos).toBe(2);
    expect(h.closed).toBe(1);
    await s.kill();
  });

  test("the last attempt's error is thrown unchanged", async () => {
    const h = harness();
    let n = 0;
    flakyLaunch(h, 5, () => new Error(`boom ${++n}`));
    await expect(
      ChatSession.open({ ...opts(h), open: { timeoutMs: 1000, retries: 2 } }),
    ).rejects.toThrow("boom 3");
  });

  test.each([
    ["AuthExpiredError", (h: Harness) => void (h.loggedIn = false)],
    [
      "BlockedError",
      (h: Harness) => {
        h.loggedIn = false;
        h.hasDetectBlock = true;
        h.block = "challenge";
      },
    ],
  ])("%s is not retried", async (_name, arrange) => {
    const h = harness();
    arrange(h);
    let launches = 0;
    const real = h.launch;
    h.launch = async (o) => {
      launches++;
      return real(o);
    };
    await expect(
      ChatSession.open({ ...opts(h), open: { timeoutMs: 1000, retries: 3 } }),
    ).rejects.toBeInstanceOf(
      _name === "BlockedError" ? BlockedError : AuthExpiredError,
    );
    expect(launches).toBe(1);
    expect(h.closed).toBe(1);
  });

  test("BrowserUnavailableError is not retried", async () => {
    const h = harness();
    let launches = 0;
    h.launch = async () => {
      launches++;
      throw new Error("x");
    };
    await expect(
      ChatSession.open({
        ...opts(h),
        open: { timeoutMs: 1000, retries: 3 },
        missingBrowserExecutable: () => "/nowhere/chromium",
      }),
    ).rejects.toBeInstanceOf(BrowserUnavailableError);
    expect(launches).toBe(0);
  });

  test("open defaults to the turn timeout and no retries", async () => {
    const h = harness();
    const calls = flakyLaunch(h, 1, () => new Error("boom"));
    await expect(ChatSession.open(opts(h))).rejects.toThrow("boom");
    expect(calls()).toBe(1);
  });

  test("opening steps use open.timeoutMs, not timeoutMs", async () => {
    const h = harness();
    let defaultTimeout: number | undefined;
    const real = h.launch;
    h.launch = async (o) => {
      const rt = await real(o);
      rt.page.setDefaultTimeout = (ms: number) => {
        defaultTimeout = ms;
      };
      return rt;
    };
    const s = await ChatSession.open({
      ...opts(h),
      timeoutMs: 1000,
      open: { timeoutMs: 7000, retries: 0 },
    });
    expect(defaultTimeout).toBe(7000);
    await s.kill();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/chat-session.test.ts`
Expected: FAIL — `open` is not a known option; retries never happen.

- [ ] **Step 3: Implement the loop**

In `packages/core/src/chat-session.ts`, add after the `RuntimeLike` interface:

```ts
/** Resolved knobs for the opening phase. */
export interface OpenOptions {
  /** Per-step timeout for goto / isLoggedIn / startNewChat. */
  timeoutMs: number;
  /** Re-runs of the whole phase after a retryable failure. */
  retries: number;
}
```

Add to `ChatSessionOptions` after `timeoutMs`:

```ts
  /** Opening-phase knobs. Default: `{ timeoutMs, retries: 0 }`, which is
   * the pre-0.8.3 behaviour. */
  open?: OpenOptions;
```

Replace the body of `static async open` (from `onProgress?.("Opening browser...")` to the `return new ChatSession(...)`) with:

```ts
    const open = opts.open ?? { timeoutMs, retries: 0 };
    const launch =
      opts.launch ?? ((o: LaunchOptions) => BrowserRuntime.launch(o));
    const preCheck =
      opts.missingBrowserExecutable ??
      (needsHeadedPreCheck(opts) ? undefined : () => undefined);
    const attempts = open.retries + 1;
    for (let attempt = 1; ; attempt++) {
      onProgress?.(
        attempt === 1
          ? "Opening browser..."
          : `Opening browser... (attempt ${attempt}/${attempts})`,
      );
      try {
        const rt = await ChatSession.attempt(
          () => launch({ headless: opts.headless, provider, authStore }),
          preCheck,
          provider,
          open.timeoutMs,
        );
        return new ChatSession(rt, provider, timeoutMs, onProgress);
      } catch (err) {
        if (attempt >= attempts || !isRetryableOpenError(err)) throw err;
      }
    }
```

Add the helper method to the class (below `assertLoggedIn`) and the predicate at module level:

```ts
  /** One opening attempt: launch → goto chatUrl → isLoggedIn →
   * startNewChat. If any step after launch fails, the browser is closed
   * before the error propagates. */
  private static async attempt(
    launch: () => Promise<RuntimeLike>,
    preCheck: (() => string | undefined) | undefined,
    provider: Provider,
    timeoutMs: number,
  ): Promise<RuntimeLike> {
    const rt = await launchRuntime(launch, preCheck);
    try {
      rt.page.setDefaultTimeout(timeoutMs);
      await runStep("goto", timeoutMs, () => rt.page.goto(provider.chatUrl));
      await ChatSession.assertLoggedIn(provider, rt.page, timeoutMs);
      await runStep("startNewChat", timeoutMs, () =>
        provider.startNewChat(rt.page),
      );
    } catch (err) {
      await rt.close();
      throw err;
    }
    return rt;
  }
```

```ts
/** Auth, block and missing-Chromium failures cannot be fixed by opening
 * again; everything else (launch errors, step timeouts, page errors) can. */
export function isRetryableOpenError(err: unknown): boolean {
  return !(
    err instanceof AuthRequiredError ||
    err instanceof AuthExpiredError ||
    err instanceof BlockedError ||
    err instanceof BrowserUnavailableError
  );
}
```

Add `BrowserUnavailableError` to the `./errors.js` import. Keep the `authStore.has()` check where it is (before the loop). Export `OpenOptions` and `isRetryableOpenError` from `packages/core/src/index.ts` next to `ChatSessionOptions`.

In `packages/core/src/session.ts`, add to the `OneShotOptions` doc: `open` is accepted and forwarded (add the field explicitly for readability):

```ts
  /** Opening-phase knobs; see ChatSessionOptions.open. */
  open?: OpenOptions;
```

with `import type { OpenOptions } from "./chat-session.js";`.

- [ ] **Step 4: Run tests and check**

Run: `bun run check`
Expected: PASS. The existing "closes the browser when a step fails" tests still pass (one attempt, `closed` 1).

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): retry the opening phase under its own timeout (Refs #42)"
```

---

### Task 3: `open` section in `config.json`

**Files:**
- Modify: `packages/cli/src/config.ts:7-15, 80-101`
- Test: `packages/cli/src/config.test.ts`

**Interfaces:**
- Produces: `CliConfig.open?: { timeoutSec?: number; retries?: number }`.

- [ ] **Step 1: Write the failing tests**

Append to `describe("loadConfig", ...)` in `packages/cli/src/config.test.ts`:

```ts
  test("reads the open section", async () => {
    writeFileSync(
      setup(),
      JSON.stringify({ open: { timeoutSec: 30, retries: 2 } }),
    );
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect(cfg.open).toEqual({ timeoutSec: 30, retries: 2 });
  });

  test("a partial open section keeps only the given keys", async () => {
    writeFileSync(setup(), JSON.stringify({ open: { retries: 1 } }));
    const cfg = await loadConfig({ configDir: "test-cli", baseDir });
    expect(cfg.open).toEqual({ retries: 1 });
  });

  test.each([
    [{ open: 5 }, '"open" must be an object'],
    [{ open: { timeoutSec: "30" } }, '"open.timeoutSec" must be a positive number'],
    [{ open: { timeoutSec: 0 } }, '"open.timeoutSec" must be a positive number'],
    [{ open: { retries: -1 } }, '"open.retries" must be a non-negative integer'],
    [{ open: { retries: 1.5 } }, '"open.retries" must be a non-negative integer'],
  ])("rejects %j", async (doc, message) => {
    writeFileSync(setup(), JSON.stringify(doc));
    const p = loadConfig({ configDir: "test-cli", baseDir });
    await expect(p).rejects.toBeInstanceOf(ChatBridgeError);
    await expect(p).rejects.toThrow(message);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/src/config.test.ts`
Expected: FAIL — `cfg.open` undefined; invalid shapes accepted.

- [ ] **Step 3: Implement**

In `packages/cli/src/config.ts`, add to `CliConfig`:

```ts
  /** Opening-phase overrides; each key is optional and wins over the
   * provider's `open` defaults. Seconds, like --timeout. */
  open?: { timeoutSec?: number; retries?: number };
```

In `loadConfig`, destructure `open` alongside `shell` and add after the `shell` block:

```ts
  if (open !== undefined) {
    if (typeof open !== "object" || open === null || Array.isArray(open)) {
      throw invalid(file, '"open" must be an object');
    }
    const { timeoutSec, retries } = open as Record<string, unknown>;
    const out: NonNullable<CliConfig["open"]> = {};
    if (timeoutSec !== undefined) {
      if (typeof timeoutSec !== "number" || !(timeoutSec > 0)) {
        throw invalid(file, '"open.timeoutSec" must be a positive number');
      }
      out.timeoutSec = timeoutSec;
    }
    if (retries !== undefined) {
      if (!Number.isInteger(retries) || (retries as number) < 0) {
        throw invalid(file, '"open.retries" must be a non-negative integer');
      }
      out.retries = retries as number;
    }
    cfg.open = out;
  }
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/cli/src/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/config.ts packages/cli/src/config.test.ts
git commit -m "feat(cli): open section in config.json (Refs #42)"
```

---

### Task 4: `resolveOpenOptions` with env parsing

**Files:**
- Create: `packages/cli/src/open-options.ts`
- Test: `packages/cli/src/open-options.test.ts`

**Interfaces:**
- Consumes: `CliConfig.open` (Task 3), `Provider.open` (Task 1), `OpenOptions` from `@chatbridge/core` (Task 2).
- Produces: `DEFAULT_OPEN_OPTIONS`, `resolveOpenOptions({ provider, config, env }): OpenOptions`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/src/open-options.test.ts
import { describe, expect, test } from "bun:test";
import { ChatBridgeError } from "@chatbridge/core";
import { DEFAULT_OPEN_OPTIONS, resolveOpenOptions } from "./open-options.js";

describe("resolveOpenOptions", () => {
  test("built-in defaults when nothing is set", () => {
    expect(resolveOpenOptions({ provider: {}, config: {}, env: {} })).toEqual(
      DEFAULT_OPEN_OPTIONS,
    );
    expect(DEFAULT_OPEN_OPTIONS).toEqual({ timeoutMs: 120_000, retries: 0 });
  });

  test("provider overrides built-in, key by key", () => {
    expect(
      resolveOpenOptions({
        provider: { open: { retries: 2 } },
        config: {},
        env: {},
      }),
    ).toEqual({ timeoutMs: 120_000, retries: 2 });
  });

  test("config overrides provider, in seconds", () => {
    expect(
      resolveOpenOptions({
        provider: { open: { timeoutMs: 5_000, retries: 2 } },
        config: { open: { timeoutSec: 30 } },
        env: {},
      }),
    ).toEqual({ timeoutMs: 30_000, retries: 2 });
  });

  test("env overrides config; empty string is unset", () => {
    expect(
      resolveOpenOptions({
        provider: {},
        config: { open: { timeoutSec: 30, retries: 1 } },
        env: { CHATBRIDGE_OPEN_TIMEOUT: "45", CHATBRIDGE_OPEN_RETRIES: "" },
      }),
    ).toEqual({ timeoutMs: 45_000, retries: 1 });
  });

  test.each([
    [{ CHATBRIDGE_OPEN_TIMEOUT: "abc" }, "CHATBRIDGE_OPEN_TIMEOUT"],
    [{ CHATBRIDGE_OPEN_TIMEOUT: "0" }, "CHATBRIDGE_OPEN_TIMEOUT"],
    [{ CHATBRIDGE_OPEN_RETRIES: "-1" }, "CHATBRIDGE_OPEN_RETRIES"],
    [{ CHATBRIDGE_OPEN_RETRIES: "1.5" }, "CHATBRIDGE_OPEN_RETRIES"],
  ])("rejects %j naming the variable", (env, name) => {
    let err: unknown;
    try {
      resolveOpenOptions({ provider: {}, config: {}, env });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ChatBridgeError);
    expect((err as ChatBridgeError).code).toBe("INVALID_ARGUMENT");
    expect((err as Error).message).toContain(name);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/src/open-options.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/open-options.ts
import { ChatBridgeError, type OpenOptions } from "@chatbridge/core";
import type { Provider } from "@chatbridge/provider";
import type { CliConfig } from "./config.js";

export type { OpenOptions };

/** Built-in layer: the opening steps ran under --timeout's 120 s default
 * before 0.8.3, so this keeps them there. */
export const DEFAULT_OPEN_OPTIONS: OpenOptions = {
  timeoutMs: 120_000,
  retries: 0,
};

export interface ResolveOpenOptionsInput {
  provider: Pick<Provider, "open">;
  config: Pick<CliConfig, "open">;
  env: Record<string, string | undefined>;
}

function envNumber(
  env: Record<string, string | undefined>,
  name: string,
  check: (n: number) => boolean,
  expected: string,
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !check(n)) {
    throw new ChatBridgeError(
      "INVALID_ARGUMENT",
      `${name} must be ${expected}, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/** built-in → provider.open → config.open → env, each layer overriding only
 * the keys it sets. Config and env are in seconds; the result is in ms. */
export function resolveOpenOptions(
  input: ResolveOpenOptionsInput,
): OpenOptions {
  const out = { ...DEFAULT_OPEN_OPTIONS };
  const p = input.provider.open;
  if (p?.timeoutMs !== undefined) out.timeoutMs = p.timeoutMs;
  if (p?.retries !== undefined) out.retries = p.retries;
  const c = input.config.open;
  if (c?.timeoutSec !== undefined) out.timeoutMs = c.timeoutSec * 1000;
  if (c?.retries !== undefined) out.retries = c.retries;
  const envTimeout = envNumber(
    input.env,
    "CHATBRIDGE_OPEN_TIMEOUT",
    (n) => n > 0,
    "a positive number of seconds",
  );
  if (envTimeout !== undefined) out.timeoutMs = envTimeout * 1000;
  const envRetries = envNumber(
    input.env,
    "CHATBRIDGE_OPEN_RETRIES",
    (n) => Number.isInteger(n) && n >= 0,
    "a non-negative integer",
  );
  if (envRetries !== undefined) out.retries = envRetries;
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/cli/src/open-options.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/open-options.ts packages/cli/src/open-options.test.ts
git commit -m "feat(cli): resolve opening knobs built-in → provider → config → env (Refs #42)"
```

---

### Task 5: Wire the knobs through `createCli`

**Files:**
- Modify: `packages/cli/src/create-cli.ts:225-295`
- Test: `packages/cli/src/create-cli.test.ts`

**Interfaces:**
- Consumes: `resolveOpenOptions` (Task 4), `loadConfig` (Task 3), `runOneShot`/`runInteractive` accepting `open` (Task 2; `InteractiveOptions extends ChatSessionOptions` so it already accepts it).

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/create-cli.test.ts` (reuse `setup`, `captureStderr`, `stderrChunks`, `stubProvider`, `fixtures` from the file):

```ts
describe("opening knobs", () => {
  function withEnv(name: string, value: string, fn: () => Promise<void>) {
    const previous = process.env[name];
    process.env[name] = value;
    return fn().finally(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }

  test("a bad CHATBRIDGE_OPEN_RETRIES exits 1 before any launch", async () => {
    captureStderr();
    const cli = createCli({
      name: "test-cli",
      provider: stubProvider(),
      baseDir: setup(),
    });
    await withEnv("CHATBRIDGE_OPEN_RETRIES", "x", async () => {
      expect(await cli.run(["bun", "cli", "-p", "hi"])).toBe(1);
      expect(stderrChunks.join("")).toContain("CHATBRIDGE_OPEN_RETRIES");
    });
  });

  test("one-shot reads config.json: a broken file exits 1", async () => {
    captureStderr();
    const baseDir = setup();
    writeFileSync(join(baseDir, "test-cli", "config.json"), "{not json");
    const cli = createCli({
      name: "test-cli",
      provider: stubProvider(),
      baseDir,
    });
    expect(await cli.run(["bun", "cli", "-p", "hi"])).toBe(1);
    expect(stderrChunks.join("")).toContain("config.json");
  });
});
```

Add `writeFileSync` / `join` imports if the file lacks them (`node:fs`, `node:path`). Note: `setup()` in this test file creates `<baseDir>/test-cli`; check the helper and adjust the path if it names the directory differently.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/src/create-cli.test.ts`
Expected: the env test fails (the stub provider throws "provider must not be used" → exit 1 but stderr lacks the variable name, or the run reaches launch); the config test fails because one-shot does not read the file when the provider is pinned.

- [ ] **Step 3: Wire it**

In `packages/cli/src/create-cli.ts`:

1. `import { resolveOpenOptions } from "./open-options.js";`
2. In the interactive branch, after `const provider = await getProvider(values.provider, config);` add
   ```ts
   const open = resolveOpenOptions({ provider, config, env: process.env });
   ```
   and pass `open,` into the `runInteractive({...})` call next to `timeoutMs`.
3. In the one-shot branch replace
   ```ts
   const provider = await getProvider(values.provider);
   ```
   with
   ```ts
   const config = await loadConfig(location, {
     providerPinned: opts.provider !== undefined,
   });
   const provider = await getProvider(values.provider, config);
   const open = resolveOpenOptions({ provider, config, env: process.env });
   ```
   and pass `open,` into `runOneShot({...})`.
4. Update the README sentence quoted in the help/README about one-shot not reading the file (Task 7 handles README; here only code).

- [ ] **Step 4: Run check**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/create-cli.ts packages/cli/src/create-cli.test.ts
git commit -m "feat(cli): pass opening knobs to one-shot and interactive sessions (Refs #42)"
```

---

### Task 6: Banner gradient `direction`

**Files:**
- Modify: `packages/cli/src/tui/banner-options.ts`
- Modify: `packages/cli/src/tui/banner.ts:17-36, 38-58, 79-83`
- Modify: `packages/cli/src/create-cli.ts:23-26` (doc comment on `banner`)
- Test: `packages/cli/src/tui/banner.test.ts`

**Interfaces:**
- Produces: `BannerDirection = "vertical" | "horizontal" | "diagonal"`, `BannerOptions.direction?`, `BannerColorSpec.direction` and `.maxWidth` (both optional: default `"vertical"` and `0`, so existing call sites and tests compile).

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/tui/banner.test.ts`, inside the `describe` holding `bannerColorAt` tests:

```ts
  test("horizontal gradient runs along the columns", () => {
    const spec = {
      rows: 2,
      maxWidth: 3,
      colors: ["#000000", "#ffffff"],
      mode: "gradient" as const,
      direction: "horizontal" as const,
    };
    expect(bannerColorAt(0, 0, spec)).toBe("#000000");
    expect(bannerColorAt(1, 1, spec)).toBe("#808080");
    expect(bannerColorAt(0, 2, spec)).toBe("#ffffff");
  });
  test("diagonal gradient uses row + col", () => {
    const spec = {
      rows: 2,
      maxWidth: 2,
      colors: ["#000000", "#ffffff"],
      mode: "gradient" as const,
      direction: "diagonal" as const,
    };
    expect(bannerColorAt(0, 0, spec)).toBe("#000000");
    expect(bannerColorAt(0, 1, spec)).toBe("#808080");
    expect(bannerColorAt(1, 0, spec)).toBe("#808080");
    expect(bannerColorAt(1, 1, spec)).toBe("#ffffff");
  });
  test("a zero denominator yields the first stop", () => {
    const spec = {
      rows: 1,
      maxWidth: 1,
      colors: ["#000000", "#ffffff"],
      mode: "gradient" as const,
      direction: "horizontal" as const,
    };
    expect(bannerColorAt(0, 0, spec)).toBe("#000000");
  });
  test("horizontal columns are measured on the centred grid", () => {
    const [wide, narrow] = resolveBanner({
      name: "x",
      providerName: "p",
      banner: {
        lines: ["abcde", "c"],
        colors: ["#000000", "#ffffff"],
        mode: "gradient",
        direction: "horizontal",
      },
    });
    // "c" sits at column 2 of a 5-wide grid: the same colour as wide[2].
    expect(fgOf(narrow, 0)).toBe(fgOf(wide, 2));
  });
```

`fgOf(text, cellIndex)` — if the test file has no helper that reads a cell's colour out of a `StyledText`, add one following how the existing `resolveBanner` tests inspect chunks (e.g. iterate `text.chunks`, accumulate `[...chunk.text].length`, and return `chunk.fg` for the chunk covering the cell). Copy the accessor names from the existing tests in that file rather than guessing.

In the `validateBanner` describe:

```ts
  test("rejects an unknown direction", () => {
    expect(() =>
      validateBanner({
        lines: ["a"],
        colors: ["#000000", "#ffffff"],
        mode: "gradient",
        direction: "sideways" as never,
      }),
    ).toThrow('banner.direction: expected "vertical" | "horizontal" | "diagonal"');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/src/tui/banner.test.ts`
Expected: FAIL — type errors on `direction`/`maxWidth`; wrong colours.

- [ ] **Step 3: Implement**

`packages/cli/src/tui/banner-options.ts`:

```ts
/** Axis of a gradient banner. Only read when mode is "gradient". */
export type BannerDirection = "vertical" | "horizontal" | "diagonal";
const DIRECTIONS: readonly BannerDirection[] = [
  "vertical",
  "horizontal",
  "diagonal",
];
```

Add to `BannerOptions`:

```ts
  /** gradient only: vertical (default) runs down the rows, horizontal
   * along the columns of the centred grid, diagonal along row + col. */
  direction?: BannerDirection;
```

Update the `mode` doc comment: "gradient: cell (r, c) takes the linear mix of the (hex-only) colours at its position along `direction`". In `validateBanner`, after the `mode` computation:

```ts
  if (
    banner.direction !== undefined &&
    !DIRECTIONS.includes(banner.direction)
  ) {
    throw new Error(
      `banner.direction: expected "vertical" | "horizontal" | "diagonal", got ${JSON.stringify(banner.direction)}`,
    );
  }
```

(Place it before the early `return` on missing `colors` so a bad direction is caught even without colours? No — keep it after the colour checks: `direction` only matters with colours. Put it right after `const n = banner.colors.length;`.)

`packages/cli/src/tui/banner.ts`:

```ts
export interface BannerColorSpec {
  rows: number;
  colors: SpinnerColor[];
  mode: BannerMode;
  /** gradient only; default "vertical". */
  direction?: BannerDirection;
  /** Widest line in code points; needed by horizontal and diagonal. */
  maxWidth?: number;
}

/** Position 0..1 of cell (row, col) along the gradient axis. A degenerate
 * grid (one row, one column) is position 0. */
export function gradientPosition(
  row: number,
  col: number,
  spec: BannerColorSpec,
): number {
  const rows = spec.rows;
  const width = spec.maxWidth ?? 0;
  const direction = spec.direction ?? "vertical";
  let num: number;
  let den: number;
  if (direction === "horizontal") {
    num = col;
    den = width - 1;
  } else if (direction === "diagonal") {
    num = row + col;
    den = rows + width - 2;
  } else {
    num = row;
    den = rows - 1;
  }
  if (den <= 0) return 0;
  return Math.min(1, Math.max(0, num / den));
}
```

Replace the gradient branch of `bannerColorAt`:

```ts
  const t = gradientPosition(row, col, spec);
  const pos = t * (n - 1);
  const i = Math.min(Math.floor(pos), n - 2);
  return mixHex(colors[i] as string, colors[i + 1] as string, pos - i);
```

In `colourLine`, compute the centring offset once and add it to every `col` passed to `bannerColorAt`:

```ts
  const cells = [...line];
  const offset = Math.floor(((spec.maxWidth ?? cells.length) - cells.length) / 2);
```

and use `bannerColorAt(row, offset, spec)` for the first cell and `bannerColorAt(row, col + offset, spec)` inside the loop (the empty-line branch passes `offset` too).

In `resolveBanner`, build the spec with:

```ts
    const spec: BannerColorSpec = {
      rows: b.lines.length,
      maxWidth: Math.max(0, ...b.lines.map((l) => [...l].length)),
      colors: b.colors,
      mode: b.mode ?? "per-line",
      direction: b.direction,
    };
```

Export `BannerDirection` from `banner.ts` alongside `BannerMode`. Update the `banner` doc comment in `create-cli.ts` to mention `direction?`.

- [ ] **Step 4: Run check**

Run: `bun run check`
Expected: PASS; the existing vertical tests are unchanged in outcome.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/tui/banner-options.ts packages/cli/src/tui/banner.ts packages/cli/src/tui/banner.test.ts packages/cli/src/create-cli.ts
git commit -m "feat(cli): horizontal and diagonal direction for banner gradient mode (Refs #81)"
```

---

### Task 7: README

**Files:**
- Modify: `README.md:58-80` (config.json block and the paragraph on one-shot not reading it), `README.md:86-95` (createCli example), `README.md:108-115` (env vars), `README.md:148-152` (banner modes)

- [ ] **Step 1: Edit**

1. Config example becomes:
   ```json
   {
     "defaultProvider": "@your-scope/your-provider",
     "shell": { "leadIn": "Please check the execution result.", "autoSend": true },
     "open": { "timeoutSec": 180, "retries": 2 }
   }
   ```
   Add after the `shell` paragraph:
   > `open` is optional and tunes the "Opening browser..." phase: `timeoutSec` is the per-step timeout for navigating to the chat page, checking the login and starting a new chat (default 120, or what the provider declares), `retries` how many times the whole phase is re-run after a launch or navigation failure, closing the browser in between (default 0). Failures that opening again would not fix (auth expired, blocked by the service, Chromium missing) are never retried. `CHATBRIDGE_OPEN_TIMEOUT` (seconds) and `CHATBRIDGE_OPEN_RETRIES` override the file for one run. A provider sets its own defaults with `open: { timeoutMs, retries }`.
2. Replace the sentence "one-shot mode (`-p`) and `auth` never read the file when the provider is pinned" with "`auth` never reads the file; one-shot mode (`-p`) reads it for the `shell`-independent `open` section, so a broken file stops it at startup too."
3. In the `createCli` example add `direction: "horizontal",` under `mode: "gradient",` with the comment `// gradient only: vertical (default), horizontal, diagonal`.
4. In the interactive-mode banner bullet, change "a vertical `gradient` between hex stops" to "a `gradient` between hex stops running down (`vertical`, default), across (`horizontal`) or diagonally (`diagonal`) over the centred banner grid".

- [ ] **Step 2: Check and commit**

Run: `bun run check`

```bash
git add README.md
git commit -m "docs: opening-phase knobs, env vars and banner gradient direction (Refs #42, #81)"
```

---

## Self-review notes

- Spec §1 → Task 1; §2 → Tasks 3, 4, 5; §3 → Task 2; §4 → Task 6; §5 tests are embedded in each task; §6 → Task 7.
- Spec deviation (optional `ChatSessionOptions.open`) is stated in Global Constraints and mirrored in the spec by the same commit that adds this plan.
- Names used across tasks: `OpenOptions` (core, re-exported), `resolveOpenOptions`, `DEFAULT_OPEN_OPTIONS`, `CliConfig.open.timeoutSec`/`.retries`, `Provider.open.timeoutMs`/`.retries`, `BannerDirection`, `BannerColorSpec.maxWidth`, `gradientPosition`.
