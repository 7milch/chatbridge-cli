# Provider Skill DOM Discovery Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the provider skills self-contained, shipped inside `@chatbridge/provider`, and usable by a Sonnet-class model alone: a Playwright MCP discovery procedure driven by a probe script, ready-made templates, and an upgrade skill for existing vendor repositories.

**Architecture:** One probe file (`window.__cbProbe`) loaded by Playwright MCP's `--init-script` turns DOM discovery into "run, read, copy". Templates carry a provider that already implements the contract. A `/hard` skin of the dummy chat reproduces the traps of real services and is the target for the automated tests and for the skill's RED/GREEN runs. The skills live in `packages/provider/skills/` and are published with the package; this repository symlinks to them.

**Tech Stack:** TypeScript, Bun (workspaces, `bun test`), Playwright (`playwright-core` 1.63.0, Chromium), `@playwright/mcp`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-21-provider-skill-dom-discovery-design.md` — read it first. Tracking issue: #113. Branch: `issue-113`.

## Global Constraints

- Everything committed is English (docs, comments, commit messages, issue comments).
- `bun run check` passes before every commit. Commit trailer:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (use the model that made the commit) and the `Claude-Session:` line.
- After every commit: `gh issue comment 113 --body "<what was committed> + What's next: <…>"`.
- No vendor-specific material: no real service names in selectors, templates or fixtures beyond the public examples already in the skill (ChatGPT traps).
- No bot-protection evasion. The probe never reads `document.cookie`, `localStorage`, `sessionStorage` or `indexedDB`; those four words must not appear in the probe source at all (a test enforces it — use other wording in comments).
- Probe output carries text only as `{ length, head }` with `head` at most 40 characters.
- The probe is plain ES2020, one file, no imports, no build step.
- No change to `@chatbridge/*` runtime code. Only `packages/provider/package.json` (`files`) and its README change.
- Dependency direction `cli → core → runtime → provider` is untouched.
- Spike result (2026-09-21, already done): `npx @playwright/mcp@latest --user-data-dir <dir> --init-script <file>` exposes the init script's globals to `browser_evaluate` (`{ function: "() => window.__cbProbe.census()" }`); `browser_evaluate` takes an optional `filename` to save the result instead of returning it; `browser_click` accepts a CSS selector as `target`; the server writes snapshots into `.playwright-mcp/` under the working directory.

## File Structure

```
examples/dummy-chat/
  hard-skin.ts            NEW  HTML for /hard/chat and /hard/login (one responsibility: the markup + page script)
  server.ts               MOD  routes /hard/*, /do-login honours ?next=
  hard-skin.test.ts       NEW  server-level tests of the skin
  probes.test.ts          NEW  Chromium tests of the probe against /hard/chat
  templates.test.ts       NEW  template provider against /hard/chat; template/VSCode manifest checks
packages/provider/
  package.json            MOD  "files" gains "skills"
  README.md               MOD  the three instructions + refresh command
  skills.test.ts          NEW  packaging + upgrade-guide + word-count checks
  skills/
    creating-provider-repo/
      SKILL.md  dom-discovery.md  vscode-extension.md
      probes/chatbridge-probes.js
      templates/…            (see Task 5)
    upgrading-provider-repo/
      SKILL.md  upgrade-guide.md
    starting-next-milestone/ is NOT moved: it is repo-internal and stays in .claude/skills/
.claude/skills/creating-provider-repo   → symlink ../../packages/provider/skills/creating-provider-repo
.claude/skills/upgrading-provider-repo  → symlink ../../packages/provider/skills/upgrading-provider-repo
.agents/skills                          → symlink ../.claude/skills
CLAUDE.md, docs/PUBLISHING.md           MOD  upgrade-guide process rule
```

Until Task 7 moves them, the skill files are created directly at their final
location `packages/provider/skills/creating-provider-repo/`; Task 7 only removes
the old `.claude/skills/creating-provider-repo/SKILL.md` and adds the symlinks.
Tasks 2–6 therefore never touch `.claude/skills/`.

Model policy (`CLAUDE.md`): Tasks 1, 3, 4, 5 → Opus. Tasks 6, 7, 8 → Opus for
writing (skill prose read by a weaker model is judgment work), Sonnet for the
mechanical parts of 7. Tasks 2 and 9 are run by the controller. Final review → Fable.

---

### Task 1: `/hard` skin for the dummy chat

**Files:**
- Create: `examples/dummy-chat/hard-skin.ts`
- Modify: `examples/dummy-chat/server.ts` (the `fetch` handler, `/do-login` branch)
- Test: `examples/dummy-chat/hard-skin.test.ts`

**Interfaces:**
- Consumes: `replyChunks` stays private; the skin's page script calls the existing `POST /reply`.
- Produces: `hardChatHtml(loggedIn: boolean, replyDelayMs: number, chunkDelayMs: number): string`, `HARD_LOGIN_HTML: string`. Routes `GET /hard/chat` (200 for guests and members alike), `GET /hard/login`, `POST /do-login?next=/hard/chat`. DOM facts later tasks rely on:
  - composer: `div[contenteditable="true"][data-testid="composer-input"]`, preceded by a hidden `<textarea style="display:none">`
  - send button `button[data-testid="send-button"]`, present **only while the composer is non-empty**; stop button `button[data-testid="stop-button"]` while generating
  - turns: `<main><div role="log">` with children `<article data-turn="user|assistant">`; assistant content in `div[data-part="content"]`, chrome in `div[data-part="actions"]`
  - placeholder: `<article data-turn="assistant" data-placeholder="true">…</article>` inserted on send, removed after `replyDelayMs`, then the real article is appended
  - code blocks are wrapped: `<div data-part="code"><div data-part="code-header"><span>LANG</span><button aria-label="コードをコピー">…</button></div><pre>…</pre></div>`
  - member: `button[data-testid="account-menu"]` (aria-label `アカウント`); guest: `a[data-testid="sign-in-link"]` (text `ログイン`), and the guest composer still exists
  - new chat: `button[aria-label="新しいチャット"]`, clears the log
  - `<html lang="ja">`; every class is of the `css-…` kind; no ids

- [ ] **Step 1: Write the failing tests**

```ts
// examples/dummy-chat/hard-skin.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { startDummyChat } from "./server";

let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe("hard skin", () => {
  test("guests get the chat page with a composer and a sign-in link", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const res = await fetch(`${s.url}/hard/chat`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="sign-in-link"');
    expect(html).toContain('data-testid="composer-input"');
    expect(html).not.toContain('data-testid="account-menu"');
  });

  test("members get the account menu and no sign-in link", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const html = await (
      await fetch(`${s.url}/hard/chat`, { headers: { cookie: "session=ok" } })
    ).text();
    expect(html).toContain('data-testid="account-menu"');
    expect(html).not.toContain('data-testid="sign-in-link"');
  });

  test("the markup has no ids and only generated class names", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const html = await (await fetch(`${s.url}/hard/chat`)).text();
    const markup = html.slice(0, html.indexOf("<script>"));
    expect(markup).not.toMatch(/\sid="/);
    for (const m of markup.matchAll(/class="([^"]+)"/g)) {
      for (const cls of (m[1] ?? "").split(/\s+/))
        expect(cls).toMatch(/^css-[a-z0-9]{6}$/);
    }
  });

  test("login honours ?next= for the hard skin only", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const hard = await fetch(`${s.url}/do-login?next=/hard/chat`, {
      method: "POST",
      redirect: "manual",
    });
    expect(hard.headers.get("location")).toBe("/hard/chat");
    const evil = await fetch(`${s.url}/do-login?next=https://example.com`, {
      method: "POST",
      redirect: "manual",
    });
    expect(evil.headers.get("location")).toBe("/chat");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test examples/dummy-chat/hard-skin.test.ts`
Expected: FAIL, 404 for `/hard/chat`.

- [ ] **Step 3: Write `hard-skin.ts`**

```ts
// examples/dummy-chat/hard-skin.ts
/** A second skin for the dummy chat with the traps real services have:
 * no ids, generated class names, localized labels, a hidden textarea before
 * the real composer, a guest composer, a send button that only exists while
 * the composer is non-empty, a stop button while generating, a placeholder
 * turn that is removed before the real one, and chrome inside replies.
 * Same session cookie and the same POST /reply as the plain skin. */

export const HARD_LOGIN_HTML = `<!doctype html>
<html lang="ja">
<title>Dummy Chat — ログイン</title>
<form method="post" action="/do-login?next=/hard/chat">
  <button class="css-9f3k2a" type="submit" data-testid="login-submit">ログインする</button>
</form>
</html>`;

