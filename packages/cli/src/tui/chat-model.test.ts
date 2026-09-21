import { describe, expect, test } from "bun:test";
import {
  AuthRequiredError,
  BlockedError,
  BrowserUnavailableError,
  LoginAbortedError,
  NOT_RESTORED_NOTE,
  type ProviderCommandResult,
  RESTORED_NOTE,
  ResponseTimeoutError,
  UrlHookError,
} from "@chatbridge/core";
import { MentionError } from "../mentions/expand-mentions.js";
import type {
  RunOptions,
  RunningCommand,
  ShellResult,
} from "../shell/run-command.js";
import {
  COPIED_NOTICE,
  COPY_FAILED_NOTICE,
  ChatModel,
  type ChatModelOptions,
  type ChatSessionLike,
  IDLE_SEPARATOR,
  NEW_CHAT_SEPARATOR,
  NOTHING_TO_COPY_NOTICE,
} from "./chat-model.js";
import { modelWith } from "./test-helpers.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets the awaited mention expansion inside submit() settle, so that
 * session.send has been called and its deferred reply is available. */
function tick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** The nth entry of a list of deferreds, failing loudly when the code under
 * test never created it (Biome forbids `!`, and `?.` would pass silently). */
function nth<T>(list: readonly T[], i: number): T {
  const entry = list[i];
  if (entry === undefined) throw new Error(`no entry at index ${i}`);
  return entry;
}

/** A fake session. `label`, when given, prefixes recorded calls so a test
 * over two sessions can tell which one was sent to. */
function fakeSession(label = "") {
  const calls: string[] = [];
  const replies: Array<ReturnType<typeof deferred<string>>> = [];
  const commands: Array<{ name: string; args: string }> = [];
  const commandResults: Array<
    ReturnType<typeof deferred<ProviderCommandResult>>
  > = [];
  const state = {
    closed: 0,
    killed: 0,
    closeHangs: false,
    /** What `session.conversation` reports; a test sets it before the turn
     * whose handle it stands for. */
    conversation: undefined as string | undefined,
    /** What `session.restored` reports; undefined means "not attempted". */
    restored: undefined as boolean | undefined,
  };
  const session: ChatSessionLike = {
    get conversation() {
      return state.conversation;
    },
    get restored() {
      return state.restored;
    },
    async send(prompt) {
      calls.push(label ? `${label}:${prompt}` : prompt);
      const d = deferred<string>();
      replies.push(d);
      return d.promise;
    },
    async runCommand(name, args) {
      commands.push({ name, args });
      const d = deferred<ProviderCommandResult>();
      commandResults.push(d);
      return d.promise;
    },
    close() {
      state.closed++;
      return state.closeHangs ? new Promise<void>(() => {}) : Promise.resolve();
    },
    async kill() {
      state.killed++;
    },
  };
  return { session, calls, replies, commands, commandResults, state };
}

/** For models that must never reopen: a reset would be a test bug. The
 * initial open is served by modelWith, so this only covers the reopens. */
const noReopen = {
  openSession: async (): Promise<ChatSessionLike> => {
    throw new Error("not expected");
  },
};

/** A model over a first session plus a queue of sessions for reopens. */
async function harness(opts: { closeTimeoutMs?: number } = {}) {
  const first = fakeSession("a");
  const next: Array<ReturnType<typeof fakeSession> | Error> = [];
  const opened: number[] = [];
  const model = await modelWith(first.session, {
    closeTimeoutMs: opts.closeTimeoutMs ?? 20,
    openSession: async () => {
      opened.push(Date.now());
      const n = next.shift();
      if (n === undefined) throw new Error("no next session queued");
      if (n instanceof Error) throw n;
      return n.session;
    },
  });
  return { model, first, next, opened };
}

/** A fake command runner. `emit` appends output (as the throttled
 * onOutput would), `finish` settles `done`; `stop()` settles it as
 * interrupted with the output so far. */
function fakeRunner() {
  const calls: Array<{ command: string; cwd: string }> = [];
  let output = "";
  let resolve: ((r: ShellResult) => void) | undefined;
  let reject: ((e: unknown) => void) | undefined;
  let onOutput: ((t: string) => void) | undefined;
  const base = (command: string): ShellResult => ({
    command,
    output: "",
    droppedBytes: 0,
    exitCode: 0,
    interrupted: false,
    durationMs: 1,
  });
  let current = base("");
  const runCommand = (command: string, opts: RunOptions): RunningCommand => {
    calls.push({ command, cwd: opts.cwd });
    output = "";
    current = base(command);
    onOutput = opts.onOutput;
    const done = new Promise<ShellResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return {
      done,
      stop() {
        resolve?.({
          ...current,
          output,
          exitCode: undefined,
          interrupted: true,
        });
      },
    };
  };
  return {
    runCommand,
    calls,
    emit(text: string) {
      output += text;
      onOutput?.(output);
    },
    finish(over: Partial<ShellResult> = {}) {
      resolve?.({ ...current, output, ...over });
    },
    fail(err: unknown) {
      reject?.(err);
    },
  };
}

describe("ChatModel.submit", () => {
  test("user message, busy, then assistant message and idle", async () => {
    const { session, replies } = fakeSession();
    const model = await modelWith(session, noReopen);
    const changes: string[] = [];
    model.onChange = () => changes.push(model.status);

    const p = model.submit("hello");
    await tick();
    expect(model.status).toBe("busy");
    expect(model.messages).toEqual([{ role: "user", text: "hello" }]);
    replies[0]?.resolve("Echo: hello");
    await p;
    expect(model.status).toBe("idle");
    expect(model.messages[1]).toEqual({
      role: "assistant",
      text: "Echo: hello",
    });
    expect(changes).toEqual(["busy", "idle"]);
  });

  test("trims the prompt and ignores blank input", async () => {
    const { session, calls, replies } = fakeSession();
    const model = await modelWith(session, noReopen);
    await model.submit("   \n  ");
    expect(calls).toEqual([]);
    expect(model.messages).toEqual([]);
    const p = model.submit("  hi \n");
    await tick();
    replies[0]?.resolve("ok");
    await p;
    expect(calls).toEqual(["hi"]);
  });

  test("queues input while busy instead of sending it", async () => {
    const { session, calls, replies } = fakeSession();
    const model = await modelWith(session, noReopen);
    const p = model.submit("one");
    await tick();
    await model.submit("two");
    expect(calls).toEqual(["one"]);
    expect(model.queue).toEqual(["two"]);
    replies[0]?.resolve("ok");
    await p;
    await tick();
    // The turn end drains the entry, so it is sent without another Enter.
    expect(calls).toEqual(["one", "two"]);
    expect(model.queue).toEqual([]);
    replies[1]?.resolve("ok");
  });

  test("timeout becomes an error message; model stays usable", async () => {
    const { session, calls, replies } = fakeSession();
    const model = await modelWith(session, noReopen);
    const p = model.submit("one");
    await tick();
    replies[0]?.reject(
      new ResponseTimeoutError("Timed out during waitForResponse after 10 ms."),
    );
    await p;
    expect(model.status).toBe("idle");
    expect(model.fatal).toBeUndefined();
    expect(model.messages[1]).toEqual({
      role: "error",
      text: "Timed out during waitForResponse after 10 ms.",
    });
    const q = model.submit("two");
    await tick();
    replies[1]?.resolve("Echo: two");
    await q;
    expect(calls).toEqual(["one", "two"]);
  });

  test("any other error is shown and stored as fatal; further input ignored", async () => {
    const { session, calls, replies } = fakeSession();
    const model = await modelWith(session, noReopen);
    const boom = new Error("page closed");
    const p = model.submit("one");
    await tick();
    replies[0]?.reject(boom);
    await p;
    expect(model.fatal).toBe(boom);
    expect(model.status).toBe("dead");
    expect(model.messages[1]).toEqual({ role: "error", text: "page closed" });
    await model.submit("two");
    expect(model.queue).toEqual(["two"]);
    expect(calls).toEqual(["one"]);
  });

  test("resolves true when accepted and false when ignored", async () => {
    const { session, replies } = fakeSession();
    const model = await modelWith(session, noReopen);
    expect(await model.submit("   ")).toBe(false);
    const p = model.submit("one");
    await tick();
    expect(await model.submit("two")).toBe(true); // busy: queued
    replies[0]?.resolve("ok");
    expect(await p).toBe(true);
  });

  test("sends the expanded prompt and records attachments on the user message", async () => {
    const { session, calls, replies } = fakeSession();
    const model = await modelWith(session, {
      ...noReopen,
      expand: async (text) => ({
        prompt: `${text}\n\n### a.ts\n\`\`\`ts\nx\n\`\`\``,
        attachments: [{ path: "a.ts", bytes: 2 }],
      }),
    });
    const p = model.submit("look @a.ts");
    await tick();
    replies[0]?.resolve("ok");
    expect(await p).toBe(true);
    expect(calls).toEqual(["look @a.ts\n\n### a.ts\n```ts\nx\n```"]);
    expect(model.messages[0]).toEqual({
      role: "user",
      text: "look @a.ts",
      attachments: [{ path: "a.ts", bytes: 2 }],
    });
  });

  test("omits the attachments key when there are none", async () => {
    const { session, replies } = fakeSession();
    const model = await modelWith(session, noReopen);
    const p = model.submit("hello");
    await tick();
    replies[0]?.resolve("ok");
    await p;
    expect(model.messages[0]).toEqual({ role: "user", text: "hello" });
  });

  test("a MentionError shows the problems, sends nothing, stays idle and not fatal", async () => {
    const { session, calls } = fakeSession();
    const model = await modelWith(session, {
      ...noReopen,
      expand: async () => {
        throw new MentionError(["@x: not found", "@d: is a directory"]);
      },
    });
    const changes: string[] = [];
    model.onChange = () => changes.push(model.status);
    expect(await model.submit("@x @d")).toBe(false);
    expect(calls).toEqual([]);
    expect(model.messages).toEqual([
      { role: "error", text: "@x: not found\n@d: is a directory" },
    ]);
    expect(model.status).toBe("idle");
    expect(model.fatal).toBeUndefined();
    expect(changes).toEqual(["idle"]);
  });

  test("a non-Mention error from expand is fatal", async () => {
    const { session, calls } = fakeSession();
    const boom = new Error("disk on fire");
    const model = await modelWith(session, {
      ...noReopen,
      expand: async () => {
        throw boom;
      },
    });
    expect(await model.submit("@x")).toBe(false);
    expect(calls).toEqual([]);
    expect(model.messages).toEqual([{ role: "error", text: "disk on fire" }]);
    expect(model.fatal).toBe(boom);
  });

  test("a second submit issued while mentions expand is rejected", async () => {
    const { session, calls, replies } = fakeSession();
    const model = await modelWith(session, {
      ...noReopen,
      expand: async (text) => {
        await tick();
        return { prompt: text, attachments: [] };
      },
    });
    const first = model.submit("one");
    const second = model.submit("two"); // same tick, expansion still pending
    expect(await second).toBe(true); // busy: queued
    expect(model.queue).toEqual(["two"]);
    await tick();
    expect(calls).toEqual(["one"]);
    replies[0]?.resolve("ok");
    expect(await first).toBe(true);
    expect(model.messages).toEqual([
      { role: "user", text: "one" },
      { role: "assistant", text: "ok" },
    ]);
  });
});

