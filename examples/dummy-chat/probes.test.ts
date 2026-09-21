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
  await page.waitForSelector('[data-testid="stop-button"]', {
    state: "detached",
  });
}

/** Appends an attribute-free element under `parentExpr` and grows its text in
 * separate tasks, so the observer sees one added node and several updates. */
async function grow(page: Page, parentExpr: string) {
  await page.evaluate(`(async () => {
    const el = document.createElement("div");
    el.className = "css-t1g6h0";
    (${parentExpr}).appendChild(el);
    const wait = () => new Promise((r) => setTimeout(r, 20));
    await wait();
    for (let i = 0; i < 3; i++) {
      el.textContent = "chunk ".repeat(i + 1);
      await wait();
    }
  })()`);
}

describe("probe source", () => {
  test("never names browser storage or cookies", () => {
    const source = readFileSync(PROBE, "utf8");
    for (const word of [
      "cookie",
      "localStorage",
      "sessionStorage",
      "indexedDB",
    ])
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
    expect(
      g.signIn.map((x: { locators: string[] }) => x.locators[0]),
    ).toContain('[data-testid="sign-in-link"]');
    expect(g.account).toHaveLength(0);
    expect(m.signIn).toHaveLength(0);
    expect(
      m.account.map((x: { locators: string[] }) => x.locators[0]),
    ).toContain('[data-testid="account-menu"]');
    expect(
      g.composer.filter((x: { visible: boolean }) => x.visible),
    ).toHaveLength(1);
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
    await sendTurn(
      page,
      "hello there this is a long enough message to be cut at forty characters",
    );
    await sendTurn(page, "second");
    const c = await probe(page, "window.__cbProbe.census()");
    const list = c.messageLists.find(
      (l: { locator: string }) => l.locator === '[role="log"]',
    );
    expect(list.children).toBe(4);
    expect(list.childShape).toContain("data-turn");
    expect(JSON.stringify(c)).not.toContain("forty characters");
    await page.context().close();
  });

  test("never carries more than 40 characters of page text", async () => {
    const page = await open(true);
    const long =
      "abcdefghij0123456789abcdefghij0123456789abcdefghij0123456789klmnop";
    await sendTurn(page, long);
    await page.fill('[data-testid="composer-input"]', long);
    const c = await probe(page, "window.__cbProbe.census()");
    // No string anywhere in the output holds 41 characters of the message.
    expect(JSON.stringify(c)).not.toContain(long.slice(0, 41));
    const heads: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (typeof record.head === "string" && typeof record.length === "number")
        heads.push(record.head);
      for (const value of Object.values(record)) walk(value);
    };
    walk(c);
    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) expect(head.length).toBeLessThanOrEqual(40);
    await page.context().close();
  });
});

describe("dom-discovery step 5", () => {
  test("its button diff finds the send control without reading a label", async () => {
    const doc = readFileSync(
      new URL("../dom-discovery.md", `file://${PROBE.replace(/[^/]+$/, "")}`),
      "utf8",
    );
    // The call exactly as the procedure prints it, so the two cannot drift.
    const call =
      /"function": "(\(\) => window\.__cbProbe\.census\(\)\.buttons\.filter[^\n]+)" }/.exec(
        doc,
      )?.[1];
    expect(call).toBeDefined();
    const expr = `(${JSON.parse(`"${call}"`)})()`;
    const page = await open(true);
    const before = await probe<{ locator: string }[]>(page, expr);
    await page.fill('[data-testid="composer-input"]', ".");
    const after = await probe<{ locator: string }[]>(page, expr);
    const known = new Set(before.map((b) => b.locator));
    expect(after.filter((b) => !known.has(b.locator))).toEqual([
      { locator: '[data-testid="send-button"]', label: "送信" },
    ]);
    await page.context().close();
  });
});

