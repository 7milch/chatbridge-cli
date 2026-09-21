import { describe, expect, test } from "bun:test";
import type {
  Page,
  Provider,
  ProviderCommandResult,
  ProviderConversation,
} from "@chatbridge/provider";
import type { AuthStore } from "@chatbridge/runtime";
import {
  ChatSession,
  DEFAULT_POLL_INTERVAL_MS,
  IDLE_CLOSE_BUDGET_MS,
  type RuntimeLike,
  needsHeadedPreCheck,
} from "./chat-session.js";
import {
  AuthExpiredError,
  AuthRequiredError,
  BlockedError,
  BrowserUnavailableError,
  InvalidStateError,
  ResponseTimeoutError,
} from "./errors.js";
import { formatIdleDuration } from "./idle-watch.js";

const CHAT_URL = "http://127.0.0.1:1/chat";

/** Deferred promise so a test can decide when waitForResponse resolves. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The page starts on the chat URL; `goto` moves it, so `url()` answers
 * whatever the last navigation asked for. `gotos`, when given, records them. */
function fakePage(gotos?: string[]): Page {
  let current = CHAT_URL;
  return {
    setDefaultTimeout() {},
    goto: async (url: string) => {
      gotos?.push(url);
      current = url;
      return null;
    },
    url: () => current,
  } as unknown as Page;
}

interface Harness {
  provider: Provider;
  sent: string[];
  replies: Array<ReturnType<typeof deferred<string>>>;
  closed: number;
  killed: number;
  saved: number;
  saveShouldFail: boolean;
  launch: (opts?: unknown) => Promise<RuntimeLike>;
  loggedIn: boolean;
  /** When set, the provider gains detectBlock returning this value. */
  block: string | undefined;
  hasDetectBlock: boolean;
  detectBlockCalls: number;
  /** When set, isLoggedIn awaits this before answering. */
  loginGate: Promise<unknown> | undefined;
  /** Every `run` the provider's "probe" command received. */
  commandCalls: Array<{ name: string; args: string }>;
  /** What "probe" returns, or throws when it is an Error. */
  commandResult: ProviderCommandResult | Error;
  /** How often startNewChat ran. */
  newChats: number;
  /** Every URL the pages of this harness were told to go to. */
  gotos: string[];
}

function harness(): Harness {
  const h: Harness = {
    sent: [],
    replies: [],
    closed: 0,
    killed: 0,
    saved: 0,
    saveShouldFail: false,
    loggedIn: true,
    block: undefined,
    hasDetectBlock: false,
    detectBlockCalls: 0,
    loginGate: undefined,
    commandCalls: [],
    commandResult: { kind: "show", text: "ok" },
    newChats: 0,
    gotos: [],
    provider: undefined as unknown as Provider,
    launch: undefined as unknown as Harness["launch"],
  };
  h.provider = {
    name: "fake",
    chatUrl: CHAT_URL,
    async navigateToLogin() {},
    async isLoggedIn() {
      if (h.loginGate !== undefined) await h.loginGate;
      return h.loggedIn;
    },
    async startNewChat() {
      h.newChats++;
    },
    async sendMessage(_page, prompt) {
      h.sent.push(prompt);
    },
    async waitForResponse() {
      const d = deferred<string>();
      h.replies.push(d);
      return d.promise;
    },
    commands: [
      {
        name: "probe",
        description: "Probe",
        async run(_page, args) {
          h.commandCalls.push({ name: "probe", args });
          if (h.commandResult instanceof Error) throw h.commandResult;
          return h.commandResult;
        },
      },
    ],
  };
  Object.defineProperty(h.provider, "detectBlock", {
    get() {
      return h.hasDetectBlock
        ? async () => {
            h.detectBlockCalls++;
            return h.block;
          }
        : undefined;
    },
  });
  h.launch = async () => ({
    page: fakePage(h.gotos),
    saveAuthState: async () => {
      if (h.saveShouldFail) throw new Error("disk full");
      h.saved++;
    },
    close: async () => {
      h.closed++;
    },
    kill: async () => {
      h.killed++;
    },
  });
  return h;
}

/**
 * Waits until `send` has reached waitForResponse and returns that turn's
 * deferred, so a test can decide when the provider reply lands.
 */
async function replyOf(h: Harness, index: number) {
  for (let i = 0; i < 1000; i++) {
    const d = h.replies[index];
    if (d) return d;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`reply ${index} was never requested`);
}

function store(has: boolean): AuthStore {
  return { has: () => has } as unknown as AuthStore;
}

function opts(h: Harness, has = true) {
  return {
    provider: h.provider,
    authStore: store(has),
    headless: true,
    timeoutMs: 1000,
    launch: h.launch,
  };
}

