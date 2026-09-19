import { describe, expect, test } from "bun:test";
import type { Page, Provider } from "@chatbridge/provider";
import type { AuthStore } from "@chatbridge/runtime";
import type { RuntimeLike } from "./chat-session.js";
import { LoginAbortedError } from "./errors.js";
import { runLogin } from "./session.js";

interface Fake {
  rt: RuntimeLike & { saved: number; closed: number; killed: number };
  provider: Provider;
  loggedIn: boolean;
  launches: number;
}

function fake(): Fake {
  const f: Fake = {
    loggedIn: false,
    launches: 0,
    provider: {
      name: "fake",
      chatUrl: "http://x/chat",
      navigateToLogin: async () => {},
      isLoggedIn: async () => f.loggedIn,
      startNewChat: async () => {},
      sendMessage: async () => {},
      waitForResponse: async () => "",
    } as unknown as Provider,
    rt: {
      page: { setDefaultTimeout() {} } as unknown as Page,
      saved: 0,
      closed: 0,
      killed: 0,
      async saveAuthState() {
        this.saved++;
      },
      async close() {
        this.closed++;
      },
      async kill() {
        this.killed++;
      },
    },
  };
  return f;
}

function opts(f: Fake, extra: Partial<Parameters<typeof runLogin>[0]> = {}) {
  return {
    provider: f.provider,
    authStore: {} as AuthStore,
    launch: async () => {
      f.launches++;
      return f.rt;
    },
    pollIntervalMs: 5,
    ...extra,
  };
}

describe("runLogin", () => {
  test("saves and closes once isLoggedIn turns true", async () => {
    const f = fake();
    setTimeout(() => {
      f.loggedIn = true;
    }, 20);
    await runLogin(opts(f));
    expect(f.rt.saved).toBe(1);
    expect(f.rt.closed).toBe(1);
    expect(f.rt.killed).toBe(0);
  });

  test("abort during polling kills the browser and rejects with LoginAbortedError", async () => {
    const f = fake();
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 20);
    await expect(
      runLogin(opts(f, { signal: ac.signal })),
    ).rejects.toBeInstanceOf(LoginAbortedError);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(f.rt.killed).toBe(1);
    expect(f.rt.closed).toBe(0);
    expect(f.rt.saved).toBe(0);
  });

  test("an abort while isLoggedIn is in flight is honoured, not dropped", async () => {
    const f = fake();
    // Slow enough that the abort below lands outside the poll sleep,
    // while this call is still pending.
    f.provider.isLoggedIn = async () => {
      await new Promise((r) => setTimeout(r, 40));
      return f.loggedIn;
    };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await expect(
      runLogin(opts(f, { signal: ac.signal })),
    ).rejects.toBeInstanceOf(LoginAbortedError);
    expect(f.rt.killed).toBe(1);
    expect(f.rt.saved).toBe(0);
  }, 1000);

  test("an abort that lands while isLoggedIn returns true still rejects, nothing saved", async () => {
    const f = fake();
    const ac = new AbortController();
    f.provider.isLoggedIn = async () => {
      await new Promise((r) => setTimeout(r, 10));
      ac.abort(); // lands before the call resolves
      return true;
    };
    await expect(
      runLogin(opts(f, { signal: ac.signal })),
    ).rejects.toBeInstanceOf(LoginAbortedError);
    expect(f.rt.saved).toBe(0);
    expect(f.rt.killed).toBe(1);
    expect(f.rt.closed).toBe(0);
  }, 1000);

  test("an already-aborted signal rejects before launching", async () => {
    const f = fake();
    const ac = new AbortController();
    ac.abort();
    await expect(
      runLogin(opts(f, { signal: ac.signal })),
    ).rejects.toBeInstanceOf(LoginAbortedError);
    expect(f.launches).toBe(0);
  });
});
