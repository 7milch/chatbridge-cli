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

/** The three placeholders a vendor replaces when copying a template. */
const fillPlaceholders = (source: string): string =>
  source
    .replaceAll("<vendor>", "hard-dummy")
    .replaceAll("<Vendor>", "Hard Dummy")
    .replaceAll("<VENDOR>", "HARD_DUMMY");

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
      // Quoted the way the template's formatter wants it.
      `export const ${name} = ${value.includes('"') && !value.includes("'") ? `'${value}'` : JSON.stringify(value)};`,
    );
    if (selectors === before) throw new Error(`no placeholder for ${name}`);
  }
  writeFileSync(join(dir, "selectors.ts"), selectors);
  for (const file of readdirSync(dir)) {
    if (file === "selectors.ts") continue;
    writeFileSync(
      join(dir, file),
      fillPlaceholders(readFileSync(join(dir, file), "utf8")),
    );
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

  test("an empty SIGN_IN_CONTROL lets the account control decide alone", async () => {
    const root = instantiate({
      CHAT_URL: `${server.url}/hard/chat`,
      ACCOUNT_CONTROL: '[data-testid="account-menu"]',
    });
    const alone: Provider = (await import(join(root, "src", "provider.ts")))
      .default;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.url}/hard/login`);
    await page.click('[data-testid="login-submit"]');
    expect(await alone.isLoggedIn(page)).toBe(true);
    await context.clearCookies();
    await page.goto(`${server.url}/hard/chat`);
    expect(await alone.isLoggedIn(page)).toBe(false);
    await context.close();
  }, 30_000);

  test("empty STOP_BUTTON and NEW_CHAT_BUTTON need no code edit", async () => {
    const root = instantiate({
      ENTRY_URL: `${server.url}/hard/login`,
      CHAT_URL: `${server.url}/hard/chat`,
      SIGN_IN_CONTROL: '[data-testid="sign-in-link"]',
      ACCOUNT_CONTROL: '[data-testid="account-menu"]',
      COMPOSER: '[data-testid="composer-input"]',
      SEND_BUTTON: '[data-testid="send-button"]',
      ASSISTANT_MESSAGE:
        'article[data-turn="assistant"]:not([data-placeholder])',
      USER_MESSAGE: 'article[data-turn="user"]',
      ASSISTANT_MESSAGE_BODY: '[data-part="content"]',
    });
    const bare: Provider = (await import(join(root, "src", "provider.ts")))
      .default;
    const context = await browser.newContext();
    const page = await context.newPage();
    await bare.navigateToLogin(page);
    await page.click('[data-testid="login-submit"]');
    await bare.startNewChat(page);
    await bare.sendMessage(page, "first question");
    const first = await bare.waitForResponse(page);
    expect(first).not.toBe("…");
    expect(first.length).toBeGreaterThan(0);
    await bare.sendMessage(page, "md: sample");
    const second = await bare.waitForResponse(page);
    expect(second).not.toBe(first);
    expect(second).toMatch(/^```\w+$/m);
    // New chat by URL: the thread is gone and the composer is empty.
    await page.fill('[data-testid="composer-input"]', "left over");
    await bare.startNewChat(page);
    expect(await page.locator('article[data-turn="assistant"]').count()).toBe(
      0,
    );
    expect(
      (await page.locator('[data-testid="composer-input"]').innerText()).trim(),
    ).toBe("");
    await context.close();
  }, 60_000);

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

  test("placeholders are literal and every one of them substitutes away", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(TEMPLATES);
    expect(files.length).toBeGreaterThan(10);
    for (const path of files) {
      const source = readFileSync(path, "utf8");
      const name = path.slice(TEMPLATES.length);
      // An HTML-escaped placeholder survives the vendor's substitution.
      expect(source, name).not.toContain("&lt;");
      expect(source, name).not.toContain("&gt;");
      expect(fillPlaceholders(source), name).not.toMatch(
        /<(vendor|Vendor|VENDOR)>/,
      );
    }
  });

  /** What a vendor repo has after `bun install`: a package.json for bin.ts to
   * read its version from, and the dependency tree. */
  const installed = (root: string) => {
    writeFileSync(
      join(root, "package.json"),
      fillPlaceholders(readFileSync(join(TEMPLATES, "package.json"), "utf8")),
      { flag: "wx" },
    );
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
    return root;
  };
  const run = (root: string, file: string, args: string[]) => {
    try {
      return execFileSync(file, args, {
        cwd: root,
        stdio: "pipe",
        encoding: "utf8",
      });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      throw new Error(`${file} ${args.join(" ")}:\n${e.stdout}\n${e.stderr}`);
    }
  };

  test("a fresh scaffold, selectors still empty, passes its own tests", () => {
    const root = installed(instantiate({}));
    run(root, process.execPath, [
      "test",
      "src/selectors.test.ts",
      "src/provider.test.ts",
    ]);
  }, 60_000);

  test("the templates type-check and lint clean against the workspace packages", () => {
    const root = installed(
      instantiate({
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
      }),
    );
    // The template's own lint config over the substituted files: a rule that
    // only fires once `<VENDOR>` is a real name is caught here. The browser
    // profile and the MCP output must be invisible to it — a formatter run
    // over a live profile corrupts it.
    cpSync(join(TEMPLATES, "biome.json"), join(root, "biome.json"));
    for (const dir of [".auth/mcp-profile", ".playwright-mcp"]) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "x.json"), '{"a":1,\n\n      "b":[1,2]}');
    }
    run(root, join(ROOT, "node_modules/.bin/biome"), ["check", "."]);
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
          // The shipped template excludes *.test.ts from its build; here they
          // are type-checked too, so a core API change cannot break
          // provider.e2e.test.ts silently.
          types: ["bun"],
        },
        include: ["src"],
      }),
    );
    run(root, join(ROOT, "node_modules/.bin/tsc"), ["-p", root]);
  }, 120_000);
});

