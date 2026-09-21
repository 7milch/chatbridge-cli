import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Provider } from "@chatbridge/provider";
import { type Browser, chromium } from "playwright-core";
import { type DummyChat, startDummyChat } from "./server";

const TEMPLATES = new URL(
  "../../packages/provider/skills/creating-provider-repo/templates/",
  import.meta.url,
).pathname;

const ROOT = new URL("../../", import.meta.url).pathname;

let server: DummyChat;
let browser: Browser;
let provider: Provider;

/** A scratch vendor repository inside the workspace: `templates/src` copied
 * to `<tmp>/src`, so the templates' bare imports (`@chatbridge/*`,
 * `playwright-core`) resolve the way they would in a vendor repository, and
 * `../package.json` resolves from `src/`. Returns `<tmp>`; removed in
 * afterAll. */
function instantiate(fill: Record<string, string>): string {
  const root = mkdtempSync(join(import.meta.dir, ".tmp-template-"));
  const dir = join(root, "src");
  cpSync(join(TEMPLATES, "src"), dir, { recursive: true });
  let selectors = readFileSync(join(dir, "selectors.ts"), "utf8");
  for (const [name, value] of Object.entries(fill)) {
    const before = selectors;
    selectors = selectors.replace(
      new RegExp(`export const ${name} = "[^"]*";`),
      `export const ${name} = ${JSON.stringify(value)};`,
    );
    if (selectors === before) throw new Error(`no placeholder for ${name}`);
  }
  writeFileSync(join(dir, "selectors.ts"), selectors);
  for (const file of ["provider.ts", "bin.ts"]) {
    const source = readFileSync(join(dir, file), "utf8")
      .replaceAll("<vendor>", "hard-dummy")
      .replaceAll("<Vendor>", "Hard Dummy")
      .replaceAll("<VENDOR>", "HARD_DUMMY");
    writeFileSync(join(dir, file), source);
  }
  return root;
}

beforeAll(async () => {
  server = await startDummyChat(0);
  server.setReplyDelayMs(150);
  server.setChunkDelayMs(30);
  browser = await chromium.launch();
  const root = instantiate({
    ENTRY_URL: `${server.url}/hard/login`,
    CHAT_URL: `${server.url}/hard/chat`,
    SIGN_IN_CONTROL: '[data-testid="sign-in-link"]',
    ACCOUNT_CONTROL: '[data-testid="account-menu"]',
    COMPOSER: '[data-testid="composer-input"]',
    SEND_BUTTON: '[data-testid="send-button"]',
    STOP_BUTTON: '[data-testid="stop-button"]',
    NEW_CHAT_BUTTON: 'button[aria-label="新しいチャット"]',
    ASSISTANT_MESSAGE: 'article[data-turn="assistant"]:not([data-placeholder])',
    USER_MESSAGE: 'article[data-turn="user"]',
    ASSISTANT_MESSAGE_BODY: '[data-part="content"]',
  });
  provider = (await import(join(root, "src", "provider.ts"))).default;
});

afterAll(async () => {
  await browser.close();
  server.stop();
  // .tmp-template-* is git-ignored and removed here.
  for (const entry of readdirSync(import.meta.dir))
    if (entry.startsWith(".tmp-template-"))
      rmSync(join(import.meta.dir, entry), { recursive: true, force: true });
});

describe("template provider on the hard skin", () => {
  test("a guest is not logged in although a composer exists", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.url}/hard/chat`);
    expect(await provider.isLoggedIn(page)).toBe(false);
    await context.close();
  });

  test("two turns: never the placeholder, never the previous turn, Markdown kept", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await provider.navigateToLogin(page);
    await page.click('[data-testid="login-submit"]');
    expect(await provider.isLoggedIn(page)).toBe(true);
    await provider.startNewChat(page);

    await provider.sendMessage(page, "first question");
    const first = await provider.waitForResponse(page);
    expect(first).not.toBe("…");
    expect(first.length).toBeGreaterThan(0);

    await provider.sendMessage(page, "md: sample");
    const seen: string[] = [];
    const poll = setInterval(() => {
      void provider.streaming
        ?.responseText(page)
        .then((partial) => {
          if (partial) seen.push(partial);
        })
        .catch(() => {});
    }, 20);
    const second = await provider.waitForResponse(page);
    clearInterval(poll);
    expect(second).not.toBe(first);
    expect(second).toMatch(/^```\w+$/m);
    expect(second).not.toContain("コードをコピー");
    expect(seen.length).toBeGreaterThan(0);
    for (const partial of seen) expect(partial).not.toBe(first);
    await context.close();
  }, 30_000);

  test("off-origin pages are logged out without touching the DOM", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("about:blank");
    expect(await provider.isLoggedIn(page)).toBe(false);
    await context.close();
  });

  test("detectBlock names the challenge page", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    server.setBlocked(true);
    try {
      await page.goto(`${server.url}/hard/chat`);
      expect(await provider.detectBlock?.(page)).toBe("challenge page");
    } finally {
      server.setBlocked(false);
      await context.close();
    }
  });
});

