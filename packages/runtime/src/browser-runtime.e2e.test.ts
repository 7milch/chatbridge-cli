import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDummyProvider } from "@chatbridge/example-dummy-chat/provider";
import { startDummyChat } from "@chatbridge/example-dummy-chat/server";
import { AuthStore } from "./auth-store.js";
import { BrowserRuntime } from "./browser-runtime.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function tempStore(name: string): AuthStore {
  const dir = mkdtempSync(join(tmpdir(), "chatbridge-e2e-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return new AuthStore({
    configDir: "chatbridge",
    providerName: name,
    baseDir: dir,
  });
}

describe("BrowserRuntime (headless Chromium on Bun)", () => {
  test("full round trip: login, save state, restore state, chat", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    const store = tempStore(provider.name);

    // Phase 1: "login" (headless here; the CLI does this headfully).
    const rt1 = await BrowserRuntime.launch({
      headless: true,
      provider,
      authStore: store,
    });
    cleanups.push(() => rt1.close());
    await provider.navigateToLogin(rt1.page);
    await rt1.page.locator("#login-button").click();
    await rt1.page.waitForURL("**/chat");
    expect(await provider.isLoggedIn(rt1.page)).toBe(true);
    await rt1.saveAuthState();
    expect(store.has()).toBe(true);
    await rt1.close();

    // Phase 2: fresh browser, restored state, one-shot round trip.
    const rt2 = await BrowserRuntime.launch({
      headless: true,
      provider,
      authStore: store,
    });
    cleanups.push(() => rt2.close());
    await rt2.page.goto(provider.chatUrl);
    expect(await provider.isLoggedIn(rt2.page)).toBe(true);
    await provider.startNewChat(rt2.page);
    await provider.sendMessage(rt2.page, "hello");
    const reply = await provider.waitForResponse(rt2.page);
    expect(reply).toBe("Echo: hello");
  }, 60_000);

  test("saved auth state includes IndexedDB databases", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    const store = tempStore(provider.name);

    const rt = await BrowserRuntime.launch({
      headless: true,
      provider,
      authStore: store,
    });
    cleanups.push(() => rt.close());
    await provider.navigateToLogin(rt.page);

    // Some services keep their session in IndexedDB, not cookies/localStorage.
    await rt.page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("test-db", 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore("kv", { keyPath: "id" });
        };
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("kv", "readwrite");
          tx.objectStore("kv").put({ id: "k", v: "v" });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    });

    await rt.saveAuthState();

    const state = (await store.load()) as {
      origins: Array<{ indexedDB?: Array<{ name: string }> }>;
    };
    const names = state.origins.flatMap((o) =>
      (o.indexedDB ?? []).map((db) => db.name),
    );
    expect(names).toContain("test-db");
  }, 60_000);

  test("kill() ends the browser process and is idempotent", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const provider = createDummyProvider(server.url);
    const store = tempStore(provider.name);

    const rt = await BrowserRuntime.launch({
      headless: true,
      provider,
      authStore: store,
    });
    await rt.page.goto(provider.chatUrl);
    expect(rt.page.isClosed()).toBe(false);

    await rt.kill();
    // The page belongs to a browser that is gone; Playwright reports it closed
    // once the disconnect has propagated.
    for (let i = 0; i < 100 && !rt.page.isClosed(); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(rt.page.isClosed()).toBe(true);

    // A second kill (process already gone) must not throw.
    await rt.kill();
    // close() after kill() must not throw either: teardown paths call it.
    await rt.close();
  }, 60_000);
});
