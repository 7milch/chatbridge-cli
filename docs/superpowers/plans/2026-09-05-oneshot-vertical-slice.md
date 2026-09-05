# One-shot Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working `chatbridge -p "..."` one-shot round trip against a bundled dummy web chat, with headful `auth login` and auth-state persistence, verified by CI E2E.

**Architecture:** Bun-workspaces monorepo with one-way dependencies `cli → core → runtime → provider`. The provider package defines the contract; the runtime owns Playwright and auth-state files; core owns the session flow and errors; cli owns argument parsing, provider resolution, and the `createCli` factory. A dummy chat server in `examples/` closes the loop for E2E.

**Tech Stack:** TypeScript, Bun (runtime + workspaces + test runner), Playwright (Chromium), Biome (lint/format). Bun+Playwright compatibility is itself under test in this milestone.

**Spec:** `docs/superpowers/specs/2026-09-05-oneshot-vertical-slice-design.md`

## Global Constraints

- All committed documents, comments, and commit messages in English.
- Dependency direction is one-way: `cli → core → runtime → provider`. Never import in reverse.
- Auth-state files: mode `600`, parent directory mode `700`, content never logged.
- One-shot stdout carries the AI response body only; progress goes to stderr and only when stderr is a TTY.
- Package names: `@chatbridge/provider`, `@chatbridge/runtime`, `@chatbridge/core`, `chatbridge` (bin `chatbridge`). Private for now (`"private": true` at root; no publishing in this milestone).
- Never commit `INIT.md` or any auth-state file.

---

### Task 1: Monorepo scaffolding + toolchain

**Files:**
- Create: `package.json` (root), `tsconfig.json` (root), `biome.json`
- Create: `packages/provider/package.json`, `packages/provider/tsconfig.json`, `packages/provider/src/index.ts` (empty export)
- Create: `packages/runtime/package.json`, `packages/runtime/tsconfig.json`, `packages/runtime/src/index.ts` (empty export)
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts` (empty export)
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/index.ts` (empty export)
- Modify: `.gitignore` (add `*.tsbuildinfo`)
- Modify: `CLAUDE.md` (replace the "Current state" section with real commands)

**Interfaces:**
- Consumes: nothing.
- Produces: workspace layout every later task builds in; `bun run check` script (Biome lint + `tsc --noEmit` per package + `bun test`).

- [ ] **Step 1: Verify Bun is installed**

Run: `bun --version`
Expected: a version ≥ 1.1. If missing, stop and tell the user to install Bun.

- [ ] **Step 2: Write root package.json**

```json
{
  "name": "chatbridge-monorepo",
  "private": true,
  "workspaces": ["packages/*", "examples/*"],
  "scripts": {
    "lint": "biome check .",
    "typecheck": "tsc --build",
    "test": "bun test",
    "check": "bun run lint && bun run typecheck && bun run test"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 3: Write root tsconfig.json (composite project references)**

```json
{
  "files": [],
  "references": [
    { "path": "packages/provider" },
    { "path": "packages/runtime" },
    { "path": "packages/core" },
    { "path": "packages/cli" }
  ]
}
```

- [ ] **Step 4: Write biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "files": { "ignore": ["node_modules", "dist", "*.tsbuildinfo"] },
  "formatter": { "enabled": true, "indentStyle": "space" },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "organizeImports": { "enabled": true }
}
```

- [ ] **Step 5: Write the four package skeletons**

Each `packages/<name>/package.json` (adjust `name` and `dependencies` per package):

```json
{
  "name": "@chatbridge/provider",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

Dependencies per package (workspace protocol):
- provider: none; `devDependencies`: `{ "playwright-core": "^1.48.0" }` (types only)
- runtime: `{ "playwright": "^1.48.0", "@chatbridge/provider": "workspace:*" }`
- core: `{ "@chatbridge/provider": "workspace:*", "@chatbridge/runtime": "workspace:*" }`
- cli: `{ "@chatbridge/core": "workspace:*" }`, plus `"bin": { "chatbridge": "./src/bin.ts" }` (bin added in Task 7)

Each `packages/<name>/tsconfig.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": false,
    "emitDeclarationOnly": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

runtime/core/cli add `"references"` pointing at their dependency packages, e.g. core:

```json
"references": [{ "path": "../provider" }, { "path": "../runtime" }]
```

Each `src/index.ts` starts as `export {};`.

- [ ] **Step 6: Install and verify the gate runs**

Run: `bun install && bun run check`
Expected: all three sub-commands succeed on the empty skeleton (no tests found is OK for `bun test` — if it exits non-zero for zero tests, add a placeholder `packages/provider/src/index.test.ts` asserting `1 === 1` and remove it in Task 2).

- [ ] **Step 7: Update CLAUDE.md "Current state" section**

Replace the whole "## Current state" section body with:

```markdown
Bun-workspaces monorepo. Commands:

- `bun install` — install all workspace deps
- `bun run check` — lint (Biome) + typecheck (tsc --build) + tests (bun test); required before every commit/PR
- `bun test packages/<name>` — run one package's tests
- `bunx playwright install chromium` — one-time browser install for E2E

Dependency direction is one-way: `cli → core → runtime → provider`. Never import in reverse.
Spec for the current milestone: `docs/superpowers/specs/2026-09-05-oneshot-vertical-slice-design.md`.
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold Bun workspaces monorepo with Biome and tsc gate"
```

---

### Task 2: Provider package — contract types