describe("ChatSession.open", () => {
  test("throws AuthRequiredError before launching when no auth state", async () => {
    const h = harness();
    await expect(ChatSession.open(opts(h, false))).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
    expect(h.closed).toBe(0);
  });

  test("needsHeadedPreCheck: only a headed launch without an injected launcher", () => {
    expect(needsHeadedPreCheck({ headless: false })).toBe(true);
    expect(needsHeadedPreCheck({ headless: true })).toBe(false);
    expect(needsHeadedPreCheck({ headless: false, launch: () => {} })).toBe(
      false,
    );
  });

  test("a headful open fails the pre-check before launching", async () => {
    const h = harness();
    let launched = 0;
    await expect(
      ChatSession.open({
        provider: h.provider,
        authStore: store(true),
        headless: false,
        timeoutMs: 1000,
        launch: async (o) => {
          launched++;
          return h.launch(o);
        },
        missingBrowserExecutable: () => "/x",
      }),
    ).rejects.toBeInstanceOf(BrowserUnavailableError);
    expect(launched).toBe(0);
  });

  test("closes the browser and throws AuthExpiredError when not logged in", async () => {
    const h = harness();
    h.loggedIn = false;
    await expect(ChatSession.open(opts(h))).rejects.toBeInstanceOf(
      AuthExpiredError,
    );
    expect(h.closed).toBe(1);
  });

  test("reports progress in the one-shot order", async () => {
    const h = harness();
    const progress: string[] = [];
    const session = await ChatSession.open({
      ...opts(h),
      onProgress: (m) => progress.push(m),
    });
    const p = session.send("hi");
    (await replyOf(h, 0)).resolve("ok");
    await p;
    expect(progress).toEqual([
      "Opening browser...",
      "Sending prompt...",
      "Waiting for response...",
    ]);
    await session.close();
  });

  test("throws BlockedError with the documented message when detectBlock reports a block", async () => {
    const h = harness();
    h.loggedIn = false;
    h.hasDetectBlock = true;
    h.block = "challenge page";
    const err = await ChatSession.open(opts(h)).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err.message).toContain('Blocked by "');
    expect(err.message).not.toContain("--headful");
    expect(h.detectBlockCalls).toBe(1);
    expect(h.closed).toBe(1);
  });

  test("throws AuthExpiredError when detectBlock returns undefined", async () => {
    const h = harness();
    h.loggedIn = false;
    h.hasDetectBlock = true;
    h.block = undefined;
    await expect(ChatSession.open(opts(h))).rejects.toBeInstanceOf(
      AuthExpiredError,
    );
    expect(h.closed).toBe(1);
  });

  test("does not call detectBlock while logged in", async () => {
    const h = harness();
    h.hasDetectBlock = true;
    h.block = "challenge page";
    const session = await ChatSession.open(opts(h));
    await session.close();
    expect(h.detectBlockCalls).toBe(0);
  });
});

describe("open retries", () => {
  function flakyLaunch(h: Harness, failures: number, err: () => Error) {
    let calls = 0;
    const real = h.launch;
    h.launch = async (o) => {
      calls++;
      if (calls <= failures) throw err();
      return real(o);
    };
    return () => calls;
  }

  test("retries 0 launches once and rethrows the launch error", async () => {
    const h = harness();
    const calls = flakyLaunch(h, 1, () => new Error("boom"));
    await expect(
      ChatSession.open({ ...opts(h), open: { timeoutMs: 1000, retries: 0 } }),
    ).rejects.toThrow("boom");
    expect(calls()).toBe(1);
  });

  test("a failed launch is retried and reports the attempt", async () => {
    const h = harness();
    const calls = flakyLaunch(h, 1, () => new Error("boom"));
    const progress: string[] = [];
    const s = await ChatSession.open({
      ...opts(h),
      open: { timeoutMs: 1000, retries: 1 },
      onProgress: (m) => progress.push(m),
    });
    expect(calls()).toBe(2);
    expect(progress).toEqual([
      "Opening browser...",
      "Attempt 1 failed: boom",
      "Opening browser... (attempt 2/2)",
    ]);
    await s.kill();
  });

  test("a timeout after launch closes the browser and retries", async () => {
    const h = harness();
    let gotos = 0;
    const real = h.launch;
    h.launch = async (o) => {
      const rt = await real(o);
      rt.page.goto = (async () => {
        gotos++;
        if (gotos === 1) {
          const e = new Error("t/o");
          e.name = "TimeoutError";
          throw e;
        }
        return null;
      }) as unknown as typeof rt.page.goto;
      return rt;
    };
    const s = await ChatSession.open({
      ...opts(h),
      open: { timeoutMs: 1000, retries: 2 },
    });
    expect(gotos).toBe(2);
    expect(h.closed).toBe(1);
    await s.kill();
  });

  test("the last attempt's error is thrown unchanged", async () => {
    const h = harness();
    let n = 0;
    flakyLaunch(h, 5, () => new Error(`boom ${++n}`));
    await expect(
      ChatSession.open({ ...opts(h), open: { timeoutMs: 1000, retries: 2 } }),
    ).rejects.toThrow("boom 3");
  });

  test.each([
    [
      "AuthExpiredError",
      (h: Harness) => {
        h.loggedIn = false;
      },
    ],
    [
      "BlockedError",
      (h: Harness) => {
        h.loggedIn = false;
        h.hasDetectBlock = true;
        h.block = "challenge";
      },
    ],
  ])("%s is not retried", async (_name, arrange) => {
    const h = harness();
    arrange(h);
    let launches = 0;
    const real = h.launch;
    h.launch = async (o) => {
      launches++;
      return real(o);
    };
    await expect(
      ChatSession.open({ ...opts(h), open: { timeoutMs: 1000, retries: 3 } }),
    ).rejects.toBeInstanceOf(
      _name === "BlockedError" ? BlockedError : AuthExpiredError,
    );
    expect(launches).toBe(1);
    expect(h.closed).toBe(1);
  });

  test("BrowserUnavailableError is not retried", async () => {
    const h = harness();
    let launches = 0;
    h.launch = async () => {
      launches++;
      throw new Error("x");
    };
    await expect(
      ChatSession.open({
        ...opts(h),
        open: { timeoutMs: 1000, retries: 3 },
        missingBrowserExecutable: () => "/nowhere/chromium",
      }),
    ).rejects.toBeInstanceOf(BrowserUnavailableError);
    expect(launches).toBe(0);
  });

  test("open defaults to the turn timeout and no retries", async () => {
    const h = harness();
    const calls = flakyLaunch(h, 1, () => new Error("boom"));
    await expect(ChatSession.open(opts(h))).rejects.toThrow("boom");
    expect(calls()).toBe(1);
  });

  test("without opts.open the provider's own open defaults are used", async () => {
    const h = harness();
    (h.provider as { open?: unknown }).open = { retries: 1 };
    const calls = flakyLaunch(h, 1, () => new Error("boom"));
    const s = await ChatSession.open(opts(h));
    expect(calls()).toBe(2);
    await s.kill();
  });

  test("without opts.open the provider's open.timeoutMs drives the steps", async () => {
    const h = harness();
    (h.provider as { open?: unknown }).open = { timeoutMs: 7000 };
    const defaults: number[] = [];
    const real = h.launch;
    h.launch = async (o) => {
      const rt = await real(o);
      rt.page.setDefaultTimeout = (ms: number) => {
        defaults.push(ms);
      };
      return rt;
    };
    const s = await ChatSession.open({ ...opts(h), timeoutMs: 1000 });
    expect(defaults).toEqual([7000, 1000]);
    await s.kill();
  });

  test("a failing close does not mask the step error", async () => {
    const h = harness();
    const real = h.launch;
    h.launch = async (o) => {
      const rt = await real(o);
      rt.page.goto = (async () => {
        const e = new Error("t/o");
        e.name = "TimeoutError";
        throw e;
      }) as unknown as typeof rt.page.goto;
      rt.close = async () => {
        throw new Error("close failed");
      };
      return rt;
    };
    await expect(
      ChatSession.open({ ...opts(h), open: { timeoutMs: 1000, retries: 0 } }),
    ).rejects.toBeInstanceOf(ResponseTimeoutError);
  });

  test("opening steps use open.timeoutMs, then turns go back to timeoutMs", async () => {
    const h = harness();
    const defaults: number[] = [];
    const real = h.launch;
    h.launch = async (o) => {
      const rt = await real(o);
      rt.page.setDefaultTimeout = (ms: number) => {
        defaults.push(ms);
      };
      return rt;
    };
    const s = await ChatSession.open({
      ...opts(h),
      timeoutMs: 1000,
      open: { timeoutMs: 7000, retries: 0 },
    });
    expect(defaults).toEqual([7000, 1000]);
    await s.kill();
  });
});

