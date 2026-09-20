import { describe, expect, test } from "bun:test";
import type {
  Page,
  Provider,
  ProviderCommandResult,
} from "@chatbridge/provider";
import type { AuthStore } from "@chatbridge/runtime";
import {
  ChatSession,
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

function fakePage(): Page {
  return {
    setDefaultTimeout() {},
    goto: async () => null,
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
    provider: undefined as unknown as Provider,
    launch: undefined as unknown as Harness["launch"],
  };
  h.provider = {
    name: "fake",
    chatUrl: "http://127.0.0.1:1/chat",
    async navigateToLogin() {},
    async isLoggedIn() {
      if (h.loginGate !== undefined) await h.loginGate;
      return h.loggedIn;
    },
    async startNewChat() {},
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
    page: fakePage(),
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
        now: c.now,
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

  test("the close budget is 5 s", () => {
    expect(IDLE_CLOSE_BUDGET_MS).toBe(5000);
  });
});
