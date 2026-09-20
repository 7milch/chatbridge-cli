import { describe, expect, test } from "bun:test";
import { AuthRequiredError, LoginAbortedError } from "@chatbridge/core";
import type { Page, Provider } from "@chatbridge/provider";
import type { AuthStore } from "@chatbridge/runtime";
import { createTestRenderer } from "@opentui/core/testing";
import { FileIndex } from "../mentions/file-index.js";
import type { ShellResult } from "../shell/run-command.js";
import { ChatView, LOGIN_STATUS } from "./chat-view.js";
import {
  RENDERER_OPTIONS,
  runInteractive,
  teardownExitMessage,
  waitForQuit,
} from "./run-interactive.js";
import { resolveSpinner } from "./spinner.js";
import { modelWith } from "./test-helpers.js";

/** Polls the frame until `needle` shows; fails naming what it waited for. */
async function waitFor(
  t: Awaited<ReturnType<typeof createTestRenderer>>,
  needle: string,
): Promise<string> {
  let frame = "";
  for (let i = 0; i < 50 && !frame.includes(needle); i++) {
    await new Promise((r) => setTimeout(r, 20));
    await t.renderOnce();
    frame = t.captureCharFrame();
  }
  if (!frame.includes(needle)) {
    throw new Error(`frame never showed ${JSON.stringify(needle)}:\n${frame}`);
  }
  return frame;
}