export function hardChatHtml(
  loggedIn: boolean,
  replyDelayMs: number,
  chunkDelayMs: number,
): string {
  const identity = loggedIn
    ? `<button class="css-7d1q0z" type="button" data-testid="account-menu" aria-label="アカウント"><svg width="16" height="16"></svg></button>`
    : `<a class="css-2m8x4c" href="/hard/login" data-testid="sign-in-link">ログイン</a>`;
  return `<!doctype html>
<html lang="ja">
<title>Dummy Chat</title>
<meta name="reply-delay" content="${replyDelayMs}">
<meta name="chunk-delay" content="${chunkDelayMs}">
<header class="css-a81k3p">
  <button class="css-k20d9s" type="button" aria-label="新しいチャット"><svg width="16" height="16"></svg></button>
  ${identity}
</header>
<main class="css-p4w7e1"><div class="css-h6t2b9" role="log"></div></main>
<footer class="css-c3n5v8">
  <textarea class="css-z0z0z0" style="display:none" tabindex="-1"></textarea>
  <div class="css-e9r1u6" contenteditable="true" role="textbox" data-testid="composer-input" aria-label="メッセージを入力"></div>
  <span class="css-b7y4i2" data-slot="action"></span>
</footer>
<script>
  const meta = (name) => Number(document.querySelector('meta[name="' + name + '"]').content);
  const log = document.querySelector('[role="log"]');
  const input = document.querySelector('[data-testid="composer-input"]');
  const slot = document.querySelector('[data-slot="action"]');
  let busy = false;
  let turn = 0;

  const button = (testid, label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "css-q5s8d3";
    b.dataset.testid = testid;
    b.setAttribute("aria-label", label);
    b.innerHTML = '<svg width="16" height="16"></svg>';
    return b;
  };
  // The send button exists only while there is something to send.
  const renderAction = () => {
    slot.replaceChildren();
    if (busy) slot.appendChild(button("stop-button", "生成を停止"));
    else if (input.textContent.trim() !== "") {
      const send = button("send-button", "送信");
      send.addEventListener("click", submit);
      slot.appendChild(send);
    }
  };
  input.addEventListener("input", renderAction);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  const article = (who) => {
    const a = document.createElement("article");
    a.className = "css-t1g6h0";
    a.dataset.turn = who;
    return a;
  };
  // Replies carry chrome: a code-block header with a copy button, and an
  // action row under the content.
  const decorate = (html) => html.replace(
    /<pre><code(?: class="language-([^"]+)")?>/g,
    (m, lang) => '<div class="css-w2x9c4" data-part="code"><div class="css-o8l3m7" data-part="code-header"><span>' +
      (lang || "text") + '</span><button type="button" aria-label="コードをコピー"><svg width="12" height="12"></svg></button></div>' + m,
  ).replace(/<\\/code><\\/pre>/g, "</code></pre></div>");

  async function submit() {
    const text = input.textContent.trim();
    if (!text || busy) return;
    input.textContent = "";
    busy = true;
    renderAction();
    const you = article("user");
    you.textContent = text;
    log.appendChild(you);
    const placeholder = article("assistant");
    placeholder.dataset.placeholder = "true";
    placeholder.textContent = "…";
    log.appendChild(placeholder);
    await new Promise((r) => setTimeout(r, text.startsWith("slow:") ? 5000 : meta("reply-delay")));
    placeholder.remove();
    const reply = article("assistant");
    reply.dataset.messageId = "m" + (++turn);
    reply.innerHTML = '<div class="css-y3v0n5" data-part="content"></div>' +
      '<div class="css-u4j7f2" data-part="actions"><button type="button" aria-label="コピー"><svg width="12" height="12"></svg></button>' +
      '<button type="button" aria-label="良い回答"><svg width="12" height="12"></svg></button></div>';
    log.appendChild(reply);
    const content = reply.querySelector('[data-part="content"]');
    try {
      const res = await fetch("/reply", { method: "POST", body: text });
      const { chunks } = await res.json();
      for (const html of chunks) {
        content.innerHTML = decorate(html);
        await new Promise((r) => setTimeout(r, meta("chunk-delay")));
      }
    } catch (err) {
      content.textContent = "reply failed: " + err;
    } finally {
      busy = false;
      renderAction();
    }
  }

  document.querySelector('[aria-label="新しいチャット"]').addEventListener("click", () => {
    log.replaceChildren();
    input.textContent = "";
    renderAction();
  });
</script>
</html>`;
}
```

Note the `/reply` endpoint requires a session, so a guest's turn ends in
"reply failed: …" text. That is intended: it mirrors a guest seeing a promo
instead of an answer.

- [ ] **Step 4: Route it in `server.ts`**

Add the import at the top:

```ts
import { HARD_LOGIN_HTML, hardChatHtml } from "./hard-skin";
```

Replace the `/do-login` branch and add the two routes before `/reply`:

```ts
      if (pathname === "/do-login" && req.method === "POST") {
        sessionsValid = true;
        // Only the two known chat pages: never an open redirect.
        const next = url.searchParams.get("next") === "/hard/chat" ? "/hard/chat" : "/chat";
        return new Response(null, {
          status: 302,
          headers: {
            location: next,
            "set-cookie": "session=ok; Path=/; HttpOnly",
          },
        });
      }
      if (pathname === "/hard/login") {
        return new Response(HARD_LOGIN_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/hard/chat") {
        if (blocked) {
          return new Response(CHALLENGE_HTML, {
            headers: { "content-type": "text/html" },
          });
        }
        // Guests get the page too: this skin offers guest chat.
        return new Response(
          hardChatHtml(hasSession(req), replyDelayMs, chunkDelayMs),
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
```

Also extend the file's header comment with one line: `GET /hard/chat, /hard/login — the same chat behind a realistic DOM (see hard-skin.ts).`

- [ ] **Step 5: Run the tests**

Run: `bun test examples/dummy-chat`
Expected: PASS, including the untouched `server.test.ts`.

- [ ] **Step 6: Look at it once in a browser**

Run `bun examples/dummy-chat/serve.ts`, open `http://localhost:8735/hard/login`, log in, send `hello` and then `md: sample` (a prompt starting with `md:` gets a reply with a code block). Confirm: the send button appears only after typing, the stop button shows while generating, "…" flashes before the reply, the code block has a header. Stop the server.

- [ ] **Step 7: Commit and sync**

```bash
bun run check
git add examples/dummy-chat
git commit -m "test: add a realistic /hard skin to the dummy chat (Refs #113)"
gh issue comment 113 --body "Task 1 done: /hard skin for the dummy chat (hidden textarea, guest composer, send/stop swap, placeholder turn, reply chrome, ja labels, generated classes). What's next: Task 2, RED baseline of the current skill against /hard."
```

---

### Task 2: RED baseline (controller, no code)

**Files:** none committed except nothing; findings go to issue #113.

**Interfaces:**
- Consumes: the `/hard` skin from Task 1; the **current** `.claude/skills/creating-provider-repo/SKILL.md` (unchanged so far).
- Produces: a list of observed failures, quoted, posted to #113. Tasks 3–6 must address each one; add rows to the decision table for any failure the spec did not predict.

- [ ] **Step 1: Prepare the arena**

```bash
ARENA="$(mktemp -d)/vendor-red" && mkdir -p "$ARENA/.claude/skills"
cp -R .claude/skills/creating-provider-repo "$ARENA/.claude/skills/"
(cd "$ARENA" && git init -q)
bun examples/dummy-chat/serve.ts &   # http://localhost:8735
```

- [ ] **Step 2: Dispatch one Sonnet subagent** (`model: "sonnet"`, general-purpose) with exactly this prompt:

```
You are working in <ARENA>. Read .claude/skills/creating-provider-repo/SKILL.md and follow it to
build a chatbridge provider for the chat service at http://localhost:8735/hard/chat (login page:
http://localhost:8735/hard/login — clicking its one button logs you in; treat that click as "the
human logged in"). You may use the Playwright MCP tools. Install @chatbridge/* from npm as the skill
says. Finish with docs/dom-notes.md filled, src/selectors.ts, src/provider.ts, and a passing two-turn
E2E against that URL. Report: what you observed, every selector you chose and why, and anything in
the skill that was unclear or missing.
```

- [ ] **Step 3: Score the result** against this checklist and record verbatim quotes of the agent's reasoning where it went wrong:

1. Any selector based on a `css-…` class, or guessed without observation?
2. Does the composer locator match the hidden `<textarea>`?
3. Is the login signal only "composer exists" (true for guests)?
4. Does `waitForResponse` ever return "…" (the placeholder)?
5. Does it wait for the send button to return (it never does while the composer is empty)?
6. Does the Markdown reply include the code header label or lose the code language?
7. How many tool calls / how much back-and-forth did discovery take?
8. Which parts of the skill did the agent say were unclear?

- [ ] **Step 4: Post the findings**

```bash
gh issue comment 113 --body "Task 2 (RED baseline, Sonnet, current skill, /hard skin): <checklist results with quotes>. What's next: Task 3, the probe script."
```

Stop the dummy server. Keep `$ARENA` until Task 9 (the upgrade scenario reuses a text-only provider; if the RED run produced a working one, note its path in the issue comment).

---

### Task 3: The probe script

**Files:**
- Create: `packages/provider/skills/creating-provider-repo/probes/chatbridge-probes.js`
- Test: `examples/dummy-chat/probes.test.ts`
- Modify: `biome.json` only if Biome rejects the plain-script globals (add the file to an override with `"javascript": { "globals": ["window", "document", …] }` is NOT needed — browser globals are known; if a rule fires, fix the code, do not disable the rule).

**Interfaces:**
- Consumes: DOM facts of `/hard/chat` (Task 1).
- Produces: `window.__cbProbe` with
  - `census(): Census`
  - `recordTurn.start(): "recording"`, `recordTurn.stop(): TurnRecord`
  - `replyShape(selector?: string): ReplyShape`
  - `verify(selectors: Record<string, string | { selector: string; many: true }>): Record<string, { count: number; visibleCount: number; ok: boolean }>`
  - Types exactly as in the spec §2 and §7.4, with these additions fixed here:
    `type Text = { length: number; head: string }`; `Candidate.text?: Text`;
    `ReplyShape = { root: string; tagCensus: Record<string, number>; chrome: { locator: string; kind: "button" | "toolbar" | "code-header" | "collapsible" | "hidden" }[]; codeLanguage: "class" | "header-label" | "none" | "no-code-block"; contentRoot: string | null; chromeInsideContent: string[] }`.

- [ ] **Step 1: Write the failing tests**

```ts
// examples/dummy-chat/probes.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type Browser, type Page, chromium } from "playwright-core";
import { type DummyChat, startDummyChat } from "./server";

const PROBE = new URL(
  "../../packages/provider/skills/creating-provider-repo/probes/chatbridge-probes.js",
  import.meta.url,
).pathname;

let server: DummyChat;
let browser: Browser;
beforeAll(async () => {
  server = await startDummyChat(0);
  server.setReplyDelayMs(150);
  server.setChunkDelayMs(30);
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  server.stop();
});

async function open(loggedIn: boolean): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript({ path: PROBE });
  const page = await context.newPage();
  if (loggedIn) {
    await page.goto(`${server.url}/hard/login`);
    await page.click('[data-testid="login-submit"]');
  } else {
    await page.goto(`${server.url}/hard/chat`);
  }
  await page.waitForSelector('[data-testid="composer-input"]');
  return page;
}

// biome-ignore lint/suspicious/noExplicitAny: the probe is untyped page-side JS
const probe = <T = any>(page: Page, expr: string): Promise<T> =>
  page.evaluate(`(${expr})`) as Promise<T>;

async function sendTurn(page: Page, text: string) {
  await page.fill('[data-testid="composer-input"]', text);
  await page.click('[data-testid="send-button"]');
  await page.waitForSelector('[data-testid="stop-button"]');
  await page.waitForSelector('[data-testid="stop-button"]', { state: "detached" });
}

describe("probe source", () => {
  test("never names browser storage or cookies", () => {
    const source = readFileSync(PROBE, "utf8");
    for (const word of ["cookie", "localStorage", "sessionStorage", "indexedDB"])
      expect(source.toLowerCase()).not.toContain(word.toLowerCase());
  });
});

describe("census", () => {
  test("reports the visible composer with a unique non-class locator and the hidden textarea as hidden", async () => {
    const page = await open(true);
    const c = await probe(page, "window.__cbProbe.census()");
    expect(c.lang).toBe("ja");
    const visible = c.composer.filter((x: { visible: boolean }) => x.visible);
    expect(visible).toHaveLength(1);
    expect(visible[0].locators[0]).toBe('[data-testid="composer-input"]');
    const hidden = c.composer.filter((x: { visible: boolean }) => !x.visible);
    expect(hidden).toHaveLength(1);
    expect(hidden[0].tag).toBe("textarea");
    for (const cand of [...c.composer, ...c.buttons, ...c.account, ...c.signIn])
      for (const loc of cand.locators) expect(loc).not.toMatch(/css-|\./);
    await page.context().close();
  });

  test("logged-out and logged-in differ in account and signIn, not in composer", async () => {
    const guest = await open(false);
    const member = await open(true);
    const g = await probe(guest, "window.__cbProbe.census()");
    const m = await probe(member, "window.__cbProbe.census()");
    expect(g.signIn.map((x: { locators: string[] }) => x.locators[0])).toContain('[data-testid="sign-in-link"]');
    expect(g.account).toHaveLength(0);
    expect(m.signIn).toHaveLength(0);
    expect(m.account.map((x: { locators: string[] }) => x.locators[0])).toContain('[data-testid="account-menu"]');
    expect(g.composer.filter((x: { visible: boolean }) => x.visible)).toHaveLength(1);
    await guest.context().close();
    await member.context().close();
  });

  test("rejects generated classes and says why", async () => {
    const page = await open(true);
    const c = await probe(page, "window.__cbProbe.census()");
    const composer = c.composer.find((x: { visible: boolean }) => x.visible);
    expect(composer.unstable.join(" ")).toContain("class");
    await page.context().close();
  });

  test("finds the message list after two turns and keeps text out of the output", async () => {
    const page = await open(true);
    await sendTurn(page, "hello there this is a long enough message to be cut at forty characters");
    await sendTurn(page, "second");
    const c = await probe(page, "window.__cbProbe.census()");
    const list = c.messageLists.find((l: { locator: string }) => l.locator === '[role="log"]');
    expect(list.children).toBe(4);
    expect(list.childShape).toContain("data-turn");
    expect(JSON.stringify(c)).not.toContain("forty characters");
    await page.context().close();
  });
});

describe("recordTurn", () => {
  test("sees the placeholder, the streaming element and the stop button leaving last", async () => {
    const page = await open(true);
    await page.fill('[data-testid="composer-input"]', "md: sample");
    expect(await probe(page, "window.__cbProbe.recordTurn.start()")).toBe("recording");
    await page.click('[data-testid="send-button"]');
    await page.waitForSelector('[data-testid="stop-button"]');
    await page.waitForSelector('[data-testid="stop-button"]', { state: "detached" });
    const r = await probe(page, "window.__cbProbe.recordTurn.stop()");
    expect(r.summary.placeholderTurns).toHaveLength(1);
    expect(r.summary.placeholderTurns[0]).toContain("data-placeholder");
    expect(r.summary.streamingElement).toContain("data-message-id");
    expect(r.summary.doneCandidates[0]).toContain("stop-button");
    expect(r.summary.doneCandidates[0]).toContain("gone");
    expect(r.buttonsSwapped.some((b: { gone?: string }) => b.gone?.includes("send-button"))).toBe(true);
    await page.context().close();
  });

  test("stop without start reports an error object, not a throw", async () => {
    const page = await open(true);
    const r = await probe(page, "window.__cbProbe.recordTurn.stop()");
    expect(r.error).toBe("recordTurn.start() was not called on this page");
    await page.context().close();
  });
});

describe("replyShape", () => {
  test("separates content from chrome and finds the content root", async () => {
    const page = await open(true);
    await sendTurn(page, "md: sample");
    const s = await probe(page, "window.__cbProbe.replyShape()");
    expect(s.contentRoot).toContain('[data-part="content"]');
    expect(s.chrome.some((c: { kind: string }) => c.kind === "code-header")).toBe(true);
    expect(s.chrome.some((c: { kind: string }) => c.kind === "button")).toBe(true);
    expect(s.codeLanguage).toBe("class");
    expect(s.chromeInsideContent.join(" ")).toContain("code-header");
    await page.context().close();
  });
});

describe("verify", () => {
  test("flags selectors that match none or several", async () => {
    const page = await open(true);
    await sendTurn(page, "one");
    await sendTurn(page, "two");
    const v = await probe(
      page,
      `window.__cbProbe.verify({
        composer: '[data-testid="composer-input"]',
        anyComposer: 'textarea, [contenteditable]',
        missing: '[data-testid="nope"]',
        assistantMessages: { selector: 'article[data-turn="assistant"]', many: true },
        broken: 'div[[',
      })`,
    );
    expect(v.composer).toEqual({ count: 1, visibleCount: 1, ok: true });
    expect(v.anyComposer.ok).toBe(false);
    expect(v.anyComposer.count).toBe(2);
    expect(v.missing).toEqual({ count: 0, visibleCount: 0, ok: false });
    expect(v.assistantMessages).toEqual({ count: 2, visibleCount: 2, ok: true });
    expect(v.broken.ok).toBe(false);
    expect(v.broken.error).toContain("invalid selector");
    await page.context().close();
  });
});
```

A prompt starting with `md:` makes `dummyReply` answer with a heading, a list,
a ```` ```ts ```` fence and a table; any other prompt gets a one-paragraph echo.

- [ ] **Step 2: Run to verify it fails**

Run: `bun run build && bun test examples/dummy-chat/probes.test.ts`
Expected: FAIL (`ENOENT` for the probe file).

- [ ] **Step 3: Write the probe**

```js
// packages/provider/skills/creating-provider-repo/probes/chatbridge-probes.js
// DOM discovery probes for chatbridge providers. Loaded into every page by
// Playwright MCP (--init-script). Installs window.__cbProbe and nothing else.
// Reads page structure only: no credentials, no browser storage, and text is
// reported as a length plus its first 40 characters.
(() => {
  if (window.__cbProbe) return;

  const HEAD = 40;
  const MAX_EVENTS = 2000;

  const text = (s) => {
    const t = (s ?? "").replace(/\s+/g, " ").trim();
    return { length: t.length, head: t.slice(0, HEAD) };
  };

  /** Hash-like values change between builds; they are not locator material. */
  const generated = (value) => {
    if (/^css-[a-z0-9]+$/i.test(value) || /^sc-/.test(value)) return true;
    if (/^:r[0-9a-z]+:$/i.test(value)) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value)) return true;
    const hex = /[0-9a-f]{8,}/i.exec(value);
    return !!hex && /\d/.test(hex[0]) && /[a-f]/i.test(hex[0]);
  };

  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    if (typeof el.checkVisibility === "function" &&
        !el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };

  const q = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const count = (sel) => {
    try { return document.querySelectorAll(sel).length; } catch { return -1; }
  };

  /** Attribute-based selectors for one element, best first, uniqueness not
   * checked. `unstable` collects what was rejected and why. */
  const selectorsOf = (el, unstable = []) => {
    const tag = el.tagName.toLowerCase();
    const out = [];
    const data = Array.from(el.attributes)
      .filter((a) => a.name.startsWith("data-"))
      .sort((a, b) => (a.name === "data-testid" ? -1 : b.name === "data-testid" ? 1 : 0));
    for (const a of data) {
      if (a.value === "" || a.value.length > 60) continue;
      if (generated(a.value)) { unstable.push(`${a.name}: generated value`); continue; }
      out.push(`[${a.name}=${q(a.value)}]`);
    }
    if (el.id) {
      if (generated(el.id)) unstable.push("id: generated value");
      else out.push(`#${CSS.escape(el.id)}`);
    }
    const role = el.getAttribute("role");
    const label = el.getAttribute("aria-label");
    if (role && label) out.push(`[role=${q(role)}][aria-label=${q(label)}]`);
    if (label) out.push(`${tag}[aria-label=${q(label)}]`);
    for (const name of ["name", "placeholder", "title"]) {
      const v = el.getAttribute(name);
      if (v) out.push(`${tag}[${name}=${q(v)}]`);
    }
    if (el.getAttribute("contenteditable") === "true") out.push(`${tag}[contenteditable="true"]`);
    if (role) out.push(`${tag}[role=${q(role)}]`);
    if (el.classList.length > 0) unstable.push("class: never used as a locator");
    return out;
  };

  /** Unique locators: own attributes first, then scoped under the nearest
   * ancestor that has a unique locator of its own. */
  const locatorsOf = (el, unstable = []) => {
    const own = selectorsOf(el, unstable);
    const unique = own.filter((s) => count(s) === 1);
    if (unique.length > 0) return unique;
    const tag = el.tagName.toLowerCase();
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const anchor = selectorsOf(a).find((s) => count(s) === 1);
      if (!anchor) continue;
      const scoped = [...own.map((s) => `${anchor} ${s}`), `${anchor} ${tag}`, `${anchor} > ${tag}`]
        .filter((s) => count(s) === 1);
      if (scoped.length > 0) return scoped;
    }
    return [];
  };

  /** One readable handle for an element in event logs; may not be unique. */
  const describe = (el) => {
    if (!(el instanceof Element)) return "(text)";
    return locatorsOf(el)[0] ?? selectorsOf(el)[0] ?? shape(el);
  };

  const shape = (el) => {
    const names = Array.from(el.attributes)
      .map((a) => a.name)
      .filter((n) => n.startsWith("data-") || n === "role")
      .sort();
    return el.tagName.toLowerCase() + names.map((n) => `[${n}]`).join("");
  };

  const name = (el) =>
    el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "";

  const candidate = (el) => {
    const unstable = [];
    const locators = locatorsOf(el, unstable);
    const c = {
      locators,
      tag: el.tagName.toLowerCase(),
      visible: visible(el),
      unstable: Array.from(new Set(unstable)),
    };
    const role = el.getAttribute("role");
    const label = el.getAttribute("aria-label");
    if (role) c.role = role;
    if (label) c.ariaLabel = label;
    const t = text(el.textContent);
    if (t.length > 0) c.text = t;
    return c;
  };

  const ACCOUNT = /account|profile|avatar|user|アカウント|プロフィール|ユーザー/i;
  const SIGN_IN = /log ?in|sign ?in|sign ?up|ログイン|サインイン|新規登録/i;
  const STATE_ATTR = /^(aria-busy|data-(.*-)?(state|status|streaming|loading|generating))$/;

  const hints = (el) =>
    [name(el), el.getAttribute("data-testid"), el.id, el.getAttribute("href")]
      .filter(Boolean).join(" ");

  function census() {
    const all = (sel) => Array.from(document.querySelectorAll(sel));
    const clickable = all('button, [role="button"], a[href]');
    const signInEls = clickable.filter((el) => SIGN_IN.test(hints(el)));
    const accountEls = clickable.filter((el) => !signInEls.includes(el) && ACCOUNT.test(hints(el)));

    const messageLists = [];
    for (const el of all("body *")) {
      const live = el.getAttribute("role") === "log" || el.hasAttribute("aria-live");
      if (el.children.length < (live ? 1 : 2)) continue;
      const shapes = new Map();
      for (const child of el.children) shapes.set(shape(child), (shapes.get(shape(child)) ?? 0) + 1);
      const [childShape, n] = Array.from(shapes).sort((a, b) => b[1] - a[1])[0];
      if (!live && (n < 2 || !childShape.includes("["))) continue;
      messageLists.push({ locator: describe(el), children: el.children.length, childShape });
    }
    messageLists.sort((a, b) => b.children - a.children);

    const stateAttrs = [];
    const dataAttrCensus = {};
    for (const el of all("body *")) {
      for (const a of el.attributes) {
        if (a.name.startsWith("data-")) dataAttrCensus[a.name] = (dataAttrCensus[a.name] ?? 0) + 1;
        if (STATE_ATTR.test(a.name)) stateAttrs.push({ locator: describe(el), attr: a.name, value: a.value });
      }
    }

    return {
      url: location.origin + location.pathname,
      title: document.title,
      lang: document.documentElement.lang || "",
      composer: all('textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]').map(candidate),
      buttons: all('button, [role="button"]')
        .filter((el) => name(el).trim() !== "" || Array.from(el.attributes).some((a) => a.name.startsWith("data-")))
        .map(candidate),
      account: accountEls.map(candidate),
      signIn: signInEls.map(candidate),
      messageLists: messageLists.slice(0, 10),
      stateAttrs: stateAttrs.slice(0, 50),
      dataAttrCensus,
    };
  }

  // ---- recordTurn -------------------------------------------------------

  let rec = null;
  let lastStreaming = null;

  const isButton = (el) => el instanceof Element && el.matches('button, [role="button"]');
  const buttonsIn = (node) =>
    node instanceof Element
      ? [...(isButton(node) ? [node] : []), ...node.querySelectorAll('button, [role="button"]')]
      : [];

  function start() {
    rec?.observer.disconnect();
    const t0 = performance.now();
    const state = {
      t0, added: [], attrs: [], swaps: [], growth: new Map(), addedNodes: new Map(), events: 0, truncated: false,
    };
    const now = () => Math.round(performance.now() - t0);
    const room = () => {
      if (state.events >= MAX_EVENTS) { state.truncated = true; return false; }
      state.events++;
      return true;
    };
    /** The outermost element added during this turn that contains `node`. */
    const growthRoot = (node) => {
      let root = null;
      for (let el = node instanceof Element ? node : node.parentElement; el; el = el.parentElement)
        if (state.addedNodes.has(el)) root = el;
      return root;
    };
    const grow = (node) => {
      const root = growthRoot(node);
      if (!root) return;
      const g = state.growth.get(root) ?? { firstAt: now(), lastAt: 0, updates: 0 };
      g.lastAt = now();
      g.updates++;
      state.growth.set(root, g);
    };

    state.observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "characterData") { grow(m.target); continue; }
        if (m.type === "attributes") {
          const el = m.target;
          const to = el.getAttribute(m.attributeName);
          if (isButton(el) && /^(aria-label|data-testid|disabled|hidden)$/.test(m.attributeName)) {
            if (room()) state.swaps.push({ t: now(), changed: `${describe(el)} ${m.attributeName}: ${m.oldValue} → ${to}` });
          }
          if (m.attributeName === "class" || m.attributeName === "style") continue;
          if (room()) state.attrs.push({ t: now(), locator: describe(el), attr: m.attributeName, from: m.oldValue, to });
          continue;
        }
        // childList
        const insideAdded = growthRoot(m.target) !== null || state.addedNodes.has(m.target);
        if (insideAdded) grow(m.target);
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          for (const b of buttonsIn(node)) if (!insideAdded && room()) state.swaps.push({ t: now(), appeared: describe(b) });
          if (insideAdded) continue;
          const entry = { t: now(), locator: describe(node), shape: shape(node) };
          state.addedNodes.set(node, entry);
          if (room()) state.added.push(entry);
        }
        for (const node of m.removedNodes) {
          if (!(node instanceof Element)) continue;
          for (const b of buttonsIn(node)) {
            // Detached: uniqueness cannot be checked any more.
            if (!insideAdded && room()) state.swaps.push({ t: now(), gone: selectorsOf(b)[0] ?? shape(b) });
          }
          const entry = state.addedNodes.get(node);
          if (entry) { entry.removedAt = now(); entry.locator = selectorsOf(node)[0] ?? entry.locator; }
        }
      }
    });
    state.observer.observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true,
    });
    rec = state;
    return "recording";
  }

  function stop() {
    if (!rec) return { error: "recordTurn.start() was not called on this page" };
    const state = rec;
    rec = null;
    state.observer.disconnect();
    const durationMs = Math.round(performance.now() - state.t0);

    const textGrowth = Array.from(state.growth, ([el, g]) => ({
      locator: describe(el), firstAt: g.firstAt, lastAt: g.lastAt, updates: g.updates,
      finalLength: (el.textContent ?? "").length,
    })).filter((g) => g.updates >= 2).sort((a, b) => b.updates - a.updates);

    const streaming = textGrowth[0];
    lastStreaming = streaming
      ? Array.from(state.growth.keys()).find((el) => describe(el) === streaming.locator) ?? null
      : null;

    const placeholderTurns = state.added.filter((a) => a.removedAt !== undefined).map((a) => `${a.locator} (${a.shape}) added @${a.t}ms, removed @${a.removedAt}ms`);

    // Last event per distinct signal; keep those at or after the last text update.
    const last = new Map();
    for (const a of state.attrs)
      if (STATE_ATTR.test(a.attr) || a.attr === "disabled" || a.attr === "aria-disabled")
        last.set(`attr ${a.locator} ${a.attr}`, { t: a.t, line: `attribute ${a.attr} on ${a.locator}: ${a.from} → ${a.to} @${a.t}ms` });
    for (const s of state.swaps) {
      const what = s.gone ? `button gone: ${s.gone}` : s.appeared ? `button appeared: ${s.appeared}` : `button changed: ${s.changed}`;
      last.set(what, { t: s.t, line: `${what} @${s.t}ms` });
    }
    const floor = streaming ? streaming.lastAt - 100 : 0;
    const doneCandidates = Array.from(last.values())
      .filter((e) => e.t >= floor)
      .sort((a, b) => b.t - a.t)
      .slice(0, 8)
      .map((e) => e.line);

    const result = {
      durationMs,
      added: state.added,
      attrs: state.attrs,
      textGrowth,
      buttonsSwapped: state.swaps,
      summary: { placeholderTurns, doneCandidates },
    };
    if (streaming) result.summary.streamingElement = streaming.locator;
    if (state.truncated) result.truncated = true;
    return result;
  }

  // ---- replyShape -------------------------------------------------------

  const CONTENT = "p, pre, ul, ol, table, blockquote, h1, h2, h3, h4, h5, h6";

  function replyShape(selector) {
    let root = selector ? document.querySelector(selector) : lastStreaming;
    if (!root || !root.isConnected) {
      const list = census().messageLists[0];
      const container = list && document.querySelector(list.locator);
      root = container?.lastElementChild ?? null;
    }
    if (!root) return { error: "no reply element: pass its selector, or run recordTurn across one turn first" };

    const tagCensus = {};
    for (const el of root.querySelectorAll("*")) {
      const tag = el.tagName.toLowerCase();
      tagCensus[tag] = (tagCensus[tag] ?? 0) + 1;
    }

    const chromeEls = new Map();
    const mark = (el, kind) => { if (!chromeEls.has(el)) chromeEls.set(el, kind); };
    for (const el of root.querySelectorAll('[role="toolbar"]')) mark(el, "toolbar");
    for (const el of root.querySelectorAll("details")) mark(el, "collapsible");
    for (const el of root.querySelectorAll('[aria-hidden="true"]')) mark(el, "hidden");
    for (const pre of root.querySelectorAll("pre")) {
      // A header is a sibling of <pre> inside a wrapper that holds nothing else of substance.
      for (const sib of pre.parentElement?.children ?? [])
        if (sib !== pre && !sib.matches(CONTENT) && (sib.textContent ?? "").trim().length <= 40) mark(sib, "code-header");
    }
    for (const el of root.querySelectorAll('button, [role="button"]')) {
      if (![...chromeEls.keys()].some((c) => c.contains(el))) mark(el, "button");
    }
    const inChrome = (el) => [...chromeEls.keys()].some((c) => c !== el && c.contains(el)) || chromeEls.has(el);

    const blocks = Array.from(root.querySelectorAll(CONTENT)).filter((el) => !inChrome(el));
    let contentRootEl = blocks[0] ?? null;
    for (const b of blocks) while (contentRootEl && !contentRootEl.contains(b)) contentRootEl = contentRootEl.parentElement;
    if (contentRootEl && blocks.length === 1) contentRootEl = contentRootEl.parentElement;
    if (contentRootEl && !root.contains(contentRootEl)) contentRootEl = root;

    let codeLanguage = "no-code-block";
    const pres = Array.from(root.querySelectorAll("pre"));
    if (pres.length > 0) {
      const byClass = pres.some((pre) =>
        [pre, pre.querySelector("code")].some((n) => Array.from(n?.classList ?? []).some((c) => /^(language|lang)-/.test(c))));
      const byHeader = [...chromeEls].some(([el, kind]) => kind === "code-header" && (el.textContent ?? "").trim() !== "");
      codeLanguage = byClass ? "class" : byHeader ? "header-label" : "none";
    }

    const chrome = Array.from(chromeEls, ([el, kind]) => ({ locator: describe(el), kind }));
    return {
      root: describe(root),
      tagCensus,
      chrome,
      codeLanguage,
      contentRoot: contentRootEl ? describe(contentRootEl) : null,
      chromeInsideContent: contentRootEl
        ? Array.from(chromeEls).filter(([el]) => contentRootEl.contains(el)).map(([el, kind]) => `${kind}: ${describe(el)}`)
        : [],
    };
  }

  // ---- verify -----------------------------------------------------------

  function verify(selectors) {
    const out = {};
    for (const [key, value] of Object.entries(selectors ?? {})) {
      const many = typeof value === "object" && value !== null && value.many === true;
      const selector = typeof value === "string" ? value : value?.selector;
      try {
        const els = Array.from(document.querySelectorAll(selector));
        const visibleCount = els.filter(visible).length;
        out[key] = { count: els.length, visibleCount, ok: many ? els.length >= 1 : els.length === 1 };
      } catch {
        out[key] = { count: 0, visibleCount: 0, ok: false, error: `invalid selector: ${selector}` };
      }
    }
    return out;
  }

  window.__cbProbe = { census, recordTurn: { start, stop }, replyShape, verify };
})();
```

- [ ] **Step 4: Run the tests and iterate**

Run: `bun test examples/dummy-chat/probes.test.ts`
Expected: PASS. The code above is a complete first implementation, but it has
not been run: where a test fails, fix the probe (not the test) unless the test
contradicts the DOM facts of Task 1. Known places to look first:
`describe()` of an element that is inside an added turn (the scoped locator may
pick `[role="log"] article`, which is not unique after two turns — the
`streamingElement` test expects the `data-message-id` attribute selector to
win, which it does because `selectorsOf` puts `data-*` first); the 100 ms
`floor` for `doneCandidates` against a 30 ms chunk delay.

- [ ] **Step 5: Run the whole check**

Run: `bun run check`
Expected: PASS. Biome lints `.js` files too; fix what it reports in the probe.

- [ ] **Step 6: Commit and sync**

```bash
git add packages/provider/skills/creating-provider-repo/probes examples/dummy-chat/probes.test.ts
git commit -m "feat: DOM discovery probe for provider authors (Refs #113)"
gh issue comment 113 --body "Task 3 done: chatbridge-probes.js (census, recordTurn, replyShape, verify) with Chromium tests against /hard. What's next: Task 4, templates."
```

---

### Task 4: Core templates (scaffold, selectors, provider, tests, dom-notes)

**Files:**
- Create under `packages/provider/skills/creating-provider-repo/templates/`:
  `package.json`, `tsconfig.json`, `biome.json`, `gitignore`, `mcp.json`,
  `src/selectors.ts`, `src/provider.ts`, `src/bin.ts`, `src/selectors.test.ts`,
  `src/provider.test.ts`, `src/provider.e2e.test.ts`, `docs/dom-notes.md`,
  `CLAUDE.md`, `README.md`
- Test: `examples/dummy-chat/templates.test.ts`
- Modify: root `tsconfig` / Biome config only if the template `.ts` files get picked up by the workspace build or lint and fail. They must be **excluded from `tsc --build`** (they import `./selectors.js` relative to themselves and contain placeholders) and **included in Biome** formatting. Check how `bun run check` globs first (`package.json` scripts, `biome.json` `files`).

**Interfaces:**
- Consumes: the `/hard` DOM facts (Task 1); `defineProvider`, `elementToMarkdown`, `Provider` from `@chatbridge/provider`; `createCli` from `@chatbridge/cli`.
- Produces: selector export names, used by `dom-discovery.md` (Task 6) and the upgrade guide (Task 8):
  `ENTRY_URL`, `CHAT_URL`, `SIGN_IN_CONTROL`, `ACCOUNT_CONTROL`, `COMPOSER`, `SEND_BUTTON`, `STOP_BUTTON`, `NEW_CHAT_BUTTON`, `ASSISTANT_MESSAGE`, `USER_MESSAGE`, `ASSISTANT_MESSAGE_BODY`, `CHALLENGE_TITLE`, and `MANY: readonly string[]` = `["ASSISTANT_MESSAGE", "USER_MESSAGE", "ASSISTANT_MESSAGE_BODY"]`. Placeholders: `<vendor>` (bin/package suffix, lower-case), `<Vendor>` (display name), `<VENDOR>` (env var prefix).

- [ ] **Step 1: Write the failing test** — the template provider, with its selector module swapped for `/hard` values, holds a two-turn Markdown conversation.

```ts
// examples/dummy-chat/templates.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@chatbridge/provider";
import { type Browser, chromium } from "playwright-core";
import { type DummyChat, startDummyChat } from "./server";