describe("template files", () => {
  test("selectors.ts starts empty and lists its collections", () => {
    const source = readFileSync(join(TEMPLATES, "src/selectors.ts"), "utf8");
    expect(source).toContain('export const COMPOSER = "";');
    expect(source).toContain("export const MANY");
  });

  test("mcp.json has a persistent and a guest browser, both with the probe", () => {
    const mcp = JSON.parse(readFileSync(join(TEMPLATES, "mcp.json"), "utf8"));
    const probe =
      ".claude/skills/creating-provider-repo/probes/chatbridge-probes.js";
    expect(Object.keys(mcp.mcpServers).sort()).toEqual([
      "playwright",
      "playwright-guest",
    ]);
    for (const name of ["playwright", "playwright-guest"]) {
      const args: string[] = mcp.mcpServers[name].args;
      expect(args, name).toContain("--init-script");
      expect(args, name).toContain(probe);
    }
    // The human logs in once in the persistent profile; the census of the
    // logged-out page needs a browser that is never logged in.
    expect(mcp.mcpServers.playwright.args).toContain("--user-data-dir");
    expect(mcp.mcpServers.playwright.args).toContain(".auth/mcp-profile");
    expect(mcp.mcpServers["playwright-guest"].args).toContain("--isolated");
    expect(mcp.mcpServers["playwright-guest"].args).not.toContain(
      "--user-data-dir",
    );
  });

  test("gitignore keeps the profile and auth state out of git", () => {
    const ignore = readFileSync(join(TEMPLATES, "gitignore"), "utf8");
    for (const line of [
      ".auth/",
      ".playwright-mcp/",
      "storage-state*.json",
      "node_modules/",
      "dist/",
    ])
      expect(ignore).toContain(line);
  });

  test("dom-notes.md has the eight sections, all unobserved", () => {
    const notes = readFileSync(join(TEMPLATES, "docs/dom-notes.md"), "utf8");
    for (const section of [
      "Login",
      "Chat page",
      "New chat",
      "Composer",
      "Messages",
      "Generation indicator",
      "Errors and rate limits",
      "Streaming behaviour",
    ])
      expect(notes).toContain(`## ${section}\n`);
    expect(notes.match(/^Not yet observed\.$/gm)).toHaveLength(8);
  });

  test("the templates type-check against the workspace packages", () => {
    const root = instantiate({
      ENTRY_URL: "https://example.com/login",
      CHAT_URL: "https://example.com/chat",
      SIGN_IN_CONTROL: '[data-testid="sign-in"]',
      ACCOUNT_CONTROL: '[data-testid="account"]',
      COMPOSER: '[data-testid="composer"]',
      SEND_BUTTON: '[data-testid="send"]',
      STOP_BUTTON: '[data-testid="stop"]',
      NEW_CHAT_BUTTON: '[data-testid="new-chat"]',
      ASSISTANT_MESSAGE: '[data-turn="assistant"]',
      USER_MESSAGE: '[data-turn="user"]',
      ASSISTANT_MESSAGE_BODY: '[data-part="content"]',
    });
    // bin.ts reads its own package's version through `../package.json`.
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "scratch", version: "0.0.0", type: "module" }),
      { flag: "wx" },
    );
    // The dependency tree a vendor repo has after `bun install`.
    mkdirSync(join(root, "node_modules/@chatbridge"), { recursive: true });
    for (const pkg of ["cli", "core", "provider"])
      symlinkSync(
        join(ROOT, "packages", pkg),
        join(root, "node_modules/@chatbridge", pkg),
      );
    symlinkSync(
      join(import.meta.dir, "node_modules/playwright-core"),
      join(root, "node_modules/playwright-core"),
    );
    const options = JSON.parse(
      readFileSync(join(TEMPLATES, "tsconfig.json"), "utf8"),
    ).compilerOptions;
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          ...options,
          noEmit: true,
          declaration: false,
          outDir: undefined,
        },
        include: ["src/selectors.ts", "src/provider.ts", "src/bin.ts"],
      }),
    );
    try {
      execFileSync(join(ROOT, "node_modules/.bin/tsc"), ["-p", root], {
        stdio: "pipe",
        encoding: "utf8",
      });
    } catch (error) {
      throw new Error(
        `tsc rejected the templates:\n${(error as { stdout?: string }).stdout ?? String(error)}`,
      );
    }
  }, 120_000);
});
