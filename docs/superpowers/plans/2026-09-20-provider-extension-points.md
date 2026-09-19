# Provider Extension Points (slash commands, URL hooks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Provider can ship its own `/commands` (show / send) and URL hooks (expand a matching URL into an attachment) for the TUI and the VSCode extension.

**Architecture:** Two additive optional fields on `Provider` (`commands`, `urlHooks`), validated by `defineProvider`. Core gains `ChatSession.runCommand` (runs a provider command on the page) and `expand-url-hooks` (pure text → attachments, with a timeout per hook). The TUI `ChatModel` and the VSCode `SessionController` each grow one custom-command path that mirrors their existing turn path, and treat `UrlHookError` exactly like a mention error. One-shot mode is untouched.

**Tech Stack:** TypeScript, Bun workspaces + `bun test`, Playwright types only. Biome for lint. `bun run check` (lint + `tsc --build` + tests) before every commit.

**Spec:** `docs/superpowers/specs/2026-09-20-provider-slash-commands-design.md` and `docs/superpowers/specs/2026-09-20-provider-url-hooks-design.md`. Issue #83 (tracking), #84. Milestone 15, ships as v0.9.0.

## Global Constraints

- Dependency direction `cli → core → runtime → provider`; never import in reverse. `packages/vscode` depends on core only.
- Every doc, comment, commit message and issue comment in English.
- TDD: write the failing test, run it, implement, run again. `bun run check` before each commit. Tests that import another package's code read it from `dist/`, so run `bun run build` after editing a package other than the one under test.
- After each task: commit, then `gh issue comment 83 --body "<what was committed> ... What's next: <next task>"`.
- Built-in command names stay `login`, `logout`, `new`, `reopen`, `help`. A provider cannot shadow them.
- The framework never fetches a URL and never holds a credential.
- No `/` completion popup, no one-shot support, no page-state-changing command kinds in this milestone.
- Commit message format: `<type>: <summary> (Refs #83)` (use `#84` for URL-hook-only commits), ending with the attribution trailer the session provides.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/provider/src/index.ts` | `ProviderCommand`, `ProviderCommandResult`, `UrlHook`, `UrlHookResult` types; `BUILTIN_COMMAND_NAMES`; `defineProvider` validation |
| `packages/core/src/slash-commands.ts` | Parser with a custom-name set, `error` variant, `helpText(custom)`, `commandNamesOf(provider)` |
| `packages/core/src/chat-session.ts` | `runCommand(name, args)` |
| `packages/core/src/expand-url-hooks.ts` (new) | `findUrls`, `resolveUrlHooks`, `expandUrlHooks`, `UrlHookError` |
| `packages/core/src/index.ts` | Re-exports |
| `packages/cli/src/tui/chat-model.ts` | `ChatSessionLike.runCommand`, `commands` option, `runCustom`, queue re-dispatch, `UrlHookError` handling |
| `packages/cli/src/tui/run-interactive.ts` | Pass `provider.commands`; compose mention + URL expansion |
| `packages/vscode/src/protocol.ts` | `customCommand` message, `args` on built-ins is not needed, `commands` on `config` |
| `packages/vscode/src/chat-view-bridge.ts` | Validate and route `customCommand` |
| `packages/vscode/src/webview/main.ts` | Parse with the config's names; post `customCommand`; show `error` |
| `packages/vscode/src/session-controller.ts` | `runCommand`, command queue entries, `expandUrls` option |
| `packages/vscode/src/commands.ts` | `help` lists provider commands; `customCommand` handler |
| `packages/vscode/src/create-extension.ts` | Wire commands and URL hooks |
| `examples/dummy-chat/provider.ts` | Reference `commands` and `urlHooks` |
| `README.md`, `.claude/skills/creating-provider-repo/SKILL.md` | Docs |

---

### Task 1: Provider API types and `defineProvider` validation

**Files:**
- Modify: `packages/provider/src/index.ts`
- Test: `packages/provider/src/index.test.ts`

**Interfaces:**
- Produces (used by every later task):
  ```ts
  export type ProviderCommandResult =
    | { kind: "show"; text: string }
    | { kind: "send"; prompt: string };
  export interface ProviderCommand {
    name: string; description: string;
    run(page: Page, args: string): Promise<ProviderCommandResult>;
  }
  export interface UrlHookResult { label: string; content: string }
  export interface UrlHook {
    match: RegExp | ((url: string) => boolean);
    resolve(url: string): Promise<UrlHookResult>;
  }
  export const BUILTIN_COMMAND_NAMES: readonly ["login","logout","new","reopen","help"];
  interface Provider { commands?: ProviderCommand[]; urlHooks?: UrlHook[] }
  ```

- [ ] **Step 1: Write the failing tests**

Append to `packages/provider/src/index.test.ts`:

```ts
import { BUILTIN_COMMAND_NAMES, type ProviderCommand, type UrlHook } from "./index.js";

const base = {
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
};

function cmd(name: string): ProviderCommand {
  return {
    name,
    description: `the ${name} command`,
    async run() {
      return { kind: "show", text: name };
    },
  };
}

describe("defineProvider: commands", () => {
  test("keeps a valid list", () => {
    const commands = [cmd("model"), cmd("summarize")];
    expect(defineProvider({ ...base, commands }).commands).toBe(commands);
  });
  test("rejects a name that is not lower-case letters", () => {
    for (const bad of ["Model", "my-cmd", "cmd2", "", "a b"]) {
      expect(() => defineProvider({ ...base, commands: [cmd(bad)] })).toThrow(
        `Provider command name "${bad}" must match /^[a-z]+$/.`,
      );
    }
  });
  test("rejects every built-in name", () => {
    for (const name of BUILTIN_COMMAND_NAMES) {
      expect(() => defineProvider({ ...base, commands: [cmd(name)] })).toThrow(
        `Provider command "/${name}" collides with a built-in command.`,
      );
    }
  });
  test("rejects a duplicate", () => {
    expect(() =>
      defineProvider({ ...base, commands: [cmd("a"), cmd("b"), cmd("a")] }),
    ).toThrow('Provider command "/a" is defined twice.');
  });
});

