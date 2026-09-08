import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ChatModel, type ChatSessionLike } from "./chat-model.js";
import { ChatView, GUIDE } from "./chat-view.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function echoSession(delayMs: number): ChatSessionLike {
  return {
    async send(prompt) {
      await sleep(delayMs);
      return `Echo: ${prompt}`;
    },
    async close() {},
  };
}

let teardown: (() => void) | undefined;
afterEach(() => {
  teardown?.();
  teardown = undefined;
});

async function setup(
  opts: {
    kittyKeyboard?: boolean;
    delayMs?: number;
    session?: ChatSessionLike;
  } = {},
) {
  const t = await createTestRenderer({
    width: 60,
    height: 20,
    kittyKeyboard: opts.kittyKeyboard ?? false,
  });
  const model = new ChatModel(opts.session ?? echoSession(opts.delayMs ?? 100));
  const view = new ChatView(t.renderer, model, {
    title: "test-cli",
    providerName: "dummy-chat",
    timeoutMs: 2_000,
  });
  teardown = () => {
    view.destroy();
    t.renderer.destroy();
  };
  await t.renderOnce();
  /** Polls in real time; OpenTUI's waitForFrame does not advance timers. */
  async function frameWith(text: string, tries = 100): Promise<string> {
    for (let i = 0; i < tries; i++) {
      await sleep(20);
      await t.renderOnce();
      const f = t.captureCharFrame();
      if (f.includes(text)) return f;
    }
    throw new Error(`no frame contained ${JSON.stringify(text)}`);
  }
  return { ...t, model, view, frameWith };
}

describe("ChatView", () => {
  test("shows the header and the guide when idle", async () => {
    const t = await setup();
    const frame = t.captureCharFrame();
    expect(frame).toContain("test-cli · dummy-chat");
    expect(frame).toContain(GUIDE);
  });

  test("Enter submits, clears the box, shows spinner, then the reply", async () => {
    const t = await setup({ delayMs: 300 });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    await t.renderOnce();
    expect(t.model.messages[0]).toEqual({ role: "user", text: "hello" });
    const busy = await t.frameWith("Thinking…");
    expect(busy).toContain("You");
    expect(busy).not.toContain(GUIDE);
    const done = await t.frameWith("Echo: hello");
    expect(done).toContain("Assistant");
    expect(done).toContain(GUIDE);
  });

  test("Shift+Enter inserts a newline on kitty terminals", async () => {
    const t = await setup({ kittyKeyboard: true });
    await t.mockInput.typeText("one");
    t.mockInput.pressEnter({ shift: true });
    await t.mockInput.typeText("two");
    t.mockInput.pressEnter();
    await t.renderOnce();
    expect(t.model.messages[0]).toEqual({ role: "user", text: "one\ntwo" });
  });

  test("Ctrl+J inserts a newline on legacy terminals", async () => {
    const t = await setup();
    await t.mockInput.typeText("one");
    t.mockInput.pressKey("LINEFEED");
    await t.mockInput.typeText("two");
    t.mockInput.pressEnter();
    await t.renderOnce();
    expect(t.model.messages[0]).toEqual({ role: "user", text: "one\ntwo" });
  });

  test("Ctrl+J inserts a newline on kitty terminals", async () => {
    // With the kitty protocol Ctrl+J is reported as ctrl+j, not as a linefeed.
    const t = await setup({ kittyKeyboard: true });
    await t.mockInput.typeText("one");
    t.mockInput.pressKey("j", { ctrl: true });
    await t.mockInput.typeText("two");
    t.mockInput.pressEnter();
    await t.renderOnce();
    expect(t.model.messages[0]).toEqual({ role: "user", text: "one\ntwo" });
  });

  test("Enter while busy keeps the typed text", async () => {
    const t = await setup({ delayMs: 300 });
    await t.mockInput.typeText("first");
    t.mockInput.pressEnter();
    await t.frameWith("Thinking…");
    await t.mockInput.typeText("second");
    t.mockInput.pressEnter();
    await t.renderOnce();
    expect(t.model.messages.map((m) => m.text)).toEqual(["first"]);
    const frame = await t.frameWith("Echo: first");
    expect(frame).toContain("second");
  });

  test("error messages are labelled Error", async () => {
    const t = await createTestRenderer({ width: 60, height: 20 });
    const model = new ChatModel({
      async send() {
        throw new Error("page closed");
      },
      async close() {},
    });
    const view = new ChatView(t.renderer, model, {
      title: "test-cli",
      providerName: "dummy-chat",
      timeoutMs: 2_000,
    });
    teardown = () => {
      view.destroy();
      t.renderer.destroy();
    };
    await model.submit("x");
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Error");
    expect(frame).toContain("page closed");
  });

  test("destroy() during a turn does not touch torn-down renderables", async () => {
    const t = await setup({ delayMs: 200 });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    await t.renderOnce();
    expect(t.model.status).toBe("busy");
    // Teardown mid-turn: the reply lands after the renderer is gone.
    t.view.destroy();
    t.renderer.destroy();
    teardown = undefined;
    await sleep(400);
    expect(t.model.status).toBe("idle");
    expect(t.model.messages.map((m) => m.text)).toEqual([
      "hello",
      "Echo: hello",
    ]);
  });

  test("Enter after a fatal error keeps the typed text", async () => {
    const t = await setup({
      session: {
        async send() {
          throw new Error("page closed");
        },
        async close() {},
      },
    });
    await t.mockInput.typeText("first");
    t.mockInput.pressEnter();
    await t.frameWith("page closed");
    expect(t.model.fatal).toBeDefined();

    await t.mockInput.typeText("second");
    t.mockInput.pressEnter();
    await t.renderOnce();
    // The model would have dropped it, so the view must not clear the box.
    expect(t.model.messages.map((m) => m.text)).toEqual([
      "first",
      "page closed",
    ]);
    expect(t.captureCharFrame()).toContain("second");
  });

  test("setStatus replaces the guide on the status line", async () => {
    const t = await setup();
    t.view.setStatus("Closing browser...");
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Closing browser...");
    expect(frame).not.toContain(GUIDE);
  });

  test("history scrolls and keeps the latest reply visible", async () => {
    const t = await setup({ delayMs: 10 });
    for (let i = 0; i < 12; i++) {
      await t.mockInput.typeText(`msg ${i}`);
      t.mockInput.pressEnter();
      await t.frameWith(`Echo: msg ${i}`);
    }
    const frame = t.captureCharFrame();
    expect(frame).toContain("Echo: msg 11");
    expect(frame).not.toContain("Echo: msg 0 ");
  });

  test("shows elapsed time against the timeout budget while busy", async () => {
    const t = await setup({ delayMs: 400 });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    const busy = await t.frameWith("Thinking…");
    expect(busy).toMatch(/[●○]{3} Thinking… {2}\ds \/ 2s/);
    await t.frameWith("Echo: hello");
    expect(t.captureCharFrame()).toContain(GUIDE);
  });

  test("the indicator animates", async () => {
    const t = await setup({ delayMs: 600 });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    const first = (await t.frameWith("Thinking…")).match(/[●○]{3}/)?.[0];
    const seen = new Set<string>([first ?? ""]);
    for (let i = 0; i < 10 && seen.size < 2; i++) {
      await sleep(60);
      await t.renderOnce();
      const frame = t.captureCharFrame().match(/[●○]{3}/)?.[0];
      if (frame) seen.add(frame);
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
    await t.frameWith("Echo: hello");
  });
});
