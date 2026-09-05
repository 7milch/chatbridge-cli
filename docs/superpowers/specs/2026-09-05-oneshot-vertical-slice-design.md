# One-shot Vertical Slice — Design

Date: 2026-09-05
Status: Approved (brainstorming session)

## Goal

Build the first end-to-end vertical slice of chatbridge: a one-shot CLI round trip.
`chatbridge -p "..."` restores a saved authentication state, drives a web chat AI
through a Provider, and prints the response to stdout. No TUI yet.

This slice exists to validate the three riskiest unknowns early:

1. The Provider API contract works against a real browser flow.
2. Playwright runs reliably on Bun (stack decision gate).
3. Auth-state save/restore works end to end.

## Scope decisions (from brainstorming)

- **First milestone:** one-shot round trip (auth login → send → response → stdout).
- **This repository holds only the service-independent skeleton.** Providers for
  public services (ChatGPT etc.) live in a separate OSS repository; company
  providers live in the company repository. Both consume this framework as a
  dependency.
- **A local dummy web chat is bundled** in `examples/dummy-chat` for E2E
  verification and as a living Provider example.
- **Stack:** TypeScript + Playwright (final), Bun + OpenTUI (provisional — this
  slice validates Bun+Playwright; switch to Node only if it fails).
- **One-shot semantics:** every `-p` invocation starts a new chat. No
  conversation continuation, no chat-handle plumbing (YAGNI — designed later
  with the interactive mode).
- **Monorepo with package boundaries** (Bun workspaces) so architectural
  boundaries are enforced structurally.

## Repository layout

```
chatbridge-cli/  (Bun workspaces monorepo)
├─ packages/
│  ├─ provider/   @chatbridge/provider   — Provider interface + defineProvider. No deps.
│  ├─ runtime/    @chatbridge/runtime    — Playwright lifecycle, headless/headful,
│  │                                       auth-state save/load/clear. Deps: playwright, provider.
│  ├─ core/       @chatbridge/core       — Session, provider lifecycle, common errors.
│  │                                       Deps: provider, runtime.
│  └─ cli/        chatbridge (bin)       — one-shot mode, auth commands, provider
│                                          resolution, createCli factory. Deps: core.
├─ examples/
│  └─ dummy-chat/                        — local dummy web chat + its sample provider
└─ docs/
```

**Dependency direction is one-way: `cli → core → runtime → provider`. No
reverse imports, ever.** The provider package is the bottom layer so external
provider repositories depend on a single lightweight types package.

The npm scope `@chatbridge` is unverified; if taken, rename the scope (structure
unchanged).

## Provider API

```typescript
interface Provider {
  /** Identifier; also names the auth-state storage directory (e.g. "dummy-chat"). */
  name: string;

  /** Chat page URL; the runtime navigates here. */
  chatUrl: string;

  /** Navigate to the login page (auth login, headful page). */
  navigateToLogin(page: Page): Promise<void>;

  /** Login-completion check. Polled during auth login; also used as the
   *  auth-validity check at one-shot startup. */
  isLoggedIn(page: Page): Promise<boolean>;

  /** Bring the page to a state where a new chat can start. */
  startNewChat(page: Page): Promise<void>;

  /** Submit the prompt. */
  sendMessage(page: Page, prompt: string): Promise<void>;

  /** Wait for response completion and return the response text. */
  waitForResponse(page: Page): Promise<string>;
}
```

Design choices:

- **The raw Playwright `Page` is passed through — no wrapper abstraction.**
  Provider authors are assumed to know Playwright; official docs apply directly.
- `defineProvider(obj)` is near-identity: type inference now, validation hook later.
- Responses are returned whole after completion. Streaming display is deferred
  to the TUI milestone.
- Timeouts are owned by the runtime (defaults, overridable via CLI flag).
  Providers do not manage their own wait budgets.
- Distribution: a provider is an npm package or local file whose default export
  implements `Provider`.

## Playwright runtime and auth state

```typescript
class BrowserRuntime {
  static launch(opts: { headless: boolean; provider: Provider }): Promise<BrowserRuntime>;
  page: Page;                        // page on a context with auth state restored
  saveAuthState(): Promise<void>;    // context.storageState()
  hasAuthState(): boolean;
  clearAuthState(): Promise<void>;   // logout
  close(): Promise<void>;
}
```