describe("ChatSession.send", () => {
  test("returns the provider reply and supports several turns", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    const first = session.send("one");
    (await replyOf(h, 0)).resolve("Echo: one");
    expect(await first).toBe("Echo: one");
    const second = session.send("two");
    (await replyOf(h, 1)).resolve("Echo: two");
    expect(await second).toBe("Echo: two");
    expect(h.sent).toEqual(["one", "two"]);
    await session.close();
  });

  test("rejects a second send while one is pending", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    const first = session.send("one");
    await expect(session.send("two")).rejects.toBeInstanceOf(InvalidStateError);
    (await replyOf(h, 0)).resolve("done");
    await first;
    await session.close();
  });

  test("rejects send after close", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    await session.close();
    await expect(session.send("x")).rejects.toBeInstanceOf(InvalidStateError);
  });

  test("a failed send leaves the session usable", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    const first = session.send("one");
    (await replyOf(h, 0)).reject(new Error("boom"));
    await expect(first).rejects.toThrow("boom");
    const second = session.send("two");
    (await replyOf(h, 1)).resolve("Echo: two");
    expect(await second).toBe("Echo: two");
    await session.close();
  });
});

describe("ChatSession.send timeout diagnosis", () => {
  const timeout = () =>
    new ResponseTimeoutError("Timed out during waitForResponse after 1000 ms.");

  test("rethrows the timeout and stays usable while still logged in", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    const first = session.send("one");
    (await replyOf(h, 0)).reject(timeout());
    await expect(first).rejects.toBeInstanceOf(ResponseTimeoutError);
    const second = session.send("two");
    (await replyOf(h, 1)).resolve("Echo: two");
    expect(await second).toBe("Echo: two");
    await session.close();
  });

  test("turns the timeout into AuthExpiredError when the page is logged out", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    const first = session.send("one");
    h.loggedIn = false;
    (await replyOf(h, 0)).reject(timeout());
    await expect(first).rejects.toBeInstanceOf(AuthExpiredError);
    await session.close();
  });

  test("a streaming turn with onPartial still diagnoses the timeout", async () => {
    const h = harness();
    const g = gate();
    h.provider.streaming = { responseText: async () => "partial" };
    const session = await ChatSession.open({ ...opts(h), pollSleep: g.sleep });
    const seen: string[] = [];
    const first = session.send("one", { onPartial: (t) => seen.push(t) });
    await g.tick();
    expect(seen).toEqual(["partial"]);
    h.loggedIn = false;
    (await replyOf(h, 0)).reject(timeout());
    await expect(first).rejects.toBeInstanceOf(AuthExpiredError);
    await session.close();
  });

  test("turns the timeout into BlockedError when detectBlock reports a block", async () => {
    const h = harness();
    h.hasDetectBlock = true;
    const session = await ChatSession.open(opts(h));
    const first = session.send("one");
    h.loggedIn = false;
    h.block = "challenge page";
    (await replyOf(h, 0)).reject(timeout());
    const err = await first.catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err.message).toContain('Blocked by "');
    expect(err.message).not.toContain("--headful");
    await session.close();
  });

  test("keeps the original timeout when the diagnosis itself fails", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    const first = session.send("one");
    h.provider.isLoggedIn = async () => {
      throw new Error("page closed");
    };
    const original = timeout();
    (await replyOf(h, 0)).reject(original);
    const err = await first.catch((e) => e);
    expect(err).toBe(original);
    // close() still runs isLoggedIn; let it fail softly.
    await session.close();
  });

  test("a non-timeout error is not diagnosed", async () => {
    const h = harness();
    let checks = 0;
    const session = await ChatSession.open(opts(h));
    h.provider.isLoggedIn = async () => {
      checks++;
      return true;
    };
    const first = session.send("one");
    (await replyOf(h, 0)).reject(new Error("boom"));
    await expect(first).rejects.toThrow("boom");
    expect(checks).toBe(0);
    await session.close();
  });
});

