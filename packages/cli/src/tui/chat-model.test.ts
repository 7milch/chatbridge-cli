import { describe, expect, test } from "bun:test";
import { ResponseTimeoutError } from "@chatbridge/core";
import { MentionError } from "../mentions/expand-mentions.js";
import type {
  RunOptions,
  RunningCommand,
  ShellResult,
} from "../shell/run-command.js";
import { ChatModel, type ChatSessionLike } from "./chat-model.js";

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

/** A fake session. `label`, when given, prefixes recorded calls so a test
 * over two sessions can tell which one was sent to. */
function fakeSession(label = "") {
  const calls: string[] = [];
  const replies: Array<ReturnType<typeof deferred<string>>> = [];
  const state = { closed: 0, killed: 0, closeHangs: false };
  const session: ChatSessionLike = {
    async send(prompt) {
      calls.push(label ? `${label}:${prompt}` : prompt);
      const d = deferred<string>();
      replies.push(d);
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
  return { session, calls, replies, state };
}

/** For models that must never reopen: a reset would be a test bug. */
const noReopen = {
  openSession: async (): Promise<ChatSessionLike> => {
    throw new Error("not expected");
  },
};

/** A model over a first session plus a queue of sessions for reopens. */
function harness(opts: { closeTimeoutMs?: number } = {}) {
  const first = fakeSession("a");
  const next: Array<ReturnType<typeof fakeSession> | Error> = [];
  const opened: number[] = [];
  const model = new ChatModel(first.session, {
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
    const model = new ChatModel(session, noReopen);
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
    const model = new ChatModel(session, noReopen);
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
    const model = new ChatModel(session, noReopen);
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
    const model = new ChatModel(session, noReopen);
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
    const model = new ChatModel(session, noReopen);
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
    const model = new ChatModel(session, noReopen);
    expect(await model.submit("   ")).toBe(false);
    const p = model.submit("one");
    await tick();
    expect(await model.submit("two")).toBe(true); // busy: queued
    replies[0]?.resolve("ok");
    expect(await p).toBe(true);
  });

  test("sends the expanded prompt and records attachments on the user message", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session, {
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
    const model = new ChatModel(session, noReopen);
    const p = model.submit("hello");
    await tick();
    replies[0]?.resolve("ok");
    await p;
    expect(model.messages[0]).toEqual({ role: "user", text: "hello" });
  });

  test("a MentionError shows the problems, sends nothing, stays idle and not fatal", async () => {
    const { session, calls } = fakeSession();
    const model = new ChatModel(session, {
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
    const model = new ChatModel(session, {
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
    const model = new ChatModel(session, {
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
    const h = harness();
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
    const h = harness();
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
    const h = harness();
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
    const h = harness({ closeTimeoutMs: 20 });
    h.first.state.closeHangs = true;
    h.next.push(fakeSession("b"));
    await h.model.reset();
    expect(h.first.state.closed).toBe(1);
    expect(h.first.state.killed).toBe(1);
    expect(h.model.status).toBe("idle");
  });

  test("dead: reset recovers and clears fatal", async () => {
    const h = harness();
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
    const h = harness();
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
    const h = harness();
    const gate = deferred<void>();
    const b = fakeSession("b");
    const model = new ChatModel(h.first.session, {
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
    const h = harness();
    const gate = deferred<void>();
    const b = fakeSession("b");
    const model = new ChatModel(h.first.session, {
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
    const h = harness();
    const gate = deferred<void>();
    const b = fakeSession("b");
    const model = new ChatModel(h.first.session, {
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
    const model = new ChatModel(session, {
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
    const model = new ChatModel(session, {
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
    const model = new ChatModel(session, {
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
    const model = new ChatModel(session, {
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
    const model = new ChatModel(session, {
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
    const model = new ChatModel(session, {
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

  test("stopShell settles the command as interrupted and still sends", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = new ChatModel(session, {
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
    const model = new ChatModel(session, {
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
    expect(model.messages[1]?.text).toBe(
      "could not start shell: spawn /no/sh ENOENT",
    );
  });

  test("send failures after a command behave like submit", async () => {
    const { session, replies } = fakeSession();
    const runner = fakeRunner();
    const model = new ChatModel(session, {
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
    const h = harness();
    const runner = fakeRunner();
    const model = new ChatModel(h.first.session, {
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
    const model = new ChatModel(fakeSession("a").session, {
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
    const model = new ChatModel(session, noReopen);
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
    const model = new ChatModel(session, noReopen);
    const p = model.submit("one");
    await tick();
    expect(await model.submit("   ")).toBe(false);
    expect(model.queue).toEqual([]);
    replies[0]?.resolve("ok");
    await p;
  });

  test("submit while dead queues; nothing is sent", async () => {
    const { session, calls, replies } = fakeSession();
    const model = new ChatModel(session, noReopen);
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
    const model = new ChatModel(session, noReopen);
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
    const model = new ChatModel(session, noReopen);
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
    const model = new ChatModel(session, noReopen);
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
    const model = new ChatModel(session, {
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
    const model = new ChatModel(session, noReopen);
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
    const h = harness();
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
    const h = harness();
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
    const model = new ChatModel(session, {
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
    const model = new ChatModel(session, {
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
    expect(model.heldResults).toEqual([]);
    expect(model.messages[0]?.held).toBe(false);
    expect(model.status).toBe("busy");
    replies[0]?.resolve("ok");
    await tick();
    expect(model.status).toBe("idle");
  });

  test("runShell while busy is rejected and queues nothing", async () => {
    const { session, calls, replies } = fakeSession();
    const runner = fakeRunner();
    const model = new ChatModel(session, {
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
