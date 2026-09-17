# VSCode Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `createExtension({ id, displayName, provider, configDir })` factory in a new `@chatbridge/vscode` package that gives a vendor repository a sidebar chat view on top of `ChatSession`, plus the two runtime gaps (#52, #53) it needs.

**Architecture:** Detection of a missing Chromium lives in `@chatbridge/runtime`, classification (`BrowserUnavailableError`) and a cancellable `runLogin` in `@chatbridge/core`. Attachment formatting and `closeOrKill` move from the CLI to core so the extension never imports `@chatbridge/cli`. `packages/vscode` splits into a `vscode`-free layer (`SessionController`, `ChatViewBridge`, `commands.ts` against a narrow `VscodeUi` interface, `installBrowser` with an injected spawn) that is unit-tested under `bun test`, and one thin file (`create-extension.ts` + `vscode-ui.ts`) that touches the real `vscode` API and is covered by a single `@vscode/test-electron` E2E in `examples/vscode-dummy-chat`.

**Tech Stack:** TypeScript, Bun (workspaces, `bun test`), Playwright 1.63.0, esbuild (CJS bundle for the extension, IIFE bundle for the webview), `@types/vscode`, `@vscode/test-electron`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-17-vscode-extension-design.md`

## Global Constraints

- Branch `issue-57`; every commit message ends with `(Refs #57)` and the trailers `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01XkTHKt1JRH3rdns86gRiuc`.
- Run `bun install` once at the start of the branch. `bun run check` (Biome lint + `tsc --build` + `bun test`) must pass before every commit. After adding a dependency run `bun install` again (the lockfile changes; commit it).
- After every commit: `gh issue comment 57 --body "<what was committed> + What's next: <next task>"` (English).
- Dependency direction is one-way: `vscode → core → runtime → provider`, `cli → core`. `packages/vscode` never imports `@chatbridge/cli`; `packages/runtime` never imports `@chatbridge/core`.
- Only `packages/vscode/src/create-extension.ts`, `packages/vscode/src/vscode-ui.ts` and `packages/vscode/src/chat-view-provider.ts` may `import ... from "vscode"`. Unit tests never load the `vscode` module.
- Every document, comment, and commit message is in English.
- Auth content never reaches logs, `onProgress`, the output channel or error messages (core already guarantees this; do not log `authStore.path()` contents).
- Exact strings and numbers: `BROWSER_UNAVAILABLE` exit code `7`; `LOGIN_ABORTED` exit code `130`; CLI install hint `Run: npx playwright install chromium`; close-or-kill timeout `5_000` ms; default `timeoutSec` `120`; default `headless` `true`; attachment limits `MAX_FILE_BYTES = 200 * 1024`, `MAX_TOTAL_BYTES = 1024 * 1024`; login poll interval `1_000` ms; separator texts `New chat`, `Logged in`, `Logged out`.
- Contributed IDs are `<id>` (view container), `<id>.chat` (view), `<id>.login`, `<id>.logout`, `<id>.newChat`, `<id>.installBrowser`, `<id>.sendSelection`, `<id>.sendFile`, `<id>.focus` (commands), `<id>.headless`, `<id>.timeoutSec` (settings).
- New package version is `0.6.0` like the others (the next tag bumps all five; `scripts/check-versions.sh` and `scripts/pack-all.sh` gain `packages/vscode`).
- `.agents/skills/` is a stale copy of `.claude/skills/`; edit only `.claude/skills/`.
- Subagent model policy: Tasks 2, 4, 9 → Sonnet; Tasks 1, 3, 5, 6, 7, 8 → Opus.

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/runtime/src/browser-executable.ts` (new) | `missingBrowserExecutable`, `isMissingExecutableError` | 1 |
| `packages/runtime/src/browser-executable.test.ts` (new) | both helpers with injected inputs | 1 |
| `packages/runtime/src/index.ts` | export the new module | 1 |
| `packages/core/src/errors.ts` | `BrowserUnavailableError`, `LoginAbortedError` | 1, 3 |
| `packages/core/src/launch-runtime.ts` (new) | `launchRuntime`: pre-check + error mapping around a launch | 1 |
| `packages/core/src/launch-runtime.test.ts` (new) | pre-check throws, mapping, pass-through | 1 |
| `packages/core/src/chat-session.ts` | `open` goes through `launchRuntime` | 1 |
| `packages/core/src/session.ts` | `runLogin` through `launchRuntime`; `signal`; injectable `launch` | 1, 3 |
| `packages/core/src/session.test.ts` (new) | `runLogin` unit tests with a fake runtime | 3 |
| `packages/cli/src/exit-codes.ts` (new) | `exitCodeFor`, `describeError` (pure) | 2 |
| `packages/cli/src/exit-codes.test.ts` (new) | code map, install hint | 2 |
| `packages/cli/src/create-cli.ts` | use `exit-codes.ts`; SIGINT → `AbortSignal` for `auth login`; help text | 2, 3 |
| `packages/core/src/attachment.ts` (new) | `Attachment`, limits, `fenceFor`, `formatAttachment`, `formatSize` | 4 |
| `packages/core/src/attachment.test.ts` (new) | moved fence tests + `formatAttachment` | 4 |
| `packages/core/src/close-session.ts` (new, moved) | `closeWithTimeout`, `closeOrKill` | 4 |
| `packages/core/src/close-session.test.ts` (moved) | unchanged tests | 4 |
| `packages/cli/src/fence.ts`, `fence.test.ts`, `tui/close-session.ts`, `tui/close-session.test.ts` | deleted | 4 |
| `packages/cli/src/mentions/expand-mentions.ts`, `shell/format-result.ts`, `tui/chat-model.ts`, `tui/run-interactive.ts`, `tui/chat-view.ts` | import from `@chatbridge/core` | 4 |
| `packages/vscode/package.json`, `tsconfig.json`, `tsconfig.webview.json`, `README.md`, `LICENSE` | package scaffold | 5 |
| `packages/vscode/src/protocol.ts` (new) | `ToHost`, `ToWebview`, `State`, `Message`, `Status` | 5 |
| `packages/vscode/src/session-controller.ts` (new) | state machine, history, pending attachments | 5 |
| `packages/vscode/src/session-controller.test.ts` (new) | transitions and error codes | 5 |
| `packages/vscode/src/install-browser.ts` (new) | spawn `playwright/cli.js install chromium` | 6 |
| `packages/vscode/src/install-browser.test.ts` (new) | args, env, progress parsing, exit code | 6 |
| `packages/vscode/src/manifest.ts` (new) | `missingContributions(packageJSON, id)` | 6 |
| `packages/vscode/src/manifest.test.ts` (new) | missing IDs are listed | 6 |
| `packages/vscode/src/chat-view-bridge.ts` (new) | `ToHost` → handlers, `state`/`progress` → webview | 7 |
| `packages/vscode/src/chat-view-bridge.test.ts` (new) | fake webview | 7 |
| `packages/vscode/src/webview-html.ts` (new) | `buildHtml` with nonce + CSP | 7 |
| `packages/vscode/src/webview-html.test.ts` (new) | CSP string | 7 |
| `packages/vscode/src/vscode-ui.ts` (new) | `VscodeUi` interface + `createVscodeUi(vscode, id)` | 7 |
| `packages/vscode/src/commands.ts` (new) | command handlers against `VscodeUi` | 7 |
| `packages/vscode/src/commands.test.ts` (new) | fake ui + fake controller | 7 |
| `packages/vscode/src/webview/main.ts`, `style.css` (new) | DOM layer | 7 |
| `packages/vscode/src/chat-view-provider.ts` (new) | `WebviewViewProvider` | 7 |
| `packages/vscode/src/create-extension.ts`, `index.ts` (new) | factory | 7 |
| `examples/vscode-dummy-chat/*` (new) | manifest template, bundle, E2E | 8 |
| `.github/workflows/ci.yml`, `package.json` (root), `tsconfig.json` (root), `scripts/pack-all.sh`, `scripts/check-versions.sh`, `.github/workflows/publish.yml` | build + CI + publish wiring | 5, 8 |
| `README.md`, `docs/ROADMAP.md`, `.claude/skills/creating-provider-repo/SKILL.md`, `packages/vscode/README.md` | docs | 9 |

---

### Task 1: `BrowserUnavailableError` (#52) — runtime detection, core classification

**Files:**
- Create: `packages/runtime/src/browser-executable.ts`, `packages/runtime/src/browser-executable.test.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/core/src/errors.ts`
- Create: `packages/core/src/launch-runtime.ts`, `packages/core/src/launch-runtime.test.ts`
- Modify: `packages/core/src/chat-session.ts:24-101`, `packages/core/src/session.ts:26-58`, `packages/core/src/index.ts`

**Interfaces:**
- Produces (runtime): `missingBrowserExecutable(executablePath?: string, exists?: (p: string) => boolean): string | undefined`; `isMissingExecutableError(err: unknown): boolean`.
- Produces (core): `class BrowserUnavailableError extends ChatBridgeError` with `code === "BROWSER_UNAVAILABLE"`; `launchRuntime<T>(launch: () => Promise<T>, missing?: () => string | undefined): Promise<T>`; `ChatSessionOptions.missingBrowserExecutable?: () => string | undefined` and `LoginOptions.launch?` / `LoginOptions.missingBrowserExecutable?` (test-only).

- [ ] **Step 1: Write the failing runtime tests**

`packages/runtime/src/browser-executable.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  isMissingExecutableError,
  missingBrowserExecutable,
} from "./browser-executable.js";

describe("missingBrowserExecutable", () => {
  test("returns undefined when the executable exists", () => {
    expect(missingBrowserExecutable("/x/chrome", () => true)).toBeUndefined();
  });

  test("returns the expected path when it does not exist", () => {
    expect(missingBrowserExecutable("/x/chrome", () => false)).toBe("/x/chrome");
  });

  test("defaults to Playwright's chromium path", () => {
    const result = missingBrowserExecutable(undefined, () => false);
    expect(result).toContain("chrom");
  });
});

describe("isMissingExecutableError", () => {
  test("matches Playwright's message", () => {
    const err = new Error(
      "Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome\n╔══╗",
    );
    expect(isMissingExecutableError(err)).toBe(true);
  });

  test("rejects other errors and non-errors", () => {
    expect(isMissingExecutableError(new Error("connect ECONNREFUSED"))).toBe(false);
    expect(isMissingExecutableError("Executable doesn't exist at")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/runtime/src/browser-executable.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the runtime helpers**

`packages/runtime/src/browser-executable.ts`:

```ts
import { existsSync } from "node:fs";
import { chromium } from "playwright";

/** The path Playwright would launch, when nothing is installed there;
 * `undefined` when the browser is present. Both inputs are injectable so
 * the check is testable without touching the real cache directory. */
export function missingBrowserExecutable(
  executablePath: string = chromium.executablePath(),
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return exists(executablePath) ? undefined : executablePath;
}

/** Playwright reports a missing browser as a plain Error whose message
 * starts with this phrase, followed by its boxed install hint. Used as a
 * fallback when the pre-launch check passed (e.g. the headless shell is
 * missing while the full browser is present). */
export function isMissingExecutableError(err: unknown): boolean {
  return (
    err instanceof Error && err.message.includes("Executable doesn't exist at")
  );
}
```

Add `export * from "./browser-executable.js";` to `packages/runtime/src/index.ts`.

- [ ] **Step 4: Run the runtime tests**

Run: `bun test packages/runtime/src/browser-executable.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing core tests**

`packages/core/src/launch-runtime.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { BrowserUnavailableError } from "./errors.js";
import { launchRuntime } from "./launch-runtime.js";

describe("launchRuntime", () => {
  test("throws BrowserUnavailableError before launching when the check fails", async () => {
    let launched = 0;
    const p = launchRuntime(
      async () => {
        launched++;
        return "rt";
      },
      () => "/cache/chromium-1/chrome",
    );
    await expect(p).rejects.toBeInstanceOf(BrowserUnavailableError);
    await expect(p).rejects.toThrow("/cache/chromium-1/chrome");
    expect(launched).toBe(0);
  });

  test("returns the runtime when the check passes", async () => {
    expect(await launchRuntime(async () => "rt", () => undefined)).toBe("rt");
  });

  test("wraps Playwright's missing-executable error", async () => {
    const cause = new Error("Executable doesn't exist at /x/headless_shell\n╔═╗");
    const p = launchRuntime(async () => {
      throw cause;
    }, () => undefined);
    await expect(p).rejects.toBeInstanceOf(BrowserUnavailableError);
    const err = await p.catch((e) => e);
    expect(err.code).toBe("BROWSER_UNAVAILABLE");
    expect(err.cause).toBe(cause);
    expect(err.message).not.toContain("╔");
  });

  test("passes other launch errors through unchanged", async () => {
    const cause = new Error("spawn ENOENT");
    await expect(
      launchRuntime(async () => {
        throw cause;
      }, () => undefined),
    ).rejects.toBe(cause);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun run build && bun test packages/core/src/launch-runtime.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 7: Implement the error and `launchRuntime`**

Append to `packages/core/src/errors.ts`:

```ts
/** Playwright's Chromium is not installed. The message names the expected
 * path; the CLI prints an install hint and the VSCode extension offers an
 * Install button. */
export class BrowserUnavailableError extends ChatBridgeError {
  constructor(message: string, options?: ErrorOptions) {
    super("BROWSER_UNAVAILABLE", message, options);
  }
}
```

`packages/core/src/launch-runtime.ts`:

```ts
import {
  isMissingExecutableError,
  missingBrowserExecutable,
} from "@chatbridge/runtime";
import { BrowserUnavailableError } from "./errors.js";

/** Runs a browser launch under the missing-Chromium classification: a
 * failed pre-check throws before anything is spawned, and a launch that
 * still fails with Playwright's missing-executable error is wrapped. Every
 * other failure passes through unchanged. */
export async function launchRuntime<T>(
  launch: () => Promise<T>,
  missing: () => string | undefined = missingBrowserExecutable,
): Promise<T> {
  const path = missing();
  if (path !== undefined) {
    throw new BrowserUnavailableError(
      `Chromium is not installed (expected at ${path}).`,
    );
  }
  try {
    return await launch();
  } catch (err) {
    if (isMissingExecutableError(err)) {
      const firstLine = (err as Error).message.split("\n")[0];
      throw new BrowserUnavailableError(`Chromium is not installed: ${firstLine}`, {
        cause: err,
      });
    }
    throw err;
  }
}
```

In `packages/core/src/chat-session.ts`, add to `ChatSessionOptions`:

```ts
  /** Test-only: replaces the missing-browser pre-check. Defaults to the
   * runtime check, or to "present" when `launch` is injected. */
  missingBrowserExecutable?: () => string | undefined;
```

and in `open()` replace

```ts
    const launch =
      opts.launch ?? ((o: LaunchOptions) => BrowserRuntime.launch(o));
    const rt = await launch({ headless: opts.headless, provider, authStore });
```

with:

```ts
    const launch =
      opts.launch ?? ((o: LaunchOptions) => BrowserRuntime.launch(o));
    const rt = await launchRuntime(
      () => launch({ headless: opts.headless, provider, authStore }),
      opts.missingBrowserExecutable ??
        (opts.launch ? () => undefined : undefined),
    );
```

(`undefined` as the second argument selects the default runtime check.)

In `packages/core/src/session.ts`, extend `LoginOptions` and `runLogin` the same way:

```ts
export interface LoginOptions {
  provider: Provider;
  authStore: AuthStore;
  onProgress?: (message: string) => void;
  /** Test-only: replaces BrowserRuntime.launch. */
  launch?: (opts: LaunchOptions) => Promise<RuntimeLike>;
  /** Test-only: see ChatSessionOptions.missingBrowserExecutable. */
  missingBrowserExecutable?: () => string | undefined;
}
```

```ts
  const launch = opts.launch ?? BrowserRuntime.launch;
  const rt = await launchRuntime(
    () => launch({ headless: false, provider, authStore }),
    opts.missingBrowserExecutable ??
      (opts.launch ? () => undefined : undefined),
  );
```

(import `LaunchOptions` from `@chatbridge/runtime` and `RuntimeLike` from `./chat-session.js`.) Export `launchRuntime` from `packages/core/src/index.ts`.

- [ ] **Step 8: Run all tests**

Run: `bun run check`
Expected: PASS. The existing `chat-session.test.ts` keeps working because an injected `launch` skips the pre-check.

- [ ] **Step 9: Commit**

```bash
git add packages/runtime/src packages/core/src
git commit -m "feat(core): BrowserUnavailableError for a missing Chromium (Refs #57, closes #52)"
```

---

### Task 2: CLI exit code 7 and the install hint

**Files:**
- Create: `packages/cli/src/exit-codes.ts`, `packages/cli/src/exit-codes.test.ts`
- Modify: `packages/cli/src/create-cli.ts:43-56` (remove `EXIT_CODES`), `:141-161` (`reportError`), help text `:95`

**Interfaces:**
- Produces: `exitCodeFor(code: string): number`; `describeError(err: ChatBridgeError): string` (the message plus, for `BROWSER_UNAVAILABLE`, `\nRun: npx playwright install chromium`).

- [ ] **Step 1: Write the failing test**

`packages/cli/src/exit-codes.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  BlockedError,
  BrowserUnavailableError,
  ChatBridgeError,
} from "@chatbridge/core";
import { describeError, exitCodeFor } from "./exit-codes.js";