describe("ChatSession.close", () => {
  test("is idempotent", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    await session.close();
    await session.close();
    expect(h.closed).toBe(1);
  });

  test("saves auth state before closing the browser", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    await session.close();
    expect(h.saved).toBe(1);
    expect(h.closed).toBe(1);
    await session.close();
    expect(h.saved).toBe(1);
  });

  test("still closes when saving fails and reports it via onProgress", async () => {
    const h = harness();
    const progress: string[] = [];
    const session = await ChatSession.open({
      ...opts(h),
      onProgress: (m) => progress.push(m),
    });
    h.saveShouldFail = true;
    await session.close();
    expect(h.closed).toBe(1);
    expect(
      progress.filter((m) => m.includes("Could not save auth state")),
    ).toHaveLength(1);
  });

  test("does not save when the session is no longer logged in", async () => {
    const h = harness();
    const progress: string[] = [];
    const session = await ChatSession.open({
      ...opts(h),
      onProgress: (m) => progress.push(m),
    });
    h.loggedIn = false;
    await session.close();
    expect(h.saved).toBe(0);
    expect(h.closed).toBe(1);
    expect(progress.filter((m) => m.includes("not saved"))).toHaveLength(1);
  });

  test("does not save when open fails", async () => {
    const h = harness();
    h.loggedIn = false;
    await expect(ChatSession.open(opts(h))).rejects.toBeInstanceOf(
      AuthExpiredError,
    );
    expect(h.saved).toBe(0);
    expect(h.closed).toBe(1);
  });
});

describe("ChatSession.kill", () => {
  test("kills the runtime without saving auth state", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    await session.kill();
    expect(h.killed).toBe(1);
    expect(h.saved).toBe(0);
    expect(h.closed).toBe(0);
  });

  test("is idempotent and blocks close() afterwards", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    await session.kill();
    await session.kill();
    await session.close();
    expect(h.killed).toBe(1);
    expect(h.closed).toBe(0);
  });

  test("wins over an in-flight close()", async () => {
    const h = harness();
    const session = await ChatSession.open({ ...opts(h), timeoutMs: 60_000 });
    // close() parks on isLoggedIn: the page is hung, which is exactly when
    // the caller falls back to kill().
    const gate = deferred<void>();
    h.loginGate = gate.promise;
    const closing = session.close();
    await new Promise((r) => setTimeout(r, 0));
    await session.kill();
    expect(h.killed).toBe(1);
    // Releasing the hung check must not save auth state or throw out of close.
    gate.reject(new Error("Target page, context or browser has been closed"));
    await closing;
    expect(h.saved).toBe(0);
    expect(h.killed).toBe(1);
  });

  test("send() after kill() throws InvalidStateError", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    await session.kill();
    await expect(session.send("x")).rejects.toBeInstanceOf(InvalidStateError);
  });

  test("kill() during a pending send makes that send reject", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    const p = session.send("one");
    const reply = await replyOf(h, 0);
    await session.kill();
    reply.reject(new Error("Target page, context or browser has been closed"));
    await expect(p).rejects.toThrow("has been closed");
  });
});