describe("defineProvider: urlHooks", () => {
  const ok: UrlHook = {
    match: /^https:\/\/wiki\.example\.test\//,
    async resolve(url) {
      return { label: `Wiki: ${url}`, content: "body" };
    },
  };
  test("keeps a valid list, RegExp or predicate", () => {
    const urlHooks = [ok, { ...ok, match: (u: string) => u.endsWith(".pdf") }];
    expect(defineProvider({ ...base, urlHooks }).urlHooks).toBe(urlHooks);
  });
  test("rejects a global or sticky RegExp", () => {
    for (const flags of ["g", "y", "gi"]) {
      expect(() =>
        defineProvider({
          ...base,
          urlHooks: [{ ...ok, match: new RegExp("x", flags) }],
        }),
      ).toThrow(
        `URL hook RegExp /x/${flags} must not use the g or y flag (it makes .test stateful).`,
      );
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/provider`
Expected: FAIL — `BUILTIN_COMMAND_NAMES` is not exported; `defineProvider` does not throw.

- [ ] **Step 3: Implement**

In `packages/provider/src/index.ts`, add after `ProviderOpenDefaults`:

```ts
/** What a provider command hands back. `show`: the UI prints `text` in the
 * history. `send`: the UI sends `prompt` as an ordinary turn; the history
 * keeps the `/command` line the user typed, the service alone sees the
 * prompt. */
export type ProviderCommandResult =
  | { kind: "show"; text: string }
  | { kind: "send"; prompt: string };

/** A `/command` a provider adds to the interactive UIs (TUI, VSCode). Not
 * available in one-shot mode. Runs on the chat page like every other
 * provider method, under the session timeout. */
export interface ProviderCommand {
  /** Typed as `/name`. Lower-case letters only; the built-in names
   * (BUILTIN_COMMAND_NAMES) are reserved. */
  name: string;
  /** One line for `/help`. */
  description: string;
  /** `args` is the rest of the line after the command word, trimmed; `""`
   * when there is none. May contain newlines. */
  run(page: Page, args: string): Promise<ProviderCommandResult>;
}

/** Commands the framework itself defines; a provider cannot redefine them.
 * Core's slash-command table is built from this list. */
export const BUILTIN_COMMAND_NAMES = [
  "login",
  "logout",
  "new",
  "reopen",
  "help",
] as const;

export interface UrlHookResult {
  /** The attachment line shown in the history, e.g. "Confluence: Title". */
  label: string;
  content: string;
}

/** Expands a URL typed in a message into an attachment. The framework never
 * fetches anything itself: `resolve` is the provider's, and so is whatever
 * credential it needs. The interactive UIs only. */
export interface UrlHook {
  /** Which URLs this hook takes. A RegExp is used with `.test`, so it must
   * not carry the `g` or `y` flag. */
  match: RegExp | ((url: string) => boolean);
  /** Return the content, or throw with a message meant for the user
   * ("403 from Confluence", "script not found"). Runs under the session
   * timeout. */
  resolve(url: string): Promise<UrlHookResult>;
}
```

Add to `Provider`, after `open?`:

```ts
  /** Optional. `/commands` for the interactive UIs, listed by `/help` after
   * the built-ins. Validated by defineProvider. */
  commands?: ProviderCommand[];
  /** Optional. Tried in order for every URL in a message; the first hook
   * whose `match` accepts the URL resolves it. Validated by defineProvider. */
  urlHooks?: UrlHook[];
```

Replace `defineProvider`:

```ts
const COMMAND_NAME = /^[a-z]+$/;
const BUILTINS: ReadonlySet<string> = new Set(BUILTIN_COMMAND_NAMES);

/** Identity helper with validation: gives provider authors type inference
 * and fails fast, at definition time, on a command list or URL hook the
 * UIs could not use. */
export function defineProvider(provider: Provider): Provider {
  const seen = new Set<string>();
  for (const c of provider.commands ?? []) {
    if (!COMMAND_NAME.test(c.name)) {
      throw new Error(
        `Provider command name "${c.name}" must match /^[a-z]+$/.`,
      );
    }
    if (BUILTINS.has(c.name)) {
      throw new Error(
        `Provider command "/${c.name}" collides with a built-in command.`,
      );
    }
    if (seen.has(c.name)) {
      throw new Error(`Provider command "/${c.name}" is defined twice.`);
    }
    seen.add(c.name);
  }
  for (const h of provider.urlHooks ?? []) {
    if (h.match instanceof RegExp && /[gy]/.test(h.match.flags)) {
      throw new Error(
        `URL hook RegExp ${h.match} must not use the g or y flag (it makes .test stateful).`,
      );
    }
  }
  return provider;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/provider`
Expected: PASS (existing tests included).

- [ ] **Step 5: Build, check, commit**

```bash
bun run check
git add packages/provider
git commit -m "feat(provider): commands and urlHooks on Provider, validated by defineProvider (Refs #83)"
gh issue comment 83 --body "Task 1 done: Provider gains optional commands and urlHooks; defineProvider validates names, built-in collisions, duplicates and RegExp flags. What's next: Task 2, core slash-command parser with custom names."
```

---

### Task 2: core slash-command parser with provider names

**Files:**
- Modify: `packages/core/src/slash-commands.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/slash-commands.test.ts`

**Interfaces:**
- Consumes: `BUILTIN_COMMAND_NAMES`, `Provider` from `@chatbridge/provider`.
- Produces:
  ```ts
  export interface CommandInfo { name: string; description: string }
  export type ParsedSlash =
    | { command: SlashCommand }
    | { custom: string; args: string }
    | { unknown: string }
    | { error: string };
  export function parseSlashCommand(text: string, custom?: ReadonlySet<string>): ParsedSlash | undefined;
  export function helpText(custom?: readonly CommandInfo[]): string;
  export function commandNamesOf(provider: { commands?: readonly CommandInfo[] }): ReadonlySet<string>;
  export function commandInfoOf(provider: { commands?: readonly CommandInfo[] }): CommandInfo[];
  ```

- [ ] **Step 1: Write the failing tests**

Replace the `"not a command: arguments, extra lines, plain text, lone slash"` test and add new ones in `packages/core/src/slash-commands.test.ts`:

```ts
import {
  SLASH_COMMANDS,
  commandInfoOf,
  commandNamesOf,
  helpText,
  parseSlashCommand,
  unknownCommandMessage,
} from "./slash-commands.js";

const custom = new Set(["model", "translate"]);

describe("parseSlashCommand", () => {
  // ...keep the existing "bare command", "every table entry", "unknown word" tests...
  test("not a command: plain text, lone slash, path, second line without a space", () => {
    expect(parseSlashCommand("login")).toBeUndefined();
    expect(parseSlashCommand("/")).toBeUndefined();
    expect(parseSlashCommand("/usr/bin/env")).toBeUndefined();
    expect(parseSlashCommand("/login x")).toBeUndefined();
  });
  test("a built-in with arguments is an error, not a message", () => {
    expect(parseSlashCommand("/login now")).toEqual({
      error: "/login takes no arguments.",
    });
    expect(parseSlashCommand("/login\nmore")).toEqual({
      error: "/login takes no arguments.",
    });
  });
  test("custom command with and without arguments", () => {
    expect(parseSlashCommand("/model", custom)).toEqual({
      custom: "model",
      args: "",
    });
    expect(parseSlashCommand("/translate  hello world ", custom)).toEqual({
      custom: "translate",
      args: "hello world",
    });
    expect(parseSlashCommand("/translate\nline one\nline two", custom)).toEqual(
      { custom: "translate", args: "line one\nline two" },
    );
  });
  test("a custom name is unknown without the set", () => {
    expect(parseSlashCommand("/model")).toEqual({ unknown: "model" });
    expect(parseSlashCommand("/model x")).toEqual({ unknown: "model" });
  });
  test("a built-in still wins over a same-named custom entry", () => {
    expect(parseSlashCommand("/help", new Set(["help"]))).toEqual({
      command: "help",
    });
  });
});

describe("helpText", () => {
  test("lists every built-in with its description", () => {
    const text = helpText();
    for (const c of SLASH_COMMANDS) {
      expect(text).toContain(`/${c.name}`);
      expect(text).toContain(c.description);
    }
  });
  test("appends custom commands after the built-ins, aligned to the longest", () => {
    const text = helpText([
      { name: "model", description: "Show the model" },
      { name: "summarize", description: "Summarize" },
    ]);
    const lines = text.split("\n");
    expect(lines).toHaveLength(SLASH_COMMANDS.length + 2);
    expect(lines.at(-2)).toBe("/model     Show the model");
    expect(lines.at(-1)).toBe("/summarize Summarize");
    expect(lines[0]).toMatch(/^\/login {5}/);
  });
});

test("commandNamesOf / commandInfoOf", () => {
  expect(commandNamesOf({})).toEqual(new Set());
  const p = {
    commands: [{ name: "model", description: "d" }],
  };
  expect(commandNamesOf(p)).toEqual(new Set(["model"]));
  expect(commandInfoOf(p)).toEqual([{ name: "model", description: "d" }]);
  expect(commandInfoOf({})).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/src/slash-commands.test.ts`
Expected: FAIL — `/login now` returns undefined; `commandNamesOf` not exported.

- [ ] **Step 3: Implement**

Rewrite `packages/core/src/slash-commands.ts`:

```ts
import { BUILTIN_COMMAND_NAMES } from "@chatbridge/provider";

/** Commands typed as `/name` in either UI. The table is the single source
 * for the TUI, the webview and `/help`. No UI dependency. The names are
 * `BUILTIN_COMMAND_NAMES` from the provider package, so `defineProvider`'s
 * collision check and this table cannot drift apart. */
export const SLASH_COMMANDS = [
  { name: "login", description: "Log in in a browser window" },
  { name: "logout", description: "Delete the saved login and close the chat" },
  { name: "new", description: "Start a new chat" },
  { name: "reopen", description: "Reopen the browser (also Ctrl+R)" },
  { name: "help", description: "List these commands" },
] as const satisfies readonly { name: (typeof BUILTIN_COMMAND_NAMES)[number]; description: string }[];

export type SlashCommand = (typeof SLASH_COMMANDS)[number]["name"];

/** Name and description of a command, for `/help` and the webview. */
export interface CommandInfo {
  name: string;
  description: string;
}

export type ParsedSlash =
  /** A built-in, which takes no arguments. */
  | { command: SlashCommand }
  /** A provider command; `args` is the rest of the line, trimmed. */
  | { custom: string; args: string }
  /** `/word` with a word nobody defines. */
  | { unknown: string }
  /** Recognised but unusable, e.g. a built-in given arguments. */
  | { error: string };

const NAMES: ReadonlySet<string> = new Set(SLASH_COMMANDS.map((c) => c.name));
const EMPTY: ReadonlySet<string> = new Set();
/** `/word` then optionally whitespace and the arguments; `word` is letters
 * only so paths like `/usr/bin` never match. */
const PATTERN = /^\/([a-z]+)(?:\s+([\s\S]*))?$/;

/** Parses one submitted text. `custom` is the provider's command names
 * (`commandNamesOf`). Returns undefined for anything that is not `/word`:
 * that is an ordinary message. */
export function parseSlashCommand(
  text: string,
  custom: ReadonlySet<string> = EMPTY,
): ParsedSlash | undefined {
  const m = PATTERN.exec(text.trim());
  if (m === null) return undefined;
  const word = m[1] as string;
  const args = (m[2] ?? "").trim();
  if (NAMES.has(word)) {
    return args === ""
      ? { command: word as SlashCommand }
      : { error: `/${word} takes no arguments.` };
  }
  if (custom.has(word)) return { custom: word, args };
  return { unknown: word };
}

export function unknownCommandMessage(word: string): string {
  return `Unknown command: /${word}. Type /help.`;
}

/** One line per command, aligned: the built-ins, then `custom` in the
 * provider's order. */
export function helpText(custom: readonly CommandInfo[] = []): string {
  const all: readonly CommandInfo[] = [...SLASH_COMMANDS, ...custom];
  const width = Math.max(...all.map((c) => c.name.length)) + 1;
  return all
    .map((c) => `/${c.name.padEnd(width)} ${c.description}`)
    .join("\n");
}

/** The provider's command names, for `parseSlashCommand`. */
export function commandNamesOf(provider: {
  commands?: readonly CommandInfo[];
}): ReadonlySet<string> {
  return new Set((provider.commands ?? []).map((c) => c.name));
}

/** The provider's commands as plain name/description pairs, safe to post
 * to a webview (no functions). */
export function commandInfoOf(provider: {
  commands?: readonly CommandInfo[];
}): CommandInfo[] {
  return (provider.commands ?? []).map(({ name, description }) => ({
    name,
    description,
  }));
}
```

Note the `satisfies` clause: if `BUILTIN_COMMAND_NAMES` and the table ever disagree, `tsc` fails.

Update `packages/core/src/index.ts`:

```ts
export {
  type CommandInfo,
  type ParsedSlash,
  SLASH_COMMANDS,
  type SlashCommand,
  commandInfoOf,
  commandNamesOf,
  helpText,
  parseSlashCommand,
  unknownCommandMessage,
} from "./slash-commands.js";
export type {
  Provider,
  ProviderCommand,
  ProviderCommandResult,
  ProviderOpenDefaults,
  UrlHook,
  UrlHookResult,
} from "@chatbridge/provider";
export { BUILTIN_COMMAND_NAMES, defineProvider } from "@chatbridge/provider";
```

(Replace the existing `Provider`/`defineProvider` export lines.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run build && bun test packages/core/src/slash-commands.test.ts`
Expected: PASS. Then `bun test packages/cli packages/vscode` — the webview test and `chat-model.test.ts` must still pass (the default `custom` set keeps old behaviour except `/login now`, which no test relies on being a message; if one does, update it to expect the error entry).

- [ ] **Step 5: Check, commit**

```bash
bun run check
git add packages/core
git commit -m "feat(core): slash-command parser accepts provider commands with arguments (Refs #83)"
gh issue comment 83 --body "Task 2 done: parseSlashCommand takes the provider's names and returns custom/args; a built-in with arguments is now an error; helpText lists provider commands. What's next: Task 3, ChatSession.runCommand."
```

---

### Task 3: `ChatSession.runCommand`

**Files:**
- Modify: `packages/core/src/chat-session.ts`
- Test: `packages/core/src/chat-session.test.ts`

**Interfaces:**
- Produces: `ChatSession.runCommand(name: string, args: string): Promise<ProviderCommandResult>`.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/chat-session.test.ts`, extend the `Harness` interface with `commandCalls: Array<{ name: string; args: string }>` and `commandResult: ProviderCommandResult | Error`, initialise them in `harness()` (`commandCalls: []`, `commandResult: { kind: "show", text: "ok" }`), and give `h.provider` a command list:

```ts
    commands: [
      {
        name: "probe",
        description: "Probe",
        async run(_page, args) {
          h.commandCalls.push({ name: "probe", args });
          if (h.commandResult instanceof Error) throw h.commandResult;
          return h.commandResult;
        },
      },
    ],
```

Add a describe block:

```ts
describe("ChatSession.runCommand", () => {
  test("runs the named provider command with the args and returns its result", async () => {
    const h = harness();
    const s = await ChatSession.open(opts(h));
    expect(await s.runCommand("probe", "a b")).toEqual({
      kind: "show",
      text: "ok",
    });
    expect(h.commandCalls).toEqual([{ name: "probe", args: "a b" }]);
    h.commandResult = { kind: "send", prompt: "expanded" };
    expect(await s.runCommand("probe", "")).toEqual({
      kind: "send",
      prompt: "expanded",
    });
  });

  test("an unknown name is an InvalidStateError and never touches the provider", async () => {
    const h = harness();
    const s = await ChatSession.open(opts(h));
    await expect(s.runCommand("nope", "")).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    expect(h.commandCalls).toEqual([]);
  });

  test("rejects while a send is pending, and after close", async () => {
    const h = harness();
    const s = await ChatSession.open(opts(h));
    const p = s.send("hi");
    await replyOf(h, 0);
    await expect(s.runCommand("probe", "")).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    h.replies[0].resolve("r");
    await p;
    await s.close();
    await expect(s.runCommand("probe", "")).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });

  test("a send is rejected while a command is running", async () => {
    const h = harness();
    const gate = deferred<void>();
    h.provider.commands = [
      {
        name: "slow",
        description: "",
        async run() {
          await gate.promise;
          return { kind: "show", text: "" };
        },
      },
    ];
    const s = await ChatSession.open(opts(h));
    const p = s.runCommand("slow", "");
    await expect(s.send("hi")).rejects.toBeInstanceOf(InvalidStateError);
    gate.resolve();
    await p;
  });

  test("a Playwright timeout becomes ResponseTimeoutError naming the command", async () => {
    const h = harness();
    const err = new Error("boom");
    err.name = "TimeoutError";
    h.commandResult = err;
    const s = await ChatSession.open(opts(h));
    await expect(s.runCommand("probe", "")).rejects.toMatchObject({
      name: "ResponseTimeoutError",
      message: "Timed out during command:probe after 1000 ms.",
    });
  });

  test("a timeout while logged out surfaces as AuthExpiredError", async () => {
    const h = harness();
    const err = new Error("boom");
    err.name = "TimeoutError";
    h.commandResult = err;
    const s = await ChatSession.open(opts(h));
    h.loggedIn = false;
    await expect(s.runCommand("probe", "")).rejects.toBeInstanceOf(
      AuthExpiredError,
    );
  });
});
```

`ProviderCommandResult` comes from `@chatbridge/provider` (add to the type import at the top).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/src/chat-session.test.ts`
Expected: FAIL — `runCommand` is not a function.

- [ ] **Step 3: Implement**

In `packages/core/src/chat-session.ts`, import `ProviderCommandResult` from `@chatbridge/provider` and add after `send`:

```ts
  /** Runs one provider `/command` on the chat page. Same guards as `send`:
   * one thing at a time on the page. The result is returned untouched: a
   * `send` result is the UI's to send (it owns the turn and its history),
   * never core's. A timeout runs the same login diagnosis as a slow turn. */
  async runCommand(name: string, args: string): Promise<ProviderCommandResult> {
    if (this.closed) {
      throw new InvalidStateError("ChatSession is closed.");
    }
    if (this.pending) {
      throw new InvalidStateError("A send is already in progress.");
    }
    const command = this.provider.commands?.find((c) => c.name === name);
    if (command === undefined) {
      throw new InvalidStateError(`Unknown provider command "/${name}".`);
    }
    this.pending = true;
    try {
      this.onProgress?.(`Running /${name}...`);
      return await runStep(`command:${name}`, this.timeoutMs, () =>
        command.run(this.rt.page, args),
      );
    } catch (err) {
      if (err instanceof ResponseTimeoutError) await this.diagnoseTimeout();
      throw err;
    } finally {
      this.pending = false;
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/core/src/chat-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Check, commit**

```bash
bun run check
git add packages/core
git commit -m "feat(core): ChatSession.runCommand runs a provider command on the page (Refs #83)"
gh issue comment 83 --body "Task 3 done: ChatSession.runCommand with the send guards, runStep timeout and login diagnosis. What's next: Task 4, core expand-url-hooks."
```

---

### Task 4: core `expand-url-hooks`

**Files:**
- Create: `packages/core/src/expand-url-hooks.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/attachment.ts` (doc comment only)
- Test: `packages/core/src/expand-url-hooks.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class UrlHookError extends Error { readonly problems: string[] }
  export interface ResolvedUrl { label: string; bytes: number; content: string }
  export interface UrlExpansion { prompt: string; attachments: Attachment[] }
  export interface UrlHookOptions { timeoutMs: number; alreadyBytes?: number }
  export function findUrls(text: string): string[];
  export function resolveUrlHooks(text, hooks, opts): Promise<ResolvedUrl[]>;
  export function expandUrlHooks(text, hooks, opts): Promise<UrlExpansion>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/expand-url-hooks.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { UrlHook } from "@chatbridge/provider";
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES } from "./attachment.js";
import {
  UrlHookError,
  expandUrlHooks,
  findUrls,
  resolveUrlHooks,
} from "./expand-url-hooks.js";

const wiki: UrlHook = {
  match: /^https:\/\/wiki\.test\//,
  async resolve(url) {
    return { label: `Wiki: ${url.slice(-3)}`, content: `body of ${url}` };
  },
};
const opts = { timeoutMs: 200 };

describe("findUrls", () => {
  test("finds http and https tokens, strips trailing punctuation, dedupes", () => {
    expect(
      findUrls(
        "see https://wiki.test/a, (http://x.test/b). <https://wiki.test/a> 'https://q.test/c'",
      ),
    ).toEqual(["https://wiki.test/a", "http://x.test/b", "https://q.test/c"]);
  });
  test("keeps inner punctuation and query strings", () => {
    expect(findUrls("https://wiki.test/p?id=1&x=(2).3")).toEqual([
      "https://wiki.test/p?id=1&x=(2).3",
    ]);
  });
  test("nothing without a scheme", () => {
    expect(findUrls("wiki.test/a and /usr/bin")).toEqual([]);
  });
});

describe("resolveUrlHooks", () => {
  test("no hooks or no matching URL: empty", async () => {
    expect(await resolveUrlHooks("https://wiki.test/a", [], opts)).toEqual([]);
    expect(await resolveUrlHooks("https://other.test/a", [wiki], opts)).toEqual(
      [],
    );
    expect(await resolveUrlHooks("no urls", [wiki], opts)).toEqual([]);
  });
  test("first matching hook wins; results in URL order; bytes are UTF-8", async () => {
    const first: UrlHook = {
      match: (u) => u.endsWith("/b"),
      async resolve() {
        return { label: "B", content: "é" };
      },
    };
    const r = await resolveUrlHooks(
      "https://wiki.test/b then https://wiki.test/a",
      [first, wiki],
      opts,
    );
    expect(r).toEqual([
      { label: "B", bytes: 2, content: "é" },
      { label: "Wiki: t/a", bytes: 27, content: "body of https://wiki.test/a" },
    ]);
  });
  test("resolves in parallel", async () => {
    let running = 0;
    let peak = 0;
    const slow: UrlHook = {
      match: () => true,
      async resolve(url) {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return { label: url, content: "x" };
      },
    };
    await resolveUrlHooks("https://a.test/ https://b.test/", [slow], opts);
    expect(peak).toBe(2);
  });
  test("a throw, a timeout and an oversized result are reported together", async () => {
    const hooks: UrlHook[] = [
      {
        match: (u) => u.includes("throw"),
        async resolve() {
          throw new Error("403 from wiki");
        },
      },
      {
        match: (u) => u.includes("hang"),
        resolve: () => new Promise(() => {}),
      },
      {
        match: (u) => u.includes("big"),
        async resolve() {
          return { label: "big", content: "x".repeat(MAX_FILE_BYTES + 1) };
        },
      },
    ];
    const p = resolveUrlHooks(
      "https://t/throw https://t/hang https://t/big",
      hooks,
      { timeoutMs: 30 },
    );
    await expect(p).rejects.toBeInstanceOf(UrlHookError);
    await expect(p).rejects.toMatchObject({
      problems: [
        "https://t/throw: 403 from wiki",
        "https://t/hang: timed out after 30 ms",
        "https://t/big: 201 KB exceeds 200 KB",
      ],
    });
  });
  test("total size counts alreadyBytes", async () => {
    const half: UrlHook = {
      match: () => true,
      async resolve(url) {
        return { label: url, content: "x".repeat(MAX_FILE_BYTES) };
      },
    };
    const text = "https://t/1";
    await expect(
      resolveUrlHooks(text, [half], {
        timeoutMs: 100,
        alreadyBytes: MAX_TOTAL_BYTES - MAX_FILE_BYTES + 1,
      }),
    ).rejects.toMatchObject({
      problems: ["attachments total 1.0 MB exceeds 1 MB"],
    });
    expect(
      await resolveUrlHooks(text, [half], {
        timeoutMs: 100,
        alreadyBytes: MAX_TOTAL_BYTES - MAX_FILE_BYTES,
      }),
    ).toHaveLength(1);
  });
});

describe("expandUrlHooks", () => {
  test("appends one fenced section per result and lists attachments", async () => {
    const r = await expandUrlHooks("read https://wiki.test/a", [wiki], opts);
    expect(r.prompt).toBe(
      "read https://wiki.test/a\n\n### Wiki: t/a\n```\nbody of https://wiki.test/a\n```",
    );
    expect(r.attachments).toEqual([{ path: "Wiki: t/a", bytes: 27 }]);
  });
  test("unchanged text when nothing matches", async () => {
    expect(await expandUrlHooks("plain", [wiki], opts)).toEqual({
      prompt: "plain",
      attachments: [],
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/src/expand-url-hooks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/expand-url-hooks.ts`:

```ts
import type { UrlHook } from "@chatbridge/provider";
import {
  type Attachment,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  formatAttachment,
  formatSize,
} from "./attachment.js";

/** Every problem found in one message, thrown together so the user fixes
 * all of them at once. Shaped like the CLI's MentionError; the UIs treat
 * both as "the user's to fix": nothing is sent, the input is refilled. */
export class UrlHookError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "UrlHookError";
    this.problems = problems;
  }
}

export interface ResolvedUrl {
  label: string;
  bytes: number;
  content: string;
}

export interface UrlExpansion {
  /** `text`, then one fenced section per resolved URL. */
  prompt: string;
  attachments: Attachment[];
}

export interface UrlHookOptions {
  /** Per-URL cap on `resolve`; the session timeout in both UIs. */
  timeoutMs: number;
  /** Bytes already attached by an earlier expansion (`@file` mentions), so
   * MAX_TOTAL_BYTES covers the whole message. */
  alreadyBytes?: number;
}

const URL = /https?:\/\/\S+/g;
/** Prose and Markdown put these right after a link. */
const TRAILING = /[)>.,;:'"!?\]]+$/;

/** Every distinct URL in `text`, in first-occurrence order. */
export function findUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL)) {
    const url = m[0].replace(TRAILING, "");
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

function matches(hook: UrlHook, url: string): boolean {
  return hook.match instanceof RegExp ? hook.match.test(url) : hook.match(url);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const utf8 = new TextEncoder();

type Outcome = { problem: string } | { ok: ResolvedUrl };

async function resolveOne(
  url: string,
  hook: UrlHook,
  timeoutMs: number,
): Promise<Outcome> {
  try {
    const { label, content } = await withTimeout(hook.resolve(url), timeoutMs);
    const bytes = utf8.encode(content).byteLength;
    if (bytes > MAX_FILE_BYTES) {
      return {
        problem: `${url}: ${Math.ceil(bytes / 1024)} KB exceeds ${MAX_FILE_BYTES / 1024} KB`,
      };
    }
    return { ok: { label, bytes, content } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { problem: `${url}: ${message}` };
  }
}

/** Resolves every URL in `text` that some hook accepts (first hook wins),
 * all in parallel. Throws UrlHookError when any of them fails, times out
 * or is too large, or when the total exceeds MAX_TOTAL_BYTES. */
export async function resolveUrlHooks(
  text: string,
  hooks: readonly UrlHook[],
  opts: UrlHookOptions,
): Promise<ResolvedUrl[]> {
  if (hooks.length === 0) return [];
  const jobs: Array<Promise<Outcome>> = [];
  for (const url of findUrls(text)) {
    const hook = hooks.find((h) => matches(h, url));
    if (hook) jobs.push(resolveOne(url, hook, opts.timeoutMs));
  }
  if (jobs.length === 0) return [];
  const outcomes = await Promise.all(jobs);
  const problems: string[] = [];
  const resolved: ResolvedUrl[] = [];
  for (const o of outcomes) {
    if ("problem" in o) problems.push(o.problem);
    else resolved.push(o.ok);
  }
  const total =
    (opts.alreadyBytes ?? 0) + resolved.reduce((n, r) => n + r.bytes, 0);
  if (total > MAX_TOTAL_BYTES) {
    problems.push(
      `attachments total ${formatSize(total)} exceeds ${formatSize(MAX_TOTAL_BYTES).replace(".0", "")}`,
    );
  }
  if (problems.length > 0) throw new UrlHookError(problems);
  return resolved;
}

/** `resolveUrlHooks`, then the prompt with one fenced section per result
 * appended to `text` (the same layout as `@file` mentions). */
export async function expandUrlHooks(
  text: string,
  hooks: readonly UrlHook[],
  opts: UrlHookOptions,
): Promise<UrlExpansion> {
  const resolved = await resolveUrlHooks(text, hooks, opts);
  if (resolved.length === 0) return { prompt: text, attachments: [] };
  const sections = resolved.map((r) => formatAttachment(r.label, r.content));
  return {
    prompt: [text, ...sections].join("\n\n"),
    attachments: resolved.map(({ label, bytes }) => ({ path: label, bytes })),
  };
}
```

`formatAttachment(label, ...)` picks a fence language from the "path" extension; a label like "Wiki: t/a" has none, so the fence is bare — the expected string in the test reflects that.

In `packages/core/src/attachment.ts`, widen the doc on `Attachment.path`:

```ts
  /** Display string: a relative `/`-separated path (may carry a `:L1-L2`
   * suffix), or a URL hook's label. */
  path: string;
```

Add to `packages/core/src/index.ts`:

```ts
export {
  type ResolvedUrl,
  type UrlExpansion,
  type UrlHookOptions,
  UrlHookError,
  expandUrlHooks,
  findUrls,
  resolveUrlHooks,
} from "./expand-url-hooks.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/core/src/expand-url-hooks.test.ts`
Expected: PASS. If the byte count `27` in the "Wiki" expectation is off, count `body of https://wiki.test/a` (27 chars, ASCII) and fix the test, not the code.

- [ ] **Step 5: Check, commit**

```bash
bun run check
git add packages/core
git commit -m "feat(core): expandUrlHooks resolves provider URL hooks into attachments (Refs #84)"
gh issue comment 83 --body "Task 4 done: core expand-url-hooks (findUrls, resolveUrlHooks, expandUrlHooks, UrlHookError) with per-URL timeout and the shared size limits. What's next: Task 5, TUI custom commands and URL hooks."
```

---

### Task 5: TUI — custom commands and URL hooks

**Files:**
- Modify: `packages/cli/src/tui/chat-model.ts`
- Modify: `packages/cli/src/tui/run-interactive.ts`
- Modify: `packages/cli/src/tui/test-helpers.ts` (only if `ChatSessionLike` needs the new method in `modelWith` fakes — it is optional, see below)
- Test: `packages/cli/src/tui/chat-model.test.ts`

**Interfaces:**
- Consumes: `parseSlashCommand(text, custom)`, `helpText(custom)`, `commandNamesOf`, `commandInfoOf`, `UrlHookError`, `expandUrlHooks`, `ProviderCommandResult`, `CommandInfo` from `@chatbridge/core`.
- Produces: `ChatSessionLike.runCommand?(name, args)`; `ChatModelOptions.commands?: readonly CommandInfo[]`.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/tui/chat-model.test.ts`, extend `fakeSession` so the fake records commands:

```ts
function fakeSession(label = "") {
  const calls: string[] = [];
  const replies: Array<ReturnType<typeof deferred<string>>> = [];
  const commands: Array<{ name: string; args: string }> = [];
  const commandResults: Array<ReturnType<typeof deferred<ProviderCommandResult>>> = [];
  const state = { closed: 0, killed: 0, closeHangs: false };
  const session: ChatSessionLike = {
    async send(prompt) { /* unchanged */ },
    async runCommand(name, args) {
      commands.push({ name, args });
      const d = deferred<ProviderCommandResult>();
      commandResults.push(d);
      return d.promise;
    },
    close() { /* unchanged */ },
    async kill() { /* unchanged */ },
  };
  return { session, calls, replies, commands, commandResults, state };
}
```

Import `type ProviderCommandResult, UrlHookError` from `@chatbridge/core`. Add a describe block:

```ts
describe("provider commands", () => {
  const commands = [
    { name: "model", description: "Show the model" },
    { name: "summarize", description: "Summarize" },
  ];

  test("/help lists the provider commands after the built-ins", async () => {
    const model = await modelWith(fakeSession().session, { commands });
    await model.submit("/help");
    const text = model.messages.at(-1)?.text ?? "";
    expect(text).toContain("/model");
    expect(text).toContain("Summarize");
    expect(text.indexOf("/login")).toBeLessThan(text.indexOf("/model"));
  });

  test("a built-in with arguments is refused with an error entry", async () => {
    const s = fakeSession();
    const model = await modelWith(s.session, { commands });
    expect(await model.submit("/login now")).toBe(false);
    expect(model.messages.at(-1)).toEqual({
      role: "error",
      text: "/login takes no arguments.",
    });
    expect(s.calls).toEqual([]);
  });

  test("show: user entry as typed, then a help-styled entry; nothing sent", async () => {
    const s = fakeSession();
    const model = await modelWith(s.session, { commands });
    const statuses: string[] = [];
    model.onChange = () => statuses.push(model.status);
    const p = model.submit("/model");
    await tick();
    expect(model.status).toBe("busy");
    expect(s.commands).toEqual([{ name: "model", args: "" }]);
    s.commandResults[0].resolve({ kind: "show", text: "gpt-x" });
    expect(await p).toBe(true);
    expect(model.messages).toEqual([
      { role: "user", text: "/model" },
      { role: "help", text: "gpt-x" },
    ]);
    expect(model.status).toBe("idle");
    expect(s.calls).toEqual([]);
    expect(statuses.at(-1)).toBe("idle");
  });

  test("send: the expanded prompt goes to the service, the typed line stays in the history", async () => {
    const s = fakeSession();
    const model = await modelWith(s.session, { commands });
    const p = model.submit("/summarize the doc");
    await tick();
    expect(s.commands).toEqual([{ name: "summarize", args: "the doc" }]);
    s.commandResults[0].resolve({ kind: "send", prompt: "Summarize: the doc" });
    await tick();
    expect(s.calls).toEqual(["Summarize: the doc"]);
    s.replies[0].resolve("done");
    expect(await p).toBe(true);
    expect(model.messages).toEqual([
      { role: "user", text: "/summarize the doc" },
      { role: "assistant", text: "done" },
    ]);
    expect(model.status).toBe("idle");
  });

  test("queued while a turn is in flight, then run in order", async () => {
    const s = fakeSession();
    const model = await modelWith(s.session, { commands });
    const first = model.submit("hello");
    await tick();
    expect(await model.submit("/model")).toBe(true);
    expect(model.queue).toEqual(["/model"]);
    expect(s.commands).toEqual([]);
    s.replies[0].resolve("hi");
    await first;
    await tick();
    expect(s.commands).toEqual([{ name: "model", args: "" }]);
    s.commandResults[0].resolve({ kind: "show", text: "m" });
    await tick();
    expect(model.messages.at(-1)).toEqual({ role: "help", text: "m" });
  });

  test("a timeout shows the error and stays idle; another error is fatal", async () => {
    const s = fakeSession();
    const model = await modelWith(s.session, { ...noReopen, commands });
    let p = model.submit("/model");
    await tick();
    s.commandResults[0].reject(new ResponseTimeoutError("slow"));
    await p;
    expect(model.messages.at(-1)).toEqual({ role: "error", text: "slow" });
    expect(model.status).toBe("idle");
    p = model.submit("/model");
    await tick();
    s.commandResults[1].reject(new Error("page gone"));
    await p;
    expect(model.status).toBe("dead");
    expect(model.messages.at(-1)).toEqual({ role: "error", text: "page gone" });
  });

  test("a session without runCommand reports the command as unavailable", async () => {
    const s = fakeSession();
    const { runCommand: _omit, ...withoutIt } = s.session;
    const model = await modelWith(withoutIt as ChatSessionLike, { commands });
    expect(await model.submit("/model")).toBe(false);
    expect(model.messages.at(-1)?.role).toBe("error");
  });
});

test("a UrlHookError is handled like a MentionError", async () => {
  const { session, calls } = fakeSession();
  const model = await modelWith(session, {
    ...noReopen,
    expand: async () => {
      throw new UrlHookError(["https://w/x: 403"]);
    },
  });
  expect(await model.submit("see https://w/x")).toBe(false);
  expect(calls).toEqual([]);
  expect(model.messages).toEqual([{ role: "error", text: "https://w/x: 403" }]);
  expect(model.status).toBe("idle");
  expect(model.fatal).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/tui/chat-model.test.ts`
Expected: FAIL — `commands` is not an option; `/model` is unknown; `UrlHookError` makes the model dead.

- [ ] **Step 3: Implement**

In `packages/cli/src/tui/chat-model.ts`:

Imports: add `type CommandInfo`, `type ProviderCommandResult`, `UrlHookError`, `commandNamesOf` to the `@chatbridge/core` import.

`ChatSessionLike`:

```ts
export interface ChatSessionLike {
  send(prompt: string): Promise<string>;
  /** Optional so older fakes keep working; the real ChatSession has it. */
  runCommand?(name: string, args: string): Promise<ProviderCommandResult>;
  close(): Promise<void>;
  kill(): Promise<void>;
}
```

`ChatModelOptions`: add

```ts
  /** The provider's `/commands` (name and description); `/help` lists them
   * and submit() recognises them. Default: none. */
  commands?: readonly CommandInfo[];
```

Fields and constructor:

```ts
  private readonly commands: readonly CommandInfo[];
  private readonly commandNames: ReadonlySet<string>;
  // in the constructor:
  this.commands = opts.commands ?? [];
  this.commandNames = commandNamesOf({ commands: this.commands });
```

`submit`:

```ts
  async submit(text: string): Promise<boolean> {
    const prompt = text.trim();
    if (!prompt) return false;
    const slash = parseSlashCommand(prompt, this.commandNames);
    // A built-in acts on the model itself, so it runs in whatever state the
    // model is in. A provider command needs the page, so it waits its turn
    // like a message.
    if (slash && !("custom" in slash)) return this.runSlash(slash);
    if (this.status !== "idle") {
      this.queue.push(prompt);
      this.onChange();
      return true;
    }
    return slash ? this.runCustom(slash.custom, slash.args, prompt) : this.runTurn(prompt, false);
  }
```

`drain`: re-dispatch a queued `/command`:

```ts
  private drain(): void {
    const next = this.queue.shift();
    if (next === undefined) return;
    const slash = parseSlashCommand(next, this.commandNames);
    if (slash && "custom" in slash) {
      void this.runCustom(slash.custom, slash.args, next);
    } else {
      void this.runTurn(next, true);
    }
  }
```

(A queued entry is always a message or a custom command: built-ins never queue.)

`runTurn`: treat `UrlHookError` like `MentionError`:

```ts
      if (err instanceof MentionError || err instanceof UrlHookError) {
```

`runSlash`: its parameter type becomes `Exclude<ParsedSlash, { custom: string }>`; add before the `unknown` branch:

```ts
    if ("error" in slash) {
      this.messages.push({ role: "error", text: slash.error });
      this.onChange();
      return false;
    }
```

and `case "help"` uses `helpText(this.commands)`.

New method after `runSlash`:

```ts
  /** One provider `/command`, from `idle`. `typed` is the line as the user
   * wrote it: it is what the history shows, whatever the command sends. */
  private async runCustom(
    name: string,
    args: string,
    typed: string,
  ): Promise<boolean> {
    const session = this.requireSession();
    if (session.runCommand === undefined) {
      this.messages.push({
        role: "error",
        text: `/${name} is not available in this session.`,
      });
      this.onChange();
      return false;
    }
    this.status = "busy";
    this.messages.push({ role: "user", text: typed });
    this.onChange();
    const generation = this.generation;
    let result: ProviderCommandResult;
    try {
      result = await session.runCommand(name, args);
    } catch (err) {
      if (generation !== this.generation) return true; // stale: reset ran
      this.messages.push({ role: "error", text: this.describe(err) });
      if (err instanceof ResponseTimeoutError) {
        this.settle("idle");
      } else {
        this.fatal = err;
        this.settle("dead");
      }
      this.onChange();
      return true;
    }
    if (generation !== this.generation) return true;
    if (result.kind === "show") {
      this.messages.push({ role: "help", text: result.text });
      this.settle("idle");
      this.onChange();
      return true;
    }
    // `send`: the rest of an ordinary turn. Held shell results ride along
    // exactly as they do for a typed message.
    let outgoing = result.prompt;
    const carriesHeld = this.heldResults.length > 0;
    if (carriesHeld) {
      outgoing = [outgoing, ...this.heldResults.map(formatShellSection)].join(
        "\n\n",
      );
    }
    await this.sendPrompt(outgoing, carriesHeld);
    return true;
  }
```

In `packages/cli/src/tui/run-interactive.ts`, pass the commands and compose the expansion. Add imports `commandInfoOf`, `expandUrlHooks` from `@chatbridge/core` and `expandMentions` from `../mentions/expand-mentions.js`, then in the `new ChatModel({...})` call add:

```ts
      commands: commandInfoOf(opts.provider),
      expand: async (text) => {
        const cwd = process.cwd();
        const mentions = await expandMentions(text, cwd);
        const hooks = opts.provider.urlHooks ?? [];
        if (hooks.length === 0) return mentions;
        const already = mentions.attachments.reduce((n, a) => n + a.bytes, 0);
        const urls = await expandUrlHooks(mentions.prompt, hooks, {
          timeoutMs: opts.timeoutMs,
          alreadyBytes: already,
        });
        return {
          prompt: urls.prompt,
          attachments: [...mentions.attachments, ...urls.attachments],
        };
      },
```

`expandUrlHooks` scans `mentions.prompt`, which contains the original text plus file sections; a URL inside an attached file would also be expanded. Avoid that: scan `text`, append to `mentions.prompt`:

```ts
        const urls = await expandUrlHooks(text, hooks, { timeoutMs: opts.timeoutMs, alreadyBytes: already });
        const extra = urls.prompt.slice(text.length); // "" or "\n\n### ..." sections
        return {
          prompt: mentions.prompt + extra,
          attachments: [...mentions.attachments, ...urls.attachments],
        };
```

Use this second form.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run build && bun test packages/cli`
Expected: PASS, including the existing slash-command and E2E tests.

- [ ] **Step 5: Check, commit**

```bash
bun run check
git add packages/cli
git commit -m "feat(cli): provider /commands and URL hooks in the interactive TUI (Refs #83)"
gh issue comment 83 --body "Task 5 done: ChatModel runs provider commands (show/send, queued behind a turn), /help lists them, UrlHookError is handled like a MentionError, run-interactive composes mention and URL expansion. What's next: Task 6, VSCode protocol, bridge and webview."
```

---

### Task 6: VSCode protocol, bridge and webview

**Files:**
- Modify: `packages/vscode/src/protocol.ts`
- Modify: `packages/vscode/src/chat-view-bridge.ts`
- Modify: `packages/vscode/src/webview/main.ts`
- Test: `packages/vscode/src/chat-view-bridge.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // ToHost
  | { type: "customCommand"; name: string; args: string; text: string }
  // ToWebview config
  | ({ type: "config" } & UiConfig & { commands?: CommandInfo[] })
  // ChatViewHandlers
  customCommand(name: string, args: string, text: string): void;
  // bridge.attach(webview, uiConfig?, commands?: CommandInfo[])
  ```

- [ ] **Step 1: Write the failing tests**

In `packages/vscode/src/chat-view-bridge.test.ts` add (using the file's `fakeWebview` and `state` helpers, and a `handlers` object the existing tests build — copy its shape and add `customCommand`):

```ts
test("customCommand is validated and routed with name, args and text", () => {
  const calls: unknown[] = [];
  const bridge = new ChatViewBridge(() => state, {
    ...noopHandlers,
    customCommand: (name, args, text) => calls.push([name, args, text]),
  });
  const w = fakeWebview();
  bridge.attach(w.webview);
  w.receive({ type: "customCommand", name: "model", args: "", text: "/model" });
  w.receive({ type: "customCommand", name: 1, args: "" } as unknown as ToHost);
  w.receive({ type: "customCommand", name: "x" } as unknown as ToHost);
  expect(calls).toEqual([["model", "", "/model"]]);
});

test("ready posts the config with the provider commands", () => {
  const bridge = new ChatViewBridge(() => state, noopHandlers);
  const w = fakeWebview();
  bridge.attach(w.webview, { welcome: "hi" }, [
    { name: "model", description: "Show the model" },
  ]);
  w.receive({ type: "ready" });
  expect(w.posted[0]).toEqual({
    type: "config",
    welcome: "hi",
    commands: [{ name: "model", description: "Show the model" }],
  });
});
```

If the file has no shared `noopHandlers`, define one at the top:

```ts
const noopHandlers: ChatViewHandlers = {
  send() {}, removeAttachment() {}, takeBack() {}, removeQueued() {},
  command() {}, customCommand() {}, attachUris() {}, pasted() {},
};
```

and import `ChatViewHandlers`. Existing tests that build a handlers object literal must gain `customCommand() {}`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/vscode/src/chat-view-bridge.test.ts`
Expected: FAIL — type error on `customCommand`, config posted without `commands`.

- [ ] **Step 3: Implement**

`packages/vscode/src/protocol.ts`: import `type CommandInfo` from `@chatbridge/core`; add to `ToHost`:

```ts
  /** A provider `/command`; `text` is the line as typed, for the history. */
  | { type: "customCommand"; name: string; args: string; text: string }
```

and change the `config` member of `ToWebview` to:

```ts
  | ({ type: "config" } & UiConfig & {
      /** The provider's commands, so the webview can parse `/name args`. */
      commands?: CommandInfo[];
    })
```

`packages/vscode/src/chat-view-bridge.ts`: add to `ChatViewHandlers`

```ts
  customCommand(name: string, args: string, text: string): void;
```

to `isToHost`:

```ts
    case "customCommand":
      return (
        typeof msg.name === "string" &&
        typeof msg.args === "string" &&
        typeof msg.text === "string"
      );
```

`attach` gains a third parameter and posts it:

```ts
  attach(
    webview: WebviewLike,
    uiConfig?: UiConfig,
    commands?: CommandInfo[],
  ): { dispose(): void } {
    // ...
        case "ready":
          if (uiConfig || commands) {
            void webview.postMessage({
              type: "config",
              ...uiConfig,
              ...(commands ? { commands } : {}),
            });
          }
          this.pushState(this.getState());
          break;
    // ...
        case "customCommand":
          this.handlers.customCommand(raw.name, raw.args, raw.text);
          break;
```

(Import `CommandInfo` from `@chatbridge/core`.)

`packages/vscode/src/webview/main.ts`: keep a name set from the config and use it in `submit`:

```ts
let commandNames: ReadonlySet<string> = new Set();
// in applyConfig(c) — or right where `config = c` is assigned:
commandNames = new Set((c.commands ?? []).map((x) => x.name));
```

(`applyConfig` receives the `config` message minus `type`; widen its parameter type to `UiConfig & { commands?: CommandInfo[] }` and import `CommandInfo` as a type from `@chatbridge/core/slash-commands`.)

`submit`:

```ts
function submit(): void {
  const text = input.value;
  if (text.trim() === "" && attachments.childElementCount === 0) return;
  const slash = parseSlashCommand(text, commandNames);
  if (slash && "unknown" in slash) {
    showInlineError(unknownCommandMessage(slash.unknown));
    return;
  }
  if (slash && "error" in slash) {
    showInlineError(slash.error);
    return;
  }
  showInlineError(undefined);
  if (slash) {
    input.value = "";
    fitComposer();
    if ("custom" in slash) {
      vscode.postMessage({
        type: "customCommand",
        name: slash.custom,
        args: slash.args,
        text: text.trim(),
      });
      return;
    }
    const name = slash.command === "new" ? "newChat" : slash.command;
    vscode.postMessage({ type: "command", name });
    return;
  }
  vscode.postMessage({ type: "send", text });
  input.value = "";
  fitComposer();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/vscode`
Expected: PASS (the webview bundle test, if any, still builds — `bun run check` covers the esbuild step if the package has one).

- [ ] **Step 5: Check, commit**

```bash
bun run check
git add packages/vscode
git commit -m "feat(vscode): webview posts provider commands; config carries their names (Refs #83)"
gh issue comment 83 --body "Task 6 done: customCommand message, bridge validation/routing, config with the provider's command list, webview parses with it. What's next: Task 7, SessionController.runCommand and URL hooks in the extension."
```

---

### Task 7: VSCode controller, commands and extension wiring

**Files:**
- Modify: `packages/vscode/src/session-controller.ts`
- Modify: `packages/vscode/src/commands.ts`
- Modify: `packages/vscode/src/create-extension.ts`
- Test: `packages/vscode/src/session-controller.test.ts`, `packages/vscode/src/commands.test.ts`

**Interfaces:**
- Consumes: `ChatSessionLike.runCommand`, `resolveUrlHooks`, `commandInfoOf`, `helpText(custom)`.
- Produces:
  ```ts
  SessionControllerOptions.expandUrls?: (text: string) => Promise<ResolvedUrl[]>;
  SessionController.runCommand(name: string, args: string, text: string): Promise<SendResult>;
  CommandDeps.commands?: readonly CommandInfo[];
  CommandHandlers.customCommand(name: string, args: string, text: string): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/vscode/src/session-controller.test.ts`: extend `Harness` with `commands: Array<{ name: string; args: string }>` and `commandResults: Array<ReturnType<typeof deferred<ProviderCommandResult>>>` (init `[]`), and `sessionOf` with:

```ts
    async runCommand(name, args) {
      h.commands.push({ name, args });
      const d = deferred<ProviderCommandResult>();
      h.commandResults.push(d);
      return d.promise;
    },
```

Import `type ProviderCommandResult, UrlHookError` from `@chatbridge/core`. Add:

```ts
describe("SessionController.runCommand", () => {
  test("opens lazily, pushes the typed line, show → help entry, idle", async () => {
    const h = harness();
    const p = h.controller.runCommand("model", "", "/model");
    await settle();
    expect(h.opens).toBe(1);
    expect(h.controller.getState().status).toBe("busy");
    expect(h.commands).toEqual([{ name: "model", args: "" }]);
    h.commandResults[0].resolve({ kind: "show", text: "gpt-x" });
    expect(await p).toEqual({ ok: true });
    const s = h.controller.getState();
    expect(s.status).toBe("idle");
    expect(s.messages).toEqual([
      { role: "user", text: "/model", attachments: [] },
      { role: "help", text: "gpt-x" },
    ]);
    expect(h.sent).toEqual([]);
  });

  test("send → the prompt is sent, the typed line stays, the reply lands", async () => {
    const h = harness();
    const p = h.controller.runCommand("summarize", "x", "/summarize x");
    await settle();
    h.commandResults[0].resolve({ kind: "send", prompt: "Summarize: x" });
    await settle();
    expect(h.sent).toEqual(["Summarize: x"]);
    h.replies[0].resolve("ok");
    expect(await p).toEqual({ ok: true });
    expect(h.controller.getState().messages).toEqual([
      { role: "user", text: "/summarize x", attachments: [] },
      { role: "assistant", text: "ok" },
    ]);
  });

  test("queued behind a turn and dispatched on drain", async () => {
    const h = harness();
    const first = h.controller.send("hello");
    await settle();
    expect(await h.controller.runCommand("model", "", "/model")).toEqual({
      ok: true,
      queued: true,
    });
    expect(h.controller.getState().queue).toEqual([
      { text: "/model", attachments: [] },
    ]);
    h.replies[0].resolve("hi");
    await first;
    await settle();
    expect(h.commands).toEqual([{ name: "model", args: "" }]);
  });

  test("timeout → idle with an error entry; other errors → dead", async () => {
    const h = harness();
    let p = h.controller.runCommand("model", "", "/model");
    await settle();
    h.commandResults[0].reject(new ResponseTimeoutError("slow"));
    expect((await p).ok).toBe(false);
    expect(h.controller.getState().status).toBe("idle");
    p = h.controller.runCommand("model", "", "/model");
    await settle();
    h.commandResults[1].reject(new Error("gone"));
    expect((await p).ok).toBe(false);
    expect(h.controller.getState().status).toBe("dead");
  });
});

describe("URL hooks", () => {
  test("resolved URLs join the turn after the pending attachments", async () => {
    const h = harness({
      expandUrls: async (text) =>
        text.includes("https://w/x")
          ? [{ label: "Wiki: X", bytes: 4, content: "body" }]
          : [],
    });
    h.controller.addAttachment({ path: "a.txt", bytes: 1, content: "a" });
    const p = h.controller.send("see https://w/x");
    await settle();
    expect(h.sent[0]).toBe(
      "see https://w/x\n\n### a.txt\n```\na\n```\n\n### Wiki: X\n```\nbody\n```",
    );
    expect(h.controller.getState().messages[0]).toEqual({
      role: "user",
      text: "see https://w/x",
      attachments: [
        { path: "a.txt", bytes: 1 },
        { path: "Wiki: X", bytes: 4 },
      ],
    });
    h.replies[0].resolve("ok");
    await p;
  });

  test("a UrlHookError refuses the send: error entry, nothing sent, not dead", async () => {
    const h = harness({
      expandUrls: async () => {
        throw new UrlHookError(["https://w/x: 403"]);
      },
    });
    const r = await h.controller.send("https://w/x");
    expect(r).toEqual({ ok: false, code: "URL_HOOK", message: "https://w/x: 403" });
    const s = h.controller.getState();
    expect(s.messages).toEqual([{ role: "error", text: "https://w/x: 403" }]);
    expect(s.status).toBe("closed");
    expect(h.opens).toBe(0);
    expect(h.sent).toEqual([]);
  });
});
```

`packages/vscode/src/commands.test.ts`: add a test that `help` with `commands: [{ name: "model", description: "Show the model" }]` in the deps pushes a help entry containing `/model` (follow the file's existing `help` test and its deps helper), and one that `customCommand("model", "", "/model")` calls `controller.runCommand` with those arguments (the file's controller fake: add a recording `runCommand`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/vscode`
Expected: FAIL — `runCommand` / `expandUrls` do not exist.

- [ ] **Step 3: Implement**

`packages/vscode/src/session-controller.ts`:

Imports: add `type ProviderCommandResult`, `type ResolvedUrl`, `UrlHookError` from `@chatbridge/core`.

`ChatSessionLike`:

```ts
export interface ChatSessionLike {
  send(prompt: string): Promise<string>;
  runCommand?(name: string, args: string): Promise<ProviderCommandResult>;
  close(): Promise<void>;
  kill(): Promise<void>;
}
```

`QueuedTurn`:

```ts
interface QueuedTurn {
  text: string;
  attachments: PendingAttachment[];
  /** Set for a provider `/command`; `text` is then the typed line. */
  command?: { name: string; args: string };
}
```

`SessionControllerOptions`:

```ts
  /** URL hook expansion for the text of a turn; the extension builds it from
   * the provider's hooks and the timeout setting. Default: none. */
  expandUrls?: (text: string) => Promise<ResolvedUrl[]>;
```

`send`: unchanged except the branch `return this.startTurn(...)` stays; `startTurn` becomes async and expands URLs:

```ts
  /** Pushes the user entry and runs the turn (or the command). Shared by
   * send, runCommand and drain. */
  private async startTurn(turn: QueuedTurn): Promise<SendResult> {
    if (turn.command) {
      this.push({ role: "user", text: turn.text, attachments: [] });
      return this.runProviderCommand(turn.command);
    }
    let attachments = turn.attachments;
    if (this.opts.expandUrls) {
      try {
        const urls = await this.opts.expandUrls(turn.text);
        attachments = [
          ...attachments,
          ...urls.map((u) => ({ path: u.label, bytes: u.bytes, content: u.content })),
        ];
      } catch (err) {
        if (!(err instanceof UrlHookError)) throw err;
        // The user's to fix: report, send nothing, leave the status alone.
        const message = err.message;
        this.push({ role: "error", text: message });
        return { ok: false, code: "URL_HOOK", message };
      }
    }
    const sections = attachments.map((a) => formatAttachment(a.path, a.content));
    const prompt = [turn.text, ...sections].filter((s) => s !== "").join("\n\n");
    this.push({
      role: "user",
      text: turn.text,
      attachments: attachments.map(({ path, bytes }) => ({ path, bytes })),
    });
    this.lastPrompt = prompt;
    return this.runTurn(prompt);
  }
```

Draining a failed hook entry: `drain()` calls `void this.startTurn(next)`; a `URL_HOOK` failure of a queued entry pushes the error and drops the entry (the queue is not a composer; the user re-types). Document that in a comment in `drain`.

`runCommand`:

```ts
  /** A provider `/command` from the webview. Queued like a message when a
   * turn is running; `text` is the line as typed, which is what the
   * history shows. */
  async runCommand(name: string, args: string, text: string): Promise<SendResult> {
    const turn: QueuedTurn = { text, attachments: [], command: { name, args } };
    if (!this.canStartTurn || this.queue.length > 0) {
      this.queue.push(turn);
      this.drain();
      this.emit();
      return { ok: true, queued: true };
    }
    return this.startTurn(turn);
  }

  /** Runs the command on the session (opening one lazily, like a turn).
   * `show` prints; `send` continues as an ordinary turn with the prompt. */
  private async runProviderCommand(command: {
    name: string;
    args: string;
  }): Promise<SendResult> {
    this.lastError = undefined;
    const generation = this.generation;
    try {
      const session = await this.ensureSession(generation);
      if (session === undefined) return { ok: true }; // stale
      if (session.runCommand === undefined) {
        throw new Error(`/${command.name} is not available in this session.`);
      }
      this.setStatus("busy");
      const result = await session.runCommand(command.name, command.args);
      if (generation !== this.generation) return { ok: true };
      if (result.kind === "show") {
        this.messages.push({ role: "help", text: result.text });
        this.status = "idle";
        this.drain();
        this.emit();
        return { ok: true };
      }
      this.lastPrompt = result.prompt;
      return this.runTurn(result.prompt);
    } catch (err) {
      if (generation !== this.generation) return { ok: true };
      return this.fail(err);
    }
  }

  /** The open session, opening one when there is none. Undefined when a
   * reopen ran meanwhile (the caller's generation is stale). */
  private async ensureSession(
    generation: number,
  ): Promise<ChatSessionLike | undefined> {
    if (this.session !== undefined) return this.session;
    this.setStatus("opening");
    const session = await this.trackOpen(this.opts.openSession());
    if (generation !== this.generation) {
      await closeOrKill(session, this.closeTimeoutMs);
      return undefined;
    }
    this.session = session;
    return session;
  }
```

Refactor `runTurn` to use `ensureSession`:

```ts
  private async runTurn(prompt: string): Promise<SendResult> {
    this.lastError = undefined;
    const generation = this.generation;
    try {
      const session = await this.ensureSession(generation);
      if (session === undefined) return { ok: true }; // stale
      this.setStatus("busy");
      const reply = await session.send(prompt);
      // ...rest unchanged
```

`getState().queue` maps `{ text, attachments }` only, so a queued command shows as its typed line — that is what the test expects.

`packages/vscode/src/commands.ts`: `CommandDeps` gains `commands?: readonly CommandInfo[]`; `CommandHandlers` gains

```ts
  /** From the webview's `/name args`. */
  customCommand(name: string, args: string, text: string): Promise<void>;
```

Implement:

```ts
    help: () => controller.pushHelp(helpText(deps.commands ?? [])),

    async customCommand(name, args, text) {
      const result = await controller.runCommand(name, args, text);
      if (result.ok || result.code !== "BROWSER_UNAVAILABLE") return;
      const choice = await ui.showErrorMessage(result.message, "Install");
      if (choice !== "Install") return;
      if (await runInstall()) await controller.retryLast();
    },
```

(Import `CommandInfo` as a type from `@chatbridge/core`.)

`packages/vscode/src/create-extension.ts`:

- Bridge handlers: add `customCommand: (name, args, text) => void handlers.customCommand(name, args, text),`.
- `bridge.attach(webview, uiConfig)` call (in the `ChatViewProvider` wiring near line 184): pass `commandInfoOf(opts.provider)` as the third argument. Check `chat-view-provider.ts` for how `attach` is invoked and thread the argument through if it wraps the call.
- Controller: add
  ```ts
      expandUrls: (text) =>
        resolveUrlHooks(text, opts.provider.urlHooks ?? [], {
          timeoutMs: settings().timeoutMs,
        }),
  ```
  (`settings()` already yields `timeoutMs`; confirm the property name in the function and use it.)
- `createCommands({... commands: commandInfoOf(opts.provider) })`.

Imports: `commandInfoOf`, `resolveUrlHooks` from `@chatbridge/core`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run build && bun test packages/vscode`
Expected: PASS, including the E2E (`e2e:vscode`) if the machine has Chromium; otherwise note it in the issue comment.

- [ ] **Step 5: Check, commit**

```bash
bun run check
git add packages/vscode
git commit -m "feat(vscode): run provider commands and URL hooks from the chat view (Refs #83)"
gh issue comment 83 --body "Task 7 done: SessionController.runCommand (lazy open, show/send, queue), URL hook expansion at turn start, help lists provider commands, extension wiring. What's next: Task 8, dummy provider examples and docs."
```

---

### Task 8: Dummy provider examples and docs

**Files:**
- Modify: `examples/dummy-chat/provider.ts`
- Modify: `README.md` (section "Scope: cooperative services only" area, and the interactive-mode section that lists slash commands)
- Modify: `.claude/skills/creating-provider-repo/SKILL.md` ("Provider method contract" table)
- Test: `packages/cli/src/cli.e2e.test.ts` (one interactive E2E case if the file already drives the TUI against the dummy chat; otherwise skip the test and say so in the issue comment)

- [ ] **Step 1: Extend the dummy provider**

In `examples/dummy-chat/provider.ts`, inside `defineProvider({...})` after `detectBlock`:

```ts
    commands: [
      {
        name: "title",
        description: "Show the chat page title",
        async run(page) {
          return { kind: "show", text: await page.title() };
        },
      },
      {
        name: "shout",
        description: "Send the arguments in upper case",
        async run(_page, args) {
          return { kind: "send", prompt: args.toUpperCase() };
        },
      },
    ],

    urlHooks: [
      {
        // Pages of the dummy chat itself, e.g. `${baseUrl}/login`.
        match: (url) => url.startsWith(baseUrl),
        async resolve(url) {
          // A real provider would run a script or call an API here; the
          // framework never fetches anything itself.
          const res = await fetch(url);
          if (!res.ok) throw new Error(`${res.status} from dummy chat`);
          return { label: `Dummy: ${new URL(url).pathname}`, content: await res.text() };
        },
      },
    ],
```

`baseUrl` is the parameter of `createDummyProvider`, in scope.

- [ ] **Step 2: E2E (if the interactive E2E exists)**

Look at `packages/cli/src/cli.e2e.test.ts` and `packages/cli/src/tui/run-interactive.test.ts`. If a test drives `runInteractive` with the dummy provider and reads `model.messages`, add:

```ts
test("provider commands: /title shows, /shout sends", async () => {
  // build the model the way the neighbouring test does, then:
  await model.submit("/title");
  expect(model.messages.at(-1)).toEqual({ role: "help", text: "Dummy Chat" });
  await model.submit("/shout hello");
  expect(model.messages.at(-1)?.text).toBe("Echo: HELLO");
});
```

Adjust the expected title to the dummy page's real `<title>` (read `examples/dummy-chat/serve.ts`). If no such harness exists, skip this step and record that in the commit message body.

- [ ] **Step 3: README**

In the interactive-mode section, after the paragraph listing the built-in slash commands, add:

```markdown
A provider can add its own commands (`/model`, `/summarize …`); `/help` lists
them after the built-ins. Arguments are the rest of the line. A provider can
also register URL hooks: a URL in your message that a hook recognises is
fetched by the provider and attached like an `@file` mention (the history
shows the hook's label; only the service sees the content). Neither is
available in one-shot mode.
```

After the "Scope: cooperative services only" paragraph, add a subsection:

````markdown
## Provider extension points

Besides the required page methods, a provider may ship:

```ts
import { defineProvider } from "@chatbridge/provider";

export default defineProvider({
  // ...name, chatUrl and the five page methods...
  commands: [
    {
      name: "model",
      description: "Show the selected model",
      async run(page) {
        return { kind: "show", text: await page.locator("#model").innerText() };
      },
    },
    {
      name: "summarize",
      description: "Summarize the given text",
      async run(_page, args) {
        return { kind: "send", prompt: `Summarize in three bullets:\n\n${args}` };
      },
    },
  ],
  urlHooks: [
    {
      match: /^https:\/\/wiki\.example\.com\//,
      async resolve(url) {
        // Your code: a script, an API call, a PAT from the environment.
        // The framework never fetches and never sees a credential.
        const { title, body } = await fetchWikiPage(url);
        return { label: `Wiki: ${title}`, content: body };
      },
    },
  ],
});
```

`defineProvider` rejects command names that are not lower-case letters, that
collide with a built-in (`login`, `logout`, `new`, `reopen`, `help`), or that
repeat. A `show` result is printed; a `send` result is sent as an ordinary
turn while the history keeps the `/command` line you typed. A URL hook runs
under the session timeout and its result is subject to the same size limits
as `@file` attachments.
````

- [ ] **Step 4: Skill doc**

In `.claude/skills/creating-provider-repo/SKILL.md`, append two rows to the "Provider method contract" table:

```markdown
| `commands` (optional, framework ≥ 0.9.0) | `/name` commands for the TUI and VSCode: `{ name, description, run(page, args) }` returning `{ kind: "show", text }` or `{ kind: "send", prompt }`. Names are lower-case letters, never a built-in. Not available in one-shot mode. |
| `urlHooks` (optional, framework ≥ 0.9.0) | `{ match: RegExp | (url) => boolean, resolve(url) => { label, content } }`. Fetching and credentials are the provider's (a script with a PAT is fine); the framework only appends the content as an attachment. Runs under the session timeout; `MAX_FILE_BYTES` / `MAX_TOTAL_BYTES` apply. |
```

- [ ] **Step 5: Check, commit**

```bash
bun run check
git add examples README.md .claude/skills/creating-provider-repo/SKILL.md packages/cli
git commit -m "docs: provider commands and URL hooks in the dummy provider, README and provider skill (Refs #83, #84)"
gh issue comment 83 --body "Task 8 done: dummy provider ships /title, /shout and a URL hook; README and the provider skill document both extension points. What's next: whole-branch review, then PR (Closes #83, closes #84) as v0.9.0."
```

---

## After the tasks

1. Whole-branch review (Fable) per CLAUDE.md, fix loop.
2. PR titled `Provider-defined slash commands and URL hooks for the TUI and VSCode (v0.9.0)`, label `enhancement`, body with `Closes #83` and `closes #84` on separate lines, and the session attribution.
3. Version bump to 0.9.0 across the five packages follows the release process in `docs/PUBLISHING.md` (a separate release commit on main after the squash-merge), then the ROADMAP heading for milestone 15.