const TEMPLATES = new URL(
  "../../packages/provider/skills/creating-provider-repo/templates/",
  import.meta.url,
).pathname;

let server: DummyChat;
let browser: Browser;
let provider: Provider;

beforeAll(async () => {
  server = await startDummyChat(0);
  server.setReplyDelayMs(150);
  server.setChunkDelayMs(30);
  browser = await chromium.launch();
  // Instantiate the template next to this test so its bare imports resolve
  // from the workspace, then fill in the selectors the way a vendor would.
  const dir = mkdtempSync(join(import.meta.dir, ".tmp-template-"));
  cpSync(join(TEMPLATES, "src"), dir, { recursive: true });
  const fill: Record<string, string> = {
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
  };
  let selectors = readFileSync(join(dir, "selectors.ts"), "utf8");
  for (const [name, value] of Object.entries(fill))
    selectors = selectors.replace(
      new RegExp(`export const ${name} = "[^"]*";`),
      `export const ${name} = ${JSON.stringify(value)};`,
    );
  writeFileSync(join(dir, "selectors.ts"), selectors);
  const source = readFileSync(join(dir, "provider.ts"), "utf8").replaceAll("<vendor>", "hard-dummy");
  writeFileSync(join(dir, "provider.ts"), source);
  provider = (await import(join(dir, "provider.ts"))).default;
});
afterAll(async () => {
  await browser.close();
  server.stop();
  // .tmp-template-* is git-ignored (Step 4) and removed here.
  const { rmSync, readdirSync } = await import("node:fs");
  for (const f of readdirSync(import.meta.dir))
    if (f.startsWith(".tmp-template-")) rmSync(join(import.meta.dir, f), { recursive: true, force: true });
});