describe("ChatSession.runCommand", () => {
  test("runs the named provider command with the args and returns its result", async () => {
    const h = harness();
    const s = await ChatSession.open(opts(h));
    expect(await s.runCommand("probe", "a b")).toEqual({
      kind: "show",
      text: "ok",
    });
    expect(h.commandCalls).toEqual([{ name: "probe", args: "a b" }]);
    h.commandResult = { kind: "send", prompt: "expanded" };
    expect(await s.runCommand("probe", "")).toEqual({
      kind: "send",
      prompt: "expanded",
    });
  });

  test("an unknown name is an InvalidStateError and never touches the provider", async () => {
    const h = harness();
    const s = await ChatSession.open(opts(h));
    await expect(s.runCommand("nope", "")).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    expect(h.commandCalls).toEqual([]);
  });

  test("rejects while a send is pending, and after close", async () => {
    const h = harness();
    const s = await ChatSession.open(opts(h));
    const p = s.send("hi");
    await replyOf(h, 0);
    await expect(s.runCommand("probe", "")).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    h.replies[0].resolve("r");
    await p;
    await s.close();
    await expect(s.runCommand("probe", "")).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });

  test("a send is rejected while a command is running", async () => {
    const h = harness();
    const gate = deferred<void>();
    h.provider.commands = [
      {
        name: "slow",
        description: "",
        async run() {
          await gate.promise;
          return { kind: "show", text: "" };
        },
      },
    ];
    const s = await ChatSession.open(opts(h));
    const p = s.runCommand("slow", "");
    await expect(s.send("hi")).rejects.toBeInstanceOf(InvalidStateError);
    gate.resolve();
    await p;
  });

  test("a Playwright timeout becomes ResponseTimeoutError naming the command", async () => {
    const h = harness();
    const err = new Error("boom");
    err.name = "TimeoutError";
    h.commandResult = err;
    const s = await ChatSession.open(opts(h));
    await expect(s.runCommand("probe", "")).rejects.toMatchObject({
      name: "ResponseTimeoutError",
      message: "Timed out during command:probe after 1000 ms.",
    });
  });

  test("a timeout while logged out surfaces as AuthExpiredError", async () => {
    const h = harness();
    const err = new Error("boom");
    err.name = "TimeoutError";
    h.commandResult = err;
    const s = await ChatSession.open(opts(h));
    h.loggedIn = false;
    await expect(s.runCommand("probe", "")).rejects.toBeInstanceOf(
      AuthExpiredError,
    );
  });
});

/** A clock the test moves by hand, as in idle-watch.test.ts. */
function clock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

async function waitFor(
  cond: () => boolean,
  what: string,
  tries = 500,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A few ticks of the 5 ms watch, so "did not expire" means something. */
function ticks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 40));
}

