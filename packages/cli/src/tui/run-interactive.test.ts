import { describe, expect, test } from "bun:test";
import type { Page, Provider } from "@chatbridge/provider";
import type { AuthStore } from "@chatbridge/runtime";
import { createTestRenderer } from "@opentui/core/testing";
import { FileIndex } from "../mentions/file-index.js";
import type { ShellResult } from "../shell/run-command.js";
import {
  ChatModel,
  type ChatModelOptions,
  type ChatSessionLike,
} from "./chat-model.js";
import { ChatView } from "./chat-view.js";
import { runInteractive, waitForQuit } from "./run-interactive.js";
import { resolveSpinner } from "./spinner.js";

/** Builds a model whose first open resolves to `session` and whose reopens
 * go to `opts.openSession`, then waits for the eager open so the model
 * starts idle. */
async function modelWith(
  session: ChatSessionLike,
  opts: Partial<ChatModelOptions> = {},
): Promise<ChatModel> {
  const reopen = opts.openSession;
  let opened = false;
  const model = new ChatModel({
    login: async () => {},
    clearAuth: async () => {},
    ...opts,
    openSession: async () => {
      if (!opened) {
        opened = true;
        return session;
      }
      if (!reopen) throw new Error("not expected");
      return reopen();
    },
  });
  await model.ready;
  return model;
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
    for (let i = 0; i < 50 && !frame.includes("test-cli v1.2.3"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await t.renderOnce();
      frame = t.captureCharFrame();
    }
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
    for (let i = 0; i < 50 && !frame.includes("ACME BANNER"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await t.renderOnce();
      frame = t.captureCharFrame();
    }
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
      for (let i = 0; i < 50 && !frame.includes("Type a message"); i++) {
        await new Promise((r) => setTimeout(r, 20));
        await t.renderOnce();
        frame = t.captureCharFrame();
      }
      await t.mockInput.typeText("hi");
      t.mockInput.pressEnter();
      for (let i = 0; i < 50 && !frame.includes("Crunching\u2026"); i++) {
        await new Promise((r) => setTimeout(r, 20));
        await t.renderOnce();
        frame = t.captureCharFrame();
      }
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
    let frame = "";
    for (let i = 0; i < 50 && !frame.includes("Ctrl+R reopen"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await t.renderOnce();
      frame = t.captureCharFrame();
    }
    t.mockInput.pressKey("r", { ctrl: true });
    for (let i = 0; i < 50 && !frame.includes("── reopened ──"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await t.renderOnce();
      frame = t.captureCharFrame();
    }
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
    let frame = "";
    for (let i = 0; i < 50 && !frame.includes("Ctrl+R reopen"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await t.renderOnce();
      frame = t.captureCharFrame();
    }
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
    let frame = "";
    for (let i = 0; i < 50 && !frame.includes("Ctrl+R reopen"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await t.renderOnce();
      frame = t.captureCharFrame();
    }
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

    for (let i = 0; i < 50 && !frame.includes("Ctrl+R reopen"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await t.renderOnce();
      frame = t.captureCharFrame();
    }
    t.mockInput.pressKey("r", { ctrl: true });
    for (let i = 0; i < 50 && !frame.includes("── reopened ──"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await t.renderOnce();
      frame = t.captureCharFrame();
    }
    try {
      expect(frame).toContain("── reopened ──");
      // Only the pre-UI open reported; the reopen's would land on the TUI.
      expect(progress.filter((m) => m === "Opening browser...")).toHaveLength(
        1,
      );
    } finally {
      t.mockInput.pressKey("c", { ctrl: true });
    }
    await run;
  });
});