describe("ChatModel.reset", () => {
  test("idle: closes the old session, opens a new one, adds a separator", async () => {
    const h = await harness();
    const b = fakeSession("b");
    h.next.push(b);
    const changes: string[] = [];
    h.model.onChange = () => changes.push(h.model.status);

    await h.model.reset();

    expect(h.first.state.closed).toBe(1);
    expect(h.first.state.killed).toBe(0);
    expect(h.model.session).toBe(b.session);
    expect(h.model.status).toBe("idle");
    expect(h.model.fatal).toBeUndefined();
    expect(h.model.messages).toEqual([{ role: "separator", text: "reopened" }]);
    expect(changes).toEqual(["resetting", "idle"]);

    const p = h.model.submit("after");
    await tick();
    b.replies[0]?.resolve("ok");
    await p;
    expect(b.calls).toEqual(["b:after"]);
    expect(h.first.calls).toEqual([]);
  });

  test("busy: the stale send's result is dropped after the reset", async () => {
    const h = await harness();
    const b = fakeSession("b");
    h.next.push(b);
    const p = h.model.submit("hang");
    await tick();
    expect(h.model.status).toBe("busy");

    await h.model.reset();
    expect(h.model.status).toBe("idle");
    expect(h.model.messages.map((m) => m.role)).toEqual(["user", "separator"]);

    // The old turn settles late: nothing must change.
    h.first.replies[0]?.resolve("late reply");
    await p;
    expect(h.model.status).toBe("idle");
    expect(h.model.messages.map((m) => m.role)).toEqual(["user", "separator"]);
  });

  test("busy: a stale send's error is dropped and does not mark dead", async () => {
    const h = await harness();
    h.next.push(fakeSession("b"));
    const p = h.model.submit("hang");
    await tick();
    await h.model.reset();
    h.first.replies[0]?.reject(new Error("Target page has been closed"));
    await p;
    expect(h.model.status).toBe("idle");
    expect(h.model.fatal).toBeUndefined();
    expect(h.model.messages.map((m) => m.role)).toEqual(["user", "separator"]);
  });

  test("kills the old session when close exceeds the cap", async () => {
    const h = await harness({ closeTimeoutMs: 20 });
    h.first.state.closeHangs = true;
    h.next.push(fakeSession("b"));
    await h.model.reset();
    expect(h.first.state.closed).toBe(1);
    expect(h.first.state.killed).toBe(1);
    expect(h.model.status).toBe("idle");
  });

  test("dead: reset recovers and clears fatal", async () => {
    const h = await harness();
    const boom = new Error("page closed");
    const p = h.model.submit("one");
    await tick();
    h.first.replies[0]?.reject(boom);
    await p;
    expect(h.model.status).toBe("dead");
    expect(h.model.fatal).toBe(boom);

    h.next.push(fakeSession("b"));
    await h.model.reset();
    expect(h.model.status).toBe("idle");
    expect(h.model.fatal).toBeUndefined();
    expect(h.model.messages.map((m) => m.role)).toEqual([
      "user",
      "error",
      "separator",
    ]);
  });

  test("a failing reopen shows the error and returns to dead", async () => {
    const h = await harness();
    const boom = new Error("Auth state is no longer valid");
    h.next.push(boom);
    const changes: string[] = [];
    h.model.onChange = () => changes.push(h.model.status);
    await h.model.reset();
    expect(h.model.status).toBe("dead");
    expect(h.model.fatal).toBe(boom);
    expect(h.model.messages).toEqual([
      { role: "error", text: "Auth state is no longer valid" },
    ]);
    expect(changes).toEqual(["resetting", "dead"]);
    // The old session is still closed; nothing is left dangling.
    expect(h.first.state.closed).toBe(1);
    expect(await h.model.submit("x")).toBe(true); // dead: queued
    expect(h.model.queue).toEqual(["x"]);
  });

  test("reset while resetting is ignored", async () => {
    const h = await harness();
    const gate = deferred<void>();
    const b = fakeSession("b");
    const model = await modelWith(h.first.session, {
      closeTimeoutMs: 20,
      openSession: async () => {
        await gate.promise;
        return b.session;
      },
    });
    const r1 = model.reset();
    await tick();
    expect(model.status).toBe("resetting");
    const r2 = model.reset();
    gate.resolve();
    await Promise.all([r1, r2]);
    expect(h.first.state.closed).toBe(1);
    expect(model.messages).toEqual([{ role: "separator", text: "reopened" }]);
  });

  test("submit while resetting is queued and drained by the reset", async () => {
    const h = await harness();
    const gate = deferred<void>();
    const b = fakeSession("b");
    const model = await modelWith(h.first.session, {
      closeTimeoutMs: 20,
      openSession: async () => {
        await gate.promise;
        return b.session;
      },
    });
    const r = model.reset();
    await tick();
    expect(await model.submit("x")).toBe(true);
    expect(model.queue).toEqual(["x"]);
    gate.resolve();
    await r;
    await tick();
    // Nothing reached the old session; the new one gets it once reset ends.
    expect(h.first.calls).toEqual([]);
    expect(b.calls).toEqual(["b:x"]);
    b.replies[0]?.resolve("ok");
  });

  test("pendingReset is defined while resetting and undefined after", async () => {
    const h = await harness();
    const gate = deferred<void>();
    const b = fakeSession("b");
    const model = await modelWith(h.first.session, {
      closeTimeoutMs: 20,
      openSession: async () => {
        await gate.promise;
        return b.session;
      },
    });
    expect(model.pendingReset).toBeUndefined();
    const r = model.reset();
    expect(model.pendingReset).toBeDefined();
    await tick();
    expect(model.pendingReset).toBeDefined();
    gate.resolve();
    await r;
    expect(model.pendingReset).toBeUndefined();
    // Awaiting the exposed promise is enough to see the new session.
    expect(model.session).toBe(b.session);
  });
});