describe("ChatSession: idle close", () => {
  /** A period that formats to a readable phrase: 1_000_000 ms is 16.7 min. */
  const IDLE_MS = 1_000_000;

  function idleOpts(
    h: ReturnType<typeof harness>,
    c: ReturnType<typeof clock>,
  ) {
    const events: string[] = [];
    return {
      events,
      options: {
        ...opts(h),
        idle: { timeoutMs: IDLE_MS },
        idleNow: c.now,
        idleTickMs: 5,
        onIdleExpired: () => events.push("expired"),
        onProgress: (message: string) => events.push(message),
      },
    };
  }

  test("expiry: onIdleExpired, then progress, then a close that saves auth", async () => {
    const h = harness();
    const c = clock();
    const { events, options } = idleOpts(h, c);
    await ChatSession.open(options);
    c.advance(IDLE_MS + 1);
    await waitFor(() => h.closed === 1, "the idle close");
    expect(events).toEqual([
      "Opening browser...",
      "expired",
      `Closing the browser after ${formatIdleDuration(IDLE_MS)} idle...`,
    ]);
    expect(formatIdleDuration(IDLE_MS)).toBe("16.7 min");
    expect(h.saved).toBe(1);
    expect(h.killed).toBe(0);
  });

  test("onIdleExpired receives a promise that settles only after the close", async () => {
    const h = harness();
    const c = clock();
    const { options } = idleOpts(h, c);
    let closing: Promise<void> | undefined;
    let closedWhenTold = -1;
    await ChatSession.open({
      ...options,
      onIdleExpired: (p) => {
        closing = p;
        closedWhenTold = h.closed;
      },
    });
    c.advance(IDLE_MS + 1);
    await waitFor(() => closing !== undefined, "the expiry callback");
    // Told first: nothing was closed yet when the UI heard about it.
    expect(closedWhenTold).toBe(0);
    await closing;
    expect(h.closed).toBe(1);
    expect(h.saved).toBe(1);
  });

  test("the closing promise resolves after the kill fallback and never rejects", async () => {
    const h = harness();
    const c = clock();
    const { options } = idleOpts(h, c);
    let closing: Promise<void> | undefined;
    await ChatSession.open({
      ...options,
      onIdleExpired: (p) => {
        closing = p;
      },
    });
    h.loginGate = new Promise<void>(() => {}); // close() parks forever
    c.advance(IDLE_MS + 1);
    await waitFor(() => closing !== undefined, "the expiry callback");
    await expect(closing).resolves.toBeUndefined();
    expect(h.killed).toBe(1);
  }, 20_000);

  test("a wedged page is killed after the close budget", async () => {
    const h = harness();
    const c = clock();
    const { options } = idleOpts(h, c);
    const session = await ChatSession.open(options);
    // From here isLoggedIn never answers: close() parks on the hung page.
    h.loginGate = new Promise<void>(() => {});
    c.advance(IDLE_MS + 1);
    // The kill only comes after the 5 s close budget.
    await waitFor(() => h.killed === 1, "the fallback kill", 5000);
    // The hung close is still parked; the session is closed either way.
    await expect(session.send("hi")).rejects.toBeInstanceOf(InvalidStateError);
  }, 20_000);

  test("send after expiry rejects as closed", async () => {
    const h = harness();
    const c = clock();
    const { options } = idleOpts(h, c);
    const session = await ChatSession.open(options);
    c.advance(IDLE_MS + 1);
    await waitFor(() => h.closed === 1, "the idle close");
    await expect(session.send("hi")).rejects.toBeInstanceOf(InvalidStateError);
    await expect(session.runCommand("probe", "")).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });

  test("a pending send holds the clock; the period restarts after it", async () => {
    const h = harness();
    const c = clock();
    const { options } = idleOpts(h, c);
    const session = await ChatSession.open(options);
    const pending = session.send("hi");
    c.advance(10 * IDLE_MS);
    await ticks();
    expect(h.closed).toBe(0);
    (await replyOf(h, 0)).resolve("ok");
    expect(await pending).toBe("ok");
    c.advance(IDLE_MS - 100);
    await ticks();
    expect(h.closed).toBe(0);
    c.advance(200);
    await waitFor(() => h.closed === 1, "expiry after the turn");
    expect(h.saved).toBe(1);
  });

  test("a pending runCommand holds the clock too", async () => {
    const h = harness();
    const c = clock();
    const { options } = idleOpts(h, c);
    const session = await ChatSession.open(options);
    const pending = session.runCommand("probe", "");
    c.advance(10 * IDLE_MS);
    await ticks();
    expect(h.closed).toBe(0);
    await pending;
    c.advance(IDLE_MS + 1);
    await waitFor(() => h.closed === 1, "expiry after the command");
  });

  test("timeoutMs 0 creates no watch", async () => {
    const h = harness();
    const c = clock();
    const { options } = idleOpts(h, c);
    await ChatSession.open({ ...options, idle: { timeoutMs: 0 } });
    c.advance(10 * 86_400_000);
    await ticks();
    expect(h.closed).toBe(0);
  });

  test("close() during the idle close joins it instead of returning early", async () => {
    const h = harness();
    const c = clock();
    const { events, options } = idleOpts(h, c);
    const session = await ChatSession.open(options);
    const gate = deferred<void>();
    // isLoggedIn is held open, so the idle close is still saving state.
    h.loginGate = gate.promise;
    c.advance(IDLE_MS + 1);
    await waitFor(() => events.length === 3, "the close to start");
    expect(h.closed).toBe(0);
    let joined = false;
    const teardown = session.close().then(() => {
      joined = true;
    });
    await ticks();
    expect(joined).toBe(false);
    gate.resolve();
    await teardown;
    expect(joined).toBe(true);
    expect(h.closed).toBe(1);
    expect(h.saved).toBe(1);
  });

  test("close() after a kill returns instead of joining the parked close", async () => {
    const h = harness();
    const c = clock();
    const { options } = idleOpts(h, c);
    const session = await ChatSession.open(options);
    // From here isLoggedIn never answers: the first close parks on it.
    h.loginGate = new Promise<void>(() => {});
    const parked = session.close();
    await ticks();
    await session.kill();
    // Bounded race: a close that joins the parked one never settles.
    const late = await Promise.race([
      session.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 200)),
    ]);
    expect(late).toBe("closed");
    expect(h.killed).toBe(1);
    // The original close is still parked; nothing about it was awaited.
    void parked.catch(() => {});
  });

  test("the close budget is 5 s", () => {
    expect(IDLE_CLOSE_BUDGET_MS).toBe(5000);
  });
});

/** A pollSleep the test releases one tick at a time. */
function gate() {
  const waiting: Array<() => void> = [];
  return {
    sleep: () => new Promise<void>((r) => waiting.push(r)),
    /** Releases one pending sleep and lets the poll body run. */
    async tick() {
      await waitFor(() => waiting.length > 0, "a pending poll sleep");
      waiting.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    },
    get pending() {
      return waiting.length;
    },
  };
}