describe("template provider on the hard skin", () => {
  test("a guest is not logged in although a composer exists", async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${server.url}/hard/chat`);
    expect(await provider.isLoggedIn(page)).toBe(false);
    await page.context().close();
  });

  test("two turns: never the placeholder, never the previous turn, Markdown kept", async () => {
    const page = await (await browser.newContext()).newPage();
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
    const poll = setInterval(async () => {
      const partial = await provider.streaming?.responseText(page).catch(() => undefined);
      if (partial) seen.push(partial);
    }, 20);
    const second = await provider.waitForResponse(page);
    clearInterval(poll);
    expect(second).not.toBe(first);
    expect(second).toMatch(/^```\w+$/m);
    expect(second).not.toContain("コードをコピー");
    for (const partial of seen) expect(partial).not.toBe(first);
    await page.context().close();
  });

  test("off-origin pages are logged out without touching the DOM", async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto("about:blank");
    expect(await provider.isLoggedIn(page)).toBe(false);
    await page.context().close();
  });
});

describe("template files", () => {
  test("selectors.ts starts empty and lists its collections", () => {
    const source = readFileSync(join(TEMPLATES, "src/selectors.ts"), "utf8");
    expect(source).toContain('export const COMPOSER = "";');
    expect(source).toContain("export const MANY");
  });
  test("mcp.json loads the probe and keeps the profile out of git", () => {
    const mcp = JSON.parse(readFileSync(join(TEMPLATES, "mcp.json"), "utf8"));
    const args: string[] = mcp.mcpServers.playwright.args;
    expect(args).toContain("--init-script");
    expect(args).toContain(".claude/skills/creating-provider-repo/probes/chatbridge-probes.js");
    expect(args).toContain(".auth/mcp-profile");
    const ignore = readFileSync(join(TEMPLATES, "gitignore"), "utf8");
    for (const line of [".auth/", ".playwright-mcp/", "storage-state*.json", "node_modules/", "dist/"])
      expect(ignore).toContain(line);
  });
});
```

If the code-header label `typescript` leaks into `second` as a stray line
before the fence, that is the known limitation recorded in the decision table
(Task 6) — the assertion above only requires that the fence line with a
language exists and the copy button's label does not appear.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test examples/dummy-chat/templates.test.ts`
Expected: FAIL (`ENOENT` for the templates directory).

