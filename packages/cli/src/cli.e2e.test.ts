import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, BrowserRuntime } from "@chatbridge/core";
import { createDummyProvider } from "@chatbridge/example-dummy-chat/provider";
import { startDummyChat } from "@chatbridge/example-dummy-chat/server";
import { createCli } from "./create-cli";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()?.();
    } catch {
      // Cleanup is best-effort; one failure must not skip the rest.
    }
  }
});

function setup() {
  const baseDir = mkdtempSync(join(tmpdir(), "chatbridge-cli-e2e-"));
  cleanups.push(() => rmSync(baseDir, { recursive: true, force: true }));
  return baseDir;
}

async function prepareAuth(baseDir: string, serverUrl: string) {
  const provider = createDummyProvider(serverUrl);
  const store = new AuthStore({
    configDir: "test-cli",
    providerName: provider.name,
    baseDir,
  });
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
  return provider;
}

describe("createCli", () => {
  test("one-shot without auth exits 2", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const cli = createCli({
      name: "test-cli",
      provider: createDummyProvider(server.url),
      baseDir,
    });
    const code = await cli.run(["bun", "cli", "-p", "hello"]);
    expect(code).toBe(2);
  });

  test("one-shot with auth prints the reply and exits 0", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const provider = await prepareAuth(baseDir, server.url);
    const cli = createCli({ name: "test-cli", provider, baseDir });

    // Capture stdout.
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    cleanups.push(() => {
      process.stdout.write = original;
    });

    const code = await cli.run(["bun", "cli", "-p", "hello"]);
    expect(code).toBe(0);
    expect(chunks.join("")).toBe("Echo: hello\n");
  }, 60_000);

  test("auth logout deletes the saved state", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const provider = await prepareAuth(baseDir, server.url);
    const cli = createCli({ name: "test-cli", provider, baseDir });

    const store = new AuthStore({
      configDir: "test-cli",
      providerName: provider.name,
      baseDir,
    });
    expect(store.has()).toBe(true);
    expect(await cli.run(["bun", "cli", "auth", "logout"])).toBe(0);
    expect(store.has()).toBe(false);
  }, 60_000);
});