describe("exitCodeFor", () => {
  test("maps every framework code", () => {
    expect(exitCodeFor("INVALID_ARGUMENT")).toBe(1);
    expect(exitCodeFor("AUTH_REQUIRED")).toBe(2);
    expect(exitCodeFor("AUTH_EXPIRED")).toBe(3);
    expect(exitCodeFor("RESPONSE_TIMEOUT")).toBe(4);
    expect(exitCodeFor("PROVIDER_LOAD")).toBe(5);
    expect(exitCodeFor("BLOCKED")).toBe(6);
    expect(exitCodeFor("BROWSER_UNAVAILABLE")).toBe(7);
    expect(exitCodeFor("LOGIN_ABORTED")).toBe(130);
  });

  test("unknown codes fall back to 1", () => {
    expect(exitCodeFor("SOMETHING_NEW")).toBe(1);
  });
});

describe("describeError", () => {
  test("appends the install hint for a missing browser", () => {
    const err = new BrowserUnavailableError("Chromium is not installed (expected at /x).");
    expect(describeError(err)).toBe(
      "Chromium is not installed (expected at /x).\nRun: npx playwright install chromium",
    );
  });

  test("other errors are the message alone", () => {
    expect(describeError(new BlockedError("blocked"))).toBe("blocked");
    expect(describeError(new ChatBridgeError("X", "m"))).toBe("m");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/cli/src/exit-codes.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/cli/src/exit-codes.ts`:

```ts
import type { ChatBridgeError } from "@chatbridge/core";

/** Single source of truth for `ChatBridgeError.code` → process exit code. */
const EXIT_CODES: Record<string, number> = {
  INVALID_ARGUMENT: 1,
  INVALID_CONFIG: 1,
  AUTH_REQUIRED: 2,
  AUTH_EXPIRED: 3,
  RESPONSE_TIMEOUT: 4,
  PROVIDER_LOAD: 5,
  INVALID_PROVIDER: 5,
  INVALID_STATE: 1,
  BLOCKED: 6,
  BROWSER_UNAVAILABLE: 7,
  // Shell convention for "terminated by Ctrl-C".
  LOGIN_ABORTED: 130,
};

export function exitCodeFor(code: string): number {
  return EXIT_CODES[code] ?? 1;
}

export const INSTALL_HINT = "Run: npx playwright install chromium";

/** The stderr text for a framework error: the message, plus the install
 * hint when Chromium is missing. */
export function describeError(err: ChatBridgeError): string {
  return err.code === "BROWSER_UNAVAILABLE"
    ? `${err.message}\n${INSTALL_HINT}`
    : err.message;
}
```

In `create-cli.ts`: delete the local `EXIT_CODES`; in `reportError` replace `process.stderr.write(\`${opts.name}: ${err.message}\n\`)` with `process.stderr.write(\`${opts.name}: ${describeError(err)}\n\`)` and `return EXIT_CODES[err.code] ?? 1;` with `return exitCodeFor(err.code);`. Update the help line to:

```
"Exit codes: 1 usage/config, 2 not logged in, 3 auth expired, 4 timeout, 5 provider load, 6 blocked by the service (try --headful), 7 Chromium not installed, 130 login cancelled.",
```

- [ ] **Step 4: Run tests**

Run: `bun run check`
Expected: PASS. (The `--help` snapshot test, if any, needs the new line.)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src
git commit -m "feat(cli): exit 7 with an install hint when Chromium is missing (Refs #57)"
```

---

### Task 3: Cancellable `runLogin` (#53)

**Files:**
- Modify: `packages/core/src/errors.ts`, `packages/core/src/session.ts`
- Create: `packages/core/src/session.test.ts`
- Modify: `packages/cli/src/create-cli.ts:206-208` (auth login)

**Interfaces:**
- Produces: `class LoginAbortedError extends ChatBridgeError` (`code === "LOGIN_ABORTED"`); `LoginOptions.signal?: AbortSignal`; `LoginOptions.pollIntervalMs?: number` (test-only, default `1_000`).

- [ ] **Step 1: Write the failing tests**

`packages/core/src/session.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Page, Provider } from "@chatbridge/provider";
import type { AuthStore } from "@chatbridge/runtime";
import type { RuntimeLike } from "./chat-session.js";
import { LoginAbortedError } from "./errors.js";
import { runLogin } from "./session.js";

interface Fake {
  rt: RuntimeLike & { saved: number; closed: number; killed: number };
  provider: Provider;
  loggedIn: boolean;
  launches: number;
}

function fake(): Fake {
  const f: Fake = {
    loggedIn: false,
    launches: 0,
    provider: {
      name: "fake",
      chatUrl: "http://x/chat",
      navigateToLogin: async () => {},
      isLoggedIn: async () => f.loggedIn,
      startNewChat: async () => {},
      sendMessage: async () => {},
      waitForResponse: async () => "",
    } as unknown as Provider,
    rt: {
      page: { setDefaultTimeout() {} } as unknown as Page,
      saved: 0,
      closed: 0,
      killed: 0,
      async saveAuthState() {
        this.saved++;
      },
      async close() {
        this.closed++;
      },
      async kill() {
        this.killed++;
      },
    },
  };
  return f;
}

function opts(f: Fake, extra: Partial<Parameters<typeof runLogin>[0]> = {}) {
  return {
    provider: f.provider,
    authStore: {} as AuthStore,
    launch: async () => {
      f.launches++;
      return f.rt;
    },
    pollIntervalMs: 5,
    ...extra,
  };
}

describe("runLogin", () => {
  test("saves and closes once isLoggedIn turns true", async () => {
    const f = fake();
    setTimeout(() => {
      f.loggedIn = true;
    }, 20);
    await runLogin(opts(f));
    expect(f.rt.saved).toBe(1);
    expect(f.rt.closed).toBe(1);
    expect(f.rt.killed).toBe(0);
  });

  test("abort during polling kills the browser and rejects with LoginAbortedError", async () => {
    const f = fake();
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 20);
    await expect(runLogin(opts(f, { signal: ac.signal }))).rejects.toBeInstanceOf(
      LoginAbortedError,
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(f.rt.killed).toBe(1);
    expect(f.rt.saved).toBe(0);
  });

  test("an already-aborted signal rejects before launching", async () => {
    const f = fake();
    const ac = new AbortController();
    ac.abort();
    await expect(runLogin(opts(f, { signal: ac.signal }))).rejects.toBeInstanceOf(
      LoginAbortedError,
    );
    expect(f.launches).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/core/src/session.test.ts`
Expected: FAIL (`LoginAbortedError` not exported; `pollIntervalMs` unknown; abort never observed).

- [ ] **Step 3: Implement**

Append to `errors.ts`:

```ts
/** `runLogin` was cancelled through its AbortSignal (the CLI's Ctrl-C, the
 * extension's cancel button). The browser was killed; nothing was saved. */
export class LoginAbortedError extends ChatBridgeError {
  constructor(message = "Login cancelled.", options?: ErrorOptions) {
    super("LOGIN_ABORTED", message, options);
  }
}
```

Rewrite `runLogin` in `session.ts`:

```ts
export interface LoginOptions {
  provider: Provider;
  authStore: AuthStore;
  onProgress?: (message: string) => void;
  /** Cancels the login: polling stops, the browser is killed, the promise
   * rejects with LoginAbortedError. */
  signal?: AbortSignal;
  /** Test-only: replaces BrowserRuntime.launch. */
  launch?: (opts: LaunchOptions) => Promise<RuntimeLike>;
  /** Test-only: see ChatSessionOptions.missingBrowserExecutable. */
  missingBrowserExecutable?: () => string | undefined;
  /** Test-only: isLoggedIn poll interval; default 1 000 ms. */
  pollIntervalMs?: number;
}

const LOGIN_NAVIGATION_TIMEOUT_MS = 30_000;
const LOGIN_POLL_INTERVAL_MS = 1_000;

/** Resolves after `ms`, or rejects with LoginAbortedError as soon as the
 * signal aborts, so a cancel never waits out the interval. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new LoginAbortedError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Headful login flow: the user logs in manually; we poll for completion.
 * No overall deadline (MFA may take a while); `signal` cancels. */
export async function runLogin(opts: LoginOptions): Promise<void> {
  const { provider, authStore, onProgress, signal } = opts;
  if (signal?.aborted) throw new LoginAbortedError();
  onProgress?.("Opening browser...");
  const launch = opts.launch ?? BrowserRuntime.launch;
  const rt = await launchRuntime(
    () => launch({ headless: false, provider, authStore }),
    opts.missingBrowserExecutable ??
      (opts.launch ? () => undefined : undefined),
  );
  let aborted = false;
  try {
    if (signal?.aborted) throw new LoginAbortedError();
    rt.page.setDefaultTimeout(LOGIN_NAVIGATION_TIMEOUT_MS);
    await runStep("navigateToLogin", LOGIN_NAVIGATION_TIMEOUT_MS, () =>
      provider.navigateToLogin(rt.page),
    );
    onProgress?.(`Please log in to ${provider.name}.`);
    while (!(await provider.isLoggedIn(rt.page))) {
      await sleepUnlessAborted(opts.pollIntervalMs ?? LOGIN_POLL_INTERVAL_MS, signal);
    }
    onProgress?.("✓ Login detected");
    await rt.saveAuthState();
    onProgress?.("✓ Session saved");
  } catch (err) {
    if (err instanceof LoginAbortedError) aborted = true;
    throw err;
  } finally {
    // A cancelled login presumes nothing about the page: kill, don't close.
    if (aborted) await rt.kill();
    else await rt.close();
  }
}
```

(`isLoggedIn` itself is not interruptible; an abort during a slow `isLoggedIn` takes effect at the next sleep. Note this in a comment.)

In `create-cli.ts` `auth login`:

```ts
        if (sub === "login") {
          const ac = new AbortController();
          const onSigint = () => ac.abort();
          process.once("SIGINT", onSigint);
          try {
            await runLogin({
              provider,
              authStore,
              onProgress: progress,
              signal: ac.signal,
            });
          } finally {
            process.off("SIGINT", onSigint);
          }
          return 0;
        }
```

`LOGIN_ABORTED` already maps to 130 (Task 2).

- [ ] **Step 4: Run tests**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/cli/src
git commit -m "feat(core): runLogin accepts an AbortSignal; CLI wires Ctrl-C to it (Refs #57, closes #53)"
```

---

### Task 4: Move `attachment` helpers and `closeOrKill` to core

**Files:**
- Create: `packages/core/src/attachment.ts`, `packages/core/src/attachment.test.ts`
- Move: `packages/cli/src/tui/close-session.ts` → `packages/core/src/close-session.ts`; `packages/cli/src/tui/close-session.test.ts` → `packages/core/src/close-session.test.ts`
- Delete: `packages/cli/src/fence.ts`, `packages/cli/src/fence.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/cli/src/mentions/expand-mentions.ts`, `packages/cli/src/shell/format-result.ts`, `packages/cli/src/tui/chat-model.ts:22`, `packages/cli/src/tui/run-interactive.ts:12`, `packages/cli/src/tui/chat-view.ts:10`

**Interfaces:**
- Produces (core): `interface Attachment { path: string; bytes: number }`, `MAX_FILE_BYTES`, `MAX_TOTAL_BYTES`, `fenceFor(content)`, `formatAttachment(path, content)`, `formatSize(bytes)`, `closeWithTimeout(session, ms)`, `closeOrKill(session, ms)`, `ClosableSession`, `KillableSession`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/attachment.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { fenceFor, formatAttachment, formatSize } from "./attachment.js";

describe("fenceFor", () => {
  test("three backticks when the content has none", () => {
    expect(fenceFor("plain\n")).toBe("```");
  });
  test("one longer than the longest run at a line start", () => {
    expect(fenceFor("a\n```\nb\n")).toBe("````");
    expect(fenceFor("`````x\n")).toBe("``````");
  });
  test("backticks not at a line start do not count", () => {
    expect(fenceFor("say ```hi```\n")).toBe("```");
  });
});

describe("formatAttachment", () => {
  test("heading, language fence, trailing newline added", () => {
    expect(formatAttachment("src/a.ts", "const x = 1;")).toBe(
      "### src/a.ts\n```ts\nconst x = 1;\n```",
    );
  });
  test("unknown extension gets a bare fence; existing newline kept", () => {
    expect(formatAttachment("notes.txt", "hi\n")).toBe("### notes.txt\n```\nhi\n```");
  });
  test("line-range suffix does not confuse the language lookup", () => {
    expect(formatAttachment("src/a.ts:L3-L9", "x")).toBe(
      "### src/a.ts:L3-L9\n```ts\nx\n```",
    );
  });
});

describe("formatSize", () => {
  test("B, KB, MB", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/core/src/attachment.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `attachment.ts`**

```ts
/** One file appended to a prompt; the history shows one line per entry. */
export interface Attachment {
  /** Display path: relative, `/`-separated; may carry a `:L1-L2` suffix. */
  path: string;
  bytes: number;
}

export const MAX_FILE_BYTES = 200 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024;

const LANGUAGES: Record<string, string> = {
  ts: "ts", js: "js", tsx: "tsx", jsx: "jsx", json: "json", md: "md",
  py: "py", sh: "sh", yaml: "yaml", yml: "yml", toml: "toml", html: "html",
  css: "css", rs: "rs", go: "go",
};

/** Three backticks, or one more than the longest backtick run that starts
 * a line in the content, so the fence can never be closed early. */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/^`+/gm)) {
    longest = Math.max(longest, m[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/** `N B` under 1 KiB, otherwise one decimal in KB or MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function languageOf(path: string): string {
  const file = path.replace(/:L\d+-L\d+$/, "");
  const dot = file.lastIndexOf(".");
  const slash = file.lastIndexOf("/");
  if (dot === -1 || dot <= slash) return "";
  return LANGUAGES[file.slice(dot + 1)] ?? "";
}

/** The attachment shape shared by the CLI's `@file` mentions and the
 * VSCode extension's send-selection / send-file:
 *
 *   ### <path>
 *   ```<lang>
 *   <content, newline-terminated>
 *   ```
 */
export function formatAttachment(path: string, content: string): string {
  const body = content.endsWith("\n") ? content : `${content}\n`;
  const fence = fenceFor(body);
  return `### ${path}\n${fence}${languageOf(path)}\n${body}${fence}`;
}
```

Biome will reformat the `LANGUAGES` object to one key per line; that is fine.

- [ ] **Step 4: Move `close-session`**

`git mv packages/cli/src/tui/close-session.ts packages/core/src/close-session.ts` and the same for the test; contents unchanged. Delete `packages/cli/src/fence.ts` and `fence.test.ts`.

Add to `packages/core/src/index.ts`:

```ts
export {
  type Attachment,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  fenceFor,
  formatAttachment,
  formatSize,
} from "./attachment.js";
export {
  type ClosableSession,
  type KillableSession,
  closeOrKill,
  closeWithTimeout,
} from "./close-session.js";
```

- [ ] **Step 5: Re-point the CLI**

- `expand-mentions.ts`: delete `Attachment`, `MAX_FILE_BYTES`, `MAX_TOTAL_BYTES`, `LANGUAGES`, `formatSize`, `languageOf`, `section`; import `{ type Attachment, MAX_FILE_BYTES, MAX_TOTAL_BYTES, formatAttachment, formatSize } from "@chatbridge/core"`; replace `section(f.path, f.content)` with `formatAttachment(f.path, f.content)`; keep `export type { Attachment }` and `export { formatSize, MAX_FILE_BYTES, MAX_TOTAL_BYTES }` re-exports so existing CLI imports and tests keep compiling.
- `shell/format-result.ts`: `import { fenceFor } from "@chatbridge/core";`.
- `tui/chat-model.ts`: `import { closeOrKill } from "@chatbridge/core";`.
- `tui/run-interactive.ts`: `import { closeWithTimeout } from "@chatbridge/core";`.
- `tui/chat-view.ts`: leave (it imports `formatSize` from `expand-mentions`, which re-exports).

- [ ] **Step 6: Run everything**

Run: `bun run check`
Expected: PASS; `expand-mentions.test.ts` output is byte-identical to before the move.

- [ ] **Step 7: Commit**

```bash
git add -A packages/core/src packages/cli/src
git commit -m "refactor(core): move attachment formatting and closeOrKill from cli to core (Refs #57)"
```

---

### Task 5: `packages/vscode` scaffold, protocol, `SessionController`

**Files:**
- Create: `packages/vscode/package.json`, `packages/vscode/tsconfig.json`, `packages/vscode/tsconfig.webview.json`, `packages/vscode/LICENSE` (copy of `packages/core/LICENSE`), `packages/vscode/README.md` (one paragraph; Task 9 completes it)
- Create: `packages/vscode/src/protocol.ts`, `packages/vscode/src/session-controller.ts`, `packages/vscode/src/session-controller.test.ts`, `packages/vscode/src/index.ts` (exports so far)
- Modify: root `tsconfig.json` (add reference), root `package.json` (`build` script), `scripts/pack-all.sh`, `scripts/check-versions.sh`, `.github/workflows/publish.yml:36`

**Interfaces:**
- Produces: everything in `protocol.ts` below; `SessionController` with `getState()`, `send(text)`, `retryLast()`, `newChat()`, `discard(reason)`, `markLoggedIn()`, `close()`, `addAttachment(a)`, `removeAttachment(i)`, `onChange`.

- [ ] **Step 1: Scaffold the package**

`packages/vscode/package.json`:

```json
{
  "name": "@chatbridge/vscode",
  "version": "0.6.0",
  "description": "VSCode extension factory for chatbridge: a sidebar chat view on top of ChatSession",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/7milch/chatbridge-cli.git",
    "directory": "packages/vscode"
  },
  "keywords": ["chatbridge", "vscode", "playwright", "chat"],
  "type": "module",
  "engines": { "node": ">=20" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build:webview": "esbuild src/webview/main.ts --bundle --format=iife --target=es2022 --outfile=dist/webview/main.js && mkdir -p dist/webview && cp src/webview/style.css dist/webview/style.css"
  },
  "dependencies": {
    "@chatbridge/core": "workspace:*"
  },
  "devDependencies": {
    "@types/vscode": "^1.100.0",
    "esbuild": "^0.25.0"
  }
}
```

`packages/vscode/tsconfig.json` (host side; excludes the webview):

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["**/*.test.ts", "src/webview/**"],
  "references": [{ "path": "../core" }]
}
```

`packages/vscode/tsconfig.webview.json` (type-check only; esbuild emits):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noEmit": true,
    "rootDir": "src"
  },
  "include": ["src/webview/**", "src/protocol.ts"]
}
```

Root `tsconfig.json`: add `{ "path": "packages/vscode" }` after `packages/cli`. Root `package.json` `build`: `"tsc --build && bun run --filter @chatbridge/vscode build:webview"`. `scripts/pack-all.sh` and `scripts/check-versions.sh`: append `packages/vscode` to both `for dir in ...` lists (check-versions has two). `publish.yml`: add `chatbridge-vscode` to the `for name in` list. Run `bun install`.

The webview files do not exist yet; create placeholders so the build passes: `packages/vscode/src/webview/main.ts` containing `export {};` and an empty `style.css` (Task 7 fills them).

- [ ] **Step 2: Write `protocol.ts`**

```ts
import type { Attachment } from "@chatbridge/core";

export type Role = "user" | "assistant" | "error" | "separator";

export interface Message {
  role: Role;
  text: string;
  /** `user` entries: files appended to the prompt, one line each. */
  attachments?: Attachment[];
}

/** closed: no browser. opening: ChatSession.open in flight. idle: ready.
 * busy: a turn is in flight. dead: fatal error; New chat or Log in recover. */
export type Status = "closed" | "opening" | "idle" | "busy" | "dead";

export interface State {
  status: Status;
  messages: Message[];
  pendingAttachments: Attachment[];
  /** `ChatBridgeError.code` of the error that made the status `dead`. */
  lastError?: string;
}

/** webview → host */
export type ToHost =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "removeAttachment"; index: number }
  | { type: "command"; name: "login" | "newChat" | "installBrowser" };

/** host → webview */
export type ToWebview =
  | ({ type: "state" } & State)
  | { type: "progress"; text: string };
```

- [ ] **Step 3: Write the failing controller tests**

`packages/vscode/src/session-controller.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  AuthExpiredError,
  AuthRequiredError,
  BrowserUnavailableError,
  ResponseTimeoutError,
} from "@chatbridge/core";
import {
  type ChatSessionLike,
  SessionController,
} from "./session-controller.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  controller: SessionController;
  sent: string[];
  replies: Array<ReturnType<typeof deferred<string>>>;
  opens: number;
  closed: number;
  killed: number;
  openError?: Error;
  closeHangs: boolean;
  states: string[];
}

function harness(): Harness {
  const h = {
    sent: [],
    replies: [],
    opens: 0,
    closed: 0,
    killed: 0,
    closeHangs: false,
    states: [],
  } as unknown as Harness;
  const session: ChatSessionLike = {
    async send(prompt) {
      h.sent.push(prompt);
      const d = deferred<string>();
      h.replies.push(d);
      return d.promise;
    },
    close: () =>
      h.closeHangs
        ? new Promise<void>(() => {})
        : Promise.resolve().then(() => {
            h.closed++;
          }),
    async kill() {
      h.killed++;
    },
  };
  h.controller = new SessionController({
    openSession: async () => {
      h.opens++;
      if (h.openError) throw h.openError;
      return session;
    },
    closeTimeoutMs: 20,
    onChange: (s) => h.states.push(s.status),
  });
  return h;
}

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("SessionController", () => {
  test("starts closed with an empty history", () => {
    const h = harness();
    expect(h.controller.getState()).toEqual({
      status: "closed",
      messages: [],
      pendingAttachments: [],
    });
    expect(h.opens).toBe(0);
  });

  test("first send opens lazily, records user and assistant messages", async () => {
    const h = harness();
    const p = h.controller.send("hello");
    await settle();
    expect(h.opens).toBe(1);
    expect(h.controller.getState().status).toBe("busy");
    h.replies[0].resolve("Echo: hello");
    expect(await p).toEqual({ ok: true });
    const s = h.controller.getState();
    expect(s.status).toBe("idle");
    expect(s.messages).toEqual([
      { role: "user", text: "hello", attachments: [] },
      { role: "assistant", text: "Echo: hello" },
    ]);
    // The user entry is pushed (emit while still closed) before opening.
    expect(h.states).toEqual(["closed", "opening", "busy", "idle"]);
  });

  test("second send reuses the session", async () => {
    const h = harness();
    const p1 = h.controller.send("a");
    await settle();
    h.replies[0].resolve("1");
    await p1;
    const p2 = h.controller.send("b");
    await settle();
    h.replies[1].resolve("2");
    await p2;
    expect(h.opens).toBe(1);
    expect(h.sent).toEqual(["a", "b"]);
  });

  test("send while busy is rejected without touching the session", async () => {
    const h = harness();
    const p = h.controller.send("a");
    await settle();
    expect(await h.controller.send("b")).toEqual({
      ok: false,
      code: "INVALID_STATE",
      message: "A send is already in progress.",
    });
    h.replies[0].resolve("1");
    await p;
    expect(h.sent).toEqual(["a"]);
  });

  test("attachments are appended in the CLI format and cleared after send", async () => {
    const h = harness();
    expect(
      h.controller.addAttachment({ path: "src/a.ts", bytes: 3, content: "x=1" }),
    ).toEqual({ ok: true });
    const p = h.controller.send("look");
    await settle();
    expect(h.sent[0]).toBe("look\n\n### src/a.ts\n```ts\nx=1\n```");
    expect(h.controller.getState().pendingAttachments).toEqual([]);
    expect(h.controller.getState().messages[0]).toEqual({
      role: "user",
      text: "look",
      attachments: [{ path: "src/a.ts", bytes: 3 }],
    });
    h.replies[0].resolve("ok");
    await p;
  });

  test("attachment-only send has no leading blank lines", async () => {
    const h = harness();
    h.controller.addAttachment({ path: "a.md", bytes: 2, content: "hi" });
    const p = h.controller.send("");
    await settle();
    expect(h.sent[0]).toBe("### a.md\n```md\nhi\n```");
    h.replies[0].resolve("ok");
    await p;
  });

  test("empty send with no attachments is a no-op", async () => {
    const h = harness();
    expect(await h.controller.send("   ")).toEqual({
      ok: false,
      code: "EMPTY",
      message: "Nothing to send.",
    });
    expect(h.opens).toBe(0);
  });

  test("addAttachment enforces per-file and total limits", () => {
    const h = harness();
    const big = "x".repeat(200 * 1024 + 1);
    expect(
      h.controller.addAttachment({ path: "big", bytes: big.length, content: big }),
    ).toEqual({ ok: false, reason: "big: 201 KB exceeds 200 KB" });
    const chunk = "y".repeat(200 * 1024);
    for (let i = 0; i < 5; i++) {
      h.controller.addAttachment({ path: `c${i}`, bytes: chunk.length, content: chunk });
    }
    // 5 × 200 KiB = 1000.0 KB fits under 1 MiB; a sixth does not.
    expect(
      h.controller.addAttachment({ path: "c5", bytes: chunk.length, content: chunk }),
    ).toEqual({ ok: false, reason: "attachments total 1200.0 KB exceeds 1 MB" });
    expect(h.controller.getState().pendingAttachments).toHaveLength(5);
  });

  test("removeAttachment drops one entry; out-of-range is ignored", () => {
    const h = harness();
    h.controller.addAttachment({ path: "a", bytes: 1, content: "a" });
    h.controller.addAttachment({ path: "b", bytes: 1, content: "b" });
    h.controller.removeAttachment(0);
    h.controller.removeAttachment(7);
    expect(h.controller.getState().pendingAttachments).toEqual([{ path: "b", bytes: 1 }]);
  });

  test("a response timeout records an error and keeps the session", async () => {
    const h = harness();
    const p = h.controller.send("slow");
    await settle();
    h.replies[0].reject(new ResponseTimeoutError("Timed out during waitForResponse after 1 ms."));
    expect(await p).toEqual({
      ok: false,
      code: "RESPONSE_TIMEOUT",
      message: "Timed out during waitForResponse after 1 ms.",
    });
    const s = h.controller.getState();
    expect(s.status).toBe("idle");
    expect(s.lastError).toBeUndefined();
    expect(s.messages[1]).toEqual({
      role: "error",
      text: "Timed out during waitForResponse after 1 ms.",
    });
    expect(h.closed).toBe(0);
  });

  test("auth expired during a turn closes the session and goes dead", async () => {
    const h = harness();
    const p = h.controller.send("x");
    await settle();
    h.replies[0].reject(new AuthExpiredError("Session expired."));
    expect(await p).toEqual({ ok: false, code: "AUTH_EXPIRED", message: "Session expired." });
    const s = h.controller.getState();
    expect(s.status).toBe("dead");
    expect(s.lastError).toBe("AUTH_EXPIRED");
    expect(h.closed).toBe(1);
  });

  test("open failure goes dead without a session to close", async () => {
    const h = harness();
    h.openError = new AuthRequiredError("Not logged in.");
    expect(await h.controller.send("x")).toEqual({
      ok: false,
      code: "AUTH_REQUIRED",
      message: "Not logged in.",
    });
    expect(h.controller.getState().status).toBe("dead");
    expect(h.controller.getState().messages).toEqual([
      { role: "user", text: "x", attachments: [] },
      { role: "error", text: "Not logged in." },
    ]);
    expect(h.closed).toBe(0);
  });

  test("a non-framework error is reported with code UNKNOWN", async () => {
    const h = harness();
    h.openError = new Error("boom");
    expect(await h.controller.send("x")).toEqual({ ok: false, code: "UNKNOWN", message: "boom" });
    expect(h.controller.getState().lastError).toBe("UNKNOWN");
  });

  test("retryLast after a dead open re-sends the same prompt without a new user entry", async () => {
    const h = harness();
    h.openError = new BrowserUnavailableError("Chromium is not installed (expected at /x).");
    h.controller.addAttachment({ path: "a", bytes: 1, content: "a" });
    await h.controller.send("again");
    h.openError = undefined;
    const p = h.controller.retryLast();
    await settle();
    expect(h.sent).toEqual(["again\n\n### a\n```\na\n```"]);
    h.replies[0].resolve("done");
    expect(await p).toEqual({ ok: true });
    const texts = h.controller.getState().messages.map((m) => `${m.role}:${m.text}`);
    expect(texts).toEqual(["user:again", "assistant:done"]);
    expect(h.controller.getState().lastError).toBeUndefined();
  });

  test("retryLast with nothing to retry is EMPTY", async () => {
    const h = harness();
    expect(await h.controller.retryLast()).toEqual({
      ok: false,
      code: "EMPTY",
      message: "Nothing to send.",
    });
  });

  test("newChat closes the session, adds a separator and reopens on the next send", async () => {
    const h = harness();
    const p = h.controller.send("a");
    await settle();
    h.replies[0].resolve("1");
    await p;
    await h.controller.newChat();
    expect(h.closed).toBe(1);
    const s = h.controller.getState();
    expect(s.status).toBe("closed");
    expect(s.messages.at(-1)).toEqual({ role: "separator", text: "New chat" });
    const p2 = h.controller.send("b");
    await settle();
    expect(h.opens).toBe(2);
    h.replies[1].resolve("2");
    await p2;
  });

  test("newChat kills a session whose close hangs", async () => {
    const h = harness();
    const p = h.controller.send("a");
    await settle();
    h.replies[0].resolve("1");
    await p;
    h.closeHangs = true;
    await h.controller.newChat();
    expect(h.killed).toBe(1);
    expect(h.controller.getState().status).toBe("closed");
  });

  test("newChat from dead clears lastError; newChat while closed only adds the separator", async () => {
    const h = harness();
    h.openError = new AuthRequiredError("no");
    await h.controller.send("x");
    await h.controller.newChat();
    expect(h.controller.getState().lastError).toBeUndefined();
    expect(h.controller.getState().status).toBe("closed");
    expect(h.closed).toBe(0);
  });

  test("newChat while busy is refused", async () => {
    const h = harness();
    const p = h.controller.send("a");
    await settle();
    await h.controller.newChat();
    expect(h.controller.getState().status).toBe("busy");
    h.replies[0].resolve("1");
    await p;
  });

  test("markLoggedIn from dead returns to closed with a separator", async () => {
    const h = harness();
    h.openError = new AuthRequiredError("no");
    await h.controller.send("x");
    h.controller.markLoggedIn();
    const s = h.controller.getState();
    expect(s.status).toBe("closed");
    expect(s.lastError).toBeUndefined();
    expect(s.messages.at(-1)).toEqual({ role: "separator", text: "Logged in" });
  });

  test("discard closes the session and adds the given separator", async () => {
    const h = harness();
    const p = h.controller.send("a");
    await settle();
    h.replies[0].resolve("1");
    await p;
    await h.controller.discard("Logged out");
    expect(h.closed).toBe(1);
    expect(h.controller.getState().status).toBe("closed");
    expect(h.controller.getState().messages.at(-1)).toEqual({
      role: "separator",
      text: "Logged out",
    });
  });

  test("close closes an open session and leaves the history alone", async () => {
    const h = harness();
    const p = h.controller.send("a");
    await settle();
    h.replies[0].resolve("1");
    await p;
    const before = h.controller.getState().messages.length;
    await h.controller.close();
    expect(h.closed).toBe(1);
    expect(h.controller.getState().messages).toHaveLength(before);
    await h.controller.close();
    expect(h.closed).toBe(1);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bun run build && bun test packages/vscode/src/session-controller.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 5: Implement `session-controller.ts`**

```ts
import {
  type Attachment,
  ChatBridgeError,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  closeOrKill,
  formatAttachment,
  formatSize,
} from "@chatbridge/core";
import type { Message, State, Status } from "./protocol.js";

/** What the controller needs from a ChatSession; lets tests inject a fake. */
export interface ChatSessionLike {
  send(prompt: string): Promise<string>;
  close(): Promise<void>;
  kill(): Promise<void>;
}

/** A queued attachment: what the history shows plus the content to send. */
export interface PendingAttachment extends Attachment {
  content: string;
}

export type SendResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export type AddResult = { ok: true } | { ok: false; reason: string };

export interface SessionControllerOptions {
  /** Opens a ChatSession; called lazily on the first send after `closed`. */
  openSession: () => Promise<ChatSessionLike>;
  /** How long newChat / discard / close wait before killing. Default 5 s. */
  closeTimeoutMs?: number;
  /** Called with the full state after every change. */
  onChange?: (state: State) => void;
}

export const CLOSE_TIMEOUT_MS = 5_000;

const EMPTY: SendResult = { ok: false, code: "EMPTY", message: "Nothing to send." };

/** Owns the history, the pending attachments and the ChatSession. No
 * vscode import: the extension wires it to the webview and the commands. */
export class SessionController {
  private status: Status = "closed";
  private messages: Message[] = [];
  private pending: PendingAttachment[] = [];
  private lastError: string | undefined;
  private session: ChatSessionLike | undefined;
  /** The full prompt of the last send, for retryLast(). */
  private lastPrompt: string | undefined;
  private readonly closeTimeoutMs: number;

  constructor(private readonly opts: SessionControllerOptions) {
    this.closeTimeoutMs = opts.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  }

  getState(): State {
    const state: State = {
      status: this.status,
      messages: this.messages.map((m) => ({ ...m })),
      pendingAttachments: this.pending.map(({ path, bytes }) => ({ path, bytes })),
    };
    if (this.lastError !== undefined) state.lastError = this.lastError;
    return state;
  }

  private setStatus(status: Status): void {
    this.status = status;
    this.emit();
  }

  private push(message: Message): void {
    this.messages.push(message);
    this.emit();
  }

  private emit(): void {
    this.opts.onChange?.(this.getState());
  }

  addAttachment(a: PendingAttachment): AddResult {
    if (a.bytes > MAX_FILE_BYTES) {
      return {
        ok: false,
        reason: `${a.path}: ${Math.ceil(a.bytes / 1024)} KB exceeds ${MAX_FILE_BYTES / 1024} KB`,
      };
    }
    const total = this.pending.reduce((n, p) => n + p.bytes, 0) + a.bytes;
    if (total > MAX_TOTAL_BYTES) {
      return {
        ok: false,
        reason: `attachments total ${formatSize(total)} exceeds ${formatSize(MAX_TOTAL_BYTES).replace(".0", "")}`,
      };
    }
    this.pending.push(a);
    this.emit();
    return { ok: true };
  }

  removeAttachment(index: number): void {
    if (index < 0 || index >= this.pending.length) return;
    this.pending.splice(index, 1);
    this.emit();
  }

  /** Sends the text plus the pending attachments as one turn. Never
   * throws: the outcome is the result and the history. */
  async send(text: string): Promise<SendResult> {
    if (this.status === "busy" || this.status === "opening") {
      return { ok: false, code: "INVALID_STATE", message: "A send is already in progress." };
    }
    const body = text.trim() === "" ? "" : text;
    if (body === "" && this.pending.length === 0) return EMPTY;
    const sections = this.pending.map((a) => formatAttachment(a.path, a.content));
    const prompt = [body, ...sections].filter((s) => s !== "").join("\n\n");
    const attachments = this.pending.map(({ path, bytes }) => ({ path, bytes }));
    this.pending = [];
    this.push({ role: "user", text: body, attachments });
    this.lastPrompt = prompt;
    return this.runTurn(prompt);
  }

  /** Re-runs the last prompt after a recoverable fatal error (a missing
   * browser that was just installed). Drops the trailing error entry so
   * the history reads user → assistant. */
  async retryLast(): Promise<SendResult> {
    if (this.lastPrompt === undefined) return EMPTY;
    if (this.status === "busy" || this.status === "opening") {
      return { ok: false, code: "INVALID_STATE", message: "A send is already in progress." };
    }
    if (this.messages.at(-1)?.role === "error") this.messages.pop();
    this.lastError = undefined;
    if (this.status === "dead") this.status = "closed";
    this.emit();
    return this.runTurn(this.lastPrompt);
  }

  private async runTurn(prompt: string): Promise<SendResult> {
    try {
      if (this.session === undefined) {
        this.setStatus("opening");
        this.session = await this.opts.openSession();
      }
      this.setStatus("busy");
      const reply = await this.session.send(prompt);
      this.messages.push({ role: "assistant", text: reply });
      this.setStatus("idle");
      return { ok: true };
    } catch (err) {
      return this.fail(err);
    }
  }

  private async fail(err: unknown): Promise<SendResult> {
    const code = err instanceof ChatBridgeError ? err.code : "UNKNOWN";
    const message = err instanceof Error ? err.message : String(err);
    this.messages.push({ role: "error", text: message });
    if (code === "RESPONSE_TIMEOUT") {
      this.setStatus("idle");
    } else {
      this.lastError = code;
      await this.dropSession();
      this.setStatus("dead");
    }
    return { ok: false, code, message };
  }

  private async dropSession(): Promise<void> {
    const old = this.session;
    this.session = undefined;
    if (old !== undefined) await closeOrKill(old, this.closeTimeoutMs);
  }

  /** Ctrl+R of the TUI: drop the browser, mark the break, reopen lazily. */
  async newChat(): Promise<void> {
    await this.discard("New chat");
  }

  /** Closes the session (if any) and pushes `separator`. Refused while a
   * turn is in flight. Clears a dead state. */
  async discard(separator: string): Promise<void> {
    if (this.status === "busy" || this.status === "opening") return;
    await this.dropSession();
    this.lastError = undefined;
    this.status = "closed";
    this.push({ role: "separator", text: separator });
  }

  /** After a successful login command: a dead controller may try again. */
  markLoggedIn(): void {
    if (this.status === "dead") {
      this.lastError = undefined;
      this.status = "closed";
    }
    this.push({ role: "separator", text: "Logged in" });
  }

  /** deactivate: close the browser, keep the history. Idempotent. */
  async close(): Promise<void> {
    await this.dropSession();
    if (this.status !== "dead") this.status = "closed";
    this.emit();
  }
}
```

`packages/vscode/src/index.ts` for now:

```ts
export * from "./protocol.js";
export {
  type AddResult,
  type ChatSessionLike,
  type PendingAttachment,
  type SendResult,
  SessionController,
  type SessionControllerOptions,
} from "./session-controller.js";
```

- [ ] **Step 6: Run tests**

Run: `bun run check`
Expected: PASS. If the `states` expectation in the second test differs (an extra `idle` from `emit` on attachment changes is impossible here; an extra entry means `setStatus` is called twice), fix the implementation, not the test.

- [ ] **Step 7: Commit**

```bash
git add -A packages/vscode tsconfig.json package.json bun.lock scripts .github/workflows/publish.yml
git commit -m "feat(vscode): package scaffold, protocol and SessionController (Refs #57)"
```

---

### Task 6: `installBrowser` and manifest validation

**Files:**
- Create: `packages/vscode/src/install-browser.ts`, `install-browser.test.ts`, `manifest.ts`, `manifest.test.ts`
- Modify: `packages/vscode/src/index.ts`

**Interfaces:**
- Produces: `installBrowser(opts: InstallBrowserOptions): Promise<void>`; `InstallBrowserOptions { cliPath: string; execPath?: string; env?: Record<string,string|undefined>; spawn?: SpawnFn; onProgress?: (line: string) => void }`; `SpawnFn = (cmd: string, args: string[], opts: { env: Record<string,string|undefined> }) => ChildLike`; `ChildLike { stdout: { on(ev: "data", f: (c: Buffer|string) => void): unknown } | null; stderr: same; on(ev: "exit", f: (code: number|null) => void): unknown; on(ev: "error", f: (e: Error) => void): unknown }`; `splitProgressLines(chunk: string): string[]`; `missingContributions(packageJSON: unknown, id: string): string[]`; `expectedContributions(id: string): { commands: string[]; views: string[]; viewContainers: string[] }`.

- [ ] **Step 1: Write the failing tests**

`packages/vscode/src/install-browser.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { type ChildLike, installBrowser, splitProgressLines } from "./install-browser.js";

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

describe("splitProgressLines", () => {
  test("splits on \\n and \\r, trims, drops empty", () => {
    expect(splitProgressLines("Downloading Chromium 131\r|■■  | 20%\r|■■■■| 40%\n\n")).toEqual([
      "Downloading Chromium 131",
      "|■■  | 20%",
      "|■■■■| 40%",
    ]);
  });
});

describe("installBrowser", () => {
  test("spawns playwright's CLI with the host binary as node", async () => {
    let call: { cmd: string; args: string[]; env: Record<string, string | undefined> } | undefined;
    const child = new FakeChild();
    const lines: string[] = [];
    const p = installBrowser({
      cliPath: "/ext/node_modules/playwright/cli.js",
      execPath: "/Applications/Code.app/Code Helper (Plugin)",
      env: { PATH: "/usr/bin" },
      spawn: (cmd, args, opts) => {
        call = { cmd, args, env: opts.env };
        return child;
      },
      onProgress: (l) => lines.push(l),
    });
    child.stdout.emit("data", Buffer.from("Downloading Chromium\r|■| 50%\n"));
    child.emit("exit", 0);
    await p;
    expect(call).toEqual({
      cmd: "/Applications/Code.app/Code Helper (Plugin)",
      args: ["/ext/node_modules/playwright/cli.js", "install", "chromium"],
      env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(lines).toEqual(["Downloading Chromium", "|■| 50%"]);
  });

  test("rejects on a non-zero exit with the last stderr line", async () => {
    const child = new FakeChild();
    const p = installBrowser({ cliPath: "/x/cli.js", spawn: () => child });
    child.stderr.emit("data", "Error: no space left\n");
    child.emit("exit", 1);
    await expect(p).rejects.toThrow("playwright install chromium exited with 1: Error: no space left");
  });

  test("rejects when the process cannot be spawned", async () => {
    const child = new FakeChild();
    const p = installBrowser({ cliPath: "/x/cli.js", spawn: () => child });
    child.emit("error", new Error("spawn ENOENT"));
    await expect(p).rejects.toThrow("spawn ENOENT");
  });
});
```

`packages/vscode/src/manifest.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { expectedContributions, missingContributions } from "./manifest.js";

const full = {
  contributes: {
    viewsContainers: { activitybar: [{ id: "acme" }] },
    views: { acme: [{ id: "acme.chat", type: "webview" }] },
    commands: expectedContributions("acme").commands.map((command) => ({ command })),
  },
};

describe("missingContributions", () => {
  test("a complete manifest has nothing missing", () => {
    expect(missingContributions(full, "acme")).toEqual([]);
  });

  test("lists every absent ID", () => {
    const partial = {
      contributes: {
        views: { acme: [{ id: "acme.chat" }] },
        commands: [{ command: "acme.login" }],
      },
    };
    expect(missingContributions(partial, "acme")).toEqual([
      "viewsContainers.activitybar: acme",
      "commands: acme.logout",
      "commands: acme.newChat",
      "commands: acme.installBrowser",
      "commands: acme.sendSelection",
      "commands: acme.sendFile",
      "commands: acme.focus",
    ]);
  });

  test("a manifest without contributes lists everything", () => {
    expect(missingContributions({}, "x")).toHaveLength(9);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/vscode/src/install-browser.test.ts packages/vscode/src/manifest.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `install-browser.ts`**

```ts
import { spawn as nodeSpawn } from "node:child_process";

export interface ChildLike {
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export type SpawnFn = (
  command: string,
  args: string[],
  opts: { env: Record<string, string | undefined> },
) => ChildLike;

export interface InstallBrowserOptions {
  /** Absolute path of `playwright/cli.js` inside the extension's node_modules. */
  cliPath: string;
  /** The Node binary to run it with; the extension host's process.execPath
   * (Electron) works with ELECTRON_RUN_AS_NODE=1. */
  execPath?: string;
  env?: Record<string, string | undefined>;
  spawn?: SpawnFn;
  /** One call per progress line (download names, progress bars). */
  onProgress?: (line: string) => void;
}

/** Playwright redraws its progress bar with `\r`; treat every `\r` or `\n`
 * as a line break and drop blanks. */
export function splitProgressLines(chunk: string): string[] {
  return chunk
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** Runs `playwright install chromium` and resolves when it exits 0. */
export function installBrowser(opts: InstallBrowserOptions): Promise<void> {
  const spawn: SpawnFn = opts.spawn ?? ((c, a, o) => nodeSpawn(c, a, o));
  const child = spawn(
    opts.execPath ?? process.execPath,
    [opts.cliPath, "install", "chromium"],
    { env: { ...(opts.env ?? process.env), ELECTRON_RUN_AS_NODE: "1" } },
  );
  let lastStderr = "";
  return new Promise((resolve, reject) => {
    child.stdout?.on("data", (chunk) => {
      for (const line of splitProgressLines(String(chunk))) opts.onProgress?.(line);
    });
    child.stderr?.on("data", (chunk) => {
      const lines = splitProgressLines(String(chunk));
      if (lines.length > 0) lastStderr = lines[lines.length - 1];
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `playwright install chromium exited with ${code ?? "signal"}${lastStderr ? `: ${lastStderr}` : ""}`,
          ),
        );
      }
    });
  });
}
```

- [ ] **Step 4: Implement `manifest.ts`**

```ts
export const COMMAND_NAMES = [
  "login",
  "logout",
  "newChat",
  "installBrowser",
  "sendSelection",
  "sendFile",
  "focus",
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export function expectedContributions(id: string) {
  return {
    viewContainers: [id],
    views: [`${id}.chat`],
    commands: COMMAND_NAMES.map((n) => `${id}.${n}`),
  };
}

function ids(list: unknown, key: string): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(list)) {
    for (const item of list) {
      const v = (item as Record<string, unknown> | null)?.[key];
      if (typeof v === "string") out.add(v);
    }
  }
  return out;
}

/** The contributes entries a vendor manifest must declare for `id`, that
 * this package.json lacks. Empty when the manifest is complete. */
export function missingContributions(packageJSON: unknown, id: string): string[] {
  const c = ((packageJSON as { contributes?: Record<string, unknown> } | null)?.contributes ?? {}) as Record<string, unknown>;
  const expected = expectedContributions(id);
  const containers = ids((c.viewsContainers as { activitybar?: unknown } | undefined)?.activitybar, "id");
  const views = ids((c.views as Record<string, unknown> | undefined)?.[id], "id");
  const commands = ids(c.commands, "command");
  const missing: string[] = [];
  for (const v of expected.viewContainers) if (!containers.has(v)) missing.push(`viewsContainers.activitybar: ${v}`);
  for (const v of expected.views) if (!views.has(v)) missing.push(`views.${id}: ${v}`);
  for (const v of expected.commands) if (!commands.has(v)) missing.push(`commands: ${v}`);
  return missing;
}
```

Export `installBrowser`, `splitProgressLines`, the option/child types, `missingContributions`, `expectedContributions`, `COMMAND_NAMES`, `CommandName` from `index.ts`.

- [ ] **Step 5: Run tests**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/src
git commit -m "feat(vscode): installBrowser via playwright's CLI and manifest validation (Refs #57)"
```

---

### Task 7: Bridge, commands, HTML, webview, factory

**Files:**
- Create: `packages/vscode/src/chat-view-bridge.ts`, `chat-view-bridge.test.ts`, `webview-html.ts`, `webview-html.test.ts`, `vscode-ui.ts`, `commands.ts`, `commands.test.ts`, `chat-view-provider.ts`, `create-extension.ts`
- Replace placeholders: `packages/vscode/src/webview/main.ts`, `style.css`
- Modify: `packages/vscode/src/index.ts`

**Interfaces:**
- Consumes: `SessionController`, `installBrowser`, `missingContributions`, `protocol.ts`, `runLogin` / `createAuthStore` / `ChatSession` from core.
- Produces: `ChatViewBridge`, `buildHtml`, `VscodeUi`, `createVscodeUi`, `createCommands`, `CommandHandlers`, `createExtension`, `CreateExtensionOptions`, `ExtensionApi { controller: SessionController }`.

- [ ] **Step 1: Write the failing bridge and HTML tests**

`packages/vscode/src/chat-view-bridge.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ChatViewBridge, type WebviewLike } from "./chat-view-bridge.js";
import type { State, ToHost, ToWebview } from "./protocol.js";

function fakeWebview() {
  const posted: ToWebview[] = [];
  let listener: ((m: ToHost) => void) | undefined;
  const webview: WebviewLike = {
    postMessage: async (m) => {
      posted.push(m);
      return true;
    },
    onDidReceiveMessage: (l) => {
      listener = l;
      return { dispose: () => { listener = undefined; } };
    },
  };
  return { webview, posted, receive: (m: ToHost) => listener?.(m), hasListener: () => listener !== undefined };
}

const state: State = { status: "idle", messages: [], pendingAttachments: [] };

describe("ChatViewBridge", () => {
  test("ready → current state is posted", () => {
    const calls: string[] = [];
    const bridge = new ChatViewBridge(() => state, {
      send: (t) => calls.push(`send:${t}`),
      removeAttachment: (i) => calls.push(`remove:${i}`),
      command: (n) => calls.push(`cmd:${n}`),
    });
    const w = fakeWebview();
    bridge.attach(w.webview);
    w.receive({ type: "ready" });
    expect(w.posted).toEqual([{ type: "state", ...state }]);
    w.receive({ type: "send", text: "hi" });
    w.receive({ type: "removeAttachment", index: 2 });
    w.receive({ type: "command", name: "newChat" });
    expect(calls).toEqual(["send:hi", "remove:2", "cmd:newChat"]);
  });

  test("pushState and pushProgress reach the attached webview only", () => {
    const bridge = new ChatViewBridge(() => state, { send() {}, removeAttachment() {}, command() {} });
    bridge.pushState(state); // no webview yet: dropped, no throw
    const w = fakeWebview();
    const sub = bridge.attach(w.webview);
    bridge.pushProgress("Waiting...");
    bridge.pushState({ ...state, status: "busy" });
    expect(w.posted).toEqual([
      { type: "progress", text: "Waiting..." },
      { type: "state", ...state, status: "busy" },
    ]);
    sub.dispose();
    expect(w.hasListener()).toBe(false);
    bridge.pushProgress("dropped");
    expect(w.posted).toHaveLength(2);
  });

  test("malformed messages are ignored", () => {
    const bridge = new ChatViewBridge(() => state, { send() { throw new Error("must not run"); }, removeAttachment() {}, command() {} });
    const w = fakeWebview();
    bridge.attach(w.webview);
    w.receive({ type: "send" } as unknown as ToHost);
    w.receive(null as unknown as ToHost);
    expect(w.posted).toEqual([]);
  });
});
```

`packages/vscode/src/webview-html.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildHtml } from "./webview-html.js";

describe("buildHtml", () => {
  test("locks the CSP to the nonce and the webview origin", () => {
    const html = buildHtml({
      cspSource: "vscode-webview://abc",
      nonce: "n0nce",
      scriptUri: "vscode-resource:/main.js",
      styleUri: "vscode-resource:/style.css",
      title: "Acme AI",
    });
    expect(html).toContain(
      `content="default-src 'none'; script-src 'nonce-n0nce'; style-src vscode-webview://abc;"`,
    );
    expect(html).toContain(`<script nonce="n0nce" src="vscode-resource:/main.js">`);
    expect(html).toContain(`<link rel="stylesheet" href="vscode-resource:/style.css">`);
    expect(html).toContain("<title>Acme AI</title>");
    expect(html).not.toContain("http://");
  });

  test("escapes the title", () => {
    expect(buildHtml({ cspSource: "x", nonce: "n", scriptUri: "s", styleUri: "c", title: "<b>" })).toContain(
      "<title>&lt;b&gt;</title>",
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/vscode/src/chat-view-bridge.test.ts packages/vscode/src/webview-html.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the bridge and the HTML builder**

`chat-view-bridge.ts`:

```ts
import type { State, ToHost, ToWebview } from "./protocol.js";

/** The slice of vscode.Webview the bridge uses; a fake in tests. */
export interface WebviewLike {
  postMessage(message: ToWebview): Thenable<boolean>;
  onDidReceiveMessage(listener: (message: ToHost) => void): { dispose(): void };
}

export interface ChatViewHandlers {
  send(text: string): void;
  removeAttachment(index: number): void;
  command(name: "login" | "newChat" | "installBrowser"): void;
}

function isToHost(m: unknown): m is ToHost {
  if (typeof m !== "object" || m === null) return false;
  const t = (m as { type?: unknown }).type;
  const msg = m as Record<string, unknown>;
  switch (t) {
    case "ready":
      return true;
    case "send":
      return typeof msg.text === "string";
    case "removeAttachment":
      return typeof msg.index === "number";
    case "command":
      return msg.name === "login" || msg.name === "newChat" || msg.name === "installBrowser";
    default:
      return false;
  }
}

/** Translates webview messages into handler calls and pushes state to
 * whichever webview is currently attached (VSCode recreates it). */
export class ChatViewBridge {
  private webview: WebviewLike | undefined;

  constructor(
    private readonly getState: () => State,
    private readonly handlers: ChatViewHandlers,
  ) {}

  attach(webview: WebviewLike): { dispose(): void } {
    this.webview = webview;
    const sub = webview.onDidReceiveMessage((raw) => {
      if (!isToHost(raw)) return;
      switch (raw.type) {
        case "ready":
          this.pushState(this.getState());
          break;
        case "send":
          this.handlers.send(raw.text);
          break;
        case "removeAttachment":
          this.handlers.removeAttachment(raw.index);
          break;
        case "command":
          this.handlers.command(raw.name);
          break;
      }
    });
    return {
      dispose: () => {
        sub.dispose();
        if (this.webview === webview) this.webview = undefined;
      },
    };
  }

  pushState(state: State): void {
    void this.webview?.postMessage({ type: "state", ...state });
  }

  pushProgress(text: string): void {
    void this.webview?.postMessage({ type: "progress", text });
  }
}
```

`webview-html.ts`:

```ts
export interface HtmlInputs {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
  title: string;
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The whole document; no inline script or style, no external origin. */
export function buildHtml(i: HtmlInputs): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${i.nonce}'; style-src ${i.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${i.styleUri}">
<title>${escape(i.title)}</title>
</head>
<body>
<main id="history" aria-live="polite"></main>
<div id="status" hidden></div>
<div id="attachments"></div>
<form id="composer">
<textarea id="input" rows="3" placeholder="Message (Enter to send, Shift+Enter for a newline)"></textarea>
<button id="send" type="submit">Send</button>
</form>
<script nonce="${i.nonce}" src="${i.scriptUri}"></script>
</body>
</html>`;
}
```

- [ ] **Step 4: Run the two tests**

Run: `bun test packages/vscode/src/chat-view-bridge.test.ts packages/vscode/src/webview-html.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing commands test**

`packages/vscode/src/commands.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { BrowserUnavailableError, LoginAbortedError } from "@chatbridge/core";
import { type CommandDeps, createCommands } from "./commands.js";
import type { SessionController } from "./session-controller.js";
import type { EditorSnapshot, VscodeUi } from "./vscode-ui.js";

interface Fake {
  ui: VscodeUi;
  log: string[];
  editor: EditorSnapshot | undefined;
  errorChoice: string | undefined;
  controller: Pick<
    SessionController,
    "send" | "retryLast" | "newChat" | "discard" | "markLoggedIn" | "addAttachment" | "removeAttachment" | "getState"
  >;
  sendResults: Array<Awaited<ReturnType<SessionController["send"]>>>;
  login: CommandDeps["runLogin"];
  install: CommandDeps["installBrowser"];
  cleared: number;
}

function fake(): Fake {
  const f = { log: [], sendResults: [], cleared: 0 } as unknown as Fake;
  f.ui = {
    showErrorMessage: async (m, ...items) => {
      f.log.push(`error:${m}${items.length ? `[${items.join(",")}]` : ""}`);
      return f.errorChoice;
    },
    showWarningMessage: (m) => f.log.push(`warn:${m}`),
    showInformationMessage: (m) => f.log.push(`info:${m}`),
    withProgress: async (title, _cancellable, task) => {
      f.log.push(`progress:${title}`);
      return task({ report: (t) => f.log.push(`report:${t}`) }, new AbortController().signal);
    },
    activeEditor: () => f.editor,
    openDocument: async (uri) => ({ path: `doc:${String(uri)}`, text: "DOC" }),
    focusView: () => f.log.push("focus"),
  };
  f.controller = {
    send: async (t) => {
      f.log.push(`send:${t}`);
      return f.sendResults.shift() ?? { ok: true };
    },
    retryLast: async () => {
      f.log.push("retry");
      return { ok: true };
    },
    newChat: async () => f.log.push("newChat"),
    discard: async (s) => f.log.push(`discard:${s}`),
    markLoggedIn: () => f.log.push("markLoggedIn"),
    addAttachment: (a) => {
      f.log.push(`attach:${a.path}:${a.bytes}`);
      return a.path.includes("toobig") ? { ok: false, reason: "too big" } : { ok: true };
    },
    removeAttachment: (i) => f.log.push(`remove:${i}`),
    getState: () => ({ status: "idle", messages: [], pendingAttachments: [] }),
  };
  f.login = async (o) => {
    f.log.push("runLogin");
    o.onProgress?.("Opening browser...");
  };
  f.install = async (o) => {
    f.log.push("installBrowser");
    o.onProgress?.("Downloading Chromium");
  };
  return f;
}

function commands(f: Fake) {
  return createCommands({
    displayName: "Acme AI",
    controller: f.controller as SessionController,
    ui: f.ui,
    runLogin: f.login,
    installBrowser: f.install,
    loginOptions: () => ({}) as never,
    installOptions: () => ({ cliPath: "/x/cli.js" }),
    clearAuth: async () => {
      f.cleared++;
    },
  });
}

describe("commands", () => {
  test("login runs runLogin under progress and marks the controller", async () => {
    const f = fake();
    await commands(f).login();
    expect(f.log).toEqual(["progress:Log in to Acme AI", "runLogin", "report:Opening browser...", "markLoggedIn"]);
  });

  test("a cancelled login is silent; another failure is shown", async () => {
    const f = fake();
    f.login = async () => {
      throw new LoginAbortedError();
    };
    await commands(f).login();
    expect(f.log.filter((l) => l.startsWith("error"))).toEqual([]);
    f.login = async () => {
      throw new Error("navigateToLogin failed");
    };
    await commands(f).login();
    expect(f.log.at(-1)).toBe("error:Login failed: navigateToLogin failed");
  });

  test("logout discards the session and clears the auth state", async () => {
    const f = fake();
    await commands(f).logout();
    expect(f.log).toEqual(["discard:Logged out"]);
    expect(f.cleared).toBe(1);
  });

  test("send forwards to the controller; a missing browser offers Install and retries", async () => {
    const f = fake();
    f.sendResults.push({
      ok: false,
      code: "BROWSER_UNAVAILABLE",
      message: new BrowserUnavailableError("Chromium is not installed (expected at /x).").message,
    });
    f.errorChoice = "Install";
    await commands(f).send("hi");
    expect(f.log).toEqual([
      "send:hi",
      "error:Chromium is not installed (expected at /x).[Install]",
      "progress:Installing Chromium",
      "installBrowser",
      "report:Downloading Chromium",
      "retry",
    ]);
  });

  test("declining the install leaves the error in the history only", async () => {
    const f = fake();
    f.sendResults.push({ ok: false, code: "BROWSER_UNAVAILABLE", message: "missing" });
    f.errorChoice = undefined;
    await commands(f).send("hi");
    expect(f.log).toEqual(["send:hi", "error:missing[Install]"]);
  });

  test("a failed install is reported and nothing is retried", async () => {
    const f = fake();
    f.sendResults.push({ ok: false, code: "BROWSER_UNAVAILABLE", message: "missing" });
    f.errorChoice = "Install";
    f.install = async () => {
      throw new Error("exited with 1");
    };
    await commands(f).send("hi");
    expect(f.log.at(-1)).toBe("error:Chromium install failed: exited with 1");
    expect(f.log).not.toContain("retry");
  });

  test("other send failures are left to the history", async () => {
    const f = fake();
    f.sendResults.push({ ok: false, code: "AUTH_EXPIRED", message: "expired" });
    await commands(f).send("hi");
    expect(f.log).toEqual(["send:hi"]);
  });

  test("installBrowser command runs the install under progress", async () => {
    const f = fake();
    await commands(f).installBrowser();
    expect(f.log).toEqual([
      "progress:Installing Chromium",
      "installBrowser",
      "report:Downloading Chromium",
      "info:Chromium installed.",
    ]);
  });

  test("sendSelection attaches the selection with a line range and focuses the view", async () => {
    const f = fake();
    f.editor = {
      path: "src/a.ts",
      text: "line1\nline2\nline3\n",
      selection: { text: "line2\nline3", startLine: 2, endLine: 3 },
    };
    await commands(f).sendSelection();
    expect(f.log).toEqual(["attach:src/a.ts:L2-L3:11", "focus"]);
  });

  test("sendSelection without a selection attaches the whole document", async () => {
    const f = fake();
    f.editor = { path: "src/a.ts", text: "abc" };
    await commands(f).sendSelection();
    expect(f.log).toEqual(["attach:src/a.ts:3", "focus"]);
  });

  test("sendSelection without an editor warns", async () => {
    const f = fake();
    await commands(f).sendSelection();
    expect(f.log).toEqual(["warn:No active editor."]);
  });

  test("an over-limit attachment is refused with the controller's reason", async () => {
    const f = fake();
    f.editor = { path: "toobig.ts", text: "x" };
    await commands(f).sendSelection();
    expect(f.log).toEqual(["attach:toobig.ts:1", "warn:too big"]);
  });

  test("sendFile with a uri opens that document; without one uses the editor", async () => {
    const f = fake();
    await commands(f).sendFile("file:///w/b.md");
    expect(f.log).toEqual(["attach:doc:file:///w/b.md:3", "focus"]);
    f.log.length = 0;
    f.editor = { path: "src/a.ts", text: "abcd", selection: { text: "b", startLine: 1, endLine: 1 } };
    await commands(f).sendFile(undefined);
    expect(f.log).toEqual(["attach:src/a.ts:4", "focus"]);
  });

  test("bytes are UTF-8 bytes, not characters", async () => {
    const f = fake();
    f.editor = { path: "j.md", text: "日本" };
    await commands(f).sendSelection();
    expect(f.log[0]).toBe("attach:j.md:6");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test packages/vscode/src/commands.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 7: Implement `vscode-ui.ts` and `commands.ts`**

`vscode-ui.ts` (the interface is `vscode`-free; `createVscodeUi` is the only function here that touches the API and it has no unit test):

```ts
import type * as vscode from "vscode";

export interface EditorSnapshot {
  /** Workspace-relative, `/`-separated; absolute when outside a workspace. */
  path: string;
  text: string;
  /** Present when the selection is non-empty; lines are 1-based inclusive. */
  selection?: { text: string; startLine: number; endLine: number };
}

export interface ProgressReporter {
  report(text: string): void;
}

/** The slice of the vscode API the commands use; a fake in unit tests. */
export interface VscodeUi {
  showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
  showWarningMessage(message: string): void;
  showInformationMessage(message: string): void;
  withProgress<T>(
    title: string,
    cancellable: boolean,
    task: (progress: ProgressReporter, signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  activeEditor(): EditorSnapshot | undefined;
  /** Opens the document behind an explorer Uri (or any Uri) read-only. */
  openDocument(uri: unknown): Promise<{ path: string; text: string }>;
  focusView(): void;
}

export function createVscodeUi(api: typeof vscode, id: string): VscodeUi {
  function relPath(uri: vscode.Uri): string {
    return api.workspace.asRelativePath(uri, false).split("\\").join("/");
  }
  return {
    showErrorMessage: (message, ...items) =>
      Promise.resolve(api.window.showErrorMessage(message, { modal: items.length > 0 }, ...items)),
    showWarningMessage: (message) => void api.window.showWarningMessage(message),
    showInformationMessage: (message) => void api.window.showInformationMessage(message),
    withProgress: (title, cancellable, task) =>
      Promise.resolve(
        api.window.withProgress(
          { location: api.ProgressLocation.Notification, title, cancellable },
          (progress, token) => {
            const ac = new AbortController();
            token.onCancellationRequested(() => ac.abort());
            return task({ report: (message) => progress.report({ message }) }, ac.signal);
          },
        ),
      ),
    activeEditor: () => {
      const editor = api.window.activeTextEditor;
      if (!editor) return undefined;
      const doc = editor.document;
      const snap: EditorSnapshot = { path: relPath(doc.uri), text: doc.getText() };
      if (!editor.selection.isEmpty) {
        snap.selection = {
          text: doc.getText(editor.selection),
          startLine: editor.selection.start.line + 1,
          endLine: editor.selection.end.line + 1,
        };
      }
      return snap;
    },
    openDocument: async (uri) => {
      const doc = await api.workspace.openTextDocument(uri as vscode.Uri);
      return { path: relPath(doc.uri), text: doc.getText() };
    },
    focusView: () => void api.commands.executeCommand(`${id}.chat.focus`),
  };
}
```

`commands.ts`:

```ts
import type { LoginOptions } from "@chatbridge/core";
import { LoginAbortedError } from "@chatbridge/core";
import type { InstallBrowserOptions } from "./install-browser.js";
import type { SessionController } from "./session-controller.js";
import type { EditorSnapshot, VscodeUi } from "./vscode-ui.js";

export interface CommandDeps {
  displayName: string;
  controller: SessionController;
  ui: VscodeUi;
  runLogin: (opts: LoginOptions) => Promise<void>;
  installBrowser: (opts: InstallBrowserOptions) => Promise<void>;
  /** Provider, auth store, etc.; the command adds signal and onProgress. */
  loginOptions: () => Omit<LoginOptions, "signal" | "onProgress">;
  installOptions: () => Omit<InstallBrowserOptions, "onProgress">;
  clearAuth: () => Promise<void>;
}

export interface CommandHandlers {
  login(): Promise<void>;
  logout(): Promise<void>;
  newChat(): Promise<void>;
  installBrowser(): Promise<void>;
  sendSelection(): Promise<void>;
  sendFile(uri: unknown): Promise<void>;
  focus(): void;
  /** From the webview's input box. */
  send(text: string): Promise<void>;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createCommands(deps: CommandDeps): CommandHandlers {
  const { controller, ui } = deps;

  async function runInstall(): Promise<boolean> {
    try {
      await ui.withProgress("Installing Chromium", false, (progress) =>
        deps.installBrowser({ ...deps.installOptions(), onProgress: (l) => progress.report(l) }),
      );
      return true;
    } catch (err) {
      await ui.showErrorMessage(`Chromium install failed: ${message(err)}`);
      return false;
    }
  }

  function attach(path: string, text: string): void {
    const result = controller.addAttachment({ path, bytes: utf8Bytes(text), content: text });
    if (!result.ok) {
      ui.showWarningMessage(result.reason);
      return;
    }
    ui.focusView();
  }

  function attachEditor(editor: EditorSnapshot, useSelection: boolean): void {
    if (useSelection && editor.selection) {
      const s = editor.selection;
      attach(`${editor.path}:L${s.startLine}-L${s.endLine}`, s.text);
    } else {
      attach(editor.path, editor.text);
    }
  }

  return {
    async login() {
      try {
        await ui.withProgress(`Log in to ${deps.displayName}`, true, (progress, signal) =>
          deps.runLogin({ ...deps.loginOptions(), signal, onProgress: (m) => progress.report(m) }),
        );
        controller.markLoggedIn();
      } catch (err) {
        if (err instanceof LoginAbortedError) return;
        await ui.showErrorMessage(`Login failed: ${message(err)}`);
      }
    },

    async logout() {
      await controller.discard("Logged out");
      await deps.clearAuth();
    },

    newChat: () => controller.newChat(),

    async installBrowser() {
      if (await runInstall()) ui.showInformationMessage("Chromium installed.");
    },

    async sendSelection() {
      const editor = ui.activeEditor();
      if (!editor) {
        ui.showWarningMessage("No active editor.");
        return;
      }
      attachEditor(editor, true);
    },

    async sendFile(uri) {
      if (uri !== undefined && uri !== null) {
        const doc = await ui.openDocument(uri);
        attach(doc.path, doc.text);
        return;
      }
      const editor = ui.activeEditor();
      if (!editor) {
        ui.showWarningMessage("No active editor.");
        return;
      }
      attachEditor(editor, false);
    },

    focus: () => ui.focusView(),

    async send(text) {
      const result = await controller.send(text);
      if (result.ok || result.code !== "BROWSER_UNAVAILABLE") return;
      const choice = await ui.showErrorMessage(result.message, "Install");
      if (choice !== "Install") return;
      if (await runInstall()) await controller.retryLast();
    },
  };
}
```

- [ ] **Step 8: Run the commands test**

Run: `bun run build && bun test packages/vscode/src/commands.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the webview**

`packages/vscode/src/webview/main.ts` (replaces the placeholder):

```ts
import type { Message, State, ToHost, ToWebview } from "../protocol.js";

declare function acquireVsCodeApi(): { postMessage(m: ToHost): void };
const vscode = acquireVsCodeApi();

const history = document.getElementById("history") as HTMLElement;
const status = document.getElementById("status") as HTMLElement;
const attachments = document.getElementById("attachments") as HTMLElement;
const form = document.getElementById("composer") as HTMLFormElement;
const input = document.getElementById("input") as HTMLTextAreaElement;
const sendButton = document.getElementById("send") as HTMLButtonElement;

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, onClick: () => void): HTMLElement {
  const b = el("button", "action", label);
  b.setAttribute("type", "button");
  b.addEventListener("click", onClick);
  return b;
}

function renderMessage(m: Message): HTMLElement {
  const box = el("div", `message ${m.role}`);
  if (m.role === "separator") {
    box.textContent = `— ${m.text} —`;
    return box;
  }
  box.appendChild(el("div", "text", m.text));
  for (const a of m.attachments ?? []) {
    box.appendChild(el("div", "attachment", `📎 ${a.path} (${formatSize(a.bytes)})`));
  }
  return box;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderStatus(s: State): void {
  status.replaceChildren();
  status.hidden = false;
  if (s.status === "busy" || s.status === "opening") {
    status.appendChild(el("span", "spinner"));
    status.appendChild(el("span", "progress-text", s.status === "opening" ? "Opening browser..." : "Waiting..."));
    return;
  }
  if (s.status === "dead") {
    const auth = s.lastError === "AUTH_REQUIRED" || s.lastError === "AUTH_EXPIRED";
    status.appendChild(el("span", "progress-text", auth ? "Not logged in." : "The chat stopped."));
    if (auth) status.appendChild(button("Log in", () => vscode.postMessage({ type: "command", name: "login" })));
    status.appendChild(button("New chat", () => vscode.postMessage({ type: "command", name: "newChat" })));
    return;
  }
  status.hidden = true;
}

function renderAttachments(s: State): void {
  attachments.replaceChildren();
  s.pendingAttachments.forEach((a, index) => {
    const chip = el("span", "chip", `📎 ${a.path} (${formatSize(a.bytes)})`);
    const x = button("×", () => vscode.postMessage({ type: "removeAttachment", index }));
    x.className = "chip-remove";
    chip.appendChild(x);
    attachments.appendChild(chip);
  });
}

function render(s: State): void {
  history.replaceChildren(...s.messages.map(renderMessage));
  history.scrollTop = history.scrollHeight;
  renderStatus(s);
  renderAttachments(s);
  const locked = s.status === "busy" || s.status === "opening";
  input.disabled = locked;
  sendButton.disabled = locked;
  if (!locked) input.focus();
}

function submit(): void {
  const text = input.value;
  if (text.trim() === "" && attachments.childElementCount === 0) return;
  vscode.postMessage({ type: "send", text });
  input.value = "";
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  submit();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const m = event.data;
  if (m.type === "state") {
    const { type: _type, ...state } = m;
    render(state);
  } else if (m.type === "progress") {
    const t = status.querySelector(".progress-text");
    if (t) t.textContent = m.text;
  }
});

vscode.postMessage({ type: "ready" });
```

`packages/vscode/src/webview/style.css`:

```css
body { margin: 0; display: flex; flex-direction: column; height: 100vh; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
#history { flex: 1; overflow-y: auto; padding: 8px; }
.message { margin-bottom: 10px; padding: 6px 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
.message.user { background: var(--vscode-input-background); border-left: 3px solid var(--vscode-focusBorder); }
.message.assistant { background: var(--vscode-editor-background); }
.message.error { color: var(--vscode-errorForeground); border-left: 3px solid var(--vscode-errorForeground); }
.message.separator { text-align: center; opacity: 0.6; }
.attachment { opacity: 0.7; font-size: 90%; margin-top: 4px; }
#status { padding: 4px 8px; display: flex; gap: 8px; align-items: center; opacity: 0.85; }
.spinner { width: 10px; height: 10px; border: 2px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
#attachments { padding: 0 8px; display: flex; flex-wrap: wrap; gap: 4px; }
.chip { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; padding: 2px 8px; font-size: 90%; }
.chip-remove, .action { margin-left: 6px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 2px 8px; cursor: pointer; }
#composer { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
#input { flex: 1; resize: none; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); font-family: inherit; }
#send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 0 12px; cursor: pointer; }
#send:disabled, #input:disabled { opacity: 0.5; }
```

Type-check the webview: add `"check:webview": "tsc -p tsconfig.webview.json"` to `packages/vscode/package.json` scripts and call it from `build:webview` (`bun run check:webview && esbuild ...`).

- [ ] **Step 10: Write `chat-view-provider.ts` and `create-extension.ts`**

`chat-view-provider.ts`:

```ts
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { ChatViewBridge } from "./chat-view-bridge.js";
import { buildHtml } from "./webview-html.js";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly title: string,
    private readonly bridge: ChatViewBridge,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    view.webview.html = buildHtml({
      cspSource: view.webview.cspSource,
      nonce: randomBytes(16).toString("base64url"),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, "main.js")).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, "style.css")).toString(),
      title: this.title,
    });
    const sub = this.bridge.attach(view.webview);
    view.onDidDispose(() => sub.dispose());
  }
}
```

The webview assets (`dist/webview/main.js`, `style.css`) are served from the *vendor extension's* tree: `import.meta.url` is unusable in a CJS bundle, so instead the vendor build copies `node_modules/@chatbridge/vscode/dist/webview` to its own `dist/webview` (Task 8's `esbuild.mjs`) and `createExtension` points the view at `context.extensionUri` + `dist/webview`.

`create-extension.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ChatSession,
  type Provider,
  createAuthStore,
  runLogin,
} from "@chatbridge/core";
import * as vscode from "vscode";
import { ChatViewBridge } from "./chat-view-bridge.js";
import { ChatViewProvider } from "./chat-view-provider.js";
import { type CommandHandlers, createCommands } from "./commands.js";
import { installBrowser } from "./install-browser.js";
import { COMMAND_NAMES, missingContributions } from "./manifest.js";
import { SessionController } from "./session-controller.js";
import { createVscodeUi } from "./vscode-ui.js";

export interface CreateExtensionOptions {
  /** Prefix for every contributed ID, e.g. "company-ai". */
  id: string;
  /** Shown as the view title and in notifications. */
  displayName: string;
  /** Always pinned; no dynamic provider loading. */
  provider: Provider;
  /** Directory name under ~/.config; defaults to `id`. Use the vendor
   * CLI's `configDir` so one `auth login` serves both. */
  configDir?: string;
  /** Defaults; the user's `<id>.timeoutSec` / `<id>.headless` settings win. */
  timeoutMs?: number;
  headless?: boolean;
  /** Test-only: overrides the config/auth-store base directory. */
  baseDir?: string;
  /** Path of `playwright/cli.js`; defaults to
   * `<extension>/node_modules/playwright/cli.js`. */
  playwrightCliPath?: string;
}

/** What `activate` returns: the E2E drives the controller directly. */
export interface ExtensionApi {
  controller: SessionController;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function createExtension(opts: CreateExtensionOptions) {
  let controller: SessionController | undefined;

  async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
    const missing = missingContributions(context.extension.packageJSON, opts.id);
    if (missing.length > 0) {
      throw new Error(
        `${opts.displayName}: package.json lacks contributes entries for "${opts.id}": ${missing.join(", ")}`,
      );
    }
    const authStore = createAuthStore({
      configDir: opts.configDir ?? opts.id,
      providerName: opts.provider.name,
      baseDir: opts.baseDir,
    });
    const output = vscode.window.createOutputChannel(opts.displayName);
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    context.subscriptions.push(output, statusBar);

    const bridge = new ChatViewBridge(
      () => (controller as SessionController).getState(),
      {
        send: (text) => void handlers.send(text),
        removeAttachment: (i) => controller?.removeAttachment(i),
        command: (name) => void handlers[name](),
      },
    );

    function settings() {
      const cfg = vscode.workspace.getConfiguration(opts.id);
      return {
        headless: cfg.get<boolean>("headless", opts.headless ?? true),
        timeoutMs: cfg.get<number>("timeoutSec", (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000) * 1000,
      };
    }

    function progress(message: string): void {
      output.appendLine(message);
      statusBar.text = `$(sync~spin) ${message}`;
      bridge.pushProgress(message);
    }

    controller = new SessionController({
      openSession: () =>
        ChatSession.open({ provider: opts.provider, authStore, ...settings(), onProgress: progress }),
      onChange: (state) => {
        bridge.pushState(state);
        if (state.status === "busy" || state.status === "opening") statusBar.show();
        else statusBar.hide();
      },
    });

    const cliPath =
      opts.playwrightCliPath ?? join(context.extensionPath, "node_modules", "playwright", "cli.js");
    const handlers: CommandHandlers = createCommands({
      displayName: opts.displayName,
      controller,
      ui: createVscodeUi(vscode, opts.id),
      runLogin,
      installBrowser,
      loginOptions: () => ({ provider: opts.provider, authStore }),
      installOptions: () => {
        if (!existsSync(cliPath)) {
          throw new Error(`playwright is not bundled with this extension (looked for ${cliPath}).`);
        }
        return { cliPath };
      },
      clearAuth: () => authStore.clear(),
    });

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        `${opts.id}.chat`,
        new ChatViewProvider(context.extensionUri, opts.displayName, bridge),
      ),
    );
    for (const name of COMMAND_NAMES) {
      context.subscriptions.push(
        vscode.commands.registerCommand(`${opts.id}.${name}`, (arg?: unknown) =>
          name === "sendFile" ? handlers.sendFile(arg) : handlers[name](),
        ),
      );
    }
    return { controller };
  }

  async function deactivate(): Promise<void> {
    await controller?.close();
  }

  return { activate, deactivate };
}
```

Note `installOptions` throwing is caught by `runInstall` in `commands.ts` and shown as `Chromium install failed: …`; that is the intended surfacing.

Update `index.ts` to export `createExtension`, `CreateExtensionOptions`, `ExtensionApi`, `ChatViewBridge`, `WebviewLike`, `ChatViewHandlers`, `buildHtml`, `VscodeUi`, `EditorSnapshot`, `createVscodeUi`, `createCommands`, `CommandDeps`, `CommandHandlers`.

- [ ] **Step 11: Build and run everything**

Run: `bun run check`
Expected: PASS; `tsc` compiles `create-extension.ts` against `@types/vscode`; the webview type-checks against DOM; `dist/webview/main.js` and `style.css` exist.

- [ ] **Step 12: Commit**

```bash
git add packages/vscode
git commit -m "feat(vscode): createExtension factory, chat webview and commands (Refs #57)"
```

---

### Task 8: Example extension, E2E, CI job

**Files:**
- Create: `examples/vscode-dummy-chat/package.json`, `tsconfig.json`, `esbuild.mjs`, `src/extension.ts`, `test/run-e2e.ts`, `test/suite.ts`, `media/icon.svg`, `.vscodeignore`
- Modify: root `package.json` (scripts `e2e:vscode`), root `tsconfig.json` (reference), `.github/workflows/ci.yml`, `.gitignore` (`.vscode-test/`)

**Interfaces:**
- Consumes: `createExtension`, `ExtensionApi`, `createDummyProvider(url)`, `startDummyChat(port)`, `BrowserRuntime`, `AuthStore`.

- [ ] **Step 1: Scaffold the example**

`examples/vscode-dummy-chat/package.json`:

```json
{
  "name": "chatbridge-example-vscode-dummy-chat",
  "displayName": "ChatBridge Dummy Chat",
  "description": "Reference VSCode extension built with @chatbridge/vscode against the bundled dummy chat",
  "private": true,
  "version": "0.0.0",
  "publisher": "chatbridge-examples",
  "license": "MIT",
  "engines": { "vscode": "^1.100.0", "node": ">=20" },
  "main": "./dist/extension.js",
  "type": "module",
  "activationEvents": [],
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        { "id": "chatbridge-dummy", "title": "Dummy Chat", "icon": "media/icon.svg" }
      ]
    },
    "views": {
      "chatbridge-dummy": [
        { "id": "chatbridge-dummy.chat", "name": "Chat", "type": "webview" }
      ]
    },
    "commands": [
      { "command": "chatbridge-dummy.login", "title": "Log in", "category": "Dummy Chat" },
      { "command": "chatbridge-dummy.logout", "title": "Log out", "category": "Dummy Chat" },
      { "command": "chatbridge-dummy.newChat", "title": "New Chat", "category": "Dummy Chat", "icon": "$(add)" },
      { "command": "chatbridge-dummy.installBrowser", "title": "Install Browser", "category": "Dummy Chat" },
      { "command": "chatbridge-dummy.sendSelection", "title": "Send Selection to Dummy Chat", "category": "Dummy Chat" },
      { "command": "chatbridge-dummy.sendFile", "title": "Send File to Dummy Chat", "category": "Dummy Chat" },
      { "command": "chatbridge-dummy.focus", "title": "Focus Chat", "category": "Dummy Chat" }
    ],
    "menus": {
      "view/title": [
        { "command": "chatbridge-dummy.newChat", "when": "view == chatbridge-dummy.chat", "group": "navigation" }
      ],
      "editor/context": [
        { "command": "chatbridge-dummy.sendSelection", "group": "chatbridge" }
      ],
      "explorer/context": [
        { "command": "chatbridge-dummy.sendFile", "when": "!explorerResourceIsFolder", "group": "chatbridge" }
      ]
    },
    "configuration": {
      "title": "Dummy Chat",
      "properties": {
        "chatbridge-dummy.headless": { "type": "boolean", "default": true, "description": "Run the browser without a window." },
        "chatbridge-dummy.timeoutSec": { "type": "number", "default": 120, "description": "Seconds to wait for each browser step." }
      }
    }
  },
  "scripts": {
    "build": "node esbuild.mjs",
    "e2e": "bun run build && bun test/run-e2e.ts",
    "package": "bunx @vscode/vsce package --no-dependencies --out dist/"
  },
  "dependencies": {
    "@chatbridge/vscode": "workspace:*",
    "@chatbridge/example-dummy-chat": "workspace:*",
    "playwright": "1.63.0"
  },
  "devDependencies": {
    "@chatbridge/core": "workspace:*",
    "@chatbridge/runtime": "workspace:*",
    "@types/vscode": "^1.100.0",
    "@vscode/test-electron": "^2.5.0",
    "@vscode/vsce": "^3.6.0",
    "esbuild": "^0.25.0"
  }
}
```

`media/icon.svg`: a 24×24 SVG with a single `<path>` of a speech bubble (`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M4 4h16v11H8l-4 4z"/></svg>`).

`tsconfig.json` (type-check only; esbuild emits):

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "emitDeclarationOnly": true,
    "outDir": "dist/types",
    "rootDir": "."
  },
  "include": ["src", "test"],
  "references": [{ "path": "../../packages/vscode" }, { "path": "../../packages/core" }, { "path": "../../packages/runtime" }, { "path": "../dummy-chat" }]
}
```

Add `{ "path": "examples/vscode-dummy-chat" }` to the root `tsconfig.json`.

`esbuild.mjs`:

```js
import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode", "playwright"],
  sourcemap: true,
};
await build({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js" });
await build({ ...common, entryPoints: ["test/suite.ts"], outfile: "dist/test/suite.js" });

// The chat webview's assets ship with @chatbridge/vscode; VSCode serves them
// from the extension's own tree, so copy them next to the bundle.
const vscodePkg = dirname(require.resolve("@chatbridge/vscode/package.json"));
mkdirSync("dist/webview", { recursive: true });
cpSync(join(vscodePkg, "dist", "webview"), "dist/webview", { recursive: true });
```

`src/extension.ts`:

```ts
import { createDummyProvider } from "@chatbridge/example-dummy-chat/provider";
import { createExtension } from "@chatbridge/vscode";

// DUMMY_CHAT_URL and CHATBRIDGE_DUMMY_BASE_DIR exist for the E2E runner; a
// real vendor extension hardcodes its service URL and has no baseDir.
export const { activate, deactivate } = createExtension({
  id: "chatbridge-dummy",
  displayName: "Dummy Chat",
  provider: createDummyProvider(process.env.DUMMY_CHAT_URL ?? "http://localhost:8735"),
  configDir: "chatbridge",
  baseDir: process.env.CHATBRIDGE_DUMMY_BASE_DIR,
});
```

`.vscodeignore`: `src/**`, `test/**`, `tsconfig.json`, `esbuild.mjs`, `dist/test/**`, `**/*.map`.

- [ ] **Step 2: Write the E2E runner and suite**

`test/run-e2e.ts` (Bun; prepares auth, launches VSCode):

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDummyProvider } from "@chatbridge/example-dummy-chat/provider";
import { startDummyChat } from "@chatbridge/example-dummy-chat/server";
import { AuthStore, BrowserRuntime } from "@chatbridge/runtime";
import { runTests } from "@vscode/test-electron";

const server = await startDummyChat(0);
const baseDir = mkdtempSync(join(tmpdir(), "cb-vsc-"));
// Short path: VSCode's IPC socket lives under --user-data-dir and macOS caps
// unix socket paths at 104 bytes.
const userDataDir = mkdtempSync(join(tmpdir(), "cb-ud-"));
try {
  // Seed the auth state headlessly; the extension's login command is the
  // same runLogin the CLI uses and is covered by the core E2E.
  const provider = createDummyProvider(server.url);
  const store = new AuthStore({ configDir: "chatbridge", providerName: provider.name, baseDir });
  const rt = await BrowserRuntime.launch({ headless: true, provider, authStore: store });
  await provider.navigateToLogin(rt.page);
  await rt.page.locator("#login-button").click();
  await rt.page.waitForURL(/\/chat$/);
  await rt.saveAuthState();
  await rt.close();

  await runTests({
    extensionDevelopmentPath: resolve(import.meta.dirname, ".."),
    extensionTestsPath: resolve(import.meta.dirname, "../dist/test/suite.js"),
    launchArgs: ["--user-data-dir", userDataDir, "--disable-extensions", "--disable-workspace-trust"],
    extensionTestsEnv: {
      DUMMY_CHAT_URL: server.url,
      CHATBRIDGE_DUMMY_BASE_DIR: baseDir,
    },
  });
} finally {
  server.stop();
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
}
```

`test/suite.ts` (runs inside the extension host; `@vscode/test-electron` calls the exported `run`):

```ts
import assert from "node:assert/strict";
import type { ExtensionApi } from "@chatbridge/vscode";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension("chatbridge-examples.chatbridge-example-vscode-dummy-chat");
  assert.ok(ext, "extension not found");
  const api = (await ext.activate()) as ExtensionApi;
  const { controller } = api;

  assert.equal(controller.getState().status, "closed");

  // First turn: opens the browser lazily.
  const first = await controller.send("hello from vscode");
  assert.deepEqual(first, { ok: true });
  let s = controller.getState();
  assert.equal(s.status, "idle");
  assert.equal(s.messages.length, 2);
  assert.equal(s.messages[1].role, "assistant");
  assert.match(s.messages[1].text, /^Echo: hello from vscode/);

  // Attachment through the command path.
  await vscode.commands.executeCommand("chatbridge-dummy.newChat");
  s = controller.getState();
  assert.equal(s.status, "closed");
  assert.deepEqual(s.messages.at(-1), { role: "separator", text: "New chat" });

  const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: "# note\n" });
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand("chatbridge-dummy.sendSelection");
  assert.equal(controller.getState().pendingAttachments.length, 1);

  const second = await controller.send("with file");
  assert.deepEqual(second, { ok: true });
  s = controller.getState();
  assert.equal(s.messages.at(-2)?.attachments?.length, 1);
  assert.match(s.messages.at(-1)?.text ?? "", /^Echo: with file/);

  await controller.close();
  assert.equal(controller.getState().status, "closed");
}
```

The extension ID VSCode derives is `<publisher>.<name>`, and `name` may not be npm-scoped (vsce rejects `@scope/`), hence the unscoped package name; with the manifest above the ID is `chatbridge-examples.chatbridge-example-vscode-dummy-chat`. If `getExtension` returns `undefined`, print `vscode.extensions.all.map(e => e.id)` in the assertion message and fix the ID, not the manifest.

Root `package.json` scripts: `"e2e:vscode": "bun run build && bun run --filter chatbridge-example-vscode-dummy-chat e2e"`. `.gitignore`: add `.vscode-test/`.

- [ ] **Step 3: Run the E2E locally**

Run: `bun install && bun run e2e:vscode`
Expected: VSCode downloads once (`.vscode-test/`), a window opens and closes, `Exit code: 0`. If the window stays open with an activation error, read `Developer: Toggle Developer Tools` output; the most likely cause is the manifest check (Task 6) or the webview asset copy in `esbuild.mjs`.

- [ ] **Step 4: Add the CI job**

Append to `.github/workflows/ci.yml`:

```yaml
  vscode-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: changes
        name: Detect extension changes
        run: |
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            base="origin/${{ github.base_ref }}"
          else
            base="${{ github.event.before }}"
          fi
          if ! git cat-file -e "$base" 2>/dev/null; then
            echo "ext=true" >> "$GITHUB_OUTPUT"; exit 0
          fi
          if git diff --name-only "$base...HEAD" | grep -E '^(packages/(vscode|core|runtime)/|examples/(vscode-dummy-chat|dummy-chat)/|\.github/workflows/ci\.yml)' | grep -q .; then
            echo "ext=true" >> "$GITHUB_OUTPUT"
          else
            echo "ext=false" >> "$GITHUB_OUTPUT"
            echo "No extension-related change; skipping the VSCode E2E."
          fi
      - if: steps.changes.outputs.ext == 'true'
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - if: steps.changes.outputs.ext == 'true'
        run: bun install --frozen-lockfile
      - if: steps.changes.outputs.ext == 'true'
        run: ./packages/runtime/node_modules/.bin/playwright install --with-deps chromium
      - if: steps.changes.outputs.ext == 'true'
        run: xvfb-run -a bun run e2e:vscode
      - if: steps.changes.outputs.ext == 'true'
        run: bun run --filter chatbridge-example-vscode-dummy-chat package
```

`vscode-e2e` is not a required status in the main ruleset; leave the ruleset alone.

- [ ] **Step 5: Run `bun run check`, commit, open the PR**

Run: `bun run check`
Expected: PASS (the example's `tsconfig` joins `tsc --build`).

```bash
git add -A examples/vscode-dummy-chat package.json tsconfig.json bun.lock .github/workflows/ci.yml .gitignore
git commit -m "feat(vscode): reference dummy-chat extension with a test-electron E2E and CI job (Refs #57)"
git push -u origin issue-57
gh pr create --title "VSCode extension factory (milestone 11)" --body "..." # per the merge-workflow memory: PR early for CI
```

Watch both CI jobs; fix until green before Task 9.

---

### Task 9: Documentation

**Files:**
- Modify: `README.md` (exit codes at lines 104-108; new section `## VSCode extension` before `## Authentication`), `docs/ROADMAP.md` (new `### 11.` entry after 10b; remove the backlog bullet at lines 184-197), `.claude/skills/creating-provider-repo/SKILL.md` (new `## VSCode extension` section after `### Runtime and shebang`), `packages/vscode/README.md`

- [ ] **Step 1: README**

Replace the exit-code paragraph with:

```
Exit codes: 1 invalid argument or config, 2 not logged in, 3 auth expired,
4 response timeout, 5 provider could not be loaded, 6 blocked by the
service (a bot challenge or an IdP refusing the automated browser; try
`--headful`), 7 Chromium is not installed (the message says
`Run: npx playwright install chromium`), 130 `auth login` cancelled with
Ctrl-C. A timeout that coincides with a lost login is reported as 3 or 6
rather than 4. Set `CHATBRIDGE_DEBUG=1` to print the underlying error.
```

Add before `## Authentication`:

```
## VSCode extension

`@chatbridge/vscode` ships the same chat as a sidebar view. A vendor
repository packages it with its Provider, in the style of `createCli`:

```ts
import { createExtension } from "@chatbridge/vscode";
import provider from "./provider.js";
export const { activate, deactivate } = createExtension({
  id: "company-ai", displayName: "Company AI", provider, configDir: "company-ai",
});
```

The manifest declares the view `<id>.chat`, the commands `<id>.login`,
`logout`, `newChat`, `installBrowser`, `sendSelection`, `sendFile`, `focus`,
and the settings `<id>.headless` / `<id>.timeoutSec`;
`examples/vscode-dummy-chat` is the template (esbuild CJS bundle, `vscode`
and `playwright` external, webview assets copied next to the bundle). The
browser runs inside the extension host and opens lazily on the first
message. Use the CLI's `configDir` so one `auth login` serves both. When
Chromium is missing the extension offers to install it. Right-click a
selection or a file to attach it to the next message in the CLI's
`### path` fenced format.
```

- [ ] **Step 2: ROADMAP**

After the 10b entry add:

```
### 11. VSCode extension — done (issue #57, 2026-09-17)

`@chatbridge/vscode`: `createExtension({ id, displayName, provider,
configDir })` returns `activate` / `deactivate`; a vendor manifest declares
the `<id>.*` view, commands and settings (validated on activation). Sidebar
webview in vanilla TS (plain-text replies, attachment chips, Log in / New
chat recovery), lazy browser launch in the extension host, login with a
cancellable progress notification, Chromium install via Playwright's CLI
spawned with the host binary, send-selection / send-file in the CLI's
attachment format (helpers moved to core with `closeOrKill`). Runtime gaps
#52 (`BrowserUnavailableError`, exit 7) and #53 (cancellable `runLogin`,
exit 130) closed first. One `@vscode/test-electron` E2E in
`examples/vscode-dummy-chat`, separate CI job. Left for later: Markdown
rendering, history persistence, `@` completion, `!` shell mode, Chat
Participant API.
Spec: `docs/superpowers/specs/2026-09-17-vscode-extension-design.md`.
```

Delete the backlog bullet **VSCode extension (chat view).**

- [ ] **Step 3: Skill and package README**

In `.claude/skills/creating-provider-repo/SKILL.md`, after `### Runtime and shebang`, add:

```
## VSCode extension (`@chatbridge/vscode` ≥ 0.7.0)

Copy `examples/vscode-dummy-chat` from the framework repo into the vendor
repo as `vscode/`: `package.json` (rename `id` everywhere from
`chatbridge-dummy` to `<vendor>`; set `publisher`, `displayName`), `esbuild.mjs`,
`media/icon.svg`, `.vscodeignore`. `src/extension.ts` is
`createExtension({ id: "<vendor>", displayName, provider, configDir: "<vendor>" })`
with the same `configDir` as the CLI so one `auth login` serves both.
Depend on `playwright` (not `playwright-core`): the Install button spawns
its CLI. Bundle with esbuild (CJS, `vscode` and `playwright` external),
package with `vsce package` so `node_modules/playwright` ships in the
`.vsix`. Activation throws a message listing missing `contributes` IDs when
the manifest and `id` disagree. Verify by hand: F5 in VSCode → Log in →
send → right-click a selection → send → New Chat → Log out.
```

`packages/vscode/README.md`: package name, one paragraph (what it is), the `createExtension` snippet, the contributed-ID list, a pointer to the example, MIT.

- [ ] **Step 4: Lint, commit, sync**

Run: `bun run check`
Expected: PASS.

```bash
git add README.md docs/ROADMAP.md .claude/skills/creating-provider-repo/SKILL.md packages/vscode/README.md
git commit -m "docs: VSCode extension milestone (Refs #57)"
git push
gh issue comment 57 --body "Docs committed. What's next: whole-branch review (Fable), then squash-merge the PR."
```

---

## Self-review notes

- Spec §1 package layout: Task 5 (scaffold), Task 7 (files); `vscode-api.ts` in the spec is `vscode-ui.ts` here (same role).
- Spec §2 controller, commands, error table, settings, progress: Tasks 5, 7. The `BLOCKED` hint from the error table is the error message itself (core's `BlockedError` already suggests headful); the webview shows it in the history.
- Spec §3 view, protocol, recreation, test boundary: Task 7.
- Spec §4 attachment move and editor commands: Tasks 4, 7.
- Spec §5 #52/#53: Tasks 1–3.
- Spec §6 tests, E2E, CI, build, vsce smoke: Tasks 5, 8.
- Spec "Task order" step 7 docs: Task 9.