- [ ] **Step 3: Write the templates**

`templates/src/selectors.ts`:

```ts
// Every URL and selector the provider uses. Each constant cites the section
// of docs/dom-notes.md that justifies it; fill them from the census, never
// from a guess. CSS selectors only, so window.__cbProbe.verify() can check them.

/** dom-notes §Login — where `auth login` sends the user. */
export const ENTRY_URL = "";
/** dom-notes §Chat page — the page a logged-in user chats on. */
export const CHAT_URL = "";
/** dom-notes §Login — visible only when logged OUT. */
export const SIGN_IN_CONTROL = "";
/** dom-notes §Login — visible only when logged IN. */
export const ACCOUNT_CONTROL = "";
/** dom-notes §Composer — must not match a hidden twin. */
export const COMPOSER = "";
/** dom-notes §Composer — may exist only while the composer is non-empty. */
export const SEND_BUTTON = "";
/** dom-notes §Generation indicator — present while a reply is generated. */
export const STOP_BUTTON = "";
/** dom-notes §New chat. */
export const NEW_CHAT_BUTTON = "";
/** dom-notes §Messages — every assistant turn, placeholders excluded. */
export const ASSISTANT_MESSAGE = "";
/** dom-notes §Messages — every user turn. */
export const USER_MESSAGE = "";
/** dom-notes §Messages — inside one assistant turn: content without chrome
 * (replyShape().contentRoot). */
export const ASSISTANT_MESSAGE_BODY = "";
/** dom-notes §Errors and rate limits — document.title of a bot challenge. */
export const CHALLENGE_TITLE = "Just a moment...";

/** Selectors that match a collection; verify() accepts `count >= 1` for them. */
export const MANY = ["ASSISTANT_MESSAGE", "USER_MESSAGE", "ASSISTANT_MESSAGE_BODY"] as const;
```

`templates/src/provider.ts`:

```ts
import { defineProvider, elementToMarkdown } from "@chatbridge/provider";
import type { Locator, Page } from "playwright-core";
import * as S from "./selectors.js";

/** The framework times a turn out by racing `waitForResponse`; it cannot
 * abort it. Every wait here is bounded so a timed-out turn leaves nothing
 * polling the page. Longer than any session timeout a user would set. */
const TURN_LIMIT_MS = 30 * 60_000;

/** Assistant turns that existed before the pending prompt was sent. */
const countBefore = new WeakMap<Page, number>();

const visibleOnly = (page: Page, selector: string): Locator =>
  // `.first()` picks DOM order, so a hidden match would stall every wait.
  page.locator(selector).locator("visible=true");

/** The newest assistant turn's readable content. */
const newestBody = (page: Page): Locator =>
  page.locator(S.ASSISTANT_MESSAGE).last().locator(S.ASSISTANT_MESSAGE_BODY).first();

export default defineProvider({
  name: "<vendor>",
  chatUrl: S.CHAT_URL,
  responseFormat: "markdown",

  async navigateToLogin(page) {
    await page.goto(S.ENTRY_URL);
  },

  async isLoggedIn(page) {
    // The IdP page: never touch its DOM.
    if (!page.url().startsWith("http") || new URL(page.url()).origin !== new URL(S.CHAT_URL).origin)
      return false;
    try {
      const signIn = visibleOnly(page, S.SIGN_IN_CONTROL);
      const account = visibleOnly(page, S.ACCOUNT_CONTROL);
      await signIn.or(account).first().waitFor({ state: "visible", timeout: 10_000 });
      // A guest composer proves nothing: account present AND sign-in absent.
      return (await account.count()) > 0 && (await signIn.count()) === 0;
    } catch {
      return false;
    }
  },

  async startNewChat(page) {
    // VARIANT (decision table "new chat is a URL"): replace the click with
    // page.goto(<new chat URL>).
    const button = visibleOnly(page, S.NEW_CHAT_BUTTON);
    if ((await button.count()) > 0) await button.first().click();
    else await page.goto(S.CHAT_URL);
    const composer = visibleOnly(page, S.COMPOSER).first();
    await composer.waitFor({ state: "visible" });
  },

  async sendMessage(page, prompt) {
    countBefore.set(page, await page.locator(S.ASSISTANT_MESSAGE).count());
    // fill() works on contenteditable composers too.
    await visibleOnly(page, S.COMPOSER).first().fill(prompt);
    // VARIANT (decision table "no send button"): replace with
    // page.keyboard.press("Enter").
    await visibleOnly(page, S.SEND_BUTTON).first().click();
    // Let the generating state begin; a fast reply may already be past it.
    await page
      .locator(S.STOP_BUTTON)
      .first()
      .waitFor({ state: "visible", timeout: 3_000 })
      .catch(() => {});
  },

  async waitForResponse(page) {
    const before = countBefore.get(page) ?? 0;
    // 1. Done signal first: a placeholder turn may come and go before the
    //    real one. VARIANT (decision table "state attribute"): wait for the
    //    attribute's idle value instead.
    const deadline = Date.now() + TURN_LIMIT_MS;
    await page.locator(S.STOP_BUTTON).first().waitFor({ state: "hidden", timeout: TURN_LIMIT_MS });
    // 2. Then the new turn must exist.
    await page.waitForFunction(
      ([selector, n]) => document.querySelectorAll(selector as string).length > (n as number),
      [S.ASSISTANT_MESSAGE, before] as const,
      { timeout: 30_000 },
    );
    // 3. Stability read: two equal reads 500 ms apart.
    let previous = await elementToMarkdown(newestBody(page));
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      const current = await elementToMarkdown(newestBody(page));
      if (current === previous && current !== "") return current;
      previous = current;
    }
    return previous;
  },

  streaming: {
    async responseText(page) {
      // Until the new turn exists, the newest element is the previous reply.
      const before = countBefore.get(page) ?? 0;
      if ((await page.locator(S.ASSISTANT_MESSAGE).count()) <= before) return undefined;
      const body = newestBody(page);
      if ((await body.count()) === 0) return undefined;
      const text = await elementToMarkdown(body);
      return text === "" ? undefined : text;
    },
  },

  async detectBlock(page) {
    try {
      return (await page.title()) === S.CHALLENGE_TITLE ? "challenge page" : undefined;
    } catch {
      return undefined;
    }
  },
});
```

