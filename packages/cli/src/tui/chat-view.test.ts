import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { type Expansion, MentionError } from "../mentions/expand-mentions.js";
import { FileIndex } from "../mentions/file-index.js";
import { ChatModel, type ChatSessionLike } from "./chat-model.js";
import { ChatView, GUIDE } from "./chat-view.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A lone ESC byte is held by the input parser until it can rule out an
 * escape sequence, so a test must wait before the key is delivered. */
async function pressEscape(mockInput: { pressEscape: () => void }) {
  mockInput.pressEscape();
  await sleep(60);
}

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
    paths?: string[];
    expand?: (text: string) => Promise<Expansion>;
  } = {},
) {
  const t = await createTestRenderer({
    width: 80,
    height: 20,
    kittyKeyboard: opts.kittyKeyboard ?? false,
  });
  const model = new ChatModel(
    opts.session ?? echoSession(opts.delayMs ?? 100),
    {
      expand:
        opts.expand ?? (async (text) => ({ prompt: text, attachments: [] })),
    },
  );
  const view = new ChatView(t.renderer, model, {
    title: "test-cli",
    providerName: "dummy-chat",
    timeoutMs: 2_000,
    index: FileIndex.fromPaths(
      opts.paths ?? ["src/chat-view.ts", "src/chat-model.ts", "README.md"],
    ),
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
    await t.frameWith("You");
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
    await t.frameWith("You");
    expect(t.model.messages[0]).toEqual({ role: "user", text: "one\ntwo" });
  });

  test("Ctrl+J inserts a newline on legacy terminals", async () => {
    const t = await setup();
    await t.mockInput.typeText("one");
    t.mockInput.pressKey("LINEFEED");
    await t.mockInput.typeText("two");
    t.mockInput.pressEnter();
    await t.frameWith("You");
    expect(t.model.messages[0]).toEqual({ role: "user", text: "one\ntwo" });
  });

  test("Ctrl+J inserts a newline on kitty terminals", async () => {
    // With the kitty protocol Ctrl+J is reported as ctrl+j, not as a linefeed.
    const t = await setup({ kittyKeyboard: true });
    await t.mockInput.typeText("one");
    t.mockInput.pressKey("j", { ctrl: true });
    await t.mockInput.typeText("two");
    t.mockInput.pressEnter();
    await t.frameWith("You");
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
      index: FileIndex.fromPaths([]),
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
    await t.frameWith("You");
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
    const seen = new Set<string>(first ? [first] : []);
    for (let i = 0; i < 10 && seen.size < 2; i++) {
      await sleep(60);
      await t.renderOnce();
      const frame = t.captureCharFrame().match(/[●○]{3}/)?.[0];
      if (frame) seen.add(frame);
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
    await t.frameWith("Echo: hello");
  });

  test("typing @ opens the popup with candidates", async () => {
    const t = await setup();
    await t.mockInput.typeText("see @");
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("README.md");
    expect(frame).toContain("src/chat-view.ts");
  });

  test("the query after @ filters the candidates", async () => {
    const t = await setup();
    await t.mockInput.typeText("@model");
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("src/chat-model.ts");
    expect(frame).not.toContain("README.md");
  });

  test("down then tab inserts the selected path followed by a space", async () => {
    const t = await setup({ paths: ["a.ts", "b.ts"] });
    await t.mockInput.typeText("look @");
    t.mockInput.pressArrow("down");
    t.mockInput.pressTab();
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("look @b.ts ");
    expect(t.model.messages).toEqual([]);
    // Popup is gone once the mention ends with a space: "a.ts" was only
    // ever visible as a popup row.
    expect(frame).not.toContain("a.ts");
  });

  test("enter with the popup open accepts and does not send", async () => {
    const t = await setup({ paths: ["a.ts"] });
    await t.mockInput.typeText("@");
    t.mockInput.pressEnter();
    await t.renderOnce();
    expect(t.model.messages).toEqual([]);
    expect(t.captureCharFrame()).toContain("@a.ts ");
    // A second Enter, popup closed, sends (submit is async: wait for the
    // "You" entry rather than a single render pass).
    t.mockInput.pressEnter();
    await t.frameWith("You");
    expect(t.model.messages[0]?.text).toBe("@a.ts");
  });

  test("escape closes the popup and keeps the text", async () => {
    const t = await setup({ paths: ["a.ts"] });
    await t.mockInput.typeText("hi @a");
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("a.ts");
    await pressEscape(t.mockInput);
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("hi @a");
    expect(frame).not.toContain("a.ts");
    // Enter now reaches the textarea again rather than the popup.
    t.mockInput.pressEnter();
    await t.frameWith("You");
    expect(t.model.messages[0]?.text).toBe("hi @a");
  });

  test("popup closes when the cursor leaves the mention", async () => {
    const t = await setup({ paths: ["a.ts"] });
    await t.mockInput.typeText("@a ");
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("a.ts");
  });

  test("no popup for an email address", async () => {
    const t = await setup({ paths: ["example.com"] });
    await t.mockInput.typeText("mail foo@example");
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("example.com");
  });

  test("attachment lines are rendered under the user message", async () => {
    let sent = "";
    const t = await setup({
      // A plain reply, so "### a.ts" in the frame can only come from the
      // history entry for the user message.
      session: {
        async send(prompt) {
          sent = prompt;
          return "done";
        },
        async close() {},
      },
      expand: async (text) => ({
        prompt: `${text}\n\n### a.ts\n\`\`\`ts\nx\n\`\`\``,
        attachments: [
          { path: "a.ts", bytes: 512 },
          { path: "docs/big.md", bytes: 3 * 1024 * 1024 },
        ],
      }),
    });
    await t.mockInput.typeText("look @a.ts");
    // Close the popup first so Enter sends.
    await pressEscape(t.mockInput);
    t.mockInput.pressEnter();
    const frame = await t.frameWith("done");
    expect(frame).toContain("📎 a.ts (512 B)");
    expect(frame).toContain("📎 docs/big.md (3.0 MB)");
    // The history shows what the user typed; the expansion only goes out.
    expect(frame).not.toContain("### a.ts");
    expect(sent).toContain("### a.ts");
  });

  test("a mention error is shown and the textarea keeps its text", async () => {
    const t = await setup({
      expand: async () => {
        throw new MentionError(["@nope.ts: not found"]);
      },
    });
    await t.mockInput.typeText("read @nope.ts");
    await pressEscape(t.mockInput);
    t.mockInput.pressEnter();
    const frame = await t.frameWith("@nope.ts: not found");
    expect(frame).toContain("Error");
    expect(frame).toContain("read @nope.ts");
    expect(t.model.status).toBe("idle");
    expect(t.model.fatal).toBeUndefined();
  });

  test("the guide mentions @ file", async () => {
    const t = await setup();
    expect(GUIDE).toBe(
      "Enter send · Shift+Enter (or Ctrl+J) newline · @ file · Ctrl+C quit",
    );
    expect(t.captureCharFrame()).toContain("@ file");
  });
});