describe("ChatModel.runShell", () => {
  test("running, live output, then autoSend sends the lead-in and section", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = await modelWith(session, {
      ...noReopen,
      runCommand: runner.runCommand,
      cwd: "/work",
    });
    const changes: string[] = [];
    model.onChange = () => changes.push(model.status);

    const p = model.runShell("  echo hi  ");
    await tick();
    expect(model.status).toBe("running");
    expect(runner.calls).toEqual([{ command: "echo hi", cwd: "/work" }]);
    expect(model.messages[0]).toMatchObject({
      role: "shell",
      text: "echo hi",
      result: { command: "echo hi", output: "", interrupted: false },
    });

    runner.emit("hi\n");
    expect(model.messages[0]?.result?.output).toBe("hi\n");
    expect(changes).toEqual(["running", "running"]);

    runner.finish({ exitCode: 0 });
    await tick();
    expect(model.status).toBe("busy");
    expect(calls).toEqual([
      "Please check the execution result.\n\n### $ echo hi\n```\nhi\n```",
    ]);
    // No user entry: the shell entry stands for the turn.
    expect(model.messages.map((m) => m.role)).toEqual(["shell"]);

    replies[0]?.resolve("Looks fine.");
    expect(await p).toBe(true);
    expect(model.status).toBe("idle");
    expect(model.messages[1]).toEqual({
      role: "assistant",
      text: "Looks fine.",
    });
    expect(model.messages[0]?.result).toMatchObject({
      output: "hi\n",
      exitCode: 0,
    });
    expect(changes).toEqual(["running", "running", "busy", "idle"]);
  });

  test("uses the configured lead-in", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = await modelWith(session, {
      ...noReopen,
      runCommand: runner.runCommand,
      shell: { leadIn: "Check:", autoSend: true },
    });
    const p = model.runShell("true");
    await tick();
    runner.finish();
    await tick();
    expect(calls[0]).toStartWith("Check:\n\n### $ true\n");
    replies[0]?.resolve("ok");
    await p;
  });

  test("blank command and non-idle states are rejected", async () => {
    const { session, replies } = fakeSession();
    const runner = fakeRunner();
    const model = await modelWith(session, {
      ...noReopen,
      runCommand: runner.runCommand,
    });
    expect(await model.runShell("   ")).toBe(false);
    const p = model.runShell("sleep");
    await tick();
    expect(await model.runShell("other")).toBe(false); // running
    // A message typed meanwhile is queued; only a command is dropped.
    expect(await model.submit("hello")).toBe(true); // running: queued
    expect(model.takeBack()).toEqual(["hello"]);
    runner.finish();
    await tick();
    expect(model.status).toBe("busy");
    expect(await model.runShell("other")).toBe(false); // busy
    replies[0]?.resolve("ok");
    await p;
    expect(runner.calls.map((c) => c.command)).toEqual(["sleep"]);
  });

  test("autoSend off: the result is held and attached to the next submit", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = await modelWith(session, {
      ...noReopen,
      runCommand: runner.runCommand,
      shell: { leadIn: "unused", autoSend: false },
    });
    const changes: string[] = [];
    model.onChange = () => changes.push(model.status);

    const p = model.runShell("ls");
    await tick();
    runner.emit("a.ts\n");
    runner.finish({ exitCode: 1 });
    expect(await p).toBe(true);
    expect(model.status).toBe("idle");
    expect(calls).toEqual([]);
    expect(model.heldResults).toHaveLength(1);
    expect(model.messages[0]).toMatchObject({ role: "shell", held: true });
    expect(changes).toEqual(["running", "running", "idle"]);

    const q = model.submit("what is this?");
    await tick();
    replies[0]?.resolve("ok");
    await q;
    expect(calls).toEqual([
      "what is this?\n\n### $ ls\n```\na.ts\n```\nexit code: 1",
    ]);
    expect(model.heldResults).toEqual([]);
    expect(model.messages[0]?.held).toBe(false);
    expect(model.messages[1]).toEqual({ role: "user", text: "what is this?" });
  });

  test("several held results go out in order after the expanded prompt", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = await modelWith(session, {
      ...noReopen,
      runCommand: runner.runCommand,
      shell: { leadIn: "x", autoSend: false },
      expand: async (text) => ({
        prompt: `${text}\n\n### a.ts\n\`\`\`ts\nx\n\`\`\``,
        attachments: [{ path: "a.ts", bytes: 2 }],
      }),
    });
    let p = model.runShell("one");
    await tick();
    runner.finish();
    await p;
    p = model.runShell("two");
    await tick();
    runner.finish();
    await p;
    expect(model.heldResults.map((r) => r.command)).toEqual(["one", "two"]);

    const q = model.submit("see @a.ts");
    await tick();
    replies[0]?.resolve("ok");
    await q;
    expect(calls).toEqual([
      "see @a.ts\n\n### a.ts\n```ts\nx\n```\n\n### $ one\n```\n```\n\n### $ two\n```\n```",
    ]);
  });

  test("a MentionError keeps the held results", async () => {
    const { session, calls } = fakeSession();
    const runner = fakeRunner();
    const model = await modelWith(session, {
      ...noReopen,
      runCommand: runner.runCommand,
      shell: { leadIn: "x", autoSend: false },
      expand: async () => {
        throw new MentionError(["@x: not found"]);
      },
    });
    const p = model.runShell("ls");
    await tick();
    runner.finish();
    await p;
    expect(await model.submit("@x")).toBe(false);
    expect(calls).toEqual([]);
    expect(model.heldResults).toHaveLength(1);
    expect(model.messages[0]?.held).toBe(true);
  });

  test("a timeout keeps the held results for the retry", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = await modelWith(session, {
      ...noReopen,
      runCommand: runner.runCommand,
      shell: { leadIn: "unused", autoSend: false },
    });
    const p = model.runShell("npm test");
    await tick();
    runner.emit("FAIL\n");
    runner.finish({ exitCode: 1 });
    await p;

    const first = model.submit("why did it fail?");
    await tick();
    // Still held while the send is in flight …
    expect(model.heldResults).toHaveLength(1);
    expect(model.messages[0]?.held).toBe(true);
    replies[0]?.reject(new ResponseTimeoutError("Timed out after 10 ms."));
    await first;
    expect(model.status).toBe("idle");
    // … and after a recoverable failure, so the retry carries them.
    expect(model.heldResults).toHaveLength(1);
    expect(model.messages[0]?.held).toBe(true);

    const second = model.submit("why did it fail?");
    await tick();
    replies[1]?.resolve("because");
    await second;
    const section = "### $ npm test\n```\nFAIL\n```\nexit code: 1";
    expect(calls).toEqual([
      `why did it fail?\n\n${section}`,
      `why did it fail?\n\n${section}`,
    ]);
    expect(model.heldResults).toEqual([]);
    expect(model.messages[0]?.held).toBe(false);
  });

  test("a fatal send failure keeps the held results for after a reset", async () => {
    const first = fakeSession("a");
    const second = fakeSession("b");
    const runner = fakeRunner();
    const model = await modelWith(first.session, {
      closeTimeoutMs: 20,
      openSession: async () => second.session,
      runCommand: runner.runCommand,
      shell: { leadIn: "unused", autoSend: false },
    });
    const p = model.runShell("ls");
    await tick();
    runner.finish();
    await p;

    const q = model.submit("hi");
    await tick();
    first.replies[0]?.reject(new Error("page closed"));
    await q;
    expect(model.status).toBe("dead");
    expect(model.heldResults).toHaveLength(1);

    await model.reset();
    const r = model.submit("hi again");
    await tick();
    second.replies[0]?.resolve("ok");
    await r;
    expect(second.calls).toEqual(["b:hi again\n\n### $ ls\n```\n```"]);
    expect(model.heldResults).toEqual([]);
    expect(model.messages[0]?.held).toBe(false);
  });

  test("stopShell settles the command as interrupted and still sends", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = await modelWith(session, {
      ...noReopen,
      runCommand: runner.runCommand,
    });
    model.stopShell(); // idle: no-op
    const p = model.runShell("sleep 10");
    await tick();
    runner.emit("partial");
    model.stopShell();
    await tick();
    expect(model.status).toBe("busy");
    expect(calls[0]).toEndWith(
      "### $ sleep 10\n```\npartial\n```\ninterrupted",
    );
    replies[0]?.resolve("ok");
    await p;
    expect(model.messages[0]?.result?.interrupted).toBe(true);
  });

  test("a shell that cannot start is an error entry, not fatal", async () => {
    const { session, calls } = fakeSession();
    const runner = fakeRunner();
    const model = await modelWith(session, {
      ...noReopen,
      runCommand: runner.runCommand,
    });
    const p = model.runShell("true");
    await tick();
    runner.fail(new Error("spawn /no/sh ENOENT"));
    expect(await p).toBe(true);
    expect(model.status).toBe("idle");
    expect(model.fatal).toBeUndefined();
    expect(calls).toEqual([]);
    expect(model.messages.map((m) => m.role)).toEqual(["shell", "error"]);
    expect(model.messages[0]).toMatchObject({ role: "shell", failed: true });
    expect(model.messages[1]?.text).toBe(
      "could not start shell: spawn /no/sh ENOENT",
    );
  });

  test("a shell that cannot start during a reset still marks its entry", async () => {
    const first = fakeSession("a");
    // A close that hangs keeps the reset in flight while we look at the
    // entry, so the repaint we assert is the failure's own, not the one
    // the finished reset would do anyway.
    first.state.closeHangs = true;
    const next = fakeSession("b");
    const runner = fakeRunner();
    const model = await modelWith(first.session, {
      openSession: async () => next.session,
      closeTimeoutMs: 20,
      runCommand: runner.runCommand,
    });
    const flags: Array<boolean | undefined> = [];
    model.onChange = () => flags.push(model.messages[0]?.failed);

    const p = model.runShell("true");
    await tick();
    // The rejection settles `done` before reset()'s stopShell() can, and
    // reset() bumps the generation synchronously while the rejection is
    // still a queued microtask: the catch takes the stale branch.
    runner.fail(new Error("spawn /no/sh ENOENT"));
    const reset = model.reset();
    expect(await p).toBe(true);
    expect(model.messages[0]).toMatchObject({ role: "shell", failed: true });
    expect(flags.at(-1)).toBe(true); // the view was told, reset or not
    await reset;
    // Nothing else is said: the reset owns the rest of the screen.
    expect(model.messages.map((m) => m.role)).toEqual(["shell", "separator"]);
    expect(model.fatal).toBeUndefined();
  });

  test("send failures after a command behave like submit", async () => {
    const { session, replies } = fakeSession();
    const runner = fakeRunner();
    const model = await modelWith(session, {
      ...noReopen,
      runCommand: runner.runCommand,
    });
    const p = model.runShell("true");
    await tick();
    runner.finish();
    await tick();
    replies[0]?.reject(new ResponseTimeoutError("Timed out after 10 ms."));
    await p;
    expect(model.status).toBe("idle");
    expect(model.messages.map((m) => m.role)).toEqual(["shell", "error"]);

    const q = model.runShell("true");
    await tick();
    runner.finish();
    await tick();
    const boom = new Error("page closed");
    replies[1]?.reject(boom);
    await q;
    expect(model.status).toBe("dead");
    expect(model.fatal).toBe(boom);
  });

  test("reset while running stops the command; its output is not sent; held results survive", async () => {
    const h = await harness();
    const runner = fakeRunner();
    const model = await modelWith(h.first.session, {
      closeTimeoutMs: 20,
      openSession: async () => fakeSession("b").session,
      runCommand: runner.runCommand,
      shell: { leadIn: "x", autoSend: false },
    });
    // One held result first.
    let p = model.runShell("one");
    await tick();
    runner.finish();
    await p;
    expect(model.heldResults).toHaveLength(1);

    p = model.runShell("sleep 10");
    await tick();
    runner.emit("partial");
    await model.reset();
    await p;
    expect(model.status).toBe("idle");
    expect(h.first.calls).toEqual([]);
    expect(model.heldResults).toHaveLength(1); // the stopped one was not held
    const shell = model.messages.filter((m) => m.role === "shell");
    expect(shell[1]?.result).toMatchObject({
      output: "partial",
      interrupted: true,
    });
    expect(model.messages.map((m) => m.role)).toEqual([
      "shell",
      "shell",
      "separator",
    ]);
  });

  test("a stale run settling later does not clear the current command's handle", async () => {
    // The real stop() does not settle `done` synchronously: it sends
    // SIGTERM and settles when the child's `close` arrives. So a command
    // stopped by a reset can settle after the next one has started.
    const handles: Array<{ command: string; stops: number }> = [];
    const runCommand = (command: string): RunningCommand => {
      const d = deferred<ShellResult>();
      const handle = { command, stops: 0 };
      handles.push(handle);
      return {
        done: d.promise,
        stop() {
          handle.stops++;
          setTimeout(
            () =>
              d.resolve({
                command,
                output: "",
                droppedBytes: 0,
                exitCode: undefined,
                interrupted: true,
                durationMs: 1,
              }),
            0,
          );
        },
      };
    };
    const model = await modelWith(fakeSession("a").session, {
      closeTimeoutMs: 20,
      openSession: async () => fakeSession("b").session,
      runCommand,
      shell: { leadIn: "x", autoSend: false },
    });

    const first = model.runShell("sleep 10");
    await tick();
    await model.reset();
    expect(model.status).toBe("idle");
    const second = model.runShell("sleep 20");
    expect(model.status).toBe("running");
    // The first command's settlement lands now, after the second took over.
    await tick();
    await first;

    model.stopShell();
    expect(handles.map((h) => h.stops)).toEqual([1, 1]);
    await tick();
    expect(await second).toBe(true);
    expect(model.status).toBe("idle");
    const shell = model.messages.filter((m) => m.role === "shell");
    expect(shell[1]?.result).toMatchObject({
      command: "sleep 20",
      interrupted: true,
    });
  });
});