describe("census on a demanding page", () => {
  test("lists descriptive attributes before per-turn identity ones", async () => {
    const page = await open(true);
    await page.evaluate(`(() => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.messageId = "m42";
      b.dataset.kind = "retry";
      b.setAttribute("aria-label", "retry");
      document.querySelector("footer").appendChild(b);
    })()`);
    const c = await probe(page, "window.__cbProbe.census()");
    const retry = c.buttons.find(
      (b: { ariaLabel?: string }) => b.ariaLabel === "retry",
    );
    expect(retry.locators[0]).toBe('[data-kind="retry"]');
    expect(retry.locators).toContain('[data-message-id="m42"]');
    await page.context().close();
  });

  test("stays fast on a large thread", async () => {
    const page = await open(true);
    const elements = await page.evaluate(`(() => {
      const log = document.querySelector('[role="log"]');
      for (let i = 0; i < 100; i++) {
        const article = document.createElement("article");
        article.className = "css-t1g6h0";
        article.dataset.turn = i % 2 ? "assistant" : "user";
        for (let j = 0; j < 29; j++) {
          const block = document.createElement("div");
          block.dataset.part = "content";
          block.dataset.state = "done";
          block.textContent = "block " + j;
          article.appendChild(block);
        }
        log.appendChild(article);
      }
      return document.querySelectorAll("*").length;
    })()`);
    expect(elements).toBeGreaterThan(3000);
    const ms = await probe<number>(
      page,
      `(() => {
        const t = performance.now();
        window.__cbProbe.census();
        return Math.round(performance.now() - t);
      })()`,
    );
    expect(ms).toBeLessThan(1500);
    const c = await probe(page, "window.__cbProbe.census()");
    expect(c.messageLists.length).toBeLessThanOrEqual(10);
    expect(c.stateAttrs.length).toBeLessThanOrEqual(50);
    await page.context().close();
  });
});