Auth-state storage:

- Path: `~/.config/chatbridge/auth/<provider.name>.json` (XDG-style), file mode
  `600`, directory `700`.
- Content: Playwright `storageState` (cookies + localStorage), verbatim.
- Logs may mention the path, never the content.
- Per-provider separation allows multiple services side by side.

Flows:

```
auth login (headful):
  launch(headless:false) → navigateToLogin → poll isLoggedIn (user logs in manually)
  → saveAuthState → "✓ Session saved" → close

one-shot (headless by default; --headful to override):
  hasAuthState? no → error: run `chatbridge auth login`
  → launch with restored storageState → goto chatUrl
  → isLoggedIn? false → auth-expired error
  → startNewChat → sendMessage → waitForResponse → stdout → close
```

## Errors

`ChatBridgeError` base plus exactly four subclasses to start:
`AuthRequiredError`, `AuthExpiredError`, `ResponseTimeoutError`,
`ProviderLoadError`. The CLI maps them to exit codes and stderr messages.

## CLI

```bash
chatbridge -p "..." [--provider <name|path>] [--headful] [--timeout <sec>]
chatbridge auth login  [--provider ...]
chatbridge auth logout [--provider ...]
chatbridge auth status [--provider ...]
```

No-argument invocation prints help (TUI is a future milestone).

Provider resolution order:

1. `--provider` flag
2. `defaultProvider` in `~/.config/chatbridge/config.json`
3. otherwise error, listing the available options

Values starting with `./` or `/` are imported as local files; anything else is
imported as an npm package name. The default export is validated against the
`Provider` shape; mismatch → `ProviderLoadError`.

**stdout discipline:** in one-shot mode stdout carries the AI response body and
nothing else (pipe-safe). Progress output goes to stderr, and only when
attached to a TTY.

### Embedding API (derived CLIs)

The CLI is a factory, not just a bin. Downstream repositories build branded
CLIs on the same code path:

```typescript
import { createCli } from "chatbridge";
import companyProvider from "./company-provider";

createCli({
  name: "company-ai-cli",   // shown in help and error messages
  provider: companyProvider, // pins the provider; --provider is hidden
  configDir: "company-ai",   // auth state under ~/.config/company-ai/ (defaults to name)
}).run(process.argv);
```

The stock `chatbridge` binary is itself `createCli({ name: "chatbridge" })`
with no pinned provider — generic and derived CLIs share one code path.
`configDir` separation keeps auth states of coexisting CLIs from interfering.

## Dummy chat (examples/dummy-chat)

A one-command local server (Bun): a login page (button click issues a cookie)
and a chat page (a submitted message produces a fixed reply after a 1–2 s
delay, appended to the DOM). Its sample provider doubles as the reference
Provider implementation. E2E tests boot this server and run
`auth login` (a headless test path auto-clicks the login button) → one-shot
round trip → `auth logout` in CI.

## Testing

1. **Unit** (`bun test`) — core session/error handling, provider resolution,
   auth-state file I/O including permission checks.
2. **E2E** — dummy-chat + real Chromium in GitHub Actions on every PR. This is
   also the Bun+Playwright compatibility gate.
3. **Type contract** — the sample provider compiling against
   `@chatbridge/provider` acts as the contract test.

## Development environment (before feature work, per requirements §14)

- Lint/format: Biome.
- `bun run check` (lint + typecheck + test) as the required PR gate.
- TDD for implementation.
- Update CLAUDE.md with real commands and the dependency-direction rule.

## Milestone 1 — done criteria

- [ ] `chatbridge auth login --provider ./examples/dummy-chat/provider.ts` logs in headfully and saves state
- [ ] `chatbridge -p "hello" --provider ...` returns the response on stdout, headless
- [ ] `auth logout` deletes the state file
- [ ] All of the above green in CI E2E
- [ ] Bun+Playwright verdict recorded; stack finalized in CLAUDE.md

## Explicitly out of scope for milestone 1

TUI, conversation continuation, streaming display, concurrent multi-provider
use, advanced config features, auth-state encryption.