describe("VSCode template", () => {
  test("contributes the same IDs as the working example", () => {
    const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
    const example = read(
      new URL("../vscode-dummy-chat/package.json", import.meta.url).pathname,
    );
    const template = read(join(TEMPLATES, "vscode/package.json"));

    // Normalise the example's contributes the way a vendor's would read once
    // copied from the template: its own id in place of "chatbridge-dummy".
    // Human-readable text (title/description/category) legitimately differs
    // per vendor, so it is stripped before comparing, along with
    // idleTimeoutMinutes/timeoutSec defaults (ruling 4: the template
    // deliberately omits them so the provider's own default is not
    // silently overridden; the example still declares them for its own
    // demo purposes).
    const strip = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(strip);
      if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (k === "title" || k === "description" || k === "category")
            continue;
          out[k] = strip(v);
        }
        return out;
      }
      return value;
    };
    const normalise = (contributes: unknown) =>
      strip(
        JSON.parse(
          JSON.stringify(contributes).replaceAll(
            "chatbridge-dummy",
            "<vendor>",
          ),
        ),
      ) as Record<string, unknown>;

    const normalisedExample = normalise(example.contributes) as {
      configuration: { properties: Record<string, { default?: unknown }> };
    };
    const normalisedTemplate = strip(template.contributes) as {
      configuration: { properties: Record<string, { default?: unknown }> };
    };

    // idleTimeoutMinutes/timeoutSec: no default in the template, on purpose.
    expect(
      normalisedTemplate.configuration.properties[
        "<vendor>.idleTimeoutMinutes"
      ],
    ).not.toHaveProperty("default");
    expect(
      normalisedTemplate.configuration.properties["<vendor>.timeoutSec"],
    ).not.toHaveProperty("default");
    for (const key of ["<vendor>.idleTimeoutMinutes", "<vendor>.timeoutSec"]) {
      normalisedExample.configuration.properties[key].default = undefined;
      normalisedTemplate.configuration.properties[key].default = undefined;
    }

    expect(normalisedTemplate).toEqual(normalisedExample);
    expect(template.dependencies).toHaveProperty("playwright");
    expect(template.dependencies).not.toHaveProperty("@chatbridge/vscode");
    expect(template.devDependencies).toHaveProperty("@chatbridge/vscode");
    expect(template.devDependencies).toHaveProperty("esbuild");
    expect(template.devDependencies).toHaveProperty("@vscode/vsce");
  });
});