describe("recordTurn", () => {
  test("sees the placeholder, the streaming element and the stop button leaving last", async () => {
    const page = await open(true);
    await page.fill('[data-testid="composer-input"]', "md: sample");
    expect(await probe(page, "window.__cbProbe.recordTurn.start()")).toBe(
      "recording",
    );
    await page.click('[data-testid="send-button"]');
    await page.waitForSelector('[data-testid="stop-button"]');
    await page.waitForSelector('[data-testid="stop-button"]', {
      state: "detached",
    });
    const r = await probe(page, "window.__cbProbe.recordTurn.stop()");
    expect(r.summary.placeholderTurns).toHaveLength(1);
    expect(r.summary.placeholderTurns[0]).toContain("data-placeholder");
    expect(r.summary.streamingElement).toContain("data-message-id");
    expect(r.summary.doneCandidates[0]).toContain("stop-button");
    expect(r.summary.doneCandidates[0]).toContain("gone");
    expect(
      r.buttonsSwapped.some((b: { gone?: string }) =>
        b.gone?.includes("send-button"),
      ),
    ).toBe(true);
    await page.context().close();
  });

  test("names the family of the streaming element, not just this turn's instance", async () => {
    const page = await open(true);
    await sendTurn(page, "first");
    await page.fill('[data-testid="composer-input"]', "second");
    await probe(page, "window.__cbProbe.recordTurn.start()");
    await page.click('[data-testid="send-button"]');
    await page.waitForSelector('[data-testid="stop-button"]');
    await page.waitForSelector('[data-testid="stop-button"]', {
      state: "detached",
    });
    const r = await probe(page, "window.__cbProbe.recordTurn.stop()");
    // The instance is this turn's; the collection is what selectors.ts keeps.
    expect(r.summary.streamingElement).toBe('[data-message-id="m2"]');
    expect(r.summary.streamingCollection).toEqual({
      selector: 'article[data-turn="assistant"]',
      count: 2,
    });
    expect(r.textGrowth[0].collection).toEqual(r.summary.streamingCollection);
    await page.context().close();
  });

  test("anchors the collection when the turns carry no attribute at all", async () => {
    const page = await open(true);
    await page.evaluate(`(() => {
      const log = document.querySelector('[role="log"]');
      log.replaceChildren();
      for (let i = 0; i < 2; i++) {
        const turn = document.createElement("div");
        turn.className = "css-t1g6h0";
        turn.textContent = "old turn";
        log.appendChild(turn);
      }
    })()`);
    await probe(page, "window.__cbProbe.recordTurn.start()");
    await grow(page, `document.querySelector('[role="log"]')`);
    const r = await probe(page, "window.__cbProbe.recordTurn.stop()");
    expect(r.summary.streamingCollection).toEqual({
      selector: '[role="log"] > div',
      count: 3,
    });
    expect(r.textGrowth[0].collection).toEqual(r.summary.streamingCollection);
    const siblings = await probe<boolean>(
      page,
      `(() => {
        const log = document.querySelector('[role="log"]');
        return [...document.querySelectorAll('[role="log"] > div')]
          .every((el) => el.parentElement === log);
      })()`,
    );
    expect(siblings).toBe(true);
    await page.context().close();
  });

  test("says so rather than handing back a bare tag", async () => {
    const page = await open(true);
    await probe(page, "window.__cbProbe.recordTurn.start()");
    await grow(page, "document.body");
    const r = await probe(page, "window.__cbProbe.recordTurn.stop()");
    expect(r.summary.streamingCollection.selector).toBe(null);
    expect(r.summary.streamingCollection.count).toBe(0);
    expect(r.summary.streamingCollection.note).toContain("messageLists");
    await page.context().close();
  });

  test("a normal turn reads as sent", async () => {
    const page = await open(true);
    await probe(page, "window.__cbProbe.recordTurn.start()");
    await sendTurn(page, "one");
    const r = await probe(page, "window.__cbProbe.recordTurn.stop()");
    expect(r.summary.sent).toBe(true);
    await page.context().close();
  });

  test("a newline inside the composer is not a turn", async () => {
    const page = await open(true);
    const r = await probe(
      page,
      `(async () => {
        const c = document.createElement("div");
        c.setAttribute("contenteditable", "true");
        c.setAttribute("data-testid", "fake-composer");
        document.body.appendChild(c);
        const wait = () => new Promise((r) => setTimeout(r, 20));
        window.__cbProbe.recordTurn.start();
        c.textContent = "prompt";
        await wait();
        const line = document.createElement("div");
        line.setAttribute("data-line", "2");
        line.appendChild(document.createElement("br"));
        c.appendChild(line);
        await wait();
        line.textContent = "a";
        await wait();
        line.textContent = "ab";
        line.setAttribute("data-line", "3");
        await wait();
        return window.__cbProbe.recordTurn.stop();
      })()`,
    );
    expect(r.added).toEqual([]);
    expect(r.attrs).toEqual([]);
    expect(r.textGrowth).toEqual([]);
    expect(r.summary.sent).toBe(false);
    await page.context().close();
  });

  test("never records a value attribute", async () => {
    const page = await open(true);
    const r = await probe(
      page,
      `(async () => {
        const i = document.createElement("input");
        i.type = "password";
        document.body.appendChild(i);
        window.__cbProbe.recordTurn.start();
        i.setAttribute("value", "hunter2secret");
        i.setAttribute("data-value", "hunter2secret");
        await new Promise((r) => setTimeout(r, 20));
        return window.__cbProbe.recordTurn.stop();
      })()`,
    );
    expect(JSON.stringify(r)).not.toContain("hunter2");
    await page.context().close();
  });

  test("a send button that is always there names itself by its disabled flip", async () => {
    const page = await open(true);
    const r = await probe(
      page,
      `(async () => {
        const b = document.createElement("button");
        b.setAttribute("data-testid", "fixed-send");
        b.textContent = "Go";
        document.body.appendChild(b);
        window.__cbProbe.recordTurn.start();
        b.setAttribute("disabled", "");
        await new Promise((r) => setTimeout(r, 20));
        b.setAttribute("aria-disabled", "true");
        await new Promise((r) => setTimeout(r, 20));
        return window.__cbProbe.recordTurn.stop();
      })()`,
    );
    expect(r.buttonsSwapped.map((s: { changed: string }) => s.changed)).toEqual(
      [
        '[data-testid="fixed-send"] disabled: null → ',
        '[data-testid="fixed-send"] aria-disabled: null → true',
      ],
    );
    await page.context().close();
  });

  test("stop without start reports an error object, not a throw", async () => {
    const page = await open(true);
    const r = await probe(page, "window.__cbProbe.recordTurn.stop()");
    expect(r.error).toBe("recordTurn.start() was not called on this page");
    await page.context().close();
  });

  test("a second start disconnects the first observer", async () => {
    const page = await open(true);
    await page.evaluate(`(() => {
      const Real = window.MutationObserver;
      window.__obs = { made: 0, disconnected: 0 };
      window.MutationObserver = class extends Real {
        constructor(cb) { super(cb); window.__obs.made++; }
        disconnect() { window.__obs.disconnected++; return super.disconnect(); }
      };
    })()`);
    await probe(page, "window.__cbProbe.recordTurn.start()");
    await probe(page, "window.__cbProbe.recordTurn.start()");
    const obs = await probe(page, "window.__obs");
    expect(obs.made).toBe(2);
    expect(obs.disconnected).toBe(1);
    await probe(page, "window.__cbProbe.recordTurn.stop()");
    expect((await probe(page, "window.__obs")).disconnected).toBe(2);
    await page.context().close();
  });
});