describe("waitForQuit", () => {
  test("resolves when the renderer is destroyed from outside", async () => {
    // OpenTUI's own SIGINT/SIGTERM/SIGHUP handlers destroy the renderer
    // without exiting the process.
    const t = await createTestRenderer({ width: 40, height: 12 });
    const model = await modelWith(
      {
        async send() {
          return "";
        },
        async close() {},
        async kill() {},
      },
      {
        openSession: async () => {
          throw new Error("not expected");
        },
      },
    );
    const view = new ChatView(t.renderer, model, {
      title: "test-cli",
      providerName: "dummy-chat",
      timeoutMs: 1_000,
      headless: true,
      banner: [],
      spinner: resolveSpinner(),
      index: FileIndex.fromPaths([]),
    });
    const quit = waitForQuit(t.renderer, model);
    view.destroy();
    t.renderer.destroy();
    expect(await quit).toBeUndefined();
  });

  test("does not resolve on a fatal error; Ctrl+C then returns it", async () => {
    const t = await createTestRenderer({ width: 40, height: 12 });
    const boom = new Error("page closed");
    const model = await modelWith(
      {
        async send() {
          throw boom;
        },
        async close() {},
        async kill() {},
      },
      {
        openSession: async () => {
          throw new Error("not expected");
        },
        expand: async (text) => ({ prompt: text, attachments: [] }),
      },
    );
    const view = new ChatView(t.renderer, model, {
      title: "test-cli",
      providerName: "dummy-chat",
      timeoutMs: 1_000,
      headless: true,
      banner: [],
      spinner: resolveSpinner(),
      index: FileIndex.fromPaths([]),
    });
    const quit = waitForQuit(t.renderer, model);
    await model.submit("x");
    expect(model.status).toBe("dead");
    const raced = await Promise.race([
      quit.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("pending"), 50)),
    ]);
    expect(raced).toBe("pending");
    t.mockInput.pressKey("c", { ctrl: true });
    expect(await quit).toBe(boom);
    view.destroy();
    t.renderer.destroy();
  });

  test("Ctrl+C from a healthy model resolves undefined", async () => {
    const t = await createTestRenderer({ width: 40, height: 12 });
    const model = await modelWith(
      {
        async send() {
          return "";
        },
        async close() {},
        async kill() {},
      },
      {
        openSession: async () => {
          throw new Error("not expected");
        },
      },
    );
    const view = new ChatView(t.renderer, model, {
      title: "test-cli",
      providerName: "dummy-chat",
      timeoutMs: 1_000,
      headless: true,
      banner: [],
      spinner: resolveSpinner(),
      index: FileIndex.fromPaths([]),
    });
    const quit = waitForQuit(t.renderer, model);
    t.mockInput.pressKey("c", { ctrl: true });
    expect(await quit).toBeUndefined();
    view.destroy();
    t.renderer.destroy();
  });
  test("Ctrl+C while a shell command runs stops it and does not quit", async () => {
    // exitOnCtrlC mirrors createCliRenderer in runInteractive; the test
    // renderer defaults to true, which would destroy it on the first Ctrl+C.
    const t = await createTestRenderer({
      width: 40,
      height: 12,
      exitOnCtrlC: false,
    });
    let stopped = 0;
    const model = await modelWith(
      {
        async send() {
          return "";
        },
        async close() {},
        async kill() {},
      },
      {
        openSession: async () => {
          throw new Error("not expected");
        },
        shell: { leadIn: "x", autoSend: false },
        runCommand: (command) => {
          let resolve!: (r: ShellResult) => void;
          const done = new Promise<ShellResult>((res) => {
            resolve = res;
          });
          return {
            done,
            stop() {
              stopped++;
              resolve({
                command,
                output: "",
                droppedBytes: 0,
                exitCode: undefined,
                interrupted: true,
                durationMs: 1,
              });
            },
          };
        },
      },
    );
    const view = new ChatView(t.renderer, model, {
      title: "test-cli",
      providerName: "dummy-chat",
      timeoutMs: 1_000,
      headless: true,
      banner: [],
      spinner: resolveSpinner(),
      index: FileIndex.fromPaths([]),
    });
    const quit = waitForQuit(t.renderer, model);
    const run = model.runShell("sleep 10");
    await new Promise((r) => setTimeout(r, 0));
    expect(model.status).toBe("running");
    t.mockInput.pressKey("c", { ctrl: true });
    await run;
    expect(stopped).toBe(1);
    expect(model.status).toBe("idle");
    const raced = await Promise.race([
      quit.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("pending"), 50)),
    ]);
    expect(raced).toBe("pending");
    t.mockInput.pressKey("c", { ctrl: true });
    expect(await quit).toBeUndefined();
    view.destroy();
    t.renderer.destroy();
  });

  test("Ctrl+C during /login cancels the login instead of quitting", async () => {
    // As runInteractive builds it: OpenTUI's own Ctrl+C would otherwise
    // destroy the renderer, which is a quit of its own.
    const t = await createTestRenderer({
      width: 40,
      height: 12,
      exitOnCtrlC: false,
    });
    const model = await modelWith(
      {
        async send() {
          return "";
        },
        async close() {},
        async kill() {},
      },
      {
        openSession: async () => {
          throw new Error("not expected");
        },
        login: ({ signal }) =>
          new Promise((_, rej) =>
            signal.addEventListener("abort", () =>
              rej(new LoginAbortedError()),
            ),
          ),
      },
    );
    const view = new ChatView(t.renderer, model, {
      title: "test-cli",
      providerName: "dummy-chat",
      timeoutMs: 1_000,
      headless: true,
      banner: [],
      spinner: resolveSpinner(),
      index: FileIndex.fromPaths([]),
    });
    const quit = waitForQuit(t.renderer, model);
    const login = model.submit("/login");
    await new Promise((r) => setTimeout(r, 0));
    expect(model.status).toBe("logging-in");
    t.mockInput.pressKey("c", { ctrl: true });
    await login;
    expect(model.messages.at(-1)?.text).toBe("Login cancelled");
    const raced = await Promise.race([
      quit.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("pending"), 50)),
    ]);
    expect(raced).toBe("pending");
    // A second Ctrl+C, now that the login is gone, quits as usual.
    t.mockInput.pressKey("c", { ctrl: true });
    expect(await quit).toBeUndefined();
    view.destroy();
    t.renderer.destroy();
  });
});

/** Minimal ChatSession dependencies: a provider that never needs a browser.
 * `launches` grows by one runtime record per BrowserRuntime.launch call.
 * `gate`, when given, holds up every launch after the first, so a test can
 * keep a Ctrl+R reset in flight. `failSave` makes every saveAuthState throw,
 * so closing reports the failure through onProgress. */
