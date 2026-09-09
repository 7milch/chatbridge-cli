import { afterEach, describe, expect, test } from "bun:test";
import type { StyledText } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { type Expansion, MentionError } from "../mentions/expand-mentions.js";
import { FileIndex } from "../mentions/file-index.js";
import { resolveBanner } from "./banner.js";
import { ChatModel, type ChatSessionLike } from "./chat-model.js";
import { ChatView, GUIDE, MAX_INPUT_ROWS } from "./chat-view.js";
import { POPUP_HINT } from "./mention-popup.js";
import { styled, theme } from "./theme.js";

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
    paths?: string[];
    expand?: (text: string) => Promise<Expansion>;
    headless?: boolean;
    banner?: StyledText[];
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
    headless: opts.headless ?? true,
    banner:
      opts.banner ??
      resolveBanner({
        name: "test-cli",
        version: "0.0.1",
        providerName: "dummy-chat",
      }),
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
  /** A lone ESC byte is held by the input parser until it can rule out an
   * escape sequence, so the key lands some time after the press. Waits for
   * the effect — `candidate` gone from the frame — instead of a fixed delay. */
  async function escapePopup(candidate: string, tries = 100): Promise<string> {
    t.mockInput.pressEscape();
    for (let i = 0; i < tries; i++) {
      await sleep(20);
      await t.renderOnce();
      const f = t.captureCharFrame();
      if (!f.includes(candidate)) return f;
    }
    throw new Error(
      `popup still showed ${JSON.stringify(candidate)} after Escape`,
    );
  }
  return { ...t, model, view, frameWith, escapePopup };
}