describe("replyShape", () => {
  test("separates content from chrome and finds the content root", async () => {
    const page = await open(true);
    await sendTurn(page, "md: sample");
    const s = await probe(page, "window.__cbProbe.replyShape()");
    expect(s.contentRoot).toContain('[data-part="content"]');
    expect(
      s.chrome.some((c: { kind: string }) => c.kind === "code-header"),
    ).toBe(true);
    expect(s.chrome.some((c: { kind: string }) => c.kind === "button")).toBe(
      true,
    );
    expect(s.codeLanguage).toBe("class");
    expect(s.chromeInsideContent.join(" ")).toContain("code-header");
    // The selector a provider actually uses: relative to one turn, so it
    // carries nothing that identifies this turn.
    expect(s.contentRootWithin).toBe('[data-part="content"]');
    await page.context().close();
  });

  test("names the content root relative to the turn when it has no attributes", async () => {
    const page = await open(true);
    await sendTurn(page, "one");
    // A turn whose body child carries only a class: the only honest relative
    // selector is the direct-child form.
    await page.evaluate(`(() => {
      const turn = document.createElement("article");
      turn.className = "css-9z8y7x";
      turn.innerHTML = '<div class="css-1a2b3c"><p>hello</p><ul><li>a</li></ul></div>';
      document.querySelector('[role="log"]').appendChild(turn);
      window.__plainTurn = turn;
    })()`);
    const s = await probe(
      page,
      "window.__cbProbe.replyShape('[role=\"log\"] > article:last-child')",
    );
    expect(s.contentRootWithin).toBe(":scope > div");
    await page.context().close();
  });

  test("never names the content root by this turn's identity", async () => {
    const page = await open(true);
    await sendTurn(page, "one");
    const shapeOf = (body: string) =>
      probe(
        page,
        `(() => {
          const log = document.querySelector('[role="log"]');
          for (const stale of log.querySelectorAll("article.probe-fixture")) stale.remove();
          const turn = document.createElement("article");
          turn.className = "css-9z8y7x probe-fixture";
          turn.innerHTML = ${JSON.stringify(body)};
          log.appendChild(turn);
          return window.__cbProbe.replyShape('[role="log"] > article:last-child');
        })()`,
      );
    // Only a per-turn id: unusable, so the direct-child form wins.
    const identity = await shapeOf(
      '<div data-message-id="m9" id="msg-9"><p>hello</p><ul><li>a</li></ul></div>',
    );
    expect(identity.contentRootWithin).toBe(":scope > div");
    // A descriptive attribute beside the identity one: that is the answer.
    const descriptive = await shapeOf(
      '<div data-part="content" data-message-id="m9"><p>hello</p><ul><li>a</li></ul></div>',
    );
    expect(descriptive.contentRootWithin).toBe('[data-part="content"]');
    // An id is never kept, even one that does not look per-turn: nothing in one
    // observation can tell "#content" from "#msg_abc".
    const plainId = await shapeOf(
      '<div id="content"><p>hello</p><ul><li>a</li></ul></div>',
    );
    expect(plainId.contentRootWithin).toBe(":scope > div");
    // A label carries page text and is translated: structure wins.
    const labelled = await shapeOf(
      '<div aria-label="Reply"><p>hello</p><ul><li>a</li></ul></div>',
    );
    expect(labelled.contentRootWithin).toBe(":scope > div");
    // Two same-tag children, the content second: no structural form resolves
    // to it first, and a label is not a fallback.
    const second = await shapeOf(
      '<div><button>x</button></div><div aria-label="Reply" id="content"><p>hello</p><ul><li>a</li></ul></div>',
    );
    expect(second.contentRootWithin).toBeNull();
    await page.context().close();
  });
});

