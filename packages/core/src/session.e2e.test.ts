import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDummyProvider } from "@chatbridge/example-dummy-chat/provider";
import { startDummyChat } from "@chatbridge/example-dummy-chat/server";
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
    expect(err.message).toBe(
      'Blocked by "dummy-chat": challenge page. Try --headful.',
    );
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
});