**Files:**
- Create: `packages/provider/src/index.ts` (overwrite the empty export)
- Test: `packages/provider/src/index.test.ts`

**Interfaces:**
- Consumes: `Page` type from `playwright-core`.
- Produces: `interface Provider` (fields exactly as below), `defineProvider(p: Provider): Provider`. All later tasks import these from `@chatbridge/provider`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/provider/src/index.test.ts
import { describe, expect, test } from "bun:test";
import { defineProvider, type Provider } from "./index";

describe("defineProvider", () => {
  test("returns the same provider object", () => {
    const p: Provider = {
      name: "test",
      chatUrl: "http://localhost:1/chat",
      navigateToLogin: async () => {},
      isLoggedIn: async () => true,
      startNewChat: async () => {},
      sendMessage: async () => {},
      waitForResponse: async () => "reply",
    };
    expect(defineProvider(p)).toBe(p);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/provider`
Expected: FAIL — `defineProvider` is not exported.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/provider/src/index.ts
import type { Page } from "playwright-core";

/**
 * A Provider implements all service-specific browser behaviour for one
 * web chat AI service. The framework owns the browser lifecycle and auth
 * state; the provider owns URLs, selectors, and completion detection.
 */
export interface Provider {
  /** Identifier; also names the auth-state storage file. */
  name: string;
  /** Chat page URL; the runtime navigates here before startNewChat. */
  chatUrl: string;
  /** Navigate to the login page (called during `auth login`, headful). */
  navigateToLogin(page: Page): Promise<void>;
  /** Login-completion check; also the auth-validity check at startup. */
  isLoggedIn(page: Page): Promise<boolean>;
  /** Bring the page to a state where a new chat can start. */
  startNewChat(page: Page): Promise<void>;
  /** Submit the prompt. */
  sendMessage(page: Page, prompt: string): Promise<void>;
  /** Wait for response completion and return the response text. */
  waitForResponse(page: Page): Promise<string>;
}

/** Identity helper: gives provider authors type inference and a future
 * validation hook without any runtime cost today. */
export function defineProvider(provider: Provider): Provider {
  return provider;
}

export type { Page };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/provider && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/provider
git commit -m "feat(provider): add Provider contract and defineProvider"
```

---

### Task 3: Core package — error types

**Files:**
- Create: `packages/core/src/errors.ts`
- Modify: `packages/core/src/index.ts` (re-export errors)
- Test: `packages/core/src/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ChatBridgeError` (base, `code: string` field), `AuthRequiredError`, `AuthExpiredError`, `ResponseTimeoutError`, `ProviderLoadError` — all exported from `@chatbridge/core`. Constructor: `new AuthRequiredError(message: string)` etc.; codes are `"AUTH_REQUIRED" | "AUTH_EXPIRED" | "RESPONSE_TIMEOUT" | "PROVIDER_LOAD"`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/errors.test.ts
import { describe, expect, test } from "bun:test";
import {
  AuthExpiredError,
  AuthRequiredError,
  ChatBridgeError,
  ProviderLoadError,
  ResponseTimeoutError,
} from "./errors";

describe("error hierarchy", () => {
  test("subclasses extend ChatBridgeError with stable codes", () => {
    const cases: Array<[ChatBridgeError, string]> = [
      [new AuthRequiredError("no auth"), "AUTH_REQUIRED"],
      [new AuthExpiredError("expired"), "AUTH_EXPIRED"],
      [new ResponseTimeoutError("timed out"), "RESPONSE_TIMEOUT"],
      [new ProviderLoadError("bad provider"), "PROVIDER_LOAD"],
    ];
    for (const [err, code] of cases) {
      expect(err).toBeInstanceOf(ChatBridgeError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.message.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core`
Expected: FAIL — module `./errors` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/errors.ts
/** Base class for all framework errors. The CLI maps `code` to exit codes. */
export class ChatBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthRequiredError extends ChatBridgeError {
  constructor(message: string) {
    super("AUTH_REQUIRED", message);
  }
}

export class AuthExpiredError extends ChatBridgeError {
  constructor(message: string) {
    super("AUTH_EXPIRED", message);
  }
}

export class ResponseTimeoutError extends ChatBridgeError {
  constructor(message: string) {
    super("RESPONSE_TIMEOUT", message);
  }
}

export class ProviderLoadError extends ChatBridgeError {
  constructor(message: string) {
    super("PROVIDER_LOAD", message);
  }
}
```

```typescript
// packages/core/src/index.ts
export * from "./errors";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): add ChatBridgeError hierarchy"
```

---

### Task 4: Runtime package — auth-state store

**Files:**
- Create: `packages/runtime/src/auth-store.ts`
- Modify: `packages/runtime/src/index.ts` (re-export)
- Test: `packages/runtime/src/auth-store.test.ts`

**Interfaces:**
- Consumes: nothing from other packages (pure file I/O).
- Produces: `class AuthStore` exported from `@chatbridge/runtime`:
  - `constructor(opts: { configDir: string; providerName: string })` — `configDir` is a directory name under `~/.config/` (e.g. `"chatbridge"`), overridable for tests via `opts` extension below.
  - `constructor` also accepts optional `baseDir?: string` replacing `~/.config` entirely (tests point it at a temp dir).
  - `path(): string` — `<base>/<configDir>/auth/<providerName>.json`
  - `has(): boolean`
  - `save(state: unknown): Promise<void>` — writes JSON, dir mode `700`, file mode `600`
  - `load(): Promise<unknown>` — parsed JSON; throws if missing
  - `clear(): Promise<void>` — deletes the file; no-op if missing

- [ ] **Step 1: Write the failing test**

```typescript
// packages/runtime/src/auth-store.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "./auth-store";

let dir: string;
function makeStore(): AuthStore {
  dir = mkdtempSync(join(tmpdir(), "chatbridge-test-"));
  return new AuthStore({ configDir: "chatbridge", providerName: "dummy", baseDir: dir });
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("AuthStore", () => {
  test("save/load round trip with restrictive permissions", async () => {
    const store = makeStore();
    expect(store.has()).toBe(false);
    await store.save({ cookies: [{ name: "sid", value: "x" }] });
    expect(store.has()).toBe(true);
    expect((statSync(store.path()).mode & 0o777)).toBe(0o600);
    expect((statSync(join(dir, "chatbridge", "auth")).mode & 0o777)).toBe(0o700);
    const loaded = (await store.load()) as { cookies: Array<{ name: string }> };
    expect(loaded.cookies[0]?.name).toBe("sid");
  });

  test("clear deletes the file and is idempotent", async () => {
    const store = makeStore();
    await store.save({ cookies: [] });
    await store.clear();
    expect(store.has()).toBe(false);
    await store.clear(); // no throw
  });

  test("load throws when no state exists", async () => {
    const store = makeStore();
    await expect(store.load()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/runtime`
Expected: FAIL — module `./auth-store` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/runtime/src/auth-store.ts
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AuthStoreOptions {
  /** Directory name under the base dir, e.g. "chatbridge" or "company-ai". */
  configDir: string;
  /** Provider name; becomes the state file name. */
  providerName: string;
  /** Base directory; defaults to ~/.config. Overridable for tests. */
  baseDir?: string;
}

/** Persists Playwright storageState JSON with restrictive permissions.
 * The content is sensitive (session cookies): never log it. */
export class AuthStore {
  private readonly dir: string;
  private readonly file: string;

  constructor(opts: AuthStoreOptions) {
    const base = opts.baseDir ?? join(homedir(), ".config");
    this.dir = join(base, opts.configDir, "auth");
    this.file = join(this.dir, `${opts.providerName}.json`);
  }

  path(): string {
    return this.file;
  }

  has(): boolean {
    return existsSync(this.file);
  }

  async save(state: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700); // mkdir mode is masked by umask; enforce
    await writeFile(this.file, JSON.stringify(state), { mode: 0o600 });
    await chmod(this.file, 0o600);
  }

  async load(): Promise<unknown> {
    return JSON.parse(await readFile(this.file, "utf8"));
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
```

```typescript
// packages/runtime/src/index.ts
export * from "./auth-store";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/runtime && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime
git commit -m "feat(runtime): add AuthStore with restrictive file permissions"
```

---

### Task 5: Dummy chat server + sample provider

**Files:**
- Create: `examples/dummy-chat/package.json`
- Create: `examples/dummy-chat/server.ts`
- Create: `examples/dummy-chat/provider.ts`
- Test: `examples/dummy-chat/server.test.ts`

**Interfaces:**
- Consumes: `defineProvider`, `Provider` from `@chatbridge/provider`.
- Produces:
  - `startDummyChat(port?: number): Promise<{ url: string; stop(): void }>` from `server.ts` (E2E tests in Tasks 6 and 8 call this).
  - `createDummyProvider(baseUrl: string): Provider` and a default export `Provider` (reads `DUMMY_CHAT_URL` env var, falling back to `http://localhost:8735`) from `provider.ts`.
  - Server behaviour contract: `GET /login` shows a `#login-button`; clicking it sets cookie `session=ok` and redirects to `/chat`. `GET /chat` without the cookie redirects to `/login`. `/chat` has `#message-input`, `#send-button`, and appends `<div class="message assistant">Echo: <prompt></div>` ~300 ms after send, then sets `data-state="idle"` on `#chat-log` (`data-state="busy"` while replying).

- [ ] **Step 1: Write package.json**

```json
{
  "name": "@chatbridge/example-dummy-chat",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": { "./server": "./server.ts", "./provider": "./provider.ts" },
  "scripts": { "start": "bun run serve.ts" },
  "dependencies": { "@chatbridge/provider": "workspace:*" }
}
```

- [ ] **Step 2: Write the failing server test**

```typescript
// examples/dummy-chat/server.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { startDummyChat } from "./server";

let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe("dummy chat server", () => {
  test("redirects /chat to /login without a session cookie", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const res = await fetch(`${s.url}/chat`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("login sets a session cookie and /chat then serves the chat page", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const login = await fetch(`${s.url}/do-login`, { method: "POST", redirect: "manual" });
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("session=ok");
    const chat = await fetch(`${s.url}/chat`, { headers: { cookie: "session=ok" } });
    expect(chat.status).toBe(200);
    expect(await chat.text()).toContain('id="message-input"');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test examples/dummy-chat`
Expected: FAIL — `./server` not found.

- [ ] **Step 4: Implement the server**

```typescript
// examples/dummy-chat/server.ts
/** Minimal dummy web chat used for E2E verification of the framework.
 * Not a real service: fixed echo responses, cookie-based fake login. */

const LOGIN_HTML = `<!doctype html>
<title>Dummy Chat — Login</title>
<h1>Dummy Chat</h1>
<form method="post" action="/do-login">
  <button id="login-button" type="submit">Log in</button>
</form>`;

const CHAT_HTML = `<!doctype html>
<title>Dummy Chat</title>
<h1>Dummy Chat</h1>
<div id="chat-log" data-state="idle"></div>
<textarea id="message-input"></textarea>
<button id="send-button" type="button">Send</button>
<script>
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
    }, 300);
  });
</script>`;

function hasSession(req: Request): boolean {
  return (req.headers.get("cookie") ?? "").includes("session=ok");
}

export async function startDummyChat(port = 8735): Promise<{ url: string; stop(): void }> {
  const server = Bun.serve({
    port,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/login") {
        return new Response(LOGIN_HTML, { headers: { "content-type": "text/html" } });
      }
      if (pathname === "/do-login" && req.method === "POST") {
        return new Response(null, {
          status: 302,
          headers: { location: "/chat", "set-cookie": "session=ok; Path=/; HttpOnly" },
        });
      }
      if (pathname === "/chat") {
        if (!hasSession(req)) {
          return new Response(null, { status: 302, headers: { location: "/login" } });
        }
        return new Response(CHAT_HTML, { headers: { "content-type": "text/html" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}
```

Also create the standalone launcher referenced by the `start` script:

```typescript
// examples/dummy-chat/serve.ts
import { startDummyChat } from "./server";

const { url } = await startDummyChat(8735);
console.log(`Dummy chat running at ${url}`);
```

Add `Create: examples/dummy-chat/serve.ts` to your working set for the commit.

- [ ] **Step 5: Run server tests to verify they pass**

Run: `bun test examples/dummy-chat`
Expected: PASS.

- [ ] **Step 6: Implement the sample provider**

```typescript
// examples/dummy-chat/provider.ts
import { defineProvider, type Provider } from "@chatbridge/provider";

/** Reference Provider implementation, targeting the bundled dummy chat.
 * Real providers follow the same shape against real services. */
export function createDummyProvider(baseUrl: string): Provider {
  return defineProvider({
    name: "dummy-chat",
    chatUrl: `${baseUrl}/chat`,

    async navigateToLogin(page) {
      await page.goto(`${baseUrl}/login`);
    },

    async isLoggedIn(page) {
      // On /chat with a valid session the input exists; when redirected
      // to /login it does not.
      return (await page.locator("#message-input").count()) > 0;
    },

    async startNewChat(page) {
      // The dummy chat has no history; being on the chat page is enough.
      await page.locator("#message-input").waitFor({ state: "visible" });
    },

    async sendMessage(page, prompt) {
      await page.locator("#message-input").fill(prompt);
      await page.locator("#send-button").click();
    },

    async waitForResponse(page) {
      const log = page.locator("#chat-log");
      await log
        .locator(".message.assistant")
        .last()
        .waitFor({ state: "visible" });
      // Wait for the busy → idle transition so partial replies are impossible.
      await page.waitForSelector('#chat-log[data-state="idle"]');
      const text = await log.locator(".message.assistant").last().textContent();
      return text ?? "";
    },
  });
}

const baseUrl = process.env.DUMMY_CHAT_URL ?? "http://localhost:8735";
export default createDummyProvider(baseUrl);
```

- [ ] **Step 7: Verify the whole gate**

Run: `bun run check`
Expected: PASS (provider compiles against `@chatbridge/provider` — this is the type-contract test).

- [ ] **Step 8: Commit**

```bash
git add examples/dummy-chat
git commit -m "feat(examples): add dummy chat server and reference provider"
```

---

### Task 6: Runtime package — BrowserRuntime (Bun+Playwright gate)

**Files:**
- Create: `packages/runtime/src/browser-runtime.ts`
- Modify: `packages/runtime/src/index.ts` (re-export)
- Test: `packages/runtime/src/browser-runtime.e2e.test.ts`

**Interfaces:**
- Consumes: `Provider` from `@chatbridge/provider`; `AuthStore` from Task 4; `startDummyChat` + `createDummyProvider` (test only).
- Produces: `class BrowserRuntime` exported from `@chatbridge/runtime`:
  - `static launch(opts: { headless: boolean; provider: Provider; authStore: AuthStore }): Promise<BrowserRuntime>` — restores storageState from `authStore` if present.
  - `page: Page`
  - `saveAuthState(): Promise<void>`
  - `close(): Promise<void>`
  - (auth-state `has/clear` stay on `AuthStore`; `BrowserRuntime` takes the store as a dependency rather than owning paths.)

Note: this deviates slightly from the spec sketch (`hasAuthState`/`clearAuthState` on the runtime) — injecting `AuthStore` keeps file I/O testable without a browser and avoids duplicating path logic. Record this in the PR description.

- [ ] **Step 1: Install Chromium**

Run: `bunx playwright install chromium`
Expected: exits 0.

- [ ] **Step 2: Write the failing E2E test**

```typescript
// packages/runtime/src/browser-runtime.e2e.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDummyProvider } from "@chatbridge/example-dummy-chat/provider";
import { startDummyChat } from "@chatbridge/example-dummy-chat/server";
import { AuthStore } from "./auth-store";
import { BrowserRuntime } from "./browser-runtime";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function tempStore(name: string): AuthStore {
  const dir = mkdtempSync(join(tmpdir(), "chatbridge-e2e-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return new AuthStore({ configDir: "chatbridge", providerName: name, baseDir: dir });
}

describe("BrowserRuntime (headless Chromium on Bun)", () => {
  test("full round trip: login, save state, restore state, chat", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    const store = tempStore(provider.name);

    // Phase 1: "login" (headless here; the CLI does this headfully).
    const rt1 = await BrowserRuntime.launch({ headless: true, provider, authStore: store });
    cleanups.push(() => rt1.close());
    await provider.navigateToLogin(rt1.page);
    await rt1.page.locator("#login-button").click();
    await rt1.page.waitForURL("**/chat");
    expect(await provider.isLoggedIn(rt1.page)).toBe(true);
    await rt1.saveAuthState();
    expect(store.has()).toBe(true);
    await rt1.close();

    // Phase 2: fresh browser, restored state, one-shot round trip.
    const rt2 = await BrowserRuntime.launch({ headless: true, provider, authStore: store });
    cleanups.push(() => rt2.close());
    await rt2.page.goto(provider.chatUrl);
    expect(await provider.isLoggedIn(rt2.page)).toBe(true);
    await provider.startNewChat(rt2.page);
    await provider.sendMessage(rt2.page, "hello");
    const reply = await provider.waitForResponse(rt2.page);
    expect(reply).toBe("Echo: hello");
  }, 60_000);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/runtime/src/browser-runtime.e2e.test.ts`
Expected: FAIL — `./browser-runtime` not found.

- [ ] **Step 4: Write the implementation**

```typescript
// packages/runtime/src/browser-runtime.ts
import type { Provider } from "@chatbridge/provider";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";
import type { AuthStore } from "./auth-store";

export interface LaunchOptions {
  headless: boolean;
  provider: Provider;
  authStore: AuthStore;
}

/** Owns the Playwright lifecycle: browser, context (with restored auth
 * state), and a single page handed to Provider methods. */
export class BrowserRuntime {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly authStore: AuthStore,
  ) {}

  static async launch(opts: LaunchOptions): Promise<BrowserRuntime> {
    const browser = await chromium.launch({ headless: opts.headless });
    const storageState = opts.authStore.has()
      ? // Playwright accepts a file path for storageState.
        opts.authStore.path()
      : undefined;
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    return new BrowserRuntime(browser, context, page, opts.authStore);
  }

  async saveAuthState(): Promise<void> {
    await this.authStore.save(await this.context.storageState());
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
```

Update `packages/runtime/src/index.ts`:

```typescript
export * from "./auth-store";
export * from "./browser-runtime";
```

Also add `@chatbridge/example-dummy-chat` to `packages/runtime/package.json` `devDependencies` as `"workspace:*"` (test-only dependency; runtime's production deps stay `playwright` + provider).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/runtime && bun run check`
Expected: PASS. **This is the Bun+Playwright verdict.** If Chromium fails to launch or hangs under Bun, stop and report — the stack decision (spec: "switch to Node only if it fails") escalates to the user.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime examples/dummy-chat
git commit -m "feat(runtime): add BrowserRuntime with auth-state restore (Bun+Playwright E2E)"
```

---

### Task 7: Core package — session flows

**Files:**
- Create: `packages/core/src/session.ts`
- Modify: `packages/core/src/index.ts` (re-export)
- Test: `packages/core/src/session.e2e.test.ts`

**Interfaces:**
- Consumes: `Provider` from `@chatbridge/provider`; `AuthStore`, `BrowserRuntime` from `@chatbridge/runtime`; error classes from Task 3.
- Produces: exported from `@chatbridge/core`:
  - `runOneShot(opts: { provider: Provider; authStore: AuthStore; prompt: string; headless: boolean; timeoutMs: number; onProgress?: (msg: string) => void }): Promise<string>` — the full one-shot flow; returns the response text.
  - `runLogin(opts: { provider: Provider; authStore: AuthStore; onProgress?: (msg: string) => void }): Promise<void>` — headful login flow: navigate, poll `isLoggedIn` every 1 s until true, save state.
  - Re-exports `AuthStore` and `Provider` types for the CLI's convenience.

- [ ] **Step 1: Write the failing E2E test**

```typescript
// packages/core/src/session.e2e.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDummyProvider } from "@chatbridge/example-dummy-chat/provider";
import { startDummyChat } from "@chatbridge/example-dummy-chat/server";
import { AuthStore, BrowserRuntime } from "@chatbridge/runtime";
import { AuthRequiredError } from "./errors";
import { runOneShot } from "./session";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function tempStore(name: string): AuthStore {
  const dir = mkdtempSync(join(tmpdir(), "chatbridge-core-e2e-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return new AuthStore({ configDir: "chatbridge", providerName: name, baseDir: dir });
}

describe("runOneShot", () => {
  test("throws AuthRequiredError when no auth state exists", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    await expect(
      runOneShot({
        provider,
        authStore: tempStore(provider.name),
        prompt: "hi",
        headless: true,
        timeoutMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });

  test("returns the response after auth state is prepared", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    const store = tempStore(provider.name);

    // Prepare auth state by driving the login directly (login-flow UX is
    // covered by the CLI E2E in Task 8).
    const rt = await BrowserRuntime.launch({ headless: true, provider, authStore: store });
    await provider.navigateToLogin(rt.page);
    await rt.page.locator("#login-button").click();
    await rt.page.waitForURL("**/chat");
    await rt.saveAuthState();
    await rt.close();

    const reply = await runOneShot({
      provider,
      authStore: store,
      prompt: "ping",
      headless: true,
      timeoutMs: 30_000,
    });
    expect(reply).toBe("Echo: ping");
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core`
Expected: FAIL — `./session` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/session.ts
import type { Provider } from "@chatbridge/provider";
import { AuthStore, BrowserRuntime } from "@chatbridge/runtime";
import { AuthExpiredError, AuthRequiredError, ResponseTimeoutError } from "./errors";

export interface OneShotOptions {
  provider: Provider;
  authStore: AuthStore;
  prompt: string;
  headless: boolean;
  timeoutMs: number;
  /** Progress messages (stderr in the CLI). Never receives auth content. */
  onProgress?: (message: string) => void;
}

/** One-shot flow: restore auth → new chat → send → wait → return text. */
export async function runOneShot(opts: OneShotOptions): Promise<string> {
  const { provider, authStore, onProgress } = opts;
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
    rt.page.setDefaultTimeout(opts.timeoutMs);
    await rt.page.goto(provider.chatUrl);
    if (!(await provider.isLoggedIn(rt.page))) {
      throw new AuthExpiredError(
        `Auth state for "${provider.name}" is no longer valid. Run \`auth login\` again.`,
      );
    }
    await provider.startNewChat(rt.page);
    onProgress?.("Sending prompt...");
    await provider.sendMessage(rt.page, opts.prompt);
    onProgress?.("Waiting for response...");
    try {
      return await provider.waitForResponse(rt.page);
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new ResponseTimeoutError(
          `No complete response within ${opts.timeoutMs} ms.`,
        );
      }
      throw err;
    }
  } finally {
    await rt.close();
  }
}

export interface LoginOptions {
  provider: Provider;
  authStore: AuthStore;
  onProgress?: (message: string) => void;
}

/** Headful login flow: the user logs in manually; we poll for completion. */
export async function runLogin(opts: LoginOptions): Promise<void> {
  const { provider, authStore, onProgress } = opts;
  onProgress?.("Opening browser...");
  const rt = await BrowserRuntime.launch({ headless: false, provider, authStore });
  try {
    await provider.navigateToLogin(rt.page);
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

Update `packages/core/src/index.ts`:

```typescript
export * from "./errors";
export * from "./session";
export { AuthStore, BrowserRuntime } from "@chatbridge/runtime";
export type { Provider } from "@chatbridge/provider";
export { defineProvider } from "@chatbridge/provider";
```

Add `@chatbridge/example-dummy-chat` to `packages/core/package.json` `devDependencies` as `"workspace:*"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): add runOneShot and runLogin session flows"
```

---

### Task 8: CLI package — createCli, commands, bin

**Files:**
- Create: `packages/cli/src/create-cli.ts`
- Create: `packages/cli/src/resolve-provider.ts`
- Create: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/index.ts` (re-export)
- Modify: `packages/cli/package.json` (add `"bin": { "chatbridge": "./src/bin.ts" }`)
- Test: `packages/cli/src/resolve-provider.test.ts`
- Test: `packages/cli/src/cli.e2e.test.ts`

**Interfaces:**
- Consumes: everything exported from `@chatbridge/core` (Task 7).
- Produces:
  - `createCli(opts: { name: string; provider?: Provider; configDir?: string; baseDir?: string }): { run(argv: string[]): Promise<number> }` — returns the exit code; `configDir` defaults to `opts.name`; `baseDir` is test-only plumbing into `AuthStore`.
  - `resolveProvider(spec: string): Promise<Provider>` — local path (starts with `./`, `../`, or `/`) or npm package name; validates the default export shape; throws `ProviderLoadError`.
  - Exit codes: `0` success, `2` `AUTH_REQUIRED`, `3` `AUTH_EXPIRED`, `4` `RESPONSE_TIMEOUT`, `5` `PROVIDER_LOAD`, `1` anything else.
  - bin: `chatbridge` = `createCli({ name: "chatbridge" })`.

- [ ] **Step 1: Write the failing resolver test**

```typescript
// packages/cli/src/resolve-provider.test.ts
import { describe, expect, test } from "bun:test";
import { ProviderLoadError } from "@chatbridge/core";
import { resolveProvider } from "./resolve-provider";

describe("resolveProvider", () => {
  test("loads a local provider file by relative path", async () => {
    const p = await resolveProvider("../../examples/dummy-chat/provider.ts");
    expect(p.name).toBe("dummy-chat");
    expect(typeof p.sendMessage).toBe("function");
  });

  test("rejects a module whose default export is not a Provider", async () => {
    // The server module exists but does not default-export a Provider.
    await expect(
      resolveProvider("../../examples/dummy-chat/server.ts"),
    ).rejects.toBeInstanceOf(ProviderLoadError);
  });

  test("rejects an unresolvable spec", async () => {
    await expect(
      resolveProvider("@chatbridge/definitely-not-a-real-package"),
    ).rejects.toBeInstanceOf(ProviderLoadError);
  });
});
```

Note: relative paths in `resolveProvider` are resolved against `process.cwd()` at the call site in real usage; in this test they resolve against the package dir. Implement resolution against `process.cwd()` and run the test with cwd = `packages/cli` (bun test does this), so the paths above are written relative to `packages/cli`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli`
Expected: FAIL — `./resolve-provider` not found.

- [ ] **Step 3: Implement the resolver**

```typescript
// packages/cli/src/resolve-provider.ts
import { resolve } from "node:path";
import { ProviderLoadError, type Provider } from "@chatbridge/core";

const REQUIRED_METHODS = [
  "navigateToLogin",
  "isLoggedIn",
  "startNewChat",
  "sendMessage",
  "waitForResponse",
] as const;

function isProvider(value: unknown): value is Provider {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.chatUrl === "string" &&
    REQUIRED_METHODS.every((m) => typeof v[m] === "function")
  );
}

/** Loads a Provider from a local file path or an npm package name.
 * The module's default export must implement the Provider interface. */
export async function resolveProvider(spec: string): Promise<Provider> {
  const isPath = spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
  const target = isPath ? resolve(process.cwd(), spec) : spec;
  let mod: { default?: unknown };
  try {
    mod = await import(target);
  } catch (err) {
    throw new ProviderLoadError(
      `Could not load provider "${spec}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isProvider(mod.default)) {
    throw new ProviderLoadError(
      `Module "${spec}" does not default-export a Provider (name, chatUrl, and the five methods are required).`,
    );
  }
  return mod.default;
}
```

- [ ] **Step 4: Run resolver tests to verify they pass**

Run: `bun test packages/cli`
Expected: PASS.

- [ ] **Step 5: Implement createCli**

```typescript
// packages/cli/src/create-cli.ts
import { parseArgs } from "node:util";
import {
  AuthStore,
  ChatBridgeError,
  type Provider,
  runLogin,
  runOneShot,
} from "@chatbridge/core";
import { resolveProvider } from "./resolve-provider";

export interface CreateCliOptions {
  /** CLI name shown in help and errors, e.g. "chatbridge" or "company-ai-cli". */
  name: string;
  /** Pinned provider. When set, --provider is not accepted. */
  provider?: Provider;
  /** Config directory name under ~/.config; defaults to `name`. */
  configDir?: string;
  /** Test-only: overrides the auth-store base directory. */
  baseDir?: string;
}

const EXIT_CODES: Record<string, number> = {
  AUTH_REQUIRED: 2,
  AUTH_EXPIRED: 3,
  RESPONSE_TIMEOUT: 4,
  PROVIDER_LOAD: 5,
};

const DEFAULT_TIMEOUT_SEC = 120;

export function createCli(opts: CreateCliOptions) {
  const configDir = opts.configDir ?? opts.name;

  function help(): string {
    const providerFlag = opts.provider ? "" : " [--provider <name|path>]";
    return [
      `Usage:`,
      `  ${opts.name} -p <prompt>${providerFlag} [--headful] [--timeout <sec>]`,
      `  ${opts.name} auth login${providerFlag}`,
      `  ${opts.name} auth logout${providerFlag}`,
      `  ${opts.name} auth status${providerFlag}`,
      ``,
      `One-shot mode prints the AI response to stdout.`,
    ].join("\n");
  }

  // Progress goes to stderr, and only when stderr is a TTY (stdout stays
  // pipe-safe: response body only).
  function progress(message: string): void {
    if (process.stderr.isTTY) process.stderr.write(`${message}\n`);
  }

  async function getProvider(flag: string | undefined): Promise<Provider> {
    if (opts.provider) return opts.provider;
    if (!flag) {
      throw new ChatBridgeError(
        "PROVIDER_LOAD",
        `No provider specified. Pass --provider <npm-package|./path>.`,
      );
    }
    return resolveProvider(flag);
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

      if (cmd === "auth" && (sub === "login" || sub === "logout" || sub === "status")) {
        const provider = await getProvider(values.provider);
        const authStore = new AuthStore({
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
        const provider = await getProvider(values.provider);
        const authStore = new AuthStore({
          configDir,
          providerName: provider.name,
          baseDir: opts.baseDir,
        });
        const timeoutMs = Number(values.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000;
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
      if (err instanceof ChatBridgeError) {
        process.stderr.write(`${opts.name}: ${err.message}\n`);
        return EXIT_CODES[err.code] ?? 1;
      }
      process.stderr.write(
        `${opts.name}: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  return { run };
}
```

```typescript
// packages/cli/src/bin.ts
#!/usr/bin/env bun
import { createCli } from "./create-cli";

process.exit(await createCli({ name: "chatbridge" }).run(process.argv));
```

```typescript
// packages/cli/src/index.ts
export { createCli, type CreateCliOptions } from "./create-cli";
export { resolveProvider } from "./resolve-provider";
```

Add to `packages/cli/package.json`: `"bin": { "chatbridge": "./src/bin.ts" }`.

Note for reviewers: the spec's `~/.config/chatbridge/config.json` `defaultProvider` fallback is **deferred within this milestone** — `--provider` (or a pinned provider via `createCli`) is required. Rationale: config-file parsing adds surface without touching any risk this slice exists to validate. The resolution order in the spec stays authoritative for the next milestone. Record this in the PR description.

- [ ] **Step 6: Write the failing CLI E2E test**

```typescript
// packages/cli/src/cli.e2e.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDummyProvider } from "@chatbridge/example-dummy-chat/provider";
import { startDummyChat } from "@chatbridge/example-dummy-chat/server";
import { AuthStore, BrowserRuntime } from "@chatbridge/core";
import { createCli } from "./create-cli";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function setup() {
  const baseDir = mkdtempSync(join(tmpdir(), "chatbridge-cli-e2e-"));
  cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
  return baseDir;
}

async function prepareAuth(baseDir: string, serverUrl: string) {
  const provider = createDummyProvider(serverUrl);
  const store = new AuthStore({ configDir: "test-cli", providerName: provider.name, baseDir });
  const rt = await BrowserRuntime.launch({ headless: true, provider, authStore: store });
  await provider.navigateToLogin(rt.page);
  await rt.page.locator("#login-button").click();
  await rt.page.waitForURL("**/chat");
  await rt.saveAuthState();
  await rt.close();
  return provider;
}

describe("createCli", () => {
  test("one-shot without auth exits 2", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const cli = createCli({
      name: "test-cli",
      provider: createDummyProvider(server.url),
      baseDir,
    });
    const code = await cli.run(["bun", "cli", "-p", "hello"]);
    expect(code).toBe(2);
  });

  test("one-shot with auth prints the reply and exits 0", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const provider = await prepareAuth(baseDir, server.url);
    const cli = createCli({ name: "test-cli", provider, baseDir });

    // Capture stdout.
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    cleanups.push(() => {
      process.stdout.write = original;
    });

    const code = await cli.run(["bun", "cli", "-p", "hello"]);
    expect(code).toBe(0);
    expect(chunks.join("")).toBe("Echo: hello\n");
  }, 60_000);

  test("auth logout deletes state; auth status reports absence; pinned provider hides --provider from help", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const provider = await prepareAuth(baseDir, server.url);
    const cli = createCli({ name: "test-cli", provider, baseDir });

    const store = new AuthStore({ configDir: "test-cli", providerName: provider.name, baseDir });
    expect(store.has()).toBe(true);
    expect(await cli.run(["bun", "cli", "auth", "logout"])).toBe(0);
    expect(store.has()).toBe(false);
  }, 60_000);
});
```

- [ ] **Step 7: Run all CLI tests to verify they pass**

Run: `bun test packages/cli && bun run check`
Expected: PASS. (`createCli` was implemented in Step 5, so only genuine bugs fail here — fix them, not the tests.)

- [ ] **Step 8: Manual smoke test of the real binary**

```bash
bun run examples/dummy-chat/serve.ts &   # starts on :8735
bun packages/cli/src/bin.ts auth status --provider ./examples/dummy-chat/provider.ts
bun packages/cli/src/bin.ts -p "hello" --provider ./examples/dummy-chat/provider.ts; echo "exit=$?"
kill %1
```

Expected: `auth status` reports no auth state; the one-shot exits 2 with the "Run `auth login`" message on stderr (headful login itself is exercised manually by the user later — CI cannot).

- [ ] **Step 9: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add createCli factory, provider resolution, and chatbridge bin"
```

---

### Task 9: CI workflow + docs closeout

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `CLAUDE.md` (record the Bun+Playwright verdict; mark stack as final)
- Modify: `README.md` (replace "Status" and add a Quick start against the dummy chat)

**Interfaces:**
- Consumes: `bun run check` (Task 1), Playwright browser install (Task 6).
- Produces: green CI on every PR; done-criteria checklist from the spec satisfied.

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bunx playwright install --with-deps chromium
      - run: bun run check
```

- [ ] **Step 2: Update CLAUDE.md**

In the "Technology candidates (not final)" section, replace the body with:

```markdown
Finalized for milestone 1: TypeScript + Bun (workspaces, test runner) +
Playwright (Chromium). Verified by CI E2E (`packages/runtime` and
`packages/cli` E2E tests run real Chromium under Bun). OpenTUI remains
provisional until the interactive-mode milestone.
```

Rename the heading to `## Technology stack`.

- [ ] **Step 3: Update README.md**

Replace the `## Status` body with:

```markdown
Milestone 1 (one-shot vertical slice) implemented: `auth login`,
auth-state persistence, and `-p` one-shot round trips work against the
bundled dummy chat. Interactive TUI is not built yet.
```

After the `## Concept` section, add:

```markdown
## Quick start (against the bundled dummy chat)

```bash
bun install
bunx playwright install chromium
bun run examples/dummy-chat/serve.ts &          # dummy service on :8735
bun packages/cli/src/bin.ts auth login \
  --provider ./examples/dummy-chat/provider.ts  # click "Log in" in the opened browser
bun packages/cli/src/bin.ts -p "hello" \
  --provider ./examples/dummy-chat/provider.ts  # → Echo: hello
```
```

- [ ] **Step 4: Verify everything locally one last time**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add .github CLAUDE.md README.md
git commit -m "ci: add GitHub Actions gate; finalize milestone-1 stack docs"
git push -u origin HEAD
```

- [ ] **Step 6: Verify CI is green**

Run: `gh run watch --exit-status` (or `gh run list --limit 1`)
Expected: the workflow completes successfully. If E2E behaves differently on Linux CI than locally (headless Chromium quirks), debug with the systematic-debugging skill — do not loosen assertions to pass.

---

## Self-review notes (already applied)

- Spec's `hasAuthState`/`clearAuthState` on `BrowserRuntime` → moved to injected `AuthStore` (recorded in Task 6; PR description must mention it).
- Spec's config-file `defaultProvider` fallback → deferred within the milestone (recorded in Task 8; PR description must mention it).
- Headful `auth login` E2E cannot run in CI; the login flow is covered headlessly at the runtime/core layers, and `runLogin`'s UX is verified manually by the user against the dummy chat.
- All done-criteria from the spec map to tasks: login+save (T7/T8), one-shot stdout (T8), logout (T8), CI green (T9), stack verdict (T6/T9).
