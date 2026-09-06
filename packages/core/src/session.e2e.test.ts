import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDummyProvider } from "@chatbridge/example-dummy-chat/provider";
import { startDummyChat } from "@chatbridge/example-dummy-chat/server";
import { AuthStore, BrowserRuntime } from "@chatbridge/runtime";
import { AuthRequiredError } from "./errors.js";
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

    // Prepare auth state by driving the login directly (login-flow UX is
    // covered by the CLI E2E in Task 8).
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
