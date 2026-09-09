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
});

/** Minimal ChatSession dependencies: a provider that never needs a browser. */
function sessionOpts(onClose: () => void) {
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
  return {
    title: "test-cli",
    provider,
    authStore: { has: () => true } as unknown as AuthStore,
    headless: true,
    timeoutMs: 1000,
    launch: async () => ({
      page,
      close: async () => onClose(),
      kill: async () => {},
    }),
  };
}

describe("runInteractive", () => {
  test("closes the session when the renderer fails to start", async () => {
    let closed = 0;
    const boom = new Error("no tty");
    await expect(
      runInteractive({
        ...sessionOpts(() => {
          closed++;
        }),
        createRenderer: () => Promise.reject(boom),
        index: FileIndex.fromPaths([]),
      }),
    ).rejects.toBe(boom);
    expect(closed).toBe(1);
  });

  test("shows the default banner with the provider name, then quits on destroy", async () => {
    const t = await createTestRenderer({ width: 80, height: 20 });
    let frame = "";
    const run = runInteractive({
      ...sessionOpts(() => {}),
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
      ...sessionOpts(() => {}),
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
});