`ChatSession.send` races `waitForResponse` against the session timeout
(`runStep` in `packages/core/src/chat-session.ts`) and cannot cancel it, hence
`TURN_LIMIT_MS`: do not replace the bounded waits with unbounded ones.

`templates/src/bin.ts`: copy the code block under "Derived CLI identity" from the
current `.claude/skills/creating-provider-repo/SKILL.md` verbatim (lines 52–90),
keeping its comments: they are the documentation of `banner` and `shell` from now on.

`templates/src/selectors.test.ts`:

```ts
import { expect, test } from "bun:test";
import * as S from "./selectors.js";

test("every selector is filled in", () => {
  for (const [name, value] of Object.entries(S)) {
    if (name === "MANY") continue;
    expect(typeof value, name).toBe("string");
    expect(value as string, name).not.toBe("");
  }
});

test("MANY names existing selectors", () => {
  for (const name of S.MANY) expect(S).toHaveProperty(name);
});

test("no selector leans on a class name", () => {
  for (const [name, value] of Object.entries(S)) {
    if (name === "MANY" || name.endsWith("_URL") || name === "CHALLENGE_TITLE") continue;
    expect(value as string, name).not.toMatch(/(^|[\s>+~,(])\.[A-Za-z_-]/);
  }
});
```

`templates/src/provider.test.ts`:

```ts
import { expect, test } from "bun:test";
import provider from "./provider.js";

test("provider shape", () => {
  expect(provider.name).toBe("<vendor>");
  expect(new URL(provider.chatUrl).protocol).toBe("https:");
  for (const method of ["navigateToLogin", "isLoggedIn", "startNewChat", "sendMessage", "waitForResponse"] as const)
    expect(typeof provider[method]).toBe("function");
  expect(provider.responseFormat).toBe("markdown");
  expect(typeof provider.streaming?.responseText).toBe("function");
});
```

`templates/src/provider.e2e.test.ts` — gated on `<VENDOR>_E2E=1`. Look at
`../chatbridge-rakuten-ai/src/provider.e2e.test.ts` **for its structure only**
(how it opens a session through `@chatbridge/core` with the saved auth state and
skips without one); do not copy vendor names, URLs or selectors. Three tests:

1. `two turns, second answer differs` — prompts `Reply with the single word: ping` and `Reply with the single word: pong`.
2. `Markdown fidelity` — prompt (verbatim, one string):
   `Repeat the following Markdown exactly, with no commentary:\n\n# Title\n\n- one\n  - nested\n- two\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n**bold** and [a link](https://example.com)`
   Assertions, structure only: `/^# /m`, `/^\s+- nested/m`, `/^```ts$/m`, `/^\|\s*-+/m`, `/\*\*bold\*\*/`, `/\[a link\]\(https:\/\/example\.com\/?\)/`.
3. `streaming never shows the previous turn` — poll `streaming.responseText` every 100 ms during the second turn; no partial equals the first answer.

`templates/docs/dom-notes.md` — eight sections (`Login`, `Chat page`, `New chat`,
`Composer`, `Messages`, `Generation indicator`, `Errors and rate limits`,
`Streaming behaviour`), each as:

```markdown
## Composer

Not yet observed.