describe("ChatSession: streaming partials", () => {
  test("emits only when the text changes, skips undefined, returns the final text", async () => {
    const h = harness();
    const g = gate();
    const texts: Array<string | undefined> = [undefined, "He", "He", "Hello"];
    h.provider.streaming = { responseText: async () => texts.shift() };
    const session = await ChatSession.open({ ...opts(h), pollSleep: g.sleep });
    const seen: string[] = [];
    const reply = session.send("hi", { onPartial: (t) => seen.push(t) });
    for (let i = 0; i < 4; i++) await g.tick();
    expect(seen).toEqual(["He", "Hello"]);
    (await replyOf(h, 0)).resolve("Hello, world");
    expect(await reply).toBe("Hello, world");
    await session.close();
  });

  test("never emits after the turn settled", async () => {
    const h = harness();
    const g = gate();
    h.provider.streaming = { responseText: async () => "late" };
    const session = await ChatSession.open({ ...opts(h), pollSleep: g.sleep });
    const seen: string[] = [];
    const reply = session.send("hi", { onPartial: (t) => seen.push(t) });
    await waitFor(() => g.pending === 1, "the first sleep");
    (await replyOf(h, 0)).resolve("done");
    await reply;
    await g.tick();
    expect(seen).toEqual([]);
    await session.close();
  });

  test("a responseText or onPartial that throws does not fail the turn", async () => {
    const h = harness();
    const g = gate();
    let calls = 0;
    h.provider.streaming = {
      responseText: async () => {
        calls++;
        if (calls === 1) throw new Error("detached");
        return "ok";
      },
    };
    const session = await ChatSession.open({ ...opts(h), pollSleep: g.sleep });
    const reply = session.send("hi", {
      onPartial: () => {
        throw new Error("ui bug");
      },
    });
    await g.tick();
    await g.tick();
    expect(calls).toBe(2);
    (await replyOf(h, 0)).resolve("final");
    expect(await reply).toBe("final");
    await session.close();
  });

  test("polls do not overlap", async () => {
    const h = harness();
    const g = gate();
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const slow = deferred<string>();
    h.provider.streaming = {
      responseText: async () => {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const v = await slow.promise;
        inFlight--;
        return v;
      },
    };
    const session = await ChatSession.open({ ...opts(h), pollSleep: g.sleep });
    const reply = session.send("hi", { onPartial: () => {} });
    await g.tick();
    // The poll body is parked on `slow`: no second sleep was requested and no
    // second read started.
    expect(calls).toBe(1);
    expect(g.pending).toBe(0);
    slow.resolve("x");
    await g.tick();
    expect(maxInFlight).toBe(1);
    (await replyOf(h, 0)).resolve("final");
    await reply;
    await session.close();
  });

  test("does not poll without onPartial, or without provider.streaming", async () => {
    const h = harness();
    const g = gate();
    let calls = 0;
    h.provider.streaming = {
      responseText: async () => {
        calls++;
        return "x";
      },
    };
    const session = await ChatSession.open({ ...opts(h), pollSleep: g.sleep });
    const a = session.send("one");
    (await replyOf(h, 0)).resolve("r1");
    await a;
    h.provider.streaming = undefined;
    const b = session.send("two", { onPartial: () => {} });
    (await replyOf(h, 1)).resolve("r2");
    await b;
    expect(calls).toBe(0);
    expect(g.pending).toBe(0);
    await session.close();
  });

  test("uses the provider's pollIntervalMs, default 250", async () => {
    const h = harness();
    const asked: number[] = [];
    const pollSleep = (ms: number) => {
      asked.push(ms);
      return new Promise<void>(() => {});
    };
    h.provider.streaming = {
      responseText: async () => undefined,
      pollIntervalMs: 40,
    };
    const custom = await ChatSession.open({ ...opts(h), pollSleep });
    const first = custom.send("hi", { onPartial: () => {} });
    await waitFor(() => asked.length === 1, "the first sleep");
    expect(asked).toEqual([40]);
    (await replyOf(h, 0)).resolve("x");
    await first;
    await custom.close();

    asked.length = 0;
    h.provider.streaming = { responseText: async () => undefined };
    const plain = await ChatSession.open({ ...opts(h), pollSleep });
    const second = plain.send("hi", { onPartial: () => {} });
    await waitFor(() => asked.length === 1, "the first sleep");
    expect(asked).toEqual([DEFAULT_POLL_INTERVAL_MS]);
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(250);
    (await replyOf(h, 1)).resolve("x");
    await second;
    await plain.close();
  });

  test("responseFormat mirrors the provider, default text", async () => {
    const h = harness();
    const plain = await ChatSession.open(opts(h));
    expect(plain.responseFormat).toBe("text");
    await plain.close();
    h.provider.responseFormat = "markdown";
    const md = await ChatSession.open(opts(h));
    expect(md.responseFormat).toBe("markdown");
    await md.close();
  });
});

