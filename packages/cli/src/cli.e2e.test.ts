import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStore,
  BrowserRuntime,
  ChatSession,
  SessionRecorder,
  SessionStore,
  commandInfoOf,
  createSessionStore,
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
    const sessions = new SessionStore({
      configDir: "test-cli",
      providerName: provider.name,
      baseDir,
    });
    await sessions.save({
      version: 1,
      id: "11111111-1111-4111-8111-111111111111",
      provider: provider.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [{ role: "user", text: "hi" }],
    });
    expect(await sessions.list()).toHaveLength(1);
    expect(store.has()).toBe(true);
    expect(await cli.run(["bun", "cli", "auth", "logout"])).toBe(0);
    expect(store.has()).toBe(false);
    expect(await sessions.list()).toEqual([]);
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
  async function openModel(
    baseDir: string,
    serverUrl: string,
    opts: { prepared?: boolean } = {},
  ) {
    const provider = opts.prepared
      ? createDummyProvider(serverUrl)
      : await prepareAuth(baseDir, serverUrl);
    const authStore = new AuthStore({
      configDir: "test-cli",
      providerName: provider.name,
      baseDir,
    });
    const recorder = new SessionRecorder({
      store: createSessionStore({
        configDir: "test-cli",
        providerName: provider.name,
        baseDir,
      }),
      provider: provider.name,
    });
    const timeoutMs = 30_000;
    const model = new ChatModel({
      openSession: (_report, _onIdleExpired, conversation) =>
        ChatSession.open({
          provider,
          authStore,
          headless: true,
          timeoutMs,
          conversation,
        }),
      login: async () => {},
      clearAuth: () => authStore.clear(),
      recorder,
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
    return { model, provider, recorder };
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

  test("a session saved by one process is resumed by another", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();

    const first = await openModel(baseDir, server.url);
    expect(await first.model.submit("hello")).toBe(true);
    expect(await first.model.submit("again")).toBe(true);
    await first.recorder.flush();
    await first.model.session?.close();

    const second = await openModel(baseDir, server.url, { prepared: true });
    await second.model.openResumePicker();
    expect(second.model.picker).toHaveLength(1);
    expect(second.model.picker?.[0]?.title).toBe("hello");
    expect(second.model.picker?.[0]?.turns).toBe(2);

    await second.model.resume(second.model.picker?.[0]?.id ?? "");
    expect(second.model.status).toBe("idle");
    expect(second.model.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "separator",
    ]);
    expect(second.model.messages[0]?.text).toBe("hello");
    expect(second.model.messages.at(-1)?.text).toBe(
      "resumed · conversation restored",
    );

    // The service side came back too: its turn counter carries on.
    expect(await second.model.submit("turns?")).toBe(true);
    expect(second.model.messages.at(-1)?.text).toBe("Echo: turns? (turn 3)");

    // And the resumed file, not a new one, received the turn.
    await second.recorder.flush();
    const store = new SessionStore({
      configDir: "test-cli",
      providerName: second.provider.name,
      baseDir,
    });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.turns).toBe(3);
  }, 120_000);

  // Review Focus 5.
  test("a handle the service no longer knows falls back to a new chat", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const { model, provider, recorder } = await openModel(baseDir, server.url);
    const id = "11111111-1111-4111-8111-111111111111";
    const store = new SessionStore({
      configDir: "test-cli",
      providerName: provider.name,
      baseDir,
    });
    await store.save({
      version: 1,
      id,
      provider: provider.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Well-formed, but the server never issued it.
      conversation: `${server.url}/chat/c/zzzzzzzz`,
      messages: [
        { role: "user", text: "from another life" },
        { role: "assistant", text: "Echo: from another life (turn 1)" },
      ],
    });

    await model.resume(id);
    expect(model.status).toBe("idle");
    expect(model.messages.at(-1)).toEqual({
      role: "separator",
      text: "resumed · conversation could not be restored",
    });
    expect(await model.submit("turns?")).toBe(true);
    expect(model.messages.at(-1)?.text).toBe("Echo: turns? (turn 1)");

    await recorder.flush();
    const after = await store.load(id);
    // The dead handle is gone; the new conversation's handle took its place.
    expect(after?.conversation).not.toBe(`${server.url}/chat/c/zzzzzzzz`);
    expect(after?.conversation).toMatch(/\/chat\/c\/[a-z0-9]{8}$/);
  }, 120_000);

  test("/logout deletes the saved sessions", async () => {
    const server = await startDummyChat(0);
    cleanups.push(server.stop);
    const baseDir = setup();
    const { model, provider, recorder } = await openModel(baseDir, server.url);
    expect(await model.submit("hello")).toBe(true);
    await recorder.flush();
    const store = new SessionStore({
      configDir: "test-cli",
      providerName: provider.name,
      baseDir,
    });
    expect(await store.list()).toHaveLength(1);

    await model.submit("/logout");
    await recorder.flush();
    expect(await store.list()).toEqual([]);
    // The status after an interactive logout is not asserted here: the
    // logout currently leaves the auth state on disk (the close before the
    // reopen saves it back), so the reopen succeeds. Whoever fixes #137
    // adds the assertion here.

    // What was saved before the logout stays deleted: the next turn starts
    // a new session file that holds only that turn.
    expect(await model.submit("after logout")).toBe(true);
    await recorder.flush();
    const after = await store.list();
    expect(after).toHaveLength(1);
    expect(after[0]?.turns).toBe(1);
    expect(after[0]?.title).toBe("after logout");
  }, 120_000);
});