describe("ChatModel queue", () => {
  test("submit while busy queues the text and resolves true", async () => {
    const { session, calls, replies } = fakeSession();
    const model = await modelWith(session, noReopen);
    const changes: string[] = [];
    model.onChange = () =>
      changes.push(`${model.status}:${model.queue.length}`);
    const p = model.submit("one");
    await tick();
    expect(await model.submit("  two  ")).toBe(true);
    expect(model.queue).toEqual(["two"]);
    expect(calls).toEqual(["one"]);
    expect(changes.at(-1)).toBe("busy:1");
    replies[0]?.resolve("ok");
    await p;
  });

  test("blank input is still ignored while busy", async () => {
    const { session, replies } = fakeSession();
    const model = await modelWith(session, noReopen);
    const p = model.submit("one");
    await tick();
    expect(await model.submit("   ")).toBe(false);
    expect(model.queue).toEqual([]);
    replies[0]?.resolve("ok");
    await p;
  });

  test("submit while dead queues; nothing is sent", async () => {
    const { session, calls, replies } = fakeSession();
    const model = await modelWith(session, noReopen);
    const p = model.submit("one");
    await tick();
    replies[0]?.reject(new Error("boom"));
    await p;
    expect(model.status).toBe("dead");
    expect(await model.submit("later")).toBe(true);
    expect(model.queue).toEqual(["later"]);
    expect(calls).toEqual(["one"]);
  });

  test("takeBack returns the entries in order and empties the queue", async () => {
    const { session, replies } = fakeSession();
    const model = await modelWith(session, noReopen);
    const p = model.submit("one");
    await tick();
    await model.submit("two");
    await model.submit("three");
    let changes = 0;
    model.onChange = () => changes++;
    expect(model.takeBack()).toEqual(["two", "three"]);
    expect(model.queue).toEqual([]);
    expect(changes).toBe(1);
    expect(model.takeBack()).toEqual([]);
    expect(changes).toBe(1);
    replies[0]?.resolve("ok");
    await p;
  });

  test("turn end sends the oldest entry; the next waits for the next end", async () => {
    const { session, calls, replies } = fakeSession();
    const model = await modelWith(session, noReopen);
    const statuses: string[] = [];
    model.onChange = () => statuses.push(model.status);
    const p = model.submit("one");
    await tick();
    await model.submit("two");
    await model.submit("three");
    replies[0]?.resolve("r1");
    await p;
    await tick();
    expect(calls).toEqual(["one", "two"]);
    expect(model.queue).toEqual(["three"]);
    expect(model.status).toBe("busy");
    // Never idle with a queue waiting: busy stays busy across the boundary.
    expect(statuses).not.toContain("idle");
    replies[1]?.resolve("r2");
    await tick();
    await tick();
    expect(calls).toEqual(["one", "two", "three"]);
    expect(model.queue).toEqual([]);
    replies[2]?.resolve("r3");
    await tick();
    await tick();
    expect(model.status).toBe("idle");
    expect(model.messages.map((m) => m.text)).toEqual([
      "one",
      "r1",
      "two",
      "r2",
      "three",
      "r3",
    ]);
  });

  test("a timeout still drains the queue", async () => {
    const { session, calls, replies } = fakeSession();
    const model = await modelWith(session, noReopen);
    const p = model.submit("one");
    await tick();
    await model.submit("two");
    replies[0]?.reject(new ResponseTimeoutError("slow"));
    await p;
    await tick();
    expect(calls).toEqual(["one", "two"]);
    expect(model.status).toBe("busy");
    replies[1]?.resolve("ok");
  });

  test("a mention error on a dequeued entry puts it back in front and pauses", async () => {
    const { session, calls, replies } = fakeSession();
    const model = await modelWith(session, {
      ...noReopen,
      expand: async (text) => {
        if (text === "bad") throw new MentionError(["no such file"]);
        return { prompt: text, attachments: [] };
      },
    });
    const p = model.submit("one");
    await tick();
    await model.submit("bad");
    await model.submit("good");
    replies[0]?.resolve("r1");
    await p;
    await tick();
    await tick();
    expect(model.status).toBe("idle");
    expect(model.queue).toEqual(["bad", "good"]);
    expect(calls).toEqual(["one"]);
    expect(model.messages.at(-1)?.role).toBe("error");
    // The user sends something by hand; when that turn ends draining resumes
    // and hits the same entry again (once per turn end, never a loop).
    const q = model.submit("manual");
    await tick();
    replies[1]?.resolve("r2");
    await q;
    await tick();
    await tick();
    expect(calls).toEqual(["one", "manual"]);
    expect(model.queue).toEqual(["bad", "good"]);
    expect(model.messages.filter((m) => m.role === "error")).toHaveLength(2);
  });

  test("a fatal error keeps the queue and sends nothing", async () => {
    const { session, calls, replies } = fakeSession();
    const model = await modelWith(session, noReopen);
    const p = model.submit("one");
    await tick();
    await model.submit("two");
    replies[0]?.reject(new Error("boom"));
    await p;
    await tick();
    expect(model.status).toBe("dead");
    expect(model.queue).toEqual(["two"]);
    expect(calls).toEqual(["one"]);
  });

  test("a successful reset drains the queue into the new session", async () => {
    const h = await harness();
    const b = fakeSession("b");
    h.next.push(b);
    const p = h.model.submit("hang");
    await tick();
    await h.model.submit("queued");
    await h.model.reset();
    await tick();
    expect(h.model.status).toBe("busy");
    expect(b.calls).toEqual(["b:queued"]);
    expect(h.model.queue).toEqual([]);
    // The stale turn settles late and changes nothing.
    h.first.replies[0]?.resolve("late");
    await p;
    expect(h.model.messages.map((m) => m.role)).toEqual([
      "user",
      "separator",
      "user",
    ]);
    b.replies[0]?.resolve("ok");
  });

  test("a failed reset keeps the queue", async () => {
    const h = await harness();
    h.next.push(new Error("cannot open"));
    const p = h.model.submit("hang");
    await tick();
    await h.model.submit("queued");
    await h.model.reset();
    expect(h.model.status).toBe("dead");
    expect(h.model.queue).toEqual(["queued"]);
    h.first.replies[0]?.resolve("late");
    await p;
  });
});