<!-- Fill from dom-discovery.md step 4. Remove "Not yet observed." when done.
Observed: YYYY-MM-DD
| Constant | Selector | verify() count | visible |
|---|---|---|---|
| COMPOSER | | | |
| SEND_BUTTON | | | |
Notes (hidden twins, localized labels, send button only while non-empty): -->
```

Give each section the constants it owns (per the comments in `selectors.ts`) and
the step of `dom-discovery.md` that fills it (spec §3). `Streaming behaviour`
asks the two questions from today's skill ("which element grows", "how is it
told apart from the previous turn") and records `replyShape()`'s `contentRoot`,
`codeLanguage` and `chromeInsideContent`. Top of the file: "Structure only.
Never paste conversation text, internal URLs beyond the entry and chat URL, or
anything from browser storage."

`templates/mcp.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--user-data-dir",
        ".auth/mcp-profile",
        "--init-script",
        ".claude/skills/creating-provider-repo/probes/chatbridge-probes.js"
      ]
    }
  }
}
```

`templates/gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
*.log
storage-state*.json
.auth/
.playwright-mcp/
.superpowers/
```

`templates/package.json`: name `chatbridge-<vendor>`, `private: true`, `type: module`,
`bin: { "<vendor>": "./dist/bin.js" }`, scripts `build` (`tsc -p .`), `lint`
(`biome check .`), `test` (`bun test`), `check` (`bun run lint && bun run build && bun test`),
dependencies `@chatbridge/cli`, `@chatbridge/core`, `@chatbridge/provider` at
`"<latest>"` and `playwright-core` at `"<runtime's playwright-core>"`, devDependencies
`@biomejs/biome`, `typescript`, `@types/bun` at the versions in this repository's root
`package.json`. `templates/tsconfig.json`: copy `packages/cli/tsconfig.json` without
`composite` and `references`. `templates/biome.json`: copy the root `biome.json`.
`templates/CLAUDE.md` and `templates/README.md`: short English files — what the repo is,
the OSS boundary reversed ("this repository is private; nothing here goes upstream"),
`bun run check`, the gated E2E, the manual checklist from the skill's Procedure step 4,
and the skills refresh command from spec §7.1.

- [ ] **Step 4: Ignore the test's scratch directory**

Add `examples/dummy-chat/.tmp-template-*/` to the root `.gitignore`.

- [ ] **Step 5: Run the tests**

Run: `bun run build && bun test examples/dummy-chat/templates.test.ts`
Expected: PASS. If `locator("visible=true")` chaining fails on this Playwright
version, use `page.locator(\`${selector} >> visible=true\`)`.

- [ ] **Step 6: Whole check, commit, sync**

```bash
bun run check
git add packages/provider/skills/creating-provider-repo/templates examples/dummy-chat/templates.test.ts .gitignore
git commit -m "feat: vendor repo templates with a contract-complete provider (Refs #113)"
gh issue comment 113 --body "Task 4 done: templates (selectors, provider implementing the contract, tests incl. Markdown fidelity E2E, dom-notes, mcp.json). Template provider passes two turns on /hard. What's next: Task 5, VSCode templates."
```

---

### Task 5: VSCode extension templates and `vscode-extension.md`

**Files:**
- Create: `packages/provider/skills/creating-provider-repo/templates/vscode/{package.json,esbuild.mjs,vscodeignore,src/extension.ts,media/icon.svg}`
- Create: `packages/provider/skills/creating-provider-repo/vscode-extension.md`
- Test: extend `examples/dummy-chat/templates.test.ts`

**Interfaces:**
- Consumes: `examples/vscode-dummy-chat/` (the working example), today's SKILL.md sections "VSCode extension" and "Building the `.vsix`".
- Produces: `templates/vscode/*` with the placeholder id `<vendor>`; `vscode-extension.md` referenced from SKILL.md (Task 6) and the upgrade guide (Task 8).

- [ ] **Step 1: Write the failing test** (append to `templates.test.ts`)

```ts
describe("VSCode template", () => {
  test("contributes the same IDs as the working example", () => {
    const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
    const example = read(new URL("../vscode-dummy-chat/package.json", import.meta.url).pathname);
    const template = read(join(TEMPLATES, "vscode/package.json"));
    const normalise = (contributes: unknown) =>
      JSON.parse(JSON.stringify(contributes).replaceAll("chatbridge-dummy", "<vendor>"));
    const ids = (c: { commands: { command: string }[]; menus: Record<string, { command: string }[]> }) => ({
      commands: c.commands.map((x) => x.command).sort(),
      menus: Object.fromEntries(Object.entries(c.menus).map(([k, v]) => [k, v.map((x) => x.command).sort()])),
    });
    expect(ids(template.contributes)).toEqual(ids(normalise(example.contributes)));
    expect(Object.keys(template.contributes.configuration.properties).sort()).toEqual(
      Object.keys(normalise(example.contributes).configuration.properties).sort(),
    );
    expect(template.dependencies).toHaveProperty("playwright");
    expect(template.dependencies).not.toHaveProperty("@chatbridge/vscode");
  });
});
```

Adjust the shape of `ids()` to the example manifest's real structure after
reading it (views, keybindings): every `contributes` key that carries an id
must be compared.

- [ ] **Step 2: Run to verify it fails.** `bun test examples/dummy-chat/templates.test.ts` → FAIL (`ENOENT`).

- [ ] **Step 3: Create the templates** by copying each file from `examples/vscode-dummy-chat/` and replacing `chatbridge-dummy` → `<vendor>`, the display name → `<Vendor>`, the publisher → `<publisher>`, workspace dependency versions → `"<latest>"`, and the provider import → `../../src/provider.js`. Move `playwright` to `dependencies` and `@chatbridge/vscode`, `esbuild`, `@vscode/vsce` to `devDependencies` (the `.vsix` recipe needs exactly that split). In the manifest's `configuration.properties`, `idleTimeoutMinutes` and `timeoutSec` must have **no `default`**. `.vscodeignore` is stored as `vscodeignore`.

- [ ] **Step 4: Write `vscode-extension.md`**: move the text of today's "VSCode extension" and "Building the `.vsix`" sections, with these changes: "Copy `examples/vscode-dummy-chat`…" becomes "Copy `templates/vscode/` to `vscode/`, rename `vscodeignore` to `.vscodeignore`, replace the placeholders"; the reference to `packages/vscode/README.md` "View title bar" is dropped because the template manifest already carries those entries; keep the `ui` option block, the missing-`contributes` symptom, the `<id>.reopen` note, the manual verification line and the five-step `.vsix` recipe verbatim.

- [ ] **Step 5: Test, check, commit, sync**

```bash
bun test examples/dummy-chat/templates.test.ts && bun run check
git add packages/provider/skills/creating-provider-repo examples/dummy-chat/templates.test.ts
git commit -m "feat: VSCode extension templates for vendor repos (Refs #113)"
gh issue comment 113 --body "Task 5 done: templates/vscode + vscode-extension.md; a test keeps the template manifest's contributes in step with examples/vscode-dummy-chat. What's next: Task 6, dom-discovery.md and the slimmed SKILL.md."
```

---

### Task 6: `dom-discovery.md` and the slimmed `SKILL.md`

**Files:**
- Create: `packages/provider/skills/creating-provider-repo/dom-discovery.md`
- Create: `packages/provider/skills/creating-provider-repo/SKILL.md` (new content; the old file in `.claude/skills/` stays until Task 7)
- Test: `packages/provider/skills.test.ts`

**Interfaces:**
- Consumes: probe API (Task 3), selector names (Task 4), RED findings (Task 2).
- Produces: the two documents. Section names other docs link to: `dom-discovery.md` → "Set up", "Procedure", "Decision table", "What never leaves the session"; `SKILL.md` → "Rules that do not bend", "Layout", "Procedure", "Provider method contract", "Traps seen in the wild".

- [ ] **Step 1: Write the failing test**

```ts
// packages/provider/skills.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILLS = join(import.meta.dir, "skills");
const read = (p: string) => readFileSync(join(SKILLS, p), "utf8");
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

describe("creating-provider-repo", () => {
  test("SKILL.md is short and only triggers in its description", () => {
    const skill = read("creating-provider-repo/SKILL.md");
    expect(words(skill)).toBeLessThanOrEqual(1300);
    const description = /^description: (.+)$/m.exec(skill)?.[1] ?? "";
    expect(description.startsWith("Use when")).toBe(true);
  });

  test("is self-contained: no path into the chatbridge-cli repository", () => {
    for (const file of ["SKILL.md", "dom-discovery.md", "vscode-extension.md"]) {
      const body = read(`creating-provider-repo/${file}`);
      expect(body, file).not.toMatch(/examples\/|packages\/(cli|core|runtime|vscode)\//);
    }
  });

  test("every relative link and template path it names exists", () => {
    for (const file of ["SKILL.md", "dom-discovery.md", "vscode-extension.md"]) {
      const body = read(`creating-provider-repo/${file}`);
      for (const m of body.matchAll(/`((?:templates|probes)\/[^`\s]+)`/g)) {
        const path = (m[1] ?? "").replace(/\*$/, "");
        expect(existsSync(join(SKILLS, "creating-provider-repo", path)), `${file}: ${path}`).toBe(true);
      }
    }
  });

  test("dom-discovery.md names every probe entry point and every selector constant", () => {
    const body = read("creating-provider-repo/dom-discovery.md");
    for (const call of ["census()", "recordTurn.start()", "recordTurn.stop()", "replyShape(", "verify("])
      expect(body).toContain(call);
    const selectors = read("creating-provider-repo/templates/src/selectors.ts");
    for (const m of selectors.matchAll(/^export const ([A-Z_]+) = "/gm))
      expect(body, m[1]).toContain(m[1] ?? "");
    expect(body).not.toContain("headless and cannot");
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `bun test packages/provider/skills.test.ts` → FAIL.

- [ ] **Step 3: Write `dom-discovery.md`.** Follow spec §3 step by step; this is prose for a weaker model, so every step is written as: **Do** (the exact tool call, copy-pasteable), **Human** (what to ask the user, if anything), **Read** (which fields of the output matter), **Write** (which `dom-notes.md` section and which constants). Required content:

  - *Set up*: copy `templates/mcp.json` → `.mcp.json`; restart Claude Code; check with `browser_evaluate` `{ "function": "() => typeof window.__cbProbe" }` → must print `"object"`; if `"undefined"`, the init script path is wrong. The window is headed; the profile in `.auth/mcp-profile` keeps the login between sessions. Alternative `--isolated --storage-state <path>` (path from `<vendor> auth status`). To keep large outputs out of the conversation, pass `"filename": ".playwright-mcp/census-in.json"` to `browser_evaluate` and read the file.
  - *Procedure*: the eight steps of spec §3 with the exact calls:
    `{ "function": "() => window.__cbProbe.census()" }`,
    `{ "function": "() => window.__cbProbe.recordTurn.start()" }`,
    `browser_type` into the composer locator / `browser_click` with `target` set to the send button's CSS selector,
    `{ "function": "() => window.__cbProbe.recordTurn.stop()" }`,
    `{ "function": "() => window.__cbProbe.replyShape()" }`,
    and the verify call built mechanically from `selectors.ts`:
    `{ "function": "() => window.__cbProbe.verify({ COMPOSER: '…', …, ASSISTANT_MESSAGE: { selector: '…', many: true } })" }` — every name in `MANY` gets the `many` form. `SEND_BUTTON` and `STOP_BUTTON` are verified at the moment they exist (type one character first; during a `slow`/long turn), and the doc says so.
    The credentials rule, verbatim: "Never type, ask for, or read credentials. Ask the user to log in in the browser window and to tell you when they are done."
  - *Decision table*: spec §3's table plus spec §7.4's three rows plus one row per unpredicted RED finding (Task 2), plus: "`ASSISTANT_MESSAGE` would match the placeholder (`placeholderTurns` shows its attributes) → exclude it with `:not([…])`"; "no send button in `buttonsSwapped` → `// VARIANT` Enter key"; "code header label leaks a stray line before the fence → accept, note it in dom-notes §Streaming behaviour".
  - *What never leaves the session*: spec §3's paragraph.
  - *When a locator stops matching later*: re-run `verify()`; for each `ok: false`, re-run the step that owns that constant; update the date in dom-notes.

- [ ] **Step 4: Write the new `SKILL.md`** from the current one. Keep the frontmatter `name`; description: `Use when standing up a new vendor-specific chatbridge Provider with its own CLI in a separate repository — a new web chat service, a spike against a public service, or a company-internal provider consuming the published @chatbridge/* packages.` (unchanged: it states triggers only). Body, in order:
  1. Overview (3 lines, as today) + "This skill directory is self-contained: `templates/`, `probes/`, `dom-discovery.md`, `vscode-extension.md`. To follow a newer framework version later, use the upgrading-provider-repo skill."
  2. *Rules that do not bend* — as today, plus: "Selectors come from probe output recorded in `docs/dom-notes.md`. A selector with no dom-notes entry is a bug."
  3. *Layout* — the file tree, shortened to one line per file, introduced by "Copy `templates/` into the new repo root, rename `gitignore` → `.gitignore` and `mcp.json` → `.mcp.json`, replace `<vendor>`, `<Vendor>`, `<VENDOR>`, resolve `<latest>` with `npm view @chatbridge/cli version`."
  4. *Runtime and shebang* — the table and the symptom line only.
  5. *Procedure* — five steps as today; step 2 becomes: "**Discover the DOM**: follow `dom-discovery.md` exactly. **REQUIRED.** Do not write a selector before its dom-notes section is filled." Step 3 becomes: "Fill `src/selectors.ts`; `src/provider.ts` already implements the contract — change it only where a `// VARIANT` comment and the decision table say so."
  6. *Provider method contract* — the table as today (it is the specification the template implements; an agent debugging a variant needs it). Trim the two longest cells (`urlHooks`, `isLoggedIn`) only if the word budget requires; never drop a rule.
  7. `browser` / `idle` options — as today.
  8. *VSCode extension* — two lines pointing at `vscode-extension.md`.
  9. *Traps seen in the wild* — as today; rows that the decision table now covers keep their symptom and point to it ("see `dom-discovery.md` decision table") instead of repeating the fix.

- [ ] **Step 5: Test, check, commit, sync**

```bash
bun test packages/provider/skills.test.ts && bun run check
wc -w packages/provider/skills/creating-provider-repo/SKILL.md
git add packages/provider/skills packages/provider/skills.test.ts
git commit -m "docs: MCP-driven DOM discovery procedure and a slimmer provider skill (Refs #113)"
gh issue comment 113 --body "Task 6 done: dom-discovery.md (fixed MCP procedure + decision table) and the new SKILL.md (<word count> words, was 2542). What's next: Task 7, ship the skills in @chatbridge/provider and symlink."
```

---

### Task 7: Ship the skills in `@chatbridge/provider`; symlinks

**Files:**
- Modify: `packages/provider/package.json` (`"files": ["dist", "skills", "README.md", "LICENSE"]`)
- Modify: `packages/provider/README.md`
- Delete: `.claude/skills/creating-provider-repo/` (directory), `.agents/skills/` (directory)
- Create: symlinks `.claude/skills/creating-provider-repo`, `.agents/skills`
- Test: extend `packages/provider/skills.test.ts`

**Interfaces:**
- Consumes: the skill directory from Tasks 3–6.
- Produces: the published path `node_modules/@chatbridge/provider/skills/`; the refresh command (spec §7.1) that Task 8's skill and the templates' README quote.

- [ ] **Step 1: Write the failing test** (append)

```ts
import { lstatSync, realpathSync } from "node:fs";
import { $ } from "bun";

describe("packaging", () => {
  test("the tarball carries the skills", async () => {
    const out = await $`bun pm pack --dry-run`.cwd(import.meta.dir).text();
    expect(out).toContain("skills/creating-provider-repo/SKILL.md");
    expect(out).toContain("skills/creating-provider-repo/probes/chatbridge-probes.js");
    expect(out).toContain("skills/creating-provider-repo/templates/src/provider.ts");
    expect(out).not.toContain("skills.test.ts");
  });

  test("this repository reads the same files through symlinks", () => {
    const root = join(import.meta.dir, "../..");
    const link = join(root, ".claude/skills/creating-provider-repo");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(SKILLS, "creating-provider-repo")));
    expect(lstatSync(join(root, ".agents/skills")).isSymbolicLink()).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `bun test packages/provider/skills.test.ts` → FAIL.

- [ ] **Step 3: Make the change**

```bash
git rm -r -q .claude/skills/creating-provider-repo .agents/skills
ln -s ../../packages/provider/skills/creating-provider-repo .claude/skills/creating-provider-repo
ln -s ../.claude/skills .agents/skills
```

Before deleting `.agents/skills/`, confirm with `git log --oneline -- .agents` what put it there and that nothing references it (`grep -rn "\.agents" --include='*.md' --include='*.json' . | grep -v node_modules`). `starting-next-milestone` stays a real directory under `.claude/skills/` and becomes reachable through the `.agents/skills` symlink.

Edit `packages/provider/package.json` `files`. If `bun pm pack --dry-run` lists template files that must not ship (none expected) or **omits** `templates/gitignore`-like names, fix through `files`, never by renaming templates.

Add to `packages/provider/README.md` a section "Skills for coding agents" with: what the two skills are, the refresh command from spec §7.1, and the three instructions from spec §7.5 verbatim.

- [ ] **Step 4: Verify Claude Code still lists the skill through the symlink**

Run: `ls -la .claude/skills/ && cat .claude/skills/creating-provider-repo/SKILL.md | head -5`
Expected: the symlink resolves and prints the frontmatter.

- [ ] **Step 5: Test, check, commit, sync**

```bash
bun test packages/provider && bun run check
git add -A .claude/skills .agents packages/provider
git commit -m "feat: ship the provider skills inside @chatbridge/provider (Refs #113)"
gh issue comment 113 --body "Task 7 done: skills live in packages/provider/skills and are in the package's files; .claude/skills/creating-provider-repo and .agents/skills are symlinks (the stale .agents copy is gone). What's next: Task 8, upgrading-provider-repo + upgrade-guide.md."
```

---

### Task 8: `upgrading-provider-repo` and `upgrade-guide.md`

**Files:**
- Create: `packages/provider/skills/upgrading-provider-repo/SKILL.md`
- Create: `packages/provider/skills/upgrading-provider-repo/upgrade-guide.md`
- Create: symlink `.claude/skills/upgrading-provider-repo` → `../../packages/provider/skills/upgrading-provider-repo`
- Modify: `CLAUDE.md` (section "Pull requests"), `docs/PUBLISHING.md`
- Test: extend `packages/provider/skills.test.ts`

**Interfaces:**
- Consumes: selector names and template paths (Task 4), `vscode-extension.md` (Task 5), `dom-discovery.md` section names (Task 6), refresh command (Task 7).
- Produces: the guide's fixed entry shape; the process rule.

- [ ] **Step 1: Write the failing test** (append)

```ts
describe("upgrading-provider-repo", () => {
  const guide = () => read("upgrading-provider-repo/upgrade-guide.md");

  test("has an entry for the current minor version, newest first", () => {
    const { version } = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"));
    const minor = version.split(".").slice(0, 2).join(".");
    const headings = Array.from(guide().matchAll(/^## (\d+\.\d+\.\d+)$/gm), (m) => m[1] ?? "");
    expect(headings.some((h) => h.startsWith(`${minor}.`))).toBe(true);
    const sorted = [...headings].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    expect(headings).toEqual(sorted);
  });

  test("every entry has the fixed shape", () => {
    const entries = guide().split(/^## \d+\.\d+\.\d+$/m).slice(1);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const entry of entries) {
      expect(entry).toMatch(/^\*\*Required:\*\*/m);
      expect(entry).toMatch(/^\*\*Optional:\*\*/m);
      expect(entry).toMatch(/^\*\*VSCode manifest:\*\*/m);
    }
  });

  test("optional features say whether they need DOM observation and how to verify", () => {
    for (const feature of guide().split(/^### /m).slice(1)) {
      expect(feature).toMatch(/^Needs DOM observation: (yes|no)/m);
      expect(feature).toMatch(/^Verify:/m);
    }
  });

  test("the skill is short and links to its sibling by relative path", () => {
    const skill = read("upgrading-provider-repo/SKILL.md");
    expect(words(skill)).toBeLessThanOrEqual(600);
    expect(skill).toContain("../creating-provider-repo/");
    expect(skill).toContain("node_modules/@chatbridge/provider/skills");
  });
});
```

- [ ] **Step 2: Run to verify it fails.** → FAIL.

- [ ] **Step 3: Gather the facts for the guide.** For each release from 0.9.0 to 0.10.0, read `gh release view v<version>` and `git log v<prev>..v<version> --oneline -- packages/provider packages/cli/src/create-cli* packages/vscode`, and the matching rows in today's SKILL.md (`commands`, `urlHooks` ≥ 0.9.0; `<id>.reopen` ≥ 0.8.1; view title bar ≥ 0.9.1; `responseFormat`, `streaming` ≥ 0.10.0; `browser.reducedMotion`, `idle` — find their versions in the releases). Also read the sibling vendor repo's adoption commit for shape only: `git -C ../chatbridge-rakuten-ai show b74b4f8 --stat` (do not copy vendor content).

- [ ] **Step 4: Write `upgrade-guide.md`.** Header: how to read it (apply every entry above your old pin, oldest first; "Required" breaks or warns if skipped; "Optional" is offered to the user). Entry shape, exactly:

```markdown
## 0.10.0

**Required:** none.

**Optional:**

### Markdown replies
Needs DOM observation: yes — `../creating-provider-repo/dom-discovery.md` step 5, then `replyShape()`.
Change:
1. `src/selectors.ts`: add `ASSISTANT_MESSAGE_BODY` = `replyShape().contentRoot`, made relative to one assistant turn; add it to `MANY`. Record it in dom-notes §Messages and §Streaming behaviour.
2. `src/provider.ts`: add `responseFormat: "markdown"`; in `waitForResponse`, replace the `innerText` reads with `elementToMarkdown(<newest turn>.locator(ASSISTANT_MESSAGE_BODY).first())` (import it from `@chatbridge/provider`); keep the done-signal → count → stability order. Compare with `../creating-provider-repo/templates/src/provider.ts`.
3. `src/provider.test.ts`: assert `provider.responseFormat === "markdown"`.
4. `src/provider.e2e.test.ts`: add the "Markdown fidelity" test from the template.
Verify: `<VENDOR>_E2E=1 bun test src/provider.e2e.test.ts` — the fidelity test passes; in interactive mode a reply with a list and a code block renders formatted.

### Streaming
Needs DOM observation: yes — `recordTurn` across one turn; `summary.streamingElement`.
Change: …
Verify: …

**VSCode manifest:** none.
```

Write complete entries for 0.10.0 (Markdown replies, Streaming), 0.9.1 (view title bar entries: copy from `../creating-provider-repo/templates/vscode/package.json`; `idle` / `reducedMotion` if they shipped here), 0.9.0 (slash commands, URL hooks — "Needs DOM observation: no"). End with: "Older than 0.9.0: re-scaffold from `../creating-provider-repo/templates/` and carry `src/selectors.ts` and `docs/dom-notes.md` over."

- [ ] **Step 5: Write the skill.** Frontmatter: `name: upgrading-provider-repo`; `description: Use when bumping @chatbridge/* in an existing vendor provider repository, or when asked to adopt a framework feature the provider does not use yet — Markdown replies, streaming, slash commands, URL hooks, idle timeout, VSCode view changes.` Body: the five-step procedure of spec §7.2 as a numbered list with the exact commands (`npm view @chatbridge/cli version`; the nested-copy `find` from the sibling skill's Rules; the refresh command; "re-open this file from the refreshed copy before continuing"), a "Red flags" list: adopting a feature from release notes without its guide entry; skipping `Verify`; bumping only some `@chatbridge/*` packages; writing a selector without a dom-notes entry; editing files under `.claude/skills/` by hand (they are overwritten by the refresh). One line on feedback: gaps the provider cannot solve are `chatbridge-cli` issues.

- [ ] **Step 6: Process rule.** `CLAUDE.md`, under "Pull requests", add:

```markdown
- A PR that changes what a vendor sees — the `Provider` type, `createCli` or
  `createExtension` options, the VSCode `contributes` a vendor manifest must
  carry, or the templates — adds its entry to
  `packages/provider/skills/upgrading-provider-repo/upgrade-guide.md` in the same
  PR. Vendors upgrade by that file alone, with a smaller model; release notes
  are not enough. The whole-branch review checks it.
```

`docs/PUBLISHING.md`: in the release checklist, add "the upgrade guide has an entry for this version (a test enforces the minor; write `Required: none.` / `Optional: none.` when nothing changed for vendors)". Also update the `CLAUDE.md` "Current state" or "Development process" text if it names `.claude/skills/creating-provider-repo` as the skill's home.

- [ ] **Step 7: Symlink, test, check, commit, sync**

```bash
ln -s ../../packages/provider/skills/upgrading-provider-repo .claude/skills/upgrading-provider-repo
bun test packages/provider && bun run check
git add -A .claude/skills packages/provider CLAUDE.md docs/PUBLISHING.md
git commit -m "feat: upgrading-provider-repo skill and a fixed-shape upgrade guide (Refs #113)"
gh issue comment 113 --body "Task 8 done: upgrading-provider-repo + upgrade-guide.md (entries 0.9.0–0.10.0), process rule in CLAUDE.md and PUBLISHING.md. What's next: Task 9, GREEN runs with Sonnet on /hard and the Markdown-adoption scenario."
```

Add the packaging assertion for the new skill to the Task 7 test (`skills/upgrading-provider-repo/upgrade-guide.md` is in the dry-run output) in this commit.

---

### Task 9: GREEN runs and the refactor loop (controller)

**Files:** whatever the findings require under `packages/provider/skills/`; findings go to #113.

**Interfaces:**
- Consumes: everything above; the RED checklist from Task 2.

- [ ] **Step 1: Arena for the creation skill.** As Task 2 Step 1, but copy both skills with the refresh command's shape: `cp -R packages/provider/skills/. "$ARENA/.claude/skills/"`. Copy `templates/mcp.json` behaviour is the agent's job. Because the published packages do not contain the skills yet, the agent installs `@chatbridge/*` from npm as usual; only the skill copy comes from this branch.

  The subagent needs Playwright MCP **with the init script**. The session's plugin server has no `--init-script`, so give the subagent this fallback, which exercises the same probe: "If `typeof window.__cbProbe` is `undefined`, run once per page load: `browser_evaluate` with the function `() => { const s = document.createElement('script'); s.textContent = <contents of probes/chatbridge-probes.js>; document.head.appendChild(s); return typeof window.__cbProbe; }`" — and record in the findings that the GREEN runs used the fallback. If it is practical to register a project-scoped `.mcp.json` server for the arena instead (start the subagent with the arena as its working directory), prefer that.

- [ ] **Step 2: Three Sonnet runs**, same prompt as Task 2 Step 2. Score each with the Task 2 checklist plus: all eight dom-notes sections filled with dates and `verify()` counts; `bun run check` passes in the arena; the two-turn test against `/hard` passes; the Markdown assertions of `templates.test.ts` hold for the agent's provider on the `md: sample` prompt; number of tool calls.

- [ ] **Step 3: The upgrade scenario, one Sonnet run.** Arena: a vendor repo whose provider is text-only (the RED output if usable; otherwise instantiate the templates for `/hard`, then strip `responseFormat`, `streaming`, `ASSISTANT_MESSAGE_BODY` and the fidelity test, and pin nothing else differently). Prompt: `Follow the upgrading-provider-repo skill. The framework version is already current; adopt Markdown replies.` Score: used `replyShape()`; `ASSISTANT_MESSAGE_BODY` points at `[data-part="content"]`; the copy-button label is not in the output; fidelity test added and passing; one commit for the entry.

- [ ] **Step 4: Refactor loop.** For each failure: classify it (writing-skills "Match the Form to the Failure") — a missing decision-table row, a template gap, a probe output that misled, or unclear wording. Fix at that place, add or extend an automated test when the fix is in the probe or templates, re-run the failed scenario. Stop when two consecutive runs of each scenario pass the checklist. Variance between runs is a finding: if runs choose different selectors for the same constant, tighten the procedure's **Read** instruction for that step.

- [ ] **Step 5: Commit fixes and sync** after each loop iteration:

```bash
bun run check
git add -A packages/provider examples/dummy-chat
git commit -m "docs: close gaps found in GREEN runs of the provider skills (Refs #113)"
gh issue comment 113 --body "Task 9, iteration <n>: <scores per run, what changed>. What's next: <next iteration | Task 10 review and PR>."
```

---

### Task 10: Whole-branch review, PR, follow-ups

- [ ] **Step 1: Backlog issues** for what this milestone found but does not fix (English, label `backlog`), at least: "elementToMarkdown: let the provider name elements to skip (code-block header labels leak a stray line)", if Task 4/9 confirmed the leak.

- [ ] **Step 2: Whole-branch review** with Fable (superpowers:requesting-code-review). Review checklist additions: the probe source has no storage/cookie access; nothing vendor-specific entered the repo (grep the diff for the sibling vendor's name and host); the skills contain no path into `chatbridge-cli`; symlinks resolve on a fresh clone (`git clone` to a temp dir, `ls -L .claude/skills/creating-provider-repo/SKILL.md`); `bun pm pack --dry-run` output for `@chatbridge/provider`.

- [ ] **Step 3: PR.** Title (it becomes a release-note line): `Provider skills ship with @chatbridge/provider: probe-driven DOM discovery through Playwright MCP, ready-made templates, and an upgrade guide for existing vendor repos`. Label `enhancement`. Body: summary, how a vendor refreshes the skills, test evidence (RED vs GREEN scores), `Closes #113`. End with the attribution lines.

- [ ] **Step 4: After the merge** (on the user's word): append the milestone 18 heading to `docs/ROADMAP.md` in the existing format, close the milestone, set the board item to `Done`, verify #113 closed. The skills reach vendors only with a release: ask the user whether to cut 0.10.1 (patch by default).
