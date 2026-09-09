import { describe, expect, test } from "bun:test";
import type { Page, Provider } from "@chatbridge/provider";
import type { AuthStore } from "@chatbridge/runtime";
import { ChatSession, type RuntimeLike } from "./chat-session.js";
import {
  AuthExpiredError,
  AuthRequiredError,
  BlockedError,
  InvalidStateError,
  ResponseTimeoutError,
} from "./errors.js";

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
  launch: () => Promise<RuntimeLike>;
  loggedIn: boolean;
  /** When set, the provider gains detectBlock returning this value. */
  block: string | undefined;
  hasDetectBlock: boolean;
  detectBlockCalls: number;
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
    provider: undefined as unknown as Provider,
    launch: undefined as unknown as Harness["launch"],
  };
  h.provider = {
    name: "fake",
    chatUrl: "http://127.0.0.1:1/chat",
    async navigateToLogin() {},
    async isLoggedIn() {
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
    expect(err.message).toBe(
      'Blocked by "fake": challenge page. Try --headful.',
    );
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
    expect(err.message).toBe(
      'Blocked by "fake": challenge page. Try --headful.',
    );
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