describe("ChatView", () => {
  test("shows the badge header and the guide when idle", async () => {
    const t = await setup();
    const frame = t.captureCharFrame();
    expect(frame.split("\n")[0]).toBe(
      " test-cli  dummy-chat · headless · 2s budget".padEnd(80),
    );
    expect(frame).toContain(GUIDE);
  });

  test("header says headful when not headless", async () => {
    const t = await setup({ headless: false });
    expect(t.captureCharFrame()).toContain("dummy-chat · headful · 2s budget");
  });

  test("Enter submits, clears the box, shows spinner, then the reply", async () => {
    const t = await setup({ delayMs: 300 });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    await t.frameWith("user");
    expect(t.model.messages[0]).toEqual({ role: "user", text: "hello" });
    const busy = await t.frameWith("Thinking…");
    expect(busy).toContain("user");
    expect(busy).not.toContain(GUIDE);
    const done = await t.frameWith("Echo: hello");
    expect(done).toContain("assistant");
    expect(done).toContain(GUIDE);
  });

  test("Shift+Enter inserts a newline on kitty terminals", async () => {
    const t = await setup({ kittyKeyboard: true });
    await t.mockInput.typeText("one");
    t.mockInput.pressEnter({ shift: true });
    await t.mockInput.typeText("two");
    t.mockInput.pressEnter();
    await t.frameWith("user");
    expect(t.model.messages[0]).toEqual({ role: "user", text: "one\ntwo" });
  });

  test("Ctrl+J inserts a newline on legacy terminals", async () => {
    const t = await setup();
    await t.mockInput.typeText("one");
    t.mockInput.pressKey("LINEFEED");
    await t.mockInput.typeText("two");
    t.mockInput.pressEnter();
    await t.frameWith("user");
    expect(t.model.messages[0]).toEqual({ role: "user", text: "one\ntwo" });
  });

  test("Ctrl+J inserts a newline on kitty terminals", async () => {
    // With the kitty protocol Ctrl+J is reported as ctrl+j, not as a linefeed.
    const t = await setup({ kittyKeyboard: true });
    await t.mockInput.typeText("one");
    t.mockInput.pressKey("j", { ctrl: true });
    await t.mockInput.typeText("two");
    t.mockInput.pressEnter();
    await t.frameWith("user");
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

  test("error messages are labelled error", async () => {
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
      headless: true,
      banner: [],
      index: FileIndex.fromPaths([]),
    });
    teardown = () => {
      view.destroy();
      t.renderer.destroy();
    };
    await model.submit("x");
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("error");
    expect(frame).toContain("page closed");
  });

  test("destroy() during a turn does not touch torn-down renderables", async () => {
    const t = await setup({ delayMs: 200 });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    await t.frameWith("user");
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

  test("the popup sits between the input and the status row", async () => {
    const t = await setup({ paths: ["src/a.ts"] });
    await t.mockInput.typeText("@");
    await t.renderOnce();
    const rows = t.captureCharFrame().split("\n");
    const bottomRule = rows.map((r) => r.startsWith("─")).lastIndexOf(true);
    expect(rows[bottomRule + 1]).toContain("src/a.ts");
    expect(rows[bottomRule + 2]).toContain(POPUP_HINT);
    expect(rows[bottomRule + 3]).toContain(GUIDE);
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
    // "user" entry rather than a single render pass).
    t.mockInput.pressEnter();
    await t.frameWith("user");
    expect(t.model.messages[0]?.text).toBe("@a.ts");
  });

  test("escape closes the popup and keeps the text", async () => {
    const t = await setup({ paths: ["a.ts"] });
    await t.mockInput.typeText("hi @a");
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("a.ts");
    const frame = await t.escapePopup("a.ts");
    expect(frame).toContain("hi @a");
    expect(frame).not.toContain("a.ts");
    // Enter now reaches the textarea again rather than the popup.
    t.mockInput.pressEnter();
    await t.frameWith("user");
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
    // The trailing space ends the mention, which closes the popup, so Enter
    // sends; the model trims it back off.
    await t.mockInput.typeText("look @a.ts ");
    await t.renderOnce();
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
    // The trailing space closes the popup so Enter sends.
    await t.mockInput.typeText("read @nope.ts ");
    await t.renderOnce();
    t.mockInput.pressEnter();
    const frame = await t.frameWith("@nope.ts: not found");
    expect(frame).toContain("error");
    expect(frame).toContain("read @nope.ts");
    expect(t.model.status).toBe("idle");
    expect(t.model.fatal).toBeUndefined();
  });

  test("the banner is centred in the empty history", async () => {
    const t = await setup();
    const rows = t.captureCharFrame().split("\n");
    const title = rows.findIndex((r) => r.includes("test-cli v0.0.1"));
    expect(title).toBeGreaterThan(2);
    expect(rows[title + 1]).toContain(
      "Connected to dummy-chat. Type a message, or @ to attach a file.",
    );
    // Centred: roughly as much blank space left as right.
    const line = rows[title] ?? "";
    const left = line.length - line.trimStart().length;
    const right = line.length - line.trimEnd().length;
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
    // Vertically centred between the header (2 rows) and the input.
    const inputTop = rows.findIndex((r) => r.startsWith("─"));
    expect(Math.abs(title - 2 - (inputTop - title - 2))).toBeLessThanOrEqual(2);
  });

  test("a vendor banner is drawn line by line and over-wide lines are cut", async () => {
    const t = await setup({
      banner: ["ACME", "x".repeat(120)].map((l) => styled(theme.muted(l))),
    });
    const frame = t.captureCharFrame();
    expect(frame).toContain("ACME");
    expect(frame).toContain("x".repeat(80));
    expect(frame).not.toContain("x".repeat(81));
    for (const row of frame.split("\n"))
      expect(row.length).toBeLessThanOrEqual(80);
  });

  test("the banner disappears with the first message and never returns", async () => {
    const t = await setup();
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    const frame = await t.frameWith("Echo: hello");
    expect(frame).not.toContain("test-cli v0.0.1");
  });

  test("the input is a bare > between two hairlines, one row when empty", async () => {
    const t = await setup();
    const rows = t.captureCharFrame().split("\n");
    const top = rows.findIndex((r) => r.startsWith("─"));
    expect(top).toBeGreaterThan(0);
    expect(rows[top]).toBe("─".repeat(80));
    expect(rows[top + 1]).toStartWith("> Type a message");
    expect(rows[top + 2]).toBe("─".repeat(80));
    expect(rows[top + 3]).toContain(GUIDE);
    expect(t.captureCharFrame()).not.toContain("┌");
  });

  test("the input grows one row per newline up to five, then scrolls", async () => {
    const t = await setup({ kittyKeyboard: true });
    const hairlines = () => {
      const rows = t.captureCharFrame().split("\n");
      const top = rows.findIndex((r) => r.startsWith("─"));
      const bottom = rows.findIndex((r, i) => i > top && r.startsWith("─"));
      return { rows, top, bottom, inner: bottom - top - 1 };
    };
    for (let i = 1; i <= 7; i++) {
      await t.mockInput.typeText(`line${i}`);
      await t.renderOnce();
      expect(hairlines().inner).toBe(Math.min(i, MAX_INPUT_ROWS));
      t.mockInput.pressEnter({ shift: true });
    }
    const { rows, top } = hairlines();
    // Seven lines typed (plus a trailing empty one), five visible: the
    // oldest scrolled out, the cursor line still in view.
    expect(rows[top + 1]).not.toContain("line1");
    const shown = rows.slice(top + 1, top + 1 + MAX_INPUT_ROWS).join("\n");
    expect(shown).toContain("line7");
    expect(t.captureCharFrame()).toContain(GUIDE);
  });

  test("the history shrinks to make room for the input", async () => {
    const t = await setup({ delayMs: 10, kittyKeyboard: true });
    await t.mockInput.typeText("first");
    t.mockInput.pressEnter();
    await t.frameWith("Echo: first");
    const before = t
      .captureCharFrame()
      .split("\n")
      .findIndex((r) => r.startsWith("─"));
    await t.mockInput.typeText("a");
    t.mockInput.pressEnter({ shift: true });
    await t.mockInput.typeText("b");
    t.mockInput.pressEnter({ shift: true });
    await t.mockInput.typeText("c");
    await t.renderOnce();
    const after = t
      .captureCharFrame()
      .split("\n")
      .findIndex((r) => r.startsWith("─"));
    expect(after).toBe(before - 2);
    expect(t.captureCharFrame()).toContain("Echo: first");
  });

  test("the guide mentions @ file", async () => {
    const t = await setup();
    expect(GUIDE).toBe(
      "Enter send · Shift+Enter (or Ctrl+J) newline · @ file · Ctrl+C quit",
    );
    expect(t.captureCharFrame()).toContain("@ file");
  });
});