describe("ChatModel shell mode × queue", () => {
  test("a message typed while a command runs is sent after its turn", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = await modelWith(session, {
      ...noReopen,
      runCommand: runner.runCommand,
    });
    const p = model.runShell("ls");
    await tick();
    expect(model.status).toBe("running");
    expect(await model.submit("  and then?  ")).toBe(true);
    expect(model.queue).toEqual(["and then?"]);
    expect(calls).toEqual([]);

    // The command's own turn goes out first; the queue waits for its end.
    runner.finish({ exitCode: 0 });
    await tick();
    expect(model.status).toBe("busy");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toStartWith("Please check the execution result.");
    expect(model.queue).toEqual(["and then?"]);

    replies[0]?.resolve("Looks fine.");
    expect(await p).toBe(true);
    await tick();
    expect(calls).toEqual([
      "Please check the execution result.\n\n### $ ls\n```\n```",
      "and then?",
    ]);
    expect(model.queue).toEqual([]);
    // Never idle with an entry still waiting.
    expect(model.status).toBe("busy");
    replies[1]?.resolve("ok");
    await tick();
    expect(model.status).toBe("idle");
    expect(model.messages.map((m) => m.role)).toEqual([
      "shell",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  test("autoSend off: a queued entry drains and carries the held section", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = await modelWith(session, {
      ...noReopen,
      runCommand: runner.runCommand,
      shell: { leadIn: "unused", autoSend: false },
    });
    const p = model.runShell("ls");
    await tick();
    expect(await model.submit("what is this?")).toBe(true);
    expect(model.queue).toEqual(["what is this?"]);

    runner.emit("a.ts\n");
    runner.finish({ exitCode: 1 });
    expect(await p).toBe(true);
    await tick();
    // The held result is attached to the drained entry, exactly as it
    // would be to a message typed after the command finished.
    expect(calls).toEqual([
      "what is this?\n\n### $ ls\n```\na.ts\n```\nexit code: 1",
    ]);
    expect(model.queue).toEqual([]);
    // Still held while that send is in flight; released with the reply, so
    // a send that fails leaves them for the next message.
    expect(model.heldResults).toHaveLength(1);
    expect(model.messages[0]?.held).toBe(true);
    expect(model.status).toBe("busy");
    replies[0]?.resolve("ok");
    await tick();
    expect(model.status).toBe("idle");
    expect(model.heldResults).toEqual([]);
    expect(model.messages[0]?.held).toBe(false);
  });

  test("runShell while busy is rejected and queues nothing", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = await modelWith(session, {
      ...noReopen,
      runCommand: runner.runCommand,
    });
    const p = model.submit("hello");
    await tick();
    expect(model.status).toBe("busy");
    expect(await model.runShell("ls")).toBe(false);
    expect(model.queue).toEqual([]);
    expect(runner.calls).toEqual([]);
    replies[0]?.resolve("ok");
    expect(await p).toBe(true);
    await tick();
    expect(model.status).toBe("idle");
    expect(calls).toEqual(["hello"]);
    expect(model.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("startup", () => {
  test("opens eagerly: status opening, then idle; input typed meanwhile drains", async () => {
    const open = deferred<ChatSessionLike>();
    const s = fakeSession();
    const model = new ChatModel({
      openSession: () => open.promise,
      login: async () => {},
      clearAuth: async () => {},
      expand: async (t) => ({ prompt: t, attachments: [] }),
    });
    expect(model.status).toBe("opening");
    expect(await model.submit("hi")).toBe(true);
    expect(model.queue).toEqual(["hi"]);
    open.resolve(s.session);
    await model.ready;
    await tick();
    expect(s.calls).toEqual(["hi"]);
  });

  test("a reset while the first open is in flight wins; the late session is closed", async () => {
    const open = deferred<ChatSessionLike>();
    const first = fakeSession("a");
    const b = fakeSession("b");
    let n = 0;
    const model = new ChatModel({
      openSession: () =>
        n++ === 0 ? open.promise : Promise.resolve(b.session),
      login: async () => {},
      clearAuth: async () => {},
      closeTimeoutMs: 20,
    });
    const reset = model.reset();
    open.resolve(first.session);
    await model.ready;
    await reset;
    expect(model.session).toBe(b.session);
    // Neither closed nor killed would mean a second live browser.
    expect(first.state.closed + first.state.killed).toBe(1);
    expect(model.status).toBe("idle");
  });

  test("a failed open is dead with the /login hint for auth errors", async () => {
    const model = new ChatModel({
      openSession: async () => {
        throw new AuthRequiredError("not logged in");
      },
      login: async () => {},
      clearAuth: async () => {},
    });
    await model.ready;
    expect(model.status).toBe("dead");
    expect(model.messages.at(-1)).toEqual({
      role: "error",
      text: "not logged in\nType /login to log in.",
    });
  });

  test("BLOCKED gets the --headful hint", async () => {
    const model = new ChatModel({
      openSession: async () => {
        throw new BlockedError('Blocked by "x": challenge page.');
      },
      login: async () => {},
      clearAuth: async () => {},
    });
    await model.ready;
    expect(model.messages.at(-1)?.text).toBe(
      'Blocked by "x": challenge page. Try --headful.',
    );
  });

  test("BROWSER_UNAVAILABLE gets the install hint", async () => {
    const model = new ChatModel({
      openSession: async () => {
        throw new BrowserUnavailableError("no chromium");
      },
      login: async () => {},
      clearAuth: async () => {},
    });
    await model.ready;
    expect(model.messages.at(-1)?.text).toBe(
      "no chromium\nRun: npx playwright install chromium",
    );
  });
});

describe("slash commands", () => {
  test("/help pushes a help entry without sending", async () => {
    const s = fakeSession();
    const model = await modelWith(s.session);
    expect(await model.submit("/help")).toBe(true);
    expect(model.messages.at(-1)?.role).toBe("help");
    expect(s.calls).toEqual([]);
  });

  test("unknown command: error entry, text refused", async () => {
    const model = await modelWith(fakeSession().session);
    expect(await model.submit("/nope")).toBe(false);
    expect(model.messages.at(-1)).toEqual({
      role: "error",
      text: "Unknown command: /nope. Type /help.",
    });
  });

  test("/new resets with the `new chat` separator; /reopen with `reopened`", async () => {
    let n = 0;
    const a = fakeSession("a");
    const b = fakeSession("b");
    const c = fakeSession("c");
    const model = await modelWith(a.session, {
      closeTimeoutMs: 20,
      openSession: async () => (n++ === 0 ? b : c).session,
    });
    await model.submit("/new");
    expect(model.messages.at(-1)).toEqual({
      role: "separator",
      text: "new chat",
    });
    await model.submit("/reopen");
    expect(model.messages.at(-1)).toEqual({
      role: "separator",
      text: "reopened",
    });
  });

  test("/logout clears auth, then the reopen fails as dead", async () => {
    let cleared = 0;
    const a = fakeSession();
    const model = await modelWith(a.session, {
      closeTimeoutMs: 20,
      openSession: async () => {
        throw new AuthRequiredError("not logged in");
      },
      clearAuth: async () => {
        cleared++;
      },
    });
    await model.submit("/logout");
    expect(cleared).toBe(1);
    expect(model.messages.map((m) => m.text)).toContain("Logged out");
    expect(model.status).toBe("dead");
  });

  test("/logout leaves the session alone when clearing auth fails", async () => {
    const a = fakeSession();
    // modelWith refuses a reopen, so a reset here would be a test failure.
    const model = await modelWith(a.session, {
      clearAuth: async () => {
        throw new Error("EACCES: auth.json");
      },
    });
    await model.submit("/logout");
    expect(model.messages.at(-1)).toEqual({
      role: "error",
      text: "EACCES: auth.json",
    });
    expect(model.status).toBe("idle");
    expect(model.session).toBe(a.session);
  });

  test("a command runs while busy and is never queued", async () => {
    const s = fakeSession();
    const model = await modelWith(s.session, {
      expand: async (t) => ({ prompt: t, attachments: [] }),
    });
    void model.submit("x");
    await tick();
    await model.submit("/help");
    expect(model.queue).toEqual([]);
    expect(model.messages.at(-1)?.role).toBe("help");
  });
});

describe("/login", () => {
  test("success: Logged in separator, reset, queue drains", async () => {
    const a = fakeSession("a");
    const b = fakeSession("b");
    const login = deferred<void>();
    const model = await modelWith(a.session, {
      closeTimeoutMs: 20,
      openSession: async () => b.session,
      login: () => login.promise,
      expand: async (t) => ({ prompt: t, attachments: [] }),
    });
    const p = model.submit("/login");
    expect(model.status).toBe("logging-in");
    await model.submit("later");
    login.resolve();
    await p;
    await tick();
    expect(model.messages.map((m) => m.text)).toContain("Logged in");
    expect(model.messages.map((m) => m.text)).toContain("reopened");
    expect(b.calls).toEqual(["b:later"]);
  });

  test("a turn ending during /login keeps logging-in and holds the queue", async () => {
    const a = fakeSession("a");
    const login = deferred<void>();
    const model = await modelWith(a.session, {
      ...noReopen,
      login: () => login.promise,
      expand: async (t) => ({ prompt: t, attachments: [] }),
    });
    void model.submit("first");
    await tick();
    expect(model.status).toBe("busy");
    const p = model.submit("/login");
    expect(model.status).toBe("logging-in");
    await model.submit("queued");
    // The reply arrives while the login browser is still open.
    a.replies[0]?.resolve("r1");
    await tick();
    expect(model.status).toBe("logging-in");
    expect(model.queue).toEqual(["queued"]);
    expect(a.calls).toEqual(["a:first"]);
    // The login fails: the model goes to where the turn left it, not to the
    // `busy` it captured, and the queue moves again.
    login.reject(new Error("no browser"));
    await p;
    await tick();
    expect(model.status).toBe("busy");
    expect(model.queue).toEqual([]);
    expect(a.calls).toEqual(["a:first", "a:queued"]);
    a.replies[1]?.resolve("r2");
    await tick();
    expect(model.status).toBe("idle");
  });

  test("an autoSend shell result finishing during /login is held, not sent", async () => {
    const a = fakeSession("a");
    const b = fakeSession("b");
    const runner = fakeRunner();
    const login = deferred<void>();
    const model = await modelWith(a.session, {
      closeTimeoutMs: 20,
      openSession: async () => b.session,
      runCommand: runner.runCommand,
      shell: { leadIn: "Check:", autoSend: true },
      login: () => login.promise,
      expand: async (t) => ({ prompt: t, attachments: [] }),
    });
    const shell = model.runShell("ls");
    await tick();
    expect(model.status).toBe("running");
    const p = model.submit("/login");
    expect(model.status).toBe("logging-in");
    await model.submit("queued");
    runner.emit("a.ts\n");
    runner.finish({ exitCode: 0 });
    expect(await shell).toBe(true);
    // The login still owns the status and the browser window.
    expect(model.status).toBe("logging-in");
    expect(a.calls).toEqual([]);
    expect(model.heldResults).toHaveLength(1);
    expect(model.messages[0]).toMatchObject({ role: "shell", held: true });
    expect(model.queue).toEqual(["queued"]);

    login.resolve();
    await p;
    await tick();
    expect(model.messages.map((m) => m.text)).toContain("Logged in");
    expect(model.messages.map((m) => m.text)).toContain("reopened");
    // The queued message goes to the new session and carries the result.
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual(["b:queued\n\n### $ ls\n```\na.ts\n```"]);
  });

  test("cancel: Login cancelled, back to the previous status", async () => {
    const model = await modelWith(fakeSession().session, {
      login: ({ signal }) =>
        new Promise((_, rej) =>
          signal.addEventListener("abort", () => rej(new LoginAbortedError())),
        ),
    });
    const p = model.submit("/login");
    model.cancelLogin();
    await p;
    expect(model.status).toBe("idle");
    expect(model.messages.at(-1)).toEqual({
      role: "separator",
      text: "Login cancelled",
    });
  });

  test("failure: error entry, previous status kept; second /login while running is ignored", async () => {
    let calls = 0;
    const login = deferred<void>();
    const model = await modelWith(fakeSession().session, {
      login: () => {
        calls++;
        return login.promise;
      },
    });
    const p = model.submit("/login");
    await model.submit("/login");
    expect(calls).toBe(1);
    login.reject(new Error("idp down"));
    await p;
    expect(model.status).toBe("idle");
    expect(model.messages.at(-1)).toEqual({ role: "error", text: "idp down" });
  });

  test("a second /login leaves pendingLogin tracking the first one", async () => {
    const gate = deferred<void>();
    const model = await modelWith(fakeSession().session, {
      login: () => gate.promise,
      openSession: async () => fakeSession().session,
      closeTimeoutMs: 20,
    });
    const first = model.submit("/login");
    const tracked = model.pendingLogin;
    expect(tracked).toBeDefined();
    // The no-op second /login resolves at once; it must not take the slot.
    await model.submit("/login");
    expect(model.pendingLogin).toBe(tracked);
    let settled = false;
    void tracked?.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    gate.resolve();
    await first;
    await tracked;
    expect(settled).toBe(true);
    expect(model.pendingLogin).toBeUndefined();
  });

  test("open progress is exposed while the open runs and cleared after", async () => {
    const open = deferred<ChatSessionLike>();
    const s = fakeSession();
    const model = new ChatModel({
      openSession: (report) => {
        report("Opening browser... (attempt 2/2)");
        return open.promise;
      },
      login: async () => {},
      clearAuth: async () => {},
    });
    expect(model.status).toBe("opening");
    expect(model.openProgress).toBe("Opening browser... (attempt 2/2)");
    open.resolve(s.session);
    await model.ready;
    expect(model.openProgress).toBeUndefined();
  });

  test("open progress is cleared when the open fails", async () => {
    const model = new ChatModel({
      openSession: async (report) => {
        report("Opening browser... (attempt 2/2)");
        throw new Error("boom");
      },
      login: async () => {},
      clearAuth: async () => {},
    });
    await model.ready;
    expect(model.status).toBe("dead");
    expect(model.openProgress).toBeUndefined();
  });

  test("progress is exposed while the login runs and cleared after", async () => {
    const login = deferred<void>();
    const model = await modelWith(fakeSession().session, {
      login: ({ onProgress }) => {
        onProgress("Waiting for login...");
        return login.promise;
      },
      openSession: async () => fakeSession().session,
      closeTimeoutMs: 20,
    });
    const p = model.submit("/login");
    await tick();
    expect(model.loginProgress).toBe("Waiting for login...");
    login.resolve();
    await p;
    expect(model.loginProgress).toBeUndefined();
  });

  test("/login typed while opening waits for the open and returns to idle", async () => {
    const open = deferred<ChatSessionLike>();
    const s = fakeSession();
    const login = deferred<void>();
    const model = new ChatModel({
      openSession: () => open.promise,
      login: () => login.promise,
      clearAuth: async () => {},
    });
    const p = model.submit("/login");
    expect(model.status).toBe("opening");
    open.resolve(s.session);
    await model.ready;
    await tick();
    expect(model.status).toBe("logging-in");
    login.reject(new Error("idp down"));
    await p;
    // The settled open's status, never the `opening` it was typed from.
    expect(model.status).toBe("idle");
  });

  test("a /login typed during the post-login reset is ignored", async () => {
    let calls = 0;
    const b = fakeSession("b");
    const reopen = deferred<ChatSessionLike>();
    const model = await modelWith(fakeSession("a").session, {
      closeTimeoutMs: 20,
      openSession: () => reopen.promise,
      login: async () => {
        calls++;
      },
    });
    const p = model.submit("/login");
    await tick();
    await model.submit("/login");
    reopen.resolve(b.session);
    await p;
    expect(calls).toBe(1);
  });

  test("a reset while /login waits for the open cancels it instead of hanging", async () => {
    // The login is only started after the open settles; a reset that runs
    // in that window aborts the controller before the login can listen for
    // it, so the wait itself must notice the cancellation.
    const open = deferred<ChatSessionLike>();
    const a = fakeSession("a");
    const b = fakeSession("b");
    let calls = 0;
    const model = new ChatModel({
      closeTimeoutMs: 20,
      openSession: () => {
        calls++;
        return calls === 1 ? open.promise : Promise.resolve(b.session);
      },
      // Like runLogin: it only learns of an abort through the listener, so
      // a controller aborted before this call would never settle it.
      login: ({ signal }) =>
        new Promise<void>((_, rej) =>
          signal.addEventListener("abort", () => rej(new LoginAbortedError())),
        ),
      clearAuth: async () => {},
    });
    const p = model.submit("/login");
    expect(model.status).toBe("opening");
    const reset = model.reset();
    open.resolve(a.session);
    await reset;
    await p;
    expect(model.messages.some((m) => m.text === "Login cancelled")).toBe(true);
    expect(model.status).toBe("idle");
    expect(model.session).toBe(b.session);
    // The single-flight guard was released: a second /login still runs.
    const again = model.submit("/login");
    await tick();
    expect(model.status).toBe("logging-in");
    model.cancelLogin();
    await again;
  });

  test("a reset during /login cancels the login and wins", async () => {
    const b = fakeSession("b");
    const model = await modelWith(fakeSession("a").session, {
      closeTimeoutMs: 20,
      openSession: async () => b.session,
      login: ({ signal }) =>
        new Promise((_, rej) =>
          signal.addEventListener("abort", () => rej(new LoginAbortedError())),
        ),
    });
    const p = model.submit("/login");
    await model.reset();
    await p;
    expect(model.status).toBe("idle");
    expect(model.session).toBe(b.session);
  });
});

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
    nth(s.commandResults, 0).resolve({ kind: "show", text: "gpt-x" });
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
    nth(s.commandResults, 0).resolve({
      kind: "send",
      prompt: "Summarize: the doc",
    });
    await tick();
    expect(s.calls).toEqual(["Summarize: the doc"]);
    nth(s.replies, 0).resolve("done");
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
    s.replies[0]?.resolve("hi");
    await first;
    await tick();
    expect(s.commands).toEqual([{ name: "model", args: "" }]);
    nth(s.commandResults, 0).resolve({ kind: "show", text: "m" });
    await tick();
    expect(model.messages.at(-1)).toEqual({ role: "help", text: "m" });
  });

  test("a timeout shows the error and stays idle; another error is fatal", async () => {
    const s = fakeSession();
    const model = await modelWith(s.session, { ...noReopen, commands });
    let p = model.submit("/model");
    await tick();
    nth(s.commandResults, 0).reject(new ResponseTimeoutError("slow"));
    await p;
    expect(model.messages.at(-1)).toEqual({ role: "error", text: "slow" });
    expect(model.status).toBe("idle");
    p = model.submit("/model");
    await tick();
    nth(s.commandResults, 1).reject(new Error("page gone"));
    await p;
    expect(model.status).toBe("dead");
    expect(model.messages.at(-1)).toEqual({ role: "error", text: "page gone" });
  });

  test("a `send` carries the held shell results, released with the reply", async () => {
    const s = fakeSession();
    const runner = fakeRunner();
    const model = await modelWith(s.session, {
      ...noReopen,
      commands,
      runCommand: runner.runCommand,
      shell: { leadIn: "x", autoSend: false },
    });
    const shell = model.runShell("ls");
    await tick();
    runner.finish();
    await shell;
    expect(model.heldResults).toHaveLength(1);

    const p = model.submit("/summarize x");
    await tick();
    nth(s.commandResults, 0).resolve({ kind: "send", prompt: "Summarize: x" });
    await tick();
    expect(s.calls[0]).toBe("Summarize: x\n\n### $ ls\n```\n```");
    nth(s.replies, 0).resolve("ok");
    await p;
    expect(model.heldResults).toEqual([]);
    expect(model.messages[0]?.held).toBe(false);
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

describe("idle close", () => {
  /** A model whose opens hand back the idle-expiry callback of each session,
   * so the test can fire an expiry exactly as core would. */
  async function idleHarness(opts: Partial<ChatModelOptions> = {}) {
    const sessions = [fakeSession("a"), fakeSession("b")];
    const expire: Array<() => void> = [];
    let n = 0;
    const model = new ChatModel({
      login: async () => {},
      clearAuth: async () => {},
      closeTimeoutMs: 20,
      commands: [{ name: "model", description: "Show the model" }],
      ...opts,
      openSession: async (_report, onIdleExpired) => {
        // These tests only care that the expiry reached the model, so the
        // close they hand over is already settled.
        expire.push(() => onIdleExpired(Promise.resolve()));
        const s = sessions[n++];
        if (s === undefined) throw new Error("no session queued");
        return s.session;
      },
    });
    await model.ready;
    return { model, sessions, expire };
  }

  test("idle expiry keeps the in-flight close reachable until it settles", async () => {
    let expire: ((closing: Promise<void>) => void) | undefined;
    let settle!: () => void;
    const closing = new Promise<void>((r) => {
      settle = r;
    });
    const session: ChatSessionLike = {
      send: async () => "ok",
      close: async () => {},
      kill: async () => {},
    };
    const model = new ChatModel({
      login: async () => {},
      clearAuth: async () => {},
      openSession: async (_report, onIdleExpired) => {
        expire = onIdleExpired;
        return session;
      },
    });
    await model.ready;
    expire?.(closing);
    expect(model.session).toBeUndefined();
    expect(model.idleClosing).toBe(closing);
    settle();
    await closing;
    await Promise.resolve();
    expect(model.idleClosing).toBeUndefined();
  });

  test("expiry drops the session and the next prompt reopens and sends", async () => {
    const h = await idleHarness();
    nth(h.expire, 0)();
    expect(h.model.idleClosed).toBe(true);
    expect(h.model.session).toBeUndefined();
    expect(h.model.status).toBe("idle");
    // Core closed the browser already; the model must not close it again.
    expect(nth(h.sessions, 0).state.closed).toBe(0);

    expect(await h.model.submit("hello")).toBe(true);
    await h.model.pendingReset;
    await tick();
    expect(h.model.idleClosed).toBe(false);
    expect(h.model.session).toBe(nth(h.sessions, 1).session);
    expect(
      h.model.messages.some(
        (m) => m.role === "separator" && m.text === IDLE_SEPARATOR,
      ),
    ).toBe(true);
    expect(nth(h.sessions, 1).calls).toEqual(["b:hello"]);
    // The old session is still not touched by the model.
    expect(nth(h.sessions, 0).state.closed).toBe(0);
    expect(nth(h.sessions, 0).state.killed).toBe(0);
  });

  test("a stale session's expiry is ignored", async () => {
    const h = await idleHarness();
    await h.model.reset();
    expect(h.model.session).toBe(nth(h.sessions, 1).session);
    nth(h.expire, 0)(); // the session the reset already closed
    expect(h.model.idleClosed).toBe(false);
    expect(h.model.session).toBe(nth(h.sessions, 1).session);
  });

  test("/new clears the flag", async () => {
    const h = await idleHarness();
    nth(h.expire, 0)();
    expect(await h.model.submit("/new")).toBe(true);
    expect(h.model.idleClosed).toBe(false);
    expect(h.model.session).toBe(nth(h.sessions, 1).session);
    expect(h.model.messages.at(-1)).toEqual({
      role: "separator",
      text: NEW_CHAT_SEPARATOR,
    });
  });

  test("Ctrl+R (reset) clears the flag", async () => {
    const h = await idleHarness();
    nth(h.expire, 0)();
    await h.model.reset();
    expect(h.model.idleClosed).toBe(false);
    expect(h.model.session).toBe(nth(h.sessions, 1).session);
  });

  test("a provider /command typed while idle-closed reopens first", async () => {
    const h = await idleHarness();
    nth(h.expire, 0)();
    expect(await h.model.submit("/model now")).toBe(true);
    // Nothing ran against a closed session.
    expect(nth(h.sessions, 0).commands).toEqual([]);
    await h.model.pendingReset;
    await tick();
    expect(h.model.idleClosed).toBe(false);
    expect(nth(h.sessions, 1).commands).toEqual([
      { name: "model", args: "now" },
    ]);
  });

  test("a shell command run while idle-closed holds its result", async () => {
    const runner = fakeRunner();
    const h = await idleHarness({ runCommand: runner.runCommand });
    nth(h.expire, 0)();
    // requireSession() would throw; the idle close deliberately leaves none,
    // and a shell command does not need one.
    const p = h.model.runShell("echo hi");
    await tick();
    expect(h.model.status).toBe("running");
    runner.emit("hi\n");
    runner.finish();
    expect(await p).toBe(true);
    // There is no session to auto-send to, so the result waits like
    // autoSend: false — no InvalidStateError, nothing lost.
    expect(h.model.status).toBe("idle");
    expect(h.model.heldResults.length).toBe(1);
    expect(h.model.idleClosed).toBe(true);

    expect(await h.model.submit("look")).toBe(true);
    await h.model.pendingReset;
    await tick();
    expect(nth(h.sessions, 1).calls[0]).toContain("hi\n");
  });

  test("a message queued behind a shell command reopens instead of throwing", async () => {
    const runner = fakeRunner();
    const h = await idleHarness({ runCommand: runner.runCommand });
    nth(h.expire, 0)();
    const shell = h.model.runShell("sleep 5");
    await tick();
    expect(h.model.status).toBe("running");
    // Typed while the command runs: queued, so it never met submit()'s
    // idle-close guard.
    expect(await h.model.submit("later")).toBe(true);
    expect(h.model.queue).toEqual(["later"]);
    runner.emit("hi\n");
    runner.finish();
    expect(await shell).toBe(true);
    // The drain at the end of the shell command has no session to send to;
    // it must reopen rather than throw into a voided promise.
    await h.model.pendingReset;
    await tick();
    expect(h.model.idleClosed).toBe(false);
    expect(h.model.session).toBe(nth(h.sessions, 1).session);
    expect(
      h.model.messages.some(
        (m) => m.role === "separator" && m.text === IDLE_SEPARATOR,
      ),
    ).toBe(true);
    expect(h.model.queue).toEqual([]);
    const sent = nth(h.sessions, 1).calls[0] ?? "";
    expect(sent).toStartWith("b:later");
    // The held shell result still rides out with it.
    expect(sent).toContain("hi\n");
  });

  test("a message queued during a failing /login reopens instead of throwing", async () => {
    const gate = deferred<void>();
    const h = await idleHarness({ login: () => gate.promise });
    const login = h.model.submit("/login");
    await tick();
    expect(h.model.status).toBe("logging-in");
    // The idle watch is not paused during a login, so expiry can land here.
    nth(h.expire, 0)();
    expect(h.model.idleClosed).toBe(true);
    expect(await h.model.submit("later")).toBe(true);
    expect(h.model.queue).toEqual(["later"]);
    gate.reject(new Error("login failed"));
    await login;
    // The failure path restores `idle` and drains directly; that drain has
    // no session either.
    await h.model.pendingReset;
    await tick();
    expect(h.model.idleClosed).toBe(false);
    expect(nth(h.sessions, 1).calls).toEqual(["b:later"]);
  });

  test("an expiry during prompt expansion re-queues the prompt and reopens", async () => {
    const gate = deferred<void>();
    let gated = true;
    const runner = fakeRunner();
    const h = await idleHarness({
      runCommand: runner.runCommand,
      shell: { leadIn: "check", autoSend: false },
      expand: async (text) => {
        if (gated) {
          gated = false;
          await gate.promise;
        }
        return { prompt: text, attachments: [] };
      },
    });
    // A held shell result waiting to ride out with the next message.
    const shell = h.model.runShell("echo hi");
    await tick();
    runner.emit("hi\n");
    runner.finish();
    expect(await shell).toBe(true);
    expect(h.model.heldResults.length).toBe(1);

    const rejections: unknown[] = [];
    const submitted = h.model.submit("hello").catch((err: unknown) => {
      rejections.push(err);
      return false;
    });
    await tick();
    expect(h.model.status).toBe("busy");
    // The idle watch is only paused inside session.send(), so it can expire
    // while the expansion (file reads, URL hooks) is still running.
    nth(h.expire, 0)();
    expect(h.model.idleClosed).toBe(true);
    gate.resolve();
    expect(await submitted).toBe(true);
    expect(rejections).toEqual([]);

    await h.model.pendingReset;
    await tick();
    expect(h.model.idleClosed).toBe(false);
    expect(h.model.status).toBe("busy"); // the reopened turn is in flight
    expect(h.model.queue).toEqual([]);
    expect(
      h.model.messages.some(
        (m) => m.role === "separator" && m.text === IDLE_SEPARATOR,
      ),
    ).toBe(true);
    // Sent exactly once, and the user entry is in the history exactly once.
    expect(nth(h.sessions, 1).calls.length).toBe(1);
    const sent = nth(h.sessions, 1).calls[0] ?? "";
    expect(sent).toStartWith("b:hello");
    expect(sent).toContain("hi\n");
    expect(h.model.messages.filter((m) => m.role === "user")).toEqual([
      { role: "user", text: "hello" },
    ]);
  });
});

/** Polls `predicate` every 5 ms until it holds, failing after 1 s with
 * `label` so a hung expectation names itself instead of timing out blind. */
async function waitFor(predicate: () => boolean, label = "condition") {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("ChatModel: streaming", () => {
  /** A session whose reply is a deferred and whose `onPartial` the test can
   * fire by hand, so a partial lands at an exactly known moment. */
  function streamingSession(format?: "markdown" | "text") {
    const d = deferred<string>();
    let emit: ((t: string) => void) | undefined;
    const session: ChatSessionLike = {
      responseFormat: format,
      send: (_p, opts) => {
        emit = opts?.onPartial;
        return d.promise;
      },
      close: async () => {},
      kill: async () => {},
    };
    return { session, d, emit: (t: string) => emit?.(t) };
  }

  test("partials update model.partial and never enter messages", async () => {
    const s = streamingSession();
    const model = await modelWith(s.session);
    let changes = 0;
    model.onChange = () => changes++;
    void model.submit("hi");
    await waitFor(() => model.status === "busy", "busy");
    expect(model.partial).toBeUndefined();
    const before = changes;
    s.emit("He");
    expect(model.partial).toBe("He");
    expect(changes).toBe(before + 1);
    expect(model.messages.map((m) => m.role)).toEqual(["user"]);
    s.d.resolve("Hello");
    await waitFor(() => model.status === "idle", "idle");
    expect(model.partial).toBeUndefined();
    expect(model.messages.at(-1)).toEqual({ role: "assistant", text: "Hello" });
  });

  test("a markdown session stamps format on the assistant message", async () => {
    const s = streamingSession("markdown");
    const model = await modelWith(s.session);
    void model.submit("hi");
    await waitFor(() => model.status === "busy", "busy");
    s.d.resolve("# T");
    await waitFor(() => model.status === "idle", "idle");
    expect(model.messages.at(-1)).toEqual({
      role: "assistant",
      text: "# T",
      format: "markdown",
    });
  });

  test("a failed turn keeps the partial as an incomplete assistant message before the error", async () => {
    const s = streamingSession("markdown");
    const model = await modelWith(s.session);
    void model.submit("hi");
    await waitFor(() => model.status === "busy", "busy");
    s.emit("half a rep");
    s.d.reject(
      new ResponseTimeoutError(
        "Timed out during waitForResponse after 1000 ms.",
      ),
    );
    await waitFor(() => model.status === "idle", "idle");
    expect(model.partial).toBeUndefined();
    expect(model.messages.slice(-2)).toEqual([
      {
        role: "assistant",
        text: "half a rep",
        format: "markdown",
        incomplete: true,
      },
      {
        role: "error",
        text: "Timed out during waitForResponse after 1000 ms.",
      },
    ]);
  });

  test("a failed turn without a partial pushes only the error", async () => {
    const s = streamingSession();
    const model = await modelWith(s.session);
    void model.submit("hi");
    await waitFor(() => model.status === "busy", "busy");
    s.d.reject(new ResponseTimeoutError("t"));
    await waitFor(() => model.status === "idle", "idle");
    expect(model.messages.map((m) => m.role)).toEqual(["user", "error"]);
  });

  test("a partial from a turn made stale by a reset is dropped", async () => {
    const s = streamingSession();
    const model = await modelWith(s.session, {
      openSession: async () => streamingSession().session,
    });
    void model.submit("hi");
    await waitFor(() => model.status === "busy", "busy");
    await model.reset();
    let changes = 0;
    model.onChange = () => changes++;
    s.emit("stale");
    expect(model.partial).toBeUndefined();
    expect(changes).toBe(0);
  });

  test("a reset clears the partial of the turn it interrupts", async () => {
    const s = streamingSession();
    const model = await modelWith(s.session, {
      openSession: async () => streamingSession().session,
    });
    void model.submit("hi");
    await waitFor(() => model.status === "busy", "busy");
    s.emit("half");
    expect(model.partial).toBe("half");
    await model.reset();
    expect(model.partial).toBeUndefined();
  });
});

describe("ChatModel: /copy", () => {
  /** A session that answers every prompt with "Echo: <prompt>". */
  function echoSession(): ChatSessionLike {
    return {
      send: async (prompt) => `Echo: ${prompt}`,
      close: async () => {},
      kill: async () => {},
    };
  }

  test("copies the newest complete assistant reply, as the provider returned it", async () => {
    const copied: string[] = [];
    const model = await modelWith(echoSession(), {
      copy: async (t) => {
        copied.push(t);
        return true;
      },
    });
    await model.submit("one");
    await model.submit("two");
    const before = model.messages.length;
    expect(await model.submit("/copy")).toBe(true);
    expect(copied).toEqual(["Echo: two"]);
    expect(model.notice).toBe(COPIED_NOTICE);
    expect(model.messages.length).toBe(before); // no turn, no entry
  });

  test("skips an incomplete reply", async () => {
    const copied: string[] = [];
    const d = deferred<string>();
    let emit: ((t: string) => void) | undefined;
    const failing: ChatSessionLike = {
      send: (_p, opts) => {
        emit = opts?.onPartial;
        return d.promise;
      },
      close: async () => {},
      kill: async () => {},
    };
    const model = await modelWith(echoSession(), {
      copy: async (t) => {
        copied.push(t);
        return true;
      },
      openSession: async () => failing,
    });
    await model.submit("one");
    // Replace the echo session with the streaming one, then fail its turn
    // after a partial arrived: the model keeps it as `incomplete`.
    await model.reset();
    void model.submit("two");
    await waitFor(() => model.status === "busy", "busy");
    emit?.("half a re");
    d.reject(new ResponseTimeoutError("timed out"));
    await waitFor(() => model.status === "idle", "idle");
    expect(
      model.messages.some((m) => m.role === "assistant" && m.incomplete),
    ).toBe(true);

    await model.submit("/copy");
    expect(copied).toEqual(["Echo: one"]);
    expect(model.notice).toBe(COPIED_NOTICE);
  });

  test("nothing to copy yet", async () => {
    const model = await modelWith(echoSession(), { copy: async () => true });
    await model.submit("/copy");
    expect(model.notice).toBe(NOTHING_TO_COPY_NOTICE);
  });

  test("copy failed", async () => {
    const model = await modelWith(echoSession(), { copy: async () => false });
    await model.submit("hi");
    await model.submit("/copy");
    expect(model.notice).toBe(COPY_FAILED_NOTICE);
  });

  test("a rejecting copy is a failure, not a crash", async () => {
    const model = await modelWith(echoSession(), {
      copy: async () => {
        throw new Error("no clipboard");
      },
    });
    await model.submit("hi");
    await model.submit("/copy");
    expect(model.notice).toBe(COPY_FAILED_NOTICE);
  });

  test("without a copy function nothing is claimed to be copied", async () => {
    const model = await modelWith(echoSession());
    await model.submit("hi");
    await model.submit("/copy");
    expect(model.notice).toBe(COPY_FAILED_NOTICE);
  });

  test("works while a turn is pending: copies the last settled reply", async () => {
    const copied: string[] = [];
    const d = deferred<string>();
    const slow: ChatSessionLike = {
      send: async () => d.promise,
      close: async () => {},
      kill: async () => {},
    };
    const model = await modelWith(echoSession(), {
      copy: async (t) => {
        copied.push(t);
        return true;
      },
      openSession: async () => slow,
    });
    await model.submit("one");
    await model.reset();
    void model.submit("two");
    await waitFor(() => model.status === "busy", "busy");
    expect(await model.submit("/copy")).toBe(true);
    expect(copied).toEqual(["Echo: one"]);
    expect(model.queue).toEqual([]); // a built-in never queues
    d.resolve("second reply");
    await waitFor(() => model.status === "idle", "idle");
    expect(model.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "second reply",
    });
  });

  test("works after the idle close, without opening a session", async () => {
    const copied: string[] = [];
    let expire: ((closing: Promise<void>) => void) | undefined;
    let opens = 0;
    const model = new ChatModel({
      login: async () => {},
      clearAuth: async () => {},
      copy: async (t) => {
        copied.push(t);
        return true;
      },
      openSession: async (_report, onIdleExpired) => {
        opens++;
        expire = onIdleExpired;
        return echoSession();
      },
    });
    await model.ready;
    await model.submit("one");
    expire?.(Promise.resolve());
    expect(model.idleClosed).toBe(true);
    expect(await model.submit("/copy")).toBe(true);
    expect(copied).toEqual(["Echo: one"]);
    expect(opens).toBe(1);
    expect(model.idleClosed).toBe(true);
  });

  test("notify sets the notice and repaints", async () => {
    const model = await modelWith(echoSession());
    let changes = 0;
    model.onChange = () => changes++;
    model.notify("hello");
    expect(model.notice).toBe("hello");
    expect(changes).toBe(1);
  });
});

describe("ChatModel conversation handle", () => {
  /** A model whose opens record the handle they were handed and can be
   * expired the way core's idle timeout does. `openedWith[0]` is the initial
   * open, so a reopen's handle is `openedWith[1]` onwards. */
  async function handleHarness() {
    const sessions = [
      fakeSession("a"),
      fakeSession("b"),
      fakeSession("c"),
      fakeSession("d"),
    ];
    const openedWith: Array<string | undefined> = [];
    const expire: Array<() => void> = [];
    let n = 0;
    const model = new ChatModel({
      login: async () => {},
      clearAuth: async () => {},
      closeTimeoutMs: 20,
      openSession: async (_report, onIdleExpired, conversation) => {
        openedWith.push(conversation);
        // These tests only care that the expiry reached the model, so the
        // close they hand over is already settled.
        expire.push(() => onIdleExpired(Promise.resolve()));
        const s = sessions[n++];
        if (s === undefined) throw new Error("no session queued");
        return s.session;
      },
    });
    await model.ready;
    return { model, sessions, openedWith, expire };
  }

  /** One complete turn against `s`, the session the model currently holds. */
  async function turn(model: ChatModel, s: ReturnType<typeof fakeSession>) {
    const p = model.submit("hi");
    await tick();
    nth(s.replies, s.replies.length - 1).resolve("ok");
    await p;
  }

  test("the initial open is given no handle", async () => {
    const h = await handleHarness();
    expect(h.openedWith).toEqual([undefined]);
  });

  test("/reopen passes the last turn's handle and notes the restore", async () => {
    const h = await handleHarness();
    const a = nth(h.sessions, 0);
    a.state.conversation = "H1";
    await turn(h.model, a);
    const b = nth(h.sessions, 1);
    b.state.conversation = "H1";
    b.state.restored = true;

    expect(await h.model.submit("/reopen")).toBe(true);

    expect(h.openedWith).toEqual([undefined, "H1"]);
    expect(h.model.messages.at(-1)).toEqual({
      role: "separator",
      text: `reopened · ${RESTORED_NOTE}`,
    });
  });

  test("a failed restore says so and is not retried", async () => {
    const h = await handleHarness();
    const a = nth(h.sessions, 0);
    a.state.conversation = "H1";
    await turn(h.model, a);
    nth(h.sessions, 1).state.restored = false;

    await h.model.reset();
    expect(h.model.messages.at(-1)).toEqual({
      role: "separator",
      text: `reopened · ${NOT_RESTORED_NOTE}`,
    });

    await h.model.reset();
    expect(h.openedWith).toEqual([undefined, "H1", undefined]);
  });

  test("a session that reports no restore gets a plain separator", async () => {
    const h = await handleHarness();
    const a = nth(h.sessions, 0);
    a.state.conversation = "H1";
    await turn(h.model, a);

    await h.model.reset();

    expect(h.openedWith).toEqual([undefined, "H1"]);
    expect(h.model.messages.at(-1)).toEqual({
      role: "separator",
      text: "reopened",
    });
  });

  test("/new forgets the handle and keeps its own separator", async () => {
    const h = await handleHarness();
    const a = nth(h.sessions, 0);
    a.state.conversation = "H1";
    await turn(h.model, a);
    // Even a session that claims a restore cannot put a note on `/new`:
    // nothing was handed to it to restore.
    nth(h.sessions, 1).state.restored = true;

    expect(await h.model.submit("/new")).toBe(true);

    expect(h.openedWith).toEqual([undefined, undefined]);
    expect(h.model.messages.at(-1)).toEqual({
      role: "separator",
      text: NEW_CHAT_SEPARATOR,
    });
  });

  test("/logout forgets the handle", async () => {
    const h = await handleHarness();
    const a = nth(h.sessions, 0);
    a.state.conversation = "H1";
    await turn(h.model, a);

    expect(await h.model.submit("/logout")).toBe(true);

    expect(h.openedWith).toEqual([undefined, undefined]);
  });

  test("the reopen after an idle close keeps the handle", async () => {
    const h = await handleHarness();
    const a = nth(h.sessions, 0);
    a.state.conversation = "H1";
    await turn(h.model, a);
    nth(h.sessions, 1).state.restored = true;

    nth(h.expire, 0)();
    expect(await h.model.submit("again")).toBe(true);
    await h.model.pendingReset;
    await tick();

    expect(h.openedWith).toEqual([undefined, "H1"]);
    expect(
      h.model.messages.some(
        (m) =>
          m.role === "separator" &&
          m.text === `${IDLE_SEPARATOR} · ${RESTORED_NOTE}`,
      ),
    ).toBe(true);
  });

  test("a failed turn does not overwrite the remembered handle", async () => {
    const h = await handleHarness();
    const a = nth(h.sessions, 0);
    a.state.conversation = "H1";
    await turn(h.model, a);

    // A timeout leaves the model idle, so the next reopen is the user's.
    a.state.conversation = "H2";
    const p = h.model.submit("again");
    await tick();
    nth(a.replies, 1).reject(new ResponseTimeoutError("Timed out."));
    await p;

    await h.model.reset();
    expect(h.openedWith).toEqual([undefined, "H1"]);
  });

  test("a turn made stale by a reset does not write its handle", async () => {
    const h = await handleHarness();
    const a = nth(h.sessions, 0);
    a.state.conversation = "H1";
    const p = h.model.submit("hi");
    await tick();

    await h.model.reset();
    nth(a.replies, 0).resolve("late");
    await p;

    await h.model.reset();
    expect(h.openedWith).toEqual([undefined, undefined, undefined]);
  });
});