describe("conversation restore and handle refresh", () => {
  interface ConvoSpy {
    /** Every handle `open` was called with, in order. */
    opens: string[];
    /** How often `handle` ran. */
    handles: number;
    /** What `open` does; the default leaves the page on the chat URL. */
    openImpl: (page: Page, handle: string) => Promise<void>;
    /** What `handle` answers. */
    handleImpl: (page: Page) => Promise<string | undefined>;
  }

  function withConversation(h: Harness): ConvoSpy {
    const spy: ConvoSpy = {
      opens: [],
      handles: 0,
      openImpl: async () => {},
      handleImpl: async () => "H-AFTER",
    };
    const conversation: ProviderConversation = {
      async open(page, handle) {
        spy.opens.push(handle);
        await spy.openImpl(page, handle);
      },
      async handle(page) {
        spy.handles++;
        return spy.handleImpl(page);
      },
    };
    (h.provider as { conversation?: ProviderConversation }).conversation =
      conversation;
    return spy;
  }

  /** Starts a turn; the caller resolves the provider reply. */
  function turn(session: ChatSession): Promise<string> {
    return session.send("hi");
  }

  test("no conversation option starts a new chat and attempts no restore", async () => {
    const h = harness();
    const spy = withConversation(h);
    const s = await ChatSession.open(opts(h));
    expect(h.newChats).toBe(1);
    expect(spy.opens).toEqual([]);
    expect(s.restored).toBeUndefined();
    expect(s.conversation).toBeUndefined();
    await s.kill();
  });

  test("a conversation option is ignored by a provider without `conversation`", async () => {
    const h = harness();
    const s = await ChatSession.open({ ...opts(h), conversation: "H-1" });
    expect(h.newChats).toBe(1);
    expect(s.restored).toBeUndefined();
    expect(s.conversation).toBeUndefined();
    await s.kill();
  });

  test("a restored conversation skips startNewChat and keeps the handle", async () => {
    const h = harness();
    const spy = withConversation(h);
    const s = await ChatSession.open({ ...opts(h), conversation: "H-1" });
    expect(spy.opens).toEqual(["H-1"]);
    expect(h.newChats).toBe(0);
    expect(s.restored).toBe(true);
    expect(s.conversation).toBe("H-1");
    await s.kill();
  });

  test("a throwing open falls back to the chat page and a new chat", async () => {
    const h = harness();
    const spy = withConversation(h);
    spy.openImpl = async () => {
      throw new Error("no such conversation");
    };
    const s = await ChatSession.open({ ...opts(h), conversation: "H-1" });
    expect(h.gotos).toEqual([CHAT_URL, CHAT_URL]);
    expect(h.newChats).toBe(1);
    expect(s.restored).toBe(false);
    expect(s.conversation).toBeUndefined();
    await s.kill();
  });

  test("an open that never settles falls back after the opening timeout", async () => {
    const h = harness();
    const spy = withConversation(h);
    spy.openImpl = () => new Promise<void>(() => {});
    const s = await ChatSession.open({
      ...opts(h),
      open: { timeoutMs: 30, retries: 0 },
      conversation: "H-1",
    });
    expect(h.newChats).toBe(1);
    expect(s.restored).toBe(false);
    await s.kill();
  });

  test("an open that parks the page on another origin is a failed restore", async () => {
    const h = harness();
    const spy = withConversation(h);
    spy.openImpl = async (page) => {
      await page.goto("https://other.test/x");
    };
    const s = await ChatSession.open({ ...opts(h), conversation: "H-1" });
    expect(h.newChats).toBe(1);
    expect(s.restored).toBe(false);
    expect(h.gotos.at(-1)).toBe(CHAT_URL);
    await s.kill();
  });

  test("a successful turn refreshes the handle", async () => {
    const h = harness();
    const spy = withConversation(h);
    const s = await ChatSession.open(opts(h));
    const p = turn(s);
    (await replyOf(h, 0)).resolve("reply");
    expect(await p).toBe("reply");
    expect(spy.handles).toBe(1);
    expect(s.conversation).toBe("H-AFTER");
    await s.kill();
  });

  test("a throwing handle leaves the turn and the previous handle alone", async () => {
    const h = harness();
    const spy = withConversation(h);
    const s = await ChatSession.open({ ...opts(h), conversation: "H-1" });
    spy.handleImpl = async () => {
      throw new Error("detached");
    };
    const p = turn(s);
    (await replyOf(h, 0)).resolve("reply");
    expect(await p).toBe("reply");
    expect(s.conversation).toBe("H-1");
    await s.kill();
  });

  test("a handle of undefined keeps the previous one", async () => {
    const h = harness();
    const spy = withConversation(h);
    const s = await ChatSession.open({ ...opts(h), conversation: "H-1" });
    spy.handleImpl = async () => undefined;
    const p = turn(s);
    (await replyOf(h, 0)).resolve("reply");
    await p;
    expect(s.conversation).toBe("H-1");
    await s.kill();
  });

  test("no progress message and no surfaced error carries the handle", async () => {
    const h = harness();
    const spy = withConversation(h);
    spy.handleImpl = async () => "H-SECRET";
    const progress: string[] = [];
    const s = await ChatSession.open({
      ...opts(h),
      conversation: "H-SECRET",
      onProgress: (m) => progress.push(m),
      onOpenProgress: (m) => progress.push(m),
    });
    const p = turn(s);
    (await replyOf(h, 0)).resolve("reply");
    await p;
    await s.close();
    expect(progress.length).toBeGreaterThan(0);
    for (const message of progress) expect(message).not.toContain("H-SECRET");

    // The failed-restore path swallows the provider's error; it must not
    // reach the caller with the handle in it either.
    const h2 = harness();
    const spy2 = withConversation(h2);
    spy2.openImpl = async (_page, handle) => {
      throw new Error(`cannot open ${handle}`);
    };
    const open2: string[] = [];
    const s2 = await ChatSession.open({
      ...opts(h2),
      conversation: "H-SECRET",
      onProgress: (m) => open2.push(m),
      onOpenProgress: (m) => open2.push(m),
    });
    expect(s2.restored).toBe(false);
    for (const message of open2) expect(message).not.toContain("H-SECRET");
    await s2.kill();
  });

  test("a retried opening phase restores on the second attempt too", async () => {
    const h = harness();
    const spy = withConversation(h);
    let gotos = 0;
    const real = h.launch;
    h.launch = async (o) => {
      const rt = await real(o);
      const inner = rt.page.goto.bind(rt.page);
      rt.page.goto = (async (url: string) => {
        gotos++;
        if (gotos === 1) {
          const e = new Error("t/o");
          e.name = "TimeoutError";
          throw e;
        }
        return inner(url);
      }) as unknown as typeof rt.page.goto;
      return rt;
    };
    const s = await ChatSession.open({
      ...opts(h),
      open: { timeoutMs: 1000, retries: 1 },
      conversation: "H-1",
    });
    expect(spy.opens).toEqual(["H-1"]);
    expect(s.restored).toBe(true);
    await s.kill();
  });
});
