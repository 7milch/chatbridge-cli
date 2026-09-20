import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStore,
  BrowserRuntime,
  ChatSession,
  commandInfoOf,
} from "@chatbridge/core";
import { createDummyProvider } from "@chatbridge/example-dummy-chat/provider";
import { startDummyChat } from "@chatbridge/example-dummy-chat/server";
import { createCli } from "./create-cli.js";
import { ChatModel } from "./tui/chat-model.js";
import { expandInput } from "./tui/expand-input.js";

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

  test("expired auth exits 3", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const provider = await prepareAuth(baseDir, server.url);
    server.invalidateSessions();
    const cli = createCli({ name: "test-cli", provider, baseDir });
    expect(await cli.run(["bun", "cli", "-p", "hello"])).toBe(3);
  }, 60_000);

  test("slow response exits 4 within the --timeout budget", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const provider = await prepareAuth(baseDir, server.url);
    server.setReplyDelayMs(5000);
    const cli = createCli({ name: "test-cli", provider, baseDir });
    const started = Date.now();
    const code = await cli.run(["bun", "cli", "-p", "hello", "--timeout", "1"]);
    expect(code).toBe(4);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 60_000);

  test("challenge page exits 6 and suggests --headful", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const provider = await prepareAuth(baseDir, server.url);
    server.setBlocked(true);
    const cli = createCli({ name: "test-cli", provider, baseDir });

    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    cleanups.push(() => {
      process.stderr.write = original;
    });

    const code = await cli.run(["bun", "cli", "-p", "hello"]);
    expect(code).toBe(6);
    expect(chunks.join("")).toContain(
      'Blocked by "dummy-chat": challenge page. Try --headful.',
    );
  }, 60_000);
});

describe("interactive model against the dummy chat", () => {
  /** A ChatModel over a real ChatSession; no renderer — the model is the
   * unit under test and its history is what the view would show. */
  async function openModel(baseDir: string, serverUrl: string) {
    const provider = await prepareAuth(baseDir, serverUrl);
    const authStore = new AuthStore({
      configDir: "test-cli",
      providerName: provider.name,
      baseDir,
    });
    const timeoutMs = 30_000;
    const model = new ChatModel({
      openSession: () =>
        ChatSession.open({
          provider,
          authStore,
          headless: true,
          timeoutMs,
        }),
      login: async () => {},
      clearAuth: async () => {},
      commands: commandInfoOf(provider),
      expand: (text) =>
        expandInput(text, {
          cwd: baseDir,
          hooks: provider.urlHooks ?? [],
          timeoutMs,
        }),
    });
    cleanups.push(() => model.session?.close());
    await model.ready;
    expect(model.status).toBe("idle");
    return { model, provider };
  }

  test("a provider `show` command reads the live page", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const { model } = await openModel(baseDir, server.url);

    expect(await model.submit("/title")).toBe(true);
    expect(model.status).toBe("idle");
    expect(model.messages.at(-2)).toEqual({ role: "user", text: "/title" });
    // The command ran on the real page: this is the dummy chat's <title>.
    expect(model.messages.at(-1)).toEqual({
      role: "help",
      text: "Dummy Chat",
    });
  }, 60_000);

  test("a provider `send` command sends its prompt as a turn", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const { model } = await openModel(baseDir, server.url);

    expect(await model.submit("/shout hello")).toBe(true);
    expect(model.status).toBe("idle");
    // The history keeps the line as typed; the browser received the upper
    // case prompt the command produced.
    expect(model.messages.at(-2)).toEqual({
      role: "user",
      text: "/shout hello",
    });
    expect(model.messages.at(-1)?.role).toBe("assistant");
    expect(model.messages.at(-1)?.text).toMatch(/^Echo: HELLO/);
  }, 60_000);

  test("a hooked URL becomes an attachment on the turn", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const { model } = await openModel(baseDir, server.url);

    expect(await model.submit(`read ${server.url}/login`)).toBe(true);
    expect(model.status).toBe("idle");
    const user = model.messages.at(-2);
    expect(user?.role).toBe("user");
    expect(user?.text).toBe(`read ${server.url}/login`);
    expect(user?.attachments?.map((a) => a.path)).toEqual(["Dummy: /login"]);
    expect((user?.attachments?.[0]?.bytes ?? 0) > 0).toBe(true);
    expect(model.messages.at(-1)?.role).toBe("assistant");
  }, 60_000);

  test("a hook that fails refuses the turn and leaves the model idle", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const { model } = await openModel(baseDir, server.url);

    // submit() resolves false so the view refills the input box.
    expect(await model.submit(`read ${server.url}/nope`)).toBe(false);
    expect(model.status).toBe("idle");
    expect(model.messages.at(-1)?.role).toBe("error");
    expect(model.messages.at(-1)?.text).toMatch(/404 from dummy chat/);
  }, 60_000);
});