describe("census composer text", () => {
  test("reads a form control's value, not its textContent", async () => {
    const page = await open(true);
    await page.evaluate(`(() => {
      const t = document.querySelector("textarea");
      t.style.display = "block";
      t.value = "typed into a textarea";
    })()`);
    const c = await probe(page, "window.__cbProbe.census().composer");
    const area = c.find((x: { tag: string }) => x.tag === "textarea");
    expect(area.text.length).toBe("typed into a textarea".length);
    expect(area.text.head).toBe("typed into a textarea");
    await page.context().close();
  });

  test("never reports an <input>'s value", async () => {
    const page = await open(true);
    await page.evaluate(`(() => {
      const i = document.createElement("input");
      i.type = "password";
      i.setAttribute("role", "textbox");
      i.setAttribute("data-testid", "secret-field");
      i.value = "hunter2secret";
      document.body.appendChild(i);
    })()`);
    const c = await probe(page, "window.__cbProbe.census()");
    const field = c.composer.find((x: { tag: string }) => x.tag === "input");
    expect(field).toBeDefined();
    expect(field.text).toBeUndefined();
    expect(JSON.stringify(c)).not.toContain("hunter2");
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
    expect(v.assistantMessages).toEqual({
      count: 2,
      visibleCount: 2,
      ok: true,
    });
    expect(v.broken.ok).toBe(false);
    expect(v.broken.error).toContain("invalid selector");
    await page.context().close();
  });

  test("scopes a `within` selector to the last matching element", async () => {
    const page = await open(true);
    await sendTurn(page, "md: sample");
    const v = await probe(
      page,
      `window.__cbProbe.verify({
        body: { selector: ':scope > [data-part="content"]', within: 'article[data-turn="assistant"]' },
        plainBody: { selector: '[data-part="content"]', within: 'article[data-turn="assistant"]' },
        noHost: { selector: 'p', within: '[data-testid="nowhere"]' },
      })`,
    );
    // `:scope` is meaningless against the document; scoping makes it work.
    expect(v.body).toEqual({ count: 1, visibleCount: 1, ok: true });
    expect(v.plainBody.ok).toBe(true);
    expect(v.noHost).toEqual({
      count: 0,
      visibleCount: 0,
      ok: false,
      error: 'within matched nothing: [data-testid="nowhere"]',
    });
    await page.context().close();
  });

  test("blames the broken half of a scoped entry", async () => {
    const page = await open(true);
    await sendTurn(page, "one");
    const v = await probe(
      page,
      `window.__cbProbe.verify({
        badWithin: { selector: 'p', within: 'article[[' },
        badSelector: { selector: 'p[[', within: 'article[data-turn="assistant"]' },
      })`,
    );
    expect(v.badWithin.error).toBe("invalid within selector: article[[");
    expect(v.badSelector.error).toBe("invalid selector: p[[");
    await page.context().close();
  });

  test("an empty selector is skipped, not reported broken", async () => {
    const page = await open(true);
    const v = await probe(
      page,
      "window.__cbProbe.verify({ SEND_BUTTON: '', STOP_BUTTON: { selector: '', many: true } })",
    );
    for (const name of ["SEND_BUTTON", "STOP_BUTTON"]) {
      expect(v[name].ok).toBe(true);
      expect(v[name].count).toBe(0);
      expect(v[name].skipped).toContain("VARIANT");
    }
    await page.context().close();
  });
});
