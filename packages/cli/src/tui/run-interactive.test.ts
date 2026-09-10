import { describe, expect, test } from "bun:test";
import type { Page, Provider } from "@chatbridge/provider";
import type { AuthStore } from "@chatbridge/runtime";
import { createTestRenderer } from "@opentui/core/testing";
import { FileIndex } from "../mentions/file-index.js";
import { ChatModel } from "./chat-model.js";
import { ChatView } from "./chat-view.js";
import { runInteractive, waitForQuit } from "./run-interactive.js";

describe("waitForQuit", () => {
  test("resolves when the renderer is destroyed from outside", async () => {
    // OpenTUI's own SIGINT/SIGTERM/SIGHUP handlers destroy the renderer
    // without exiting the process.
    const t = await createTestRenderer({ width: 40, height: 12 });
    const model = new ChatModel(
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
    const model = new ChatModel(
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
    const model = new ChatModel(
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
      index: FileIndex.fromPaths([]),
    });
    const quit = waitForQuit(t.renderer, model);
    t.mockInput.pressKey("c", { ctrl: true });
    expect(await quit).toBeUndefined();
    view.destroy();
    t.renderer.destroy();
  });
});

/** Minimal ChatSession dependencies: a provider that never needs a browser.
 * `launches` grows by one runtime record per BrowserRuntime.launch call.
 * `gate`, when given, holds up every launch after the first, so a test can
 * keep a Ctrl+R reset in flight. */
function sessionOpts(gate?: Promise<void>) {
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
          saveAuthState: async () => {},
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
  test("closes the session when the renderer fails to start", async () => {
    const s = sessionOpts();
    const boom = new Error("no tty");
    await expect(
      runInteractive({
        ...s.opts,
        createRenderer: () => Promise.reject(boom),
        index: FileIndex.fromPaths([]),
      }),
    ).rejects.toBe(boom);
    expect(s.launches[0]?.closed).toBe(1);
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
