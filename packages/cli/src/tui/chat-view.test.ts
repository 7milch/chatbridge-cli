import { afterEach, describe, expect, test } from "bun:test";
import type { StyledText } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { type Expansion, MentionError } from "../mentions/expand-mentions.js";
import { FileIndex } from "../mentions/file-index.js";
import type {
  RunOptions,
  RunningCommand,
  ShellResult,
} from "../shell/run-command.js";
import type { ShellConfig } from "../shell/shell-config.js";
import { resolveBanner } from "./banner.js";
import {
  ChatModel,
  type ChatModelOptions,
  type ChatSessionLike,
} from "./chat-model.js";
import {
  ChatView,
  DEAD_GUIDE,
  GUIDE,
  HELD_GUIDE,
  LOGIN_STATUS,
  MAX_INPUT_ROWS,
  MAX_QUEUE_ROWS,
  OPENING_STATUS,
  QUEUE_GUIDE,
  RESETTING_STATUS,
  SHELL_GUIDE,
  SHELL_PLACEHOLDER,
  idleGuide,
} from "./chat-view.js";
import { POPUP_HINT } from "./mention-popup.js";
import { type ResolvedSpinner, resolveSpinner } from "./spinner.js";
import { styled, theme } from "./theme.js";

/** Builds a model whose first open resolves to `session` and whose reopens
 * go to `opts.openSession`, then waits for the eager open so the model
 * starts idle. */
