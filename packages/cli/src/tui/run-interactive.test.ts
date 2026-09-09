import { describe, expect, test } from "bun:test";
import type { Page, Provider } from "@chatbridge/provider";
import type { AuthStore } from "@chatbridge/runtime";
import { createTestRenderer } from "@opentui/core/testing";
import { FileIndex } from "../mentions/file-index.js";
import { ChatModel } from "./chat-model.js";
import { ChatView } from "./chat-view.js";
import {
  closeWithTimeout,
  runInteractive,
  waitForQuit,
} from "./run-interactive.js";

describe("closeWithTimeout", () => {
  test("returns true when the session closes in time", async () => {
    expect(await closeWithTimeout({ close: async () => {} }, 1000)).toBe(true);
  });

  test("returns false when the close never settles", async () => {
    const started = Date.now();
    const stuck = { close: () => new Promise<void>(() => {}) };
    expect(await closeWithTimeout(stuck, 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("swallows a rejecting close", async () => {
    const failing = {
      close: async () => {
        throw new Error("browser already gone");
      },
    };
    expect(await closeWithTimeout(failing, 1000)).toBe(true);
  });
});

describe("waitForQuit", () => {
  test("resolves when the renderer is destroyed from outside", async () => {
    // OpenTUI's own SIGINT/SIGTERM/SIGHUP handlers destroy the renderer
    // without exiting the process.
    const t = await createTestRenderer({ width: 40, height: 12 });
    const model = new ChatModel({
      async send() {
        return "";
      },
      async close() {},
    });
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
    launch: async () => ({ page, close: async () => onClose() }),
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
    expect(frame).toContain("test-cli v1.2.3");
    expect(frame).toContain("Connected to fake.");
    expect(frame).toContain("fake · headless · 1s budget");
    t.renderer.destroy();
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
    expect(frame).toContain("ACME BANNER");
    expect(frame).not.toContain("Connected to");
    t.renderer.destroy();
    await run;
  });
});