function sessionOpts(gate?: Promise<void>, failSave = false) {
  const provider: Provider = {
    name: "fake",
    chatUrl: "http://127.0.0.1:1/chat",
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
  const page = {
    setDefaultTimeout() {},
    goto: async () => null,
  } as unknown as Page;
  const launches: Array<{ closed: number; killed: number }> = [];
  return {
    launches,
    opts: {
      title: "test-cli",
      provider,
      authStore: { has: () => true } as unknown as AuthStore,
      headless: true,
      timeoutMs: 1000,
      launch: async () => {
        const rec = { closed: 0, killed: 0 };
        launches.push(rec);
        // Pushed before the wait, so a test can see the launch has started.
        if (gate !== undefined && launches.length > 1) await gate;
        return {
          page,
          saveAuthState: async () => {
            if (failSave) throw new Error("disk full");
          },
          close: async () => {
            rec.closed++;
          },
          kill: async () => {
            rec.killed++;
          },
        };
      },
    },
  };
}

describe("teardownExitMessage", () => {
  test("a settled teardown blames the close", () => {
    expect(teardownExitMessage(true, true)).toBe(
      "browser did not close within 5 s; exiting\n",
    );
    expect(teardownExitMessage(true, false)).toBe(
      "browser did not close within 5 s; exiting\n",
    );
  });

  test("an unsettled wait names the promise that was raced", () => {
    expect(teardownExitMessage(false, true)).toBe(
      "browser reopen did not finish within 5 s; exiting\n",
    );
    // No reset was in flight: the wait was the eager first open.
    expect(teardownExitMessage(false, false)).toBe(
      "browser did not finish opening within 5 s; exiting\n",
    );
  });
});

describe("runInteractive", () => {
  test("a renderer that fails to start rejects without opening a browser", async () => {
    const s = sessionOpts();
    const boom = new Error("no tty");
    await expect(
      runInteractive({
        ...s.opts,
        createRenderer: () => Promise.reject(boom),
        index: FileIndex.fromPaths([]),
      }),
    ).rejects.toBe(boom);
    // The model opens the session, and there is no model yet: nothing to
    // leak, and nothing to close.
    expect(s.launches).toEqual([]);
  });

  test("shows the default banner with the provider name, then quits on destroy", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    let frame = "";
    const run = runInteractive({
      ...sessionOpts().opts,
      version: "1.2.3",
      createRenderer: async () => t.renderer,
      index: FileIndex.fromPaths([]),
    });
    frame = await waitFor(t, "test-cli v1.2.3");
    try {
      expect(frame).toContain("test-cli v1.2.3");
      expect(frame).toContain("Connected to fake.");
      expect(frame).toContain("fake · headless · 1s budget");
    } finally {
      // A failed assertion must not leave the renderer up and `run` pending.
      t.renderer.destroy();
    }
    expect(await run).toEqual({});
  });

  test("a vendor banner replaces the default", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    let frame = "";
    const run = runInteractive({
      ...sessionOpts().opts,
      banner: ["ACME BANNER"],
      createRenderer: async () => t.renderer,
      index: FileIndex.fromPaths([]),
    });
    frame = await waitFor(t, "ACME BANNER");
    try {
      expect(frame).toContain("ACME BANNER");
      expect(frame).not.toContain("Connected to");
    } finally {
      t.renderer.destroy();
    }
    await run;
  });

  test("a vendor spinner replaces the default", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    let frame = "";
    const base = sessionOpts().opts;
    const run = runInteractive({
      ...base,
      // A slow reply keeps the busy row on screen long enough to capture.
      provider: {
        ...base.provider,
        async waitForResponse() {
          await new Promise((r) => setTimeout(r, 300));
          return "";
        },
      },
      spinner: { frames: ["@@"], label: "Crunching\u2026", labelColor: 2 },
      createRenderer: async () => t.renderer,
      index: FileIndex.fromPaths([]),
    });
    try {
      frame = await waitFor(t, "Type a message");
      await t.mockInput.typeText("hi");
      t.mockInput.pressEnter();
      frame = await waitFor(t, "Crunching\u2026");
      expect(frame).toContain("@@ Crunching\u2026");
      expect(frame).not.toContain("Thinking\u2026");
    } finally {
      t.renderer.destroy();
    }
    await run;
  });

  test("teardown closes the session that is current after a reset", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    const s = sessionOpts();
    const run = runInteractive({
      ...s.opts,
      createRenderer: async () => t.renderer,
      index: FileIndex.fromPaths([]),
    });
    await waitFor(t, "Ctrl+R reopen");
    t.mockInput.pressKey("r", { ctrl: true });
    const frame = await waitFor(t, "── reopened ──");
    try {
      expect(frame).toContain("── reopened ──");
      expect(s.launches).toHaveLength(2);
      expect(s.launches[0]?.closed).toBe(1);
      expect(s.launches[1]?.closed).toBe(0);
    } finally {
      t.mockInput.pressKey("c", { ctrl: true });
    }
    expect(await run).toEqual({});
    expect(s.launches[1]?.closed).toBe(1);
  });

  test("Ctrl+C while a reset is in flight still closes the reopened session", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = () => resolve();
    });
    const s = sessionOpts(gate);
    const run = runInteractive({
      ...s.opts,
      createRenderer: async () => t.renderer,
      index: FileIndex.fromPaths([]),
    });
    const frame = await waitFor(t, "Ctrl+R reopen");
    t.mockInput.pressKey("r", { ctrl: true });
    // The second launch has started and is parked on the gate.
    for (let i = 0; i < 50 && s.launches.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
      await t.renderOnce();
    }
    try {
      expect(s.launches).toHaveLength(2);
      expect(t.captureCharFrame()).not.toContain("── reopened ──");
    } finally {
      // Quit mid-reset, then let the reopen finish.
      t.mockInput.pressKey("c", { ctrl: true });
      openGate();
    }
    expect(await run).toEqual({});
    expect(s.launches[0]?.closed).toBe(1);
    // The browser opened by the abandoned reset must not be left running.
    expect(s.launches[1]?.closed).toBe(1);
  });

  /** A session the model can hold, for the idle-close teardown tests: core
   * owns the real browser there, so the fake never has to close one. */
  function idleSession() {
    return {
      send: async () => "",
      close: async () => {},
      kill: async () => {},
    };
  }

  test("the copy seam is what the model uses for /copy", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    const copied: string[] = [];
    const run = runInteractive({
      ...sessionOpts().opts,
      createSession: async () => ({
        send: async (prompt: string) => `Echo: ${prompt}`,
        close: async () => {},
        kill: async () => {},
      }),
      createRenderer: async () => t.renderer,
      index: FileIndex.fromPaths([]),
      copy: async (text) => {
        copied.push(text);
        return true;
      },
    });
    await waitFor(t, "Ctrl+R reopen");
    await t.mockInput.typeText("hi");
    t.mockInput.pressEnter();
    await waitFor(t, "Echo: hi");
    await t.mockInput.typeText("/copy");
    t.mockInput.pressEnter();
    await waitFor(t, "copied");
    t.mockInput.pressKey("c", { ctrl: true });
    expect(await run).toEqual({});
    expect(copied).toEqual(["Echo: hi"]);
  });

  test("the view gets the copy seam too: a selection reaches it", async () => {
    const t = await createTestRenderer({
      width: 80,
      height: 20,
      autoFocus: RENDERER_OPTIONS.autoFocus,
    });
    const copied: string[] = [];
    const run = runInteractive({
      ...sessionOpts().opts,
      createSession: async () => ({
        send: async (prompt: string) => `Echo: ${prompt}`,
        close: async () => {},
        kill: async () => {},
      }),
      createRenderer: async () => t.renderer,
      index: FileIndex.fromPaths([]),
      copy: async (text) => {
        copied.push(text);
        return true;
      },
    });
    await waitFor(t, "Ctrl+R reopen");
    await t.mockInput.typeText("hi");
    t.mockInput.pressEnter();
    await waitFor(t, "Echo: hi");
    // A mouse drag is what this is in real life, but runInteractive calls
    // renderer.start() and the live loop repaints between the press and the
    // release, so the mock mouse's anchor and focus land on different rows
    // and the selection comes back empty (verified A/B: the same drag in
    // chat-view.test.ts, on a renderer that was never started, selects the
    // reply). The renderer's "selection" event is the next thing down that
    // path, and only the view listens for it: this proves runInteractive
    // handed `copy` to ChatView and not just to the model.
    (t.renderer as unknown as { emit(e: string, v: unknown): void }).emit(
      "selection",
      { getSelectedText: () => "Echo: hi" },
    );
    await waitFor(t, "copied");
    expect(copied).toEqual(["Echo: hi"]);
    t.mockInput.pressKey("c", { ctrl: true });
    expect(await run).toEqual({});
  });

  test("teardown waits for an idle close that is still saving auth state", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    let expire: ((closing: Promise<void>) => void) | undefined;
    let settle!: () => void;
    const closing = new Promise<void>((r) => {
      settle = r;
    });
    let resolved = false;
    const run = runInteractive({
      ...sessionOpts().opts,
      createSession: async (_report, onIdleExpired) => {
        expire = onIdleExpired;
        return idleSession();
      },
      createRenderer: async () => t.renderer,
      index: FileIndex.fromPaths([]),
    }).then((r) => {
      resolved = true;
      return r;
    });
    await waitFor(t, "Ctrl+R reopen");
    // Core has dropped the session into its idle close; the model no longer
    // holds it, so `closing` is teardown's only handle on the save.
    expire?.(closing);
    t.mockInput.pressKey("c", { ctrl: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);
    settle();
    expect(await run).toEqual({});
  });

  test("a wedged idle close is given up on after the teardown budget", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    let expire: ((closing: Promise<void>) => void) | undefined;
    const exits: Array<number | undefined> = [];
    const errs: string[] = [];
    const realExit = process.exit;
    const realWrite = process.stderr.write.bind(process.stderr);
    process.exit = ((code?: number) => {
      exits.push(code);
    }) as unknown as typeof process.exit;
    process.stderr.write = ((chunk: unknown) => {
      errs.push(String(chunk));
      return true;
    }) as unknown as typeof process.stderr.write;
    try {
      const run = runInteractive({
        ...sessionOpts().opts,
        createSession: async (_report, onIdleExpired) => {
          expire = onIdleExpired;
          return idleSession();
        },
        createRenderer: async () => t.renderer,
        index: FileIndex.fromPaths([]),
      });
      await waitFor(t, "Ctrl+R reopen");
      expire?.(new Promise<void>(() => {})); // the close never settles
      t.mockInput.pressKey("c", { ctrl: true });
      await run;
    } finally {
      process.exit = realExit;
      process.stderr.write = realWrite;
    }
    expect(exits).toEqual([1]);
    expect(errs).toContain("browser did not close within 5 s; exiting\n");
  }, 20_000);

  test("teardown progress messages are flushed after the terminal is restored", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    const s = sessionOpts(undefined, true);
    const progress: string[] = [];
    let resolved = false;
    const run = runInteractive({
      ...s.opts,
      onProgress: (m) => progress.push(m),
      createRenderer: async () => t.renderer,
      index: FileIndex.fromPaths([]),
    }).then((r) => {
      resolved = true;
      return r;
    });
    const frame = await waitFor(t, "Ctrl+R reopen");
    // Nothing from close() yet, and nothing may be printed over the live TUI.
    expect(progress.some((m) => m.includes("Could not save auth state"))).toBe(
      false,
    );
    t.mockInput.pressKey("c", { ctrl: true });
    await run;
    expect(resolved).toBe(true);
    expect(
      progress.filter((m) => m.includes("Could not save auth state")),
    ).toHaveLength(1);
  });

  test("progress messages stop once the TUI owns the terminal", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    const s = sessionOpts();
    const progress: string[] = [];
    const run = runInteractive({
      ...s.opts,
      onProgress: (m) => progress.push(m),
      createRenderer: async () => t.renderer,
      index: FileIndex.fromPaths([]),
    });
    let frame = "";

    frame = await waitFor(t, "Ctrl+R reopen");
    t.mockInput.pressKey("r", { ctrl: true });
    frame = await waitFor(t, "── reopened ──");
    try {
      expect(frame).toContain("── reopened ──");
      // Opening messages go to the model's status row, never to stderr:
      // neither the first open nor the reopen may reach onProgress.
      expect(progress.filter((m) => m === "Opening browser...")).toHaveLength(
        0,
      );
    } finally {
      t.mockInput.pressKey("c", { ctrl: true });
    }
    await run;
  });

  test("an open that fails with AuthRequiredError shows in the TUI and is reported at quit", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    const boom = new AuthRequiredError("not logged in");
    const run = runInteractive({
      ...sessionOpts().opts,
      createSession: () => Promise.reject(boom),
      createRenderer: async () => t.renderer,
      index: FileIndex.fromPaths([]),
    });
    const frame = await waitFor(t, "not logged in");
    try {
      // The UI came up despite the failure, and says how to fix it.
      expect(frame).toContain("not logged in");
      expect(frame).toContain("Type /login to log in.");
      expect(frame).toContain("Ctrl+R reopen · /login · Ctrl+C quit");
    } finally {
      t.mockInput.pressKey("c", { ctrl: true });
    }
    expect(await run).toEqual({ fatal: boom });
  });

  test("quit during /login waits for the login to unwind before destroying the renderer", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    let unwound = false;
    const base = sessionOpts().opts;
    const run = runInteractive({
      ...base,
      login: async ({ signal }) => {
        await new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => {
            setTimeout(() => {
              unwound = true;
              reject(new LoginAbortedError());
            }, 30);
          }),
        );
      },
      createRenderer: async () => t.renderer,
      index: FileIndex.fromPaths([]),
    });
    await waitFor(t, "Type a message");
    await t.mockInput.typeText("/login");
    t.mockInput.pressEnter();
    await waitFor(t, LOGIN_STATUS);
    // An external destroy is the only quit path that skips Ctrl+C's cancel.
    t.renderer.destroy();
    await run;
    expect(unwound).toBe(true);
  });
});