async function modelWith(
  session: ChatSessionLike,
  opts: Partial<ChatModelOptions> = {},
  gate?: Promise<void>,
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
        if (gate) await gate;
        return session;
      }
      if (!reopen) throw new Error("not expected");
      return reopen();
    },
  });
  // A gated first open leaves the model `opening`, which is the point of
  // the tests that pass one.
  if (!gate) await model.ready;
  return model;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function echoSession(delayMs: number): ChatSessionLike {
  return {
    async send(prompt) {
      await sleep(delayMs);
      return `Echo: ${prompt}`;
    },
    async close() {},
    async kill() {},
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeRunner() {
  const calls: string[] = [];
  let output = "";
  let resolve: ((r: ShellResult) => void) | undefined;
  let reject: ((e: unknown) => void) | undefined;
  let onOutput: ((t: string) => void) | undefined;
  let current: ShellResult | undefined;
  const runCommand = (command: string, opts: RunOptions): RunningCommand => {
    calls.push(command);
    output = "";
    onOutput = opts.onOutput;
    current = {
      command,
      output: "",
      droppedBytes: 0,
      exitCode: 0,
      interrupted: false,
      durationMs: 1,
    };
    const done = new Promise<ShellResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return {
      done,
      stop() {
        if (current)
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
      if (current) resolve?.({ ...current, output, ...over });
    },
    fail(err: unknown) {
      reject?.(err);
    },
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
    openSession?: () => Promise<ChatSessionLike>;
    paths?: string[];
    expand?: (text: string) => Promise<Expansion>;
    headless?: boolean;
    banner?: StyledText[];
    spinner?: ResolvedSpinner;
    width?: number;
    runCommand?: (c: string, o: RunOptions) => RunningCommand;
    shell?: ShellConfig;
    /** Holds the first open open, so the model stays `opening`. */
    openGate?: Promise<void>;
    login?: ChatModelOptions["login"];
  } = {},
) {
  const t = await createTestRenderer({
    width: opts.width ?? 80,
    height: 20,
    kittyKeyboard: opts.kittyKeyboard ?? false,
  });
  const model = await modelWith(
    opts.session ?? echoSession(opts.delayMs ?? 100),
    {
      openSession:
        opts.openSession ?? (async () => echoSession(opts.delayMs ?? 100)),
      closeTimeoutMs: 50,
      expand:
        opts.expand ?? (async (text) => ({ prompt: text, attachments: [] })),
      runCommand: opts.runCommand,
      shell: opts.shell,
      ...(opts.login ? { login: opts.login } : {}),
    },
    opts.openGate,
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
    spinner: opts.spinner ?? resolveSpinner(),
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

  test("Enter while busy queues the text", async () => {
    const t = await setup({ delayMs: 300 });
    await t.mockInput.typeText("first");
    t.mockInput.pressEnter();
    await t.frameWith("Thinking…");
    await t.mockInput.typeText("second");
    t.mockInput.pressEnter();
    await t.renderOnce();
    expect(t.model.queue).toEqual(["second"]);
    expect(t.model.messages.map((m) => m.text)).toEqual(["first"]);
    await t.frameWith("Echo: first");
    expect(await t.frameWith("Echo: second")).toContain("Echo: second");
  });

  test("error messages are labelled error", async () => {
    const t = await createTestRenderer({ width: 60, height: 20 });
    const model = await modelWith(
      {
        async send() {
          throw new Error("page closed");
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
      timeoutMs: 2_000,
      headless: true,
      banner: [],
      spinner: resolveSpinner(),
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

  test("Enter after a fatal error queues the text", async () => {
    const t = await setup({
      session: {
        async send() {
          throw new Error("page closed");
        },
        async close() {},
        async kill() {},
      },
    });
    await t.mockInput.typeText("first");
    t.mockInput.pressEnter();
    await t.frameWith("page closed");
    expect(t.model.fatal).toBeDefined();

    await t.mockInput.typeText("second");
    t.mockInput.pressEnter();
    await t.renderOnce();
    // A dead model queues rather than sends: the text survives in the queue
    // and Ctrl+R replays it, so the box is cleared like anywhere else.
    expect(t.model.messages.map((m) => m.text)).toEqual([
      "first",
      "page closed",
    ]);
    expect(t.model.queue).toEqual(["second"]);
    expect(await t.frameWith("▹ second")).toContain("▹ second");
  });

  test("the status row says the browser is opening until the open lands", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const t = await setup({ openGate: gate });
    expect(t.model.status).toBe("opening");
    expect(await t.frameWith(OPENING_STATUS)).toContain(OPENING_STATUS);
    release();
    await t.model.ready;
    expect(await t.frameWith(GUIDE)).toContain(GUIDE);
  });

  test("/login shows the login status, then the latest progress line", async () => {
    let report!: (message: string) => void;
    const done = deferred<void>();
    const t = await setup({
      login: async ({ onProgress }) => {
        report = onProgress;
        await done.promise;
      },
    });
    const login = t.model.submit("/login");
    expect(await t.frameWith(LOGIN_STATUS)).toContain(LOGIN_STATUS);
    report("Waiting for the login page...");
    const frame = await t.frameWith("Waiting for the login page...");
    expect(frame).not.toContain(LOGIN_STATUS);
    done.resolve();
    await login;
  });

  test("a help entry renders verbatim with no role label", async () => {
    const t = await setup();
    await t.model.submit("/help");
    const frame = await t.frameWith("/login");
    expect(frame).toContain("/login   Log in in a browser window");
    expect(frame).toContain("/help    List these commands");
    // No "help" label row above it; the text is the whole entry.
    expect(frame).not.toMatch(/^help\s*$/m);
  });

  test("the dead guide points at /login", async () => {
    const t = await setup({
      session: {
        async send() {
          throw new Error("page closed");
        },
        async close() {},
        async kill() {},
      },
    });
    await t.model.submit("boom");
    expect(t.model.status).toBe("dead");
    const frame = await t.frameWith(DEAD_GUIDE);
    expect(frame).toContain("Ctrl+R reopen · /login · Ctrl+C quit");
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

  test("a vendor spinner replaces frames and label", async () => {
    const t = await setup({
      delayMs: 400,
      spinner: { frames: ["<>", "><"], intervalMs: 120, labels: ["Working…"] },
    });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    const busy = await t.frameWith("Working…");
    expect(busy).toMatch(/(<>|><) Working… {2}\ds \/ 2s/);
    expect(busy).not.toContain("Thinking…");
  });

  test("a vendor interval drives the frame rate", async () => {
    const t = await setup({
      delayMs: 600,
      spinner: { frames: ["A1", "B2"], intervalMs: 30, labels: ["Go"] },
    });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    await t.frameWith("Go");
    const seen = new Set<string>();
    for (let i = 0; i < 10 && seen.size < 2; i++) {
      await sleep(20);
      await t.renderOnce();
      const m = t.captureCharFrame().match(/(A1|B2) Go/)?.[1];
      if (m) seen.add(m);
    }
    expect(seen.size).toBe(2);
  });

  test("one label is picked per turn and kept across frames", async () => {
    const random = Math.random;
    Math.random = () => 0.99;
    try {
      const t = await setup({
        delayMs: 400,
        spinner: {
          frames: ["●○○", "○●○"],
          intervalMs: 30,
          labels: ["First…", "Second…", "Third…"],
        },
      });
      await t.mockInput.typeText("hello");
      t.mockInput.pressEnter();
      await t.frameWith("Third…");
      Math.random = () => 0;
      for (let i = 0; i < 5; i++) {
        await sleep(30);
        await t.renderOnce();
        expect(t.captureCharFrame()).toContain("Third…");
      }
      await t.frameWith("Echo: hello");
      await t.mockInput.typeText("again");
      t.mockInput.pressEnter();
      expect(await t.frameWith("First…")).not.toContain("Third…");
    } finally {
      Math.random = random;
    }
  });

  test("a drained queued turn picks a new label", async () => {
    const random = Math.random;
    Math.random = () => 0.99;
    try {
      const t = await setup({
        delayMs: 300,
        spinner: {
          frames: ["●○○", "○●○"],
          intervalMs: 30,
          labels: ["First…", "Second…", "Third…"],
        },
      });
      await t.mockInput.typeText("one");
      t.mockInput.pressEnter();
      await t.frameWith("Third…");
      // Queued: the view stays busy, so the spinner is never restarted.
      await t.mockInput.typeText("two");
      t.mockInput.pressEnter();
      Math.random = () => 0;
      await t.frameWith("Echo: one");
      expect(await t.frameWith("First…")).not.toContain("Third…");
    } finally {
      Math.random = random;
    }
  });

  test("a coloured spinner renders the same text", async () => {
    const t = await setup({
      delayMs: 400,
      spinner: {
        frames: ["**"],
        intervalMs: 120,
        labels: ["Tinted…"],
        frameColor: 4,
        labelColor: "#8a8a8a",
      },
    });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    const busy = await t.frameWith("Tinted…");
    expect(busy).toMatch(/\*\* Tinted… {2}\ds \/ 2s/);
  });

  test("an empty label list shows the frame alone", async () => {
    const t = await setup({
      delayMs: 400,
      spinner: { frames: ["##"], intervalMs: 120, labels: [] },
    });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    const busy = await t.frameWith("## ");
    expect(busy).toMatch(/## {3}\ds \/ 2s/);
  });

  test("a renderer destroyed mid-turn stops the indicator instead of writing", async () => {
    // OpenTUI's own SIGINT handler destroys the renderer without telling the
    // view; the spinner interval would then write to a freed text buffer,
    // and runInteractive only calls destroy() after the browser has closed.
    const t = await setup({ delayMs: 5_000 });
    await t.mockInput.typeText("hello");
    t.mockInput.pressEnter();
    await t.frameWith("Thinking…");
    t.renderer.destroy();
    // Several spinner frames (120 ms each) must pass without a throw.
    await sleep(400);
    expect(() => t.view.setStatus("Closing browser...")).not.toThrow();
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
    expect(bottomRule).toBeGreaterThan(0);
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
        async kill() {},
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

  test("a refill that starts with ! does not turn the message into a command", async () => {
    const t = await setup({
      expand: async () => {
        throw new MentionError(["@nope.ts: not found"]);
      },
    });
    // `!` typed after other text is plain text, not the shell prefix; the
    // leading character is then deleted so the refill starts with `!`.
    await t.mockInput.typeText("z!@nope.ts ");
    await t.renderOnce();
    t.mockInput.pressKey("HOME");
    t.mockInput.pressKey("DELETE");
    await t.renderOnce();
    expect(t.view.shellMode).toBe(false);
    t.mockInput.pressEnter();
    const frame = await t.frameWith("@nope.ts: not found");
    expect(frame).toContain("error");
    // The text came back whole, with the `!` still part of it.
    expect(frame).toContain("!@nope.ts");
    expect(t.view.shellMode).toBe(false);
  });

  test("the banner is centred in the empty history", async () => {
    const t = await setup();
    const rows = t.captureCharFrame().split("\n");
    const title = rows.findIndex((r) => r.includes("test-cli v0.0.1"));
    expect(title).toBeGreaterThan(2);
    expect(rows[title + 1]).toContain("Connected to dummy-chat.");
    expect(rows[title + 2]).toContain(
      "Type a message, @ to attach a file, ! to run a command.",
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

  test("the input grows for a single line that wraps", async () => {
    const t = await setup({ width: 40 });
    const inner = () => {
      const rows = t.captureCharFrame().split("\n");
      const top = rows.findIndex((r) => r.startsWith("─"));
      const bottom = rows.findIndex((r, i) => i > top && r.startsWith("─"));
      return { rows, top, count: bottom - top - 1 };
    };
    expect(inner().count).toBe(1);
    // 100 code units with no newline: at 38 usable columns that is 3 rows.
    await t.mockInput.typeText("w".repeat(100));
    await t.renderOnce();
    const { rows, top, count } = inner();
    expect(count).toBe(3);
    expect(rows.slice(top + 1, top + 1 + count).join("")).toContain(
      "w".repeat(30),
    );
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
      "Enter send · @ file · ! shell · / commands · Ctrl+R reopen · Ctrl+C quit",
    );
    // Must fit an 80-column terminal, or the status row clips.
    expect([...GUIDE].length).toBeLessThanOrEqual(80);
    expect(t.captureCharFrame()).toContain("@ file");
  });

  test("the guide mentions Ctrl+R reopen", async () => {
    const t = await setup();
    expect(t.captureCharFrame()).toContain("Ctrl+R reopen");
  });

  test("Ctrl+R resets the model and draws a separator", async () => {
    const t = await setup();
    t.mockInput.pressKey("r", { ctrl: true });
    const frame = await t.frameWith("── reopened ──");
    expect(t.model.status).toBe("idle");
    expect(frame).toContain(GUIDE);
    expect(t.model.messages).toEqual([{ role: "separator", text: "reopened" }]);
  });

  test("Ctrl+R resets the model on kitty terminals too", async () => {
    const t = await setup({ kittyKeyboard: true });
    t.mockInput.pressKey("r", { ctrl: true });
    await t.frameWith("── reopened ──");
    expect(t.model.status).toBe("idle");
  });

  test("Ctrl+R while busy replaces the spinner with the resetting status", async () => {
    const gate = deferred<ChatSessionLike>();
    const t = await setup({
      delayMs: 5_000,
      openSession: () => gate.promise,
    });
    await t.mockInput.typeText("hang");
    t.mockInput.pressEnter();
    await t.frameWith("Thinking…");
    t.mockInput.pressKey("r", { ctrl: true });
    const resetting = await t.frameWith(RESETTING_STATUS);
    expect(resetting).not.toContain("Thinking…");
    gate.resolve(echoSession(10));
    const done = await t.frameWith("── reopened ──");
    expect(done).toContain(GUIDE);
    expect(done).toContain("hang"); // history kept
  });

  test("a fatal error shows the dead guide and Ctrl+R recovers", async () => {
    const t = await setup({
      session: {
        async send() {
          throw new Error("page closed");
        },
        async close() {},
        async kill() {},
      },
    });
    await t.mockInput.typeText("x");
    t.mockInput.pressEnter();
    const dead = await t.frameWith(DEAD_GUIDE);
    expect(dead).toContain("page closed");
    expect(dead).not.toContain(GUIDE);
    t.mockInput.pressKey("r", { ctrl: true });
    const back = await t.frameWith("── reopened ──");
    expect(back).toContain(GUIDE);
    expect(t.model.fatal).toBeUndefined();
  });

  test("a failed reopen keeps the dead guide and shows the error", async () => {
    const t = await setup({
      openSession: async () => {
        throw new Error("auth gone");
      },
    });
    t.mockInput.pressKey("r", { ctrl: true });
    const frame = await t.frameWith("auth gone");
    expect(frame).toContain(DEAD_GUIDE);
    expect(t.model.status).toBe("dead");
  });

  test("Ctrl+R works with the mention popup open", async () => {
    const t = await setup();
    await t.mockInput.typeText("see @chat");
    await t.frameWith("src/chat-view.ts");
    t.mockInput.pressKey("r", { ctrl: true });
    await t.frameWith("── reopened ──");
    expect(t.model.status).toBe("idle");
  });

  test("the separator has no role label", async () => {
    const t = await setup();
    await t.model.reset();
    const frame = await t.frameWith("── reopened ──");
    expect(frame).not.toContain("separator");
  });
});

describe("ChatView shell mode", () => {
  /** Presses Esc and waits for shell mode to end: a lone ESC byte is held
   * by the input parser until it can rule out an escape sequence. */
  async function leaveShellMode(t: {
    mockInput: { pressEscape(): void };
    renderOnce(): Promise<unknown>;
    view: ChatView;
  }) {
    t.mockInput.pressEscape();
    for (let i = 0; i < 100 && t.view.shellMode; i++) {
      await sleep(20);
      await t.renderOnce();
    }
    expect(t.view.shellMode).toBe(false);
  }

  test("! on an empty input enters shell mode and is not typed", async () => {
    const t = await setup();
    await t.mockInput.typeText("!");
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(t.view.shellMode).toBe(true);
    expect(frame).toContain(`! ${SHELL_PLACEHOLDER}`);
    expect(frame).toContain(SHELL_GUIDE);
    expect(frame).not.toContain(GUIDE);
    await t.mockInput.typeText("ls");
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("! ls");
  });

  test("a ! after other text is an ordinary character", async () => {
    const t = await setup();
    await t.mockInput.typeText("wow!");
    await t.renderOnce();
    expect(t.view.shellMode).toBe(false);
    expect(t.captureCharFrame()).toContain("> wow!");
  });

  test("a pasted !command enters shell mode with the command kept", async () => {
    const t = await setup();
    await t.mockInput.pasteBracketedText("!git status");
    await t.renderOnce();
    expect(t.view.shellMode).toBe(true);
    expect(t.captureCharFrame()).toContain("! git status");
  });

  test("Escape on an empty shell input exits shell mode", async () => {
    const t = await setup();
    await t.mockInput.typeText("!");
    await t.renderOnce();
    t.mockInput.pressEscape();
    for (let i = 0; i < 100 && t.view.shellMode; i++) {
      await sleep(20);
      await t.renderOnce();
    }
    expect(t.view.shellMode).toBe(false);
    expect(t.captureCharFrame()).toContain("> Type a message");
    expect(t.captureCharFrame()).toContain(GUIDE);
  });

  test("Backspace exits only once the input is empty", async () => {
    const t = await setup();
    await t.mockInput.typeText("!a");
    t.mockInput.pressBackspace();
    await t.renderOnce();
    expect(t.view.shellMode).toBe(true);
    t.mockInput.pressBackspace();
    await t.renderOnce();
    expect(t.view.shellMode).toBe(false);
  });

  test("Ctrl+U on an empty shell input exits shell mode", async () => {
    const t = await setup();
    await t.mockInput.typeText("!");
    t.mockInput.pressKey("u", { ctrl: true });
    await t.renderOnce();
    expect(t.view.shellMode).toBe(false);
  });

  test("@ shows no popup in shell mode", async () => {
    const t = await setup({ paths: ["types/node.d.ts"] });
    await t.mockInput.typeText("!npm i @types");
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("types/node.d.ts");
    expect(t.captureCharFrame()).not.toContain(POPUP_HINT);
  });

  test("Enter runs the command, leaves shell mode, streams output, then sends", async () => {
    const runner = fakeRunner();
    const t = await setup({ runCommand: runner.runCommand, delayMs: 200 });
    await t.mockInput.typeText("!echo hi");
    t.mockInput.pressEnter();
    const running = await t.frameWith("Running…");
    expect(runner.calls).toEqual(["echo hi"]);
    expect(running).toContain("shell");
    expect(running).toContain("$ echo hi");
    expect(running).toMatch(/[●○]{3} Running… {2}\ds · Ctrl\+C stop/);
    // The box is back to message mode while the command runs, so the
    // next thing typed is a message about the output, not a command.
    expect(t.view.shellMode).toBe(false);
    expect(running).not.toContain(`! ${SHELL_PLACEHOLDER}`);
    expect(running).toContain("Type a message");

    runner.emit("line one\n");
    const live = await t.frameWith("line one");
    runner.emit("line two\n");
    const more = await t.frameWith("line two");
    expect(more).toContain("line one");
    expect(live).not.toContain("Thinking…");

    runner.finish({ exitCode: 0 });
    const thinking = await t.frameWith("Thinking…");
    expect(thinking).not.toContain("Running…");
    const done = await t.frameWith("Echo: Please check");
    expect(done).toContain("assistant");
    expect(done).toContain(GUIDE);
    expect(done).not.toContain("exit code");
  });

  test("! on the empty input re-enters shell mode after a command", async () => {
    const runner = fakeRunner();
    const t = await setup({ runCommand: runner.runCommand });
    await t.mockInput.typeText("!true");
    t.mockInput.pressEnter();
    await t.frameWith("Running…");
    expect(t.view.shellMode).toBe(false);
    runner.finish({ exitCode: 0 });
    await t.frameWith("Echo: Please check");
    await t.mockInput.typeText("!");
    await t.renderOnce();
    expect(t.view.shellMode).toBe(true);
    expect(t.view.inputText).toBe("");
  });

  test("Enter with an empty shell input does nothing", async () => {
    const runner = fakeRunner();
    const t = await setup({ runCommand: runner.runCommand });
    await t.mockInput.typeText("!");
    t.mockInput.pressEnter();
    await t.renderOnce();
    expect(runner.calls).toEqual([]);
    expect(t.model.messages).toEqual([]);
  });

  test("non-zero exit, interrupted and truncation are shown as a footer", async () => {
    const runner = fakeRunner();
    const t = await setup({
      runCommand: runner.runCommand,
      shell: { leadIn: "x", autoSend: false },
    });
    await t.mockInput.typeText("!false");
    t.mockInput.pressEnter();
    await t.frameWith("Running…");
    runner.finish({ exitCode: 1, interrupted: true, droppedBytes: 2048 });
    const frame = await t.frameWith("exit code: 1");
    expect(frame).toContain("interrupted");
    expect(frame).toContain("… (truncated: first 2 KB dropped)");
  });

  test("a signal death is shown as a footer", async () => {
    const runner = fakeRunner();
    const t = await setup({
      runCommand: runner.runCommand,
      shell: { leadIn: "x", autoSend: false },
    });
    await t.mockInput.typeText("!./crashy");
    t.mockInput.pressEnter();
    await t.frameWith("Running…");
    runner.finish({ exitCode: undefined, signal: "SIGSEGV" });
    const frame = await t.frameWith("killed by SIGSEGV");
    expect(frame).not.toContain("exit code");
    expect(frame).not.toContain("interrupted");
  });

  test("autoSend off: held footer, held count in the guide, cleared on send", async () => {
    const runner = fakeRunner();
    const t = await setup({
      runCommand: runner.runCommand,
      shell: { leadIn: "x", autoSend: false },
      delayMs: 10,
    });
    await t.mockInput.typeText("!ls");
    t.mockInput.pressEnter();
    await t.frameWith("Running…");
    runner.emit("a.ts\n");
    runner.finish();
    const held = await t.frameWith("📎 held, sent with your next message");
    // Enter left shell mode, so the idle guide is the held one.
    expect(t.view.shellMode).toBe(false);
    expect(held).toContain(`📎 1 held · ${HELD_GUIDE}`);
    expect(t.model.status).toBe("idle");

    await t.mockInput.typeText("what is this?");
    t.mockInput.pressEnter();
    const done = await t.frameWith("Echo: what is this?");
    expect(done).toContain(GUIDE);
    expect(done).not.toContain("held");
  });

  test("Ctrl+R while running stops the command and reopens", async () => {
    const runner = fakeRunner();
    const t = await setup({ runCommand: runner.runCommand });
    await t.mockInput.typeText("!sleep 10");
    t.mockInput.pressEnter();
    await t.frameWith("Running…");
    t.mockInput.pressKey("r", { ctrl: true });
    const frame = await t.frameWith("── reopened ──");
    expect(frame).toContain("interrupted");
    expect(t.model.status).toBe("idle");
  });

  test("a message typed while a command runs is queued and listed", async () => {
    const runner = fakeRunner();
    const t = await setup({ runCommand: runner.runCommand });
    await t.mockInput.typeText("!sleep 10");
    t.mockInput.pressEnter();
    await t.frameWith("Running…");
    // Enter already left shell mode; the command keeps running underneath.
    expect(t.view.shellMode).toBe(false);
    expect(t.model.status).toBe("running");
    await t.mockInput.typeText("and then?");
    t.mockInput.pressEnter();
    const frame = await t.frameWith("▹ and then?");
    expect(t.model.queue).toEqual(["and then?"]);
    expect(t.view.inputText).toBe("");
    expect(frame).toContain("Running…");
    expect(frame).toContain("· 1 queued");
    // The command's own turn goes out first; the queued message follows it.
    runner.finish({ exitCode: 0 });
    const done = await t.frameWith("Echo: and then?");
    expect(done).not.toContain("▹");
  });

  test("Up is not a take-back in shell mode; Esc first, then it is", async () => {
    const runner = fakeRunner();
    const t = await setup({ runCommand: runner.runCommand });
    await t.mockInput.typeText("!sleep 10");
    t.mockInput.pressEnter();
    await t.frameWith("Running…");
    await t.mockInput.typeText("and then?");
    t.mockInput.pressEnter();
    await t.frameWith("▹ and then?");

    // Back into shell mode: the box is for a command, so Up must not drop
    // the queued message into it.
    await t.mockInput.typeText("!");
    await t.renderOnce();
    expect(t.view.shellMode).toBe(true);
    t.mockInput.pressArrow("up");
    await t.renderOnce();
    expect(t.model.queue).toEqual(["and then?"]);
    expect(t.view.inputText).toBe("");
    // The entry is still listed; the status row is the running one.
    const held = t.captureCharFrame();
    expect(held).toContain("▹ and then?");
    expect(held).toContain("· 1 queued");

    await leaveShellMode(t);
    t.mockInput.pressArrow("up");
    await t.renderOnce();
    expect(t.model.queue).toEqual([]);
    expect(t.view.inputText).toBe("and then?");
    runner.finish({ exitCode: 0 });
  });

  test("a taken-back entry starting with ! stays a message", async () => {
    const t = await setup({ delayMs: 10_000 });
    await t.mockInput.typeText("first");
    t.mockInput.pressEnter();
    await t.frameWith("Thinking…");
    // `!` typed after other text is plain text; deleting the leading
    // character leaves a message that starts with `!`.
    await t.mockInput.typeText("a!foo");
    await t.renderOnce();
    t.mockInput.pressKey("HOME");
    t.mockInput.pressKey("DELETE");
    await t.renderOnce();
    expect(t.view.shellMode).toBe(false);
    expect(t.view.inputText).toBe("!foo");
    t.mockInput.pressEnter();
    await t.frameWith("▹ !foo");
    expect(t.model.queue).toEqual(["!foo"]);

    t.mockInput.pressArrow("up");
    await t.renderOnce();
    // The refill is the message it was, not a command: no shell mode.
    expect(t.view.inputText).toBe("!foo");
    expect(t.view.shellMode).toBe(false);
    expect(t.model.queue).toEqual([]);
  });

  test("idleGuide texts fit 80 columns", () => {
    for (const text of [
      idleGuide(false, 0, 0),
      idleGuide(true, 0, 0),
      idleGuide(false, 12, 0),
      idleGuide(true, 12, 0),
      idleGuide(false, 0, 3),
      idleGuide(false, 12, 3),
      idleGuide(true, 12, 3),
      DEAD_GUIDE,
      QUEUE_GUIDE,
    ]) {
      expect([...text].length).toBeLessThanOrEqual(78); // 📎 is 2 cells wide
    }
    expect(idleGuide(false, 0, 0)).toBe(GUIDE);
    expect(idleGuide(true, 0, 0)).toBe(SHELL_GUIDE);
    expect(idleGuide(false, 2, 0)).toBe(`📎 2 held · ${HELD_GUIDE}`);
    expect(idleGuide(true, 2, 0)).toBe(`📎 2 held · ${SHELL_GUIDE}`);
    // A waiting queue takes the guide over, except in shell mode where
    // `Up` is not a take-back.
    expect(idleGuide(false, 0, 1)).toBe(QUEUE_GUIDE);
    expect(idleGuide(false, 2, 1)).toBe(`📎 2 held · ${QUEUE_GUIDE}`);
    expect(idleGuide(true, 0, 1)).toBe(SHELL_GUIDE);
  });

  test("a shell that cannot start is marked on its entry and explained after it", async () => {
    const runner = fakeRunner();
    const t = await setup({ runCommand: runner.runCommand });
    await t.mockInput.typeText("!ls");
    t.mockInput.pressEnter();
    await t.frameWith("Running…");
    runner.fail(new Error("spawn /no/sh ENOENT"));
    const frame = await t.frameWith(
      "could not start shell: spawn /no/sh ENOENT",
    );
    expect(frame).toContain("did not start");
    expect(t.model.status).toBe("idle");
  });
});

describe("ChatView queue", () => {
  /** Starts a turn that stays busy until `release` is called. */
  async function busySetup() {
    const reply = deferred<string>();
    const t = await setup({
      session: {
        async send() {
          return reply.promise;
        },
        async close() {},
        async kill() {},
      },
    });
    await t.mockInput.typeText("first");
    t.mockInput.pressEnter();
    await t.frameWith("Thinking…");
    return { ...t, release: () => reply.resolve("done") };
  }

  test("Enter while busy queues the text, clears the box and lists it above the input", async () => {
    const t = await busySetup();
    await t.mockInput.typeText("second line one\nmore");
    t.mockInput.pressEnter();
    const frame = await t.frameWith("▹ second line one");
    expect(t.model.queue).toEqual(["second line one\nmore"]);
    expect(frame).not.toContain("more");
    const rows = frame.split("\n");
    const list = rows.findIndex((r) => r.includes("▹ second line one"));
    const topRule = rows.findIndex((r, i) => i > list && r.startsWith("─"));
    expect(topRule).toBe(list + 1);
    expect(frame).toContain("· 1 queued");
    t.release();
    await t.frameWith("done");
  });

  test("shows at most MAX_QUEUE_ROWS rows, the last one a +N more line", async () => {
    const t = await busySetup();
    for (let i = 1; i <= MAX_QUEUE_ROWS + 2; i++) {
      await t.mockInput.typeText(`q${i}`);
      t.mockInput.pressEnter();
    }
    const frame = await t.frameWith("… +3 more");
    for (let i = 1; i < MAX_QUEUE_ROWS; i++) expect(frame).toContain(`▹ q${i}`);
    expect(frame).not.toContain(`▹ q${MAX_QUEUE_ROWS}`);
    expect(frame).toContain(`· ${MAX_QUEUE_ROWS + 2} queued`);
    t.release();
  });

  test("the list disappears once the queue drains", async () => {
    const t = await busySetup();
    await t.mockInput.typeText("second");
    t.mockInput.pressEnter();
    await t.frameWith("▹ second");
    t.release();
    // The fake session resolves every send with the same settled promise,
    // so the drained turn also replies "done": two replies on screen.
    let frame = "";

    for (let i = 0; i < 100; i++) {
      frame = await t.frameWith("done");
      if (frame.split("done").length - 1 >= 2) break;
    }
    expect(frame.split("done").length - 1).toBe(2);
    expect(frame).not.toContain("▹");
    expect(frame).toContain(GUIDE);
  });

  test("a dead model with a queue shows the take-back guide", async () => {
    const reply = deferred<string>();
    const t = await setup({
      session: {
        async send() {
          return reply.promise;
        },
        async close() {},
        async kill() {},
      },
    });
    await t.mockInput.typeText("first");
    t.mockInput.pressEnter();
    await t.frameWith("Thinking…");
    await t.mockInput.typeText("second");
    t.mockInput.pressEnter();
    await t.frameWith("▹ second");
    reply.reject(new Error("boom"));
    const frame = await t.frameWith("boom");
    expect(frame).toContain(QUEUE_GUIDE);
    // DEAD_GUIDE is a suffix of QUEUE_GUIDE, so only the take-back prefix
    // tells the two apart on screen.
    expect(QUEUE_GUIDE).toStartWith("Up take back ·");
  });

  test("Up on the first line takes the queue back ahead of the typed text", async () => {
    const t = await busySetup();
    await t.mockInput.typeText("second");
    t.mockInput.pressEnter();
    await t.mockInput.typeText("third");
    t.mockInput.pressEnter();
    await t.frameWith("▹ third");
    await t.mockInput.typeText("typed");
    t.mockInput.pressArrow("up");
    await t.renderOnce();
    expect(t.model.queue).toEqual([]);
    expect(t.view.inputText).toBe("second\nthird\ntyped");
    const frame = t.captureCharFrame();
    expect(frame).not.toContain("▹");
    // Enter re-queues the whole box as one entry.
    t.mockInput.pressEnter();
    await t.frameWith("▹ second");
    expect(t.model.queue).toEqual(["second\nthird\ntyped"]);
    t.release();
  });

  test("Up with an empty box takes the queue back without a trailing newline", async () => {
    const t = await busySetup();
    await t.mockInput.typeText("second");
    t.mockInput.pressEnter();
    await t.frameWith("▹ second");
    t.mockInput.pressArrow("up");
    await t.renderOnce();
    expect(t.view.inputText).toBe("second");
    t.release();
  });

  test("Up on the second line does not take the queue back", async () => {
    const t = await busySetup();
    await t.mockInput.typeText("second");
    t.mockInput.pressEnter();
    await t.frameWith("▹ second");
    await t.mockInput.typeText("a");
    t.mockInput.pressKey("LINEFEED");
    await t.mockInput.typeText("b");
    t.mockInput.pressArrow("up");
    await t.renderOnce();
    expect(t.model.queue).toEqual(["second"]);
    expect(t.view.inputText).toBe("a\nb");
    t.release();
  });

  test("Up with an empty queue reaches the textarea", async () => {
    const t = await setup();
    await t.mockInput.typeText("a");
    t.mockInput.pressKey("LINEFEED");
    await t.mockInput.typeText("b");
    t.mockInput.pressArrow("up");
    await t.mockInput.typeText("X");
    await t.renderOnce();
    expect(t.view.inputText).toBe("aX\nb");
  });
  test("the elapsed timer restarts for a drained turn", async () => {
    const replies: Array<ReturnType<typeof deferred<string>>> = [];
    const t = await setup({
      session: {
        async send() {
          const d = deferred<string>();
          replies.push(d);
          return d.promise;
        },
        async close() {},
        async kill() {},
      },
    });
    await t.mockInput.typeText("first");
    t.mockInput.pressEnter();
    await t.frameWith("Thinking…");
    await t.mockInput.typeText("second");
    t.mockInput.pressEnter();
    await t.frameWith("▹ second");
    // Let the first turn's timer run past a second, so a carried-over
    // startedAt would be visible on the drained turn's status row.
    await t.frameWith("1s /");
    replies[0]?.resolve("reply one");
    await t.frameWith("reply one");
    expect(await t.frameWith("0s /")).toContain("0s /");
    replies[1]?.resolve("reply two");
    await t.frameWith("reply two");
  });
});
