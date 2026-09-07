import { describe, expect, test } from "bun:test";
import type { Page, Provider } from "@chatbridge/provider";
import type { AuthStore } from "@chatbridge/runtime";
import { ChatSession, type RuntimeLike } from "./chat-session.js";
import {
  AuthExpiredError,
  AuthRequiredError,
  InvalidStateError,
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
  launch: () => Promise<RuntimeLike>;
  loggedIn: boolean;
}

function harness(): Harness {
  const h: Harness = {
    sent: [],
    replies: [],
    closed: 0,
    loggedIn: true,
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
  h.launch = async () => ({
    page: fakePage(),
    close: async () => {
      h.closed++;
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

describe("ChatSession.close", () => {
  test("is idempotent", async () => {
    const h = harness();
    const session = await ChatSession.open(opts(h));
    await session.close();
    await session.close();
    expect(h.closed).toBe(1);
  });
});
