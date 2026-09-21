import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDummyProvider } from "@chatbridge/example-dummy-chat/provider";
import {
  dummyReply,
  startDummyChat,
} from "@chatbridge/example-dummy-chat/server";
import type { Provider } from "@chatbridge/provider";
import { AuthStore, BrowserRuntime } from "@chatbridge/runtime";
import { ChatSession } from "./chat-session.js";
import {
  AuthExpiredError,
  AuthRequiredError,
  BlockedError,
  ResponseTimeoutError,
} from "./errors.js";
import { runOneShot } from "./session.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) {
    const cleanup = cleanups.pop();
    try {
      await cleanup?.();
    } catch {
      // One failing cleanup must not strand the remaining ones.
    }
  }
});

function tempStore(name: string): AuthStore {
  const dir = mkdtempSync(join(tmpdir(), "chatbridge-core-e2e-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return new AuthStore({
    configDir: "chatbridge",
    providerName: name,
    baseDir: dir,
  });
}

/** Drives the dummy login once so the store holds a valid session. */
async function prepareAuth(
  provider: Provider,
  store: AuthStore,
): Promise<void> {
  const rt = await BrowserRuntime.launch({
    headless: true,
    provider,
    authStore: store,
  });
  await provider.navigateToLogin(rt.page);
  await rt.page.locator("#login-button").click();
  await rt.page.waitForURL("**/chat");
  await rt.saveAuthState();
  await rt.close();
}

describe("runOneShot", () => {
  test("throws AuthRequiredError when no auth state exists", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    await expect(
      runOneShot({
        provider,
        authStore: tempStore(provider.name),
        prompt: "hi",
        headless: true,
        timeoutMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });

  test("returns the response after auth state is prepared", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    const store = tempStore(provider.name);

    await prepareAuth(provider, store);

    const reply = await runOneShot({
      provider,
      authStore: store,
      prompt: "ping",
      headless: true,
      timeoutMs: 30_000,
    });
    expect(reply).toBe("Echo: ping");
  }, 60_000);
});

describe("ChatSession", () => {
  test("carries a conversation across two turns", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    const store = tempStore(provider.name);
    await prepareAuth(provider, store);

    const session = await ChatSession.open({
      provider,
      authStore: store,
      headless: true,
      timeoutMs: 30_000,
    });
    cleanups.push(() => session.close());
    expect(await session.send("first")).toBe("Echo: first");
    expect(await session.send("second")).toBe("Echo: second");
  }, 60_000);

  test("an interactive-style send sees growing partials and a Markdown final text", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    const store = tempStore(provider.name);
    await prepareAuth(provider, store);
    server.setChunkDelayMs(60);

    const session = await ChatSession.open({
      provider,
      authStore: store,
      headless: true,
      timeoutMs: 30_000,
    });
    cleanups.push(() => session.close());
    expect(session.responseFormat).toBe("markdown");

    const partials: string[] = [];
    const reply = await session.send("md: table please", {
      onPartial: (text) => partials.push(text),
    });
    expect(reply).toBe(dummyReply("md: table please"));
    expect(partials.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < partials.length; i++) {
      expect(partials[i]?.length).toBeGreaterThan(partials[i - 1]?.length ?? 0);
    }

    // Second turn: no partial may carry the first turn's text, which is what
    // the provider's `assistants < users` guard exists to prevent.
    const second: string[] = [];
    const secondReply = await session.send("md: again", {
      onPartial: (text) => second.push(text),
    });
    expect(secondReply).toBe(dummyReply("md: again"));
    expect(second.length).toBeGreaterThanOrEqual(2);
    for (const text of second) {
      expect(text.startsWith("Echo: md: again")).toBe(true);
    }
  }, 60_000);

  test("a response timeout leaves the session usable", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    const store = tempStore(provider.name);
    await prepareAuth(provider, store);

    const session = await ChatSession.open({
      provider,
      authStore: store,
      headless: true,
      timeoutMs: 2_000,
    });
    cleanups.push(() => session.close());
    // "slow:" makes the dummy chat answer after 5 s, past the 2 s budget.
    await expect(session.send("slow:one")).rejects.toBeInstanceOf(
      ResponseTimeoutError,
    );
    expect(await session.send("two")).toBe("Echo: two");
  }, 60_000);

  test("open reports a challenge page as BlockedError, not an expired login", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    const store = tempStore(provider.name);
    await prepareAuth(provider, store);

    server.setBlocked(true);
    const err = await ChatSession.open({
      provider,
      authStore: store,
      headless: true,
      timeoutMs: 30_000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err.message).toBe('Blocked by "dummy-chat": challenge page.');
  }, 60_000);

  test("a timeout after the login expired is reported as AuthExpiredError", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const dummy = createDummyProvider(server.url);
    const store = tempStore(dummy.name);
    await prepareAuth(dummy, store);

    // The dummy provider's isLoggedIn inspects the current DOM, so a
    // server-side expiry only becomes visible after a navigation. Reload
    // /chat from inside sendMessage: once sessions are invalid it redirects
    // to /login, where #message-input is missing, so the fill times out and
    // the diagnosis must promote that timeout to AuthExpiredError.
    const provider: Provider = {
      ...dummy,
      async sendMessage(page, prompt) {
        await page.goto(`${server.url}/chat`);
        await dummy.sendMessage(page, prompt);
      },
    };

    const session = await ChatSession.open({
      provider,
      authStore: store,
      headless: true,
      timeoutMs: 2_000,
    });
    cleanups.push(() => session.close());
    server.invalidateSessions();
    await expect(session.send("one")).rejects.toBeInstanceOf(AuthExpiredError);
  }, 60_000);

  test("a later session restores the conversation from its handle", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    const store = tempStore(provider.name);
    await prepareAuth(provider, store);
    const opts = {
      provider,
      authStore: store,
      headless: true,
      timeoutMs: 30_000,
    };

    const first = await ChatSession.open(opts);
    await first.send("hello");
    expect(await first.send("turns?")).toContain("turn 2");
    const handle = first.conversation;
    expect(handle).toMatch(/\/chat\/c\/[a-z0-9]{8}$/);
    await first.close();

    const second = await ChatSession.open({ ...opts, conversation: handle });
    try {
      expect(second.restored).toBe(true);
      // The restored page already holds two turns, so this also proves the
      // provider's streaming/completion checks read the new reply, not a
      // stale one.
      expect(await second.send("turns?")).toContain("turn 3");
    } finally {
      await second.close();
    }
  }, 90_000);

  test("an unknown handle falls back to a new chat", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    const store = tempStore(provider.name);
    await prepareAuth(provider, store);

    const session = await ChatSession.open({
      provider,
      authStore: store,
      headless: true,
      timeoutMs: 30_000,
      conversation: `${server.url}/chat/c/zzzzzzzz`,
    });
    try {
      expect(session.restored).toBe(false);
      expect(await session.send("turns?")).toContain("turn 1");
    } finally {
      await session.close();
    }
  }, 60_000);
});
