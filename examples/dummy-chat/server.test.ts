import { afterEach, describe, expect, test } from "bun:test";
import { dummyReply, renderDummyMarkdown, startDummyChat } from "./server";

let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe("dummy chat server", () => {
  test("redirects /chat to /login without a session cookie", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const res = await fetch(`${s.url}/chat`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("login sets a session cookie and /chat then serves the chat page", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const login = await fetch(`${s.url}/do-login`, {
      method: "POST",
      redirect: "manual",
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("session=ok");
    const chat = await fetch(`${s.url}/chat`, {
      headers: { cookie: "session=ok" },
    });
    expect(chat.status).toBe(200);
    expect(await chat.text()).toContain('id="message-input"');
  });

  test("invalidateSessions makes /chat redirect even with the cookie", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    s.invalidateSessions();
    const res = await fetch(`${s.url}/chat`, {
      headers: { cookie: "session=ok" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
  });

  test("setReplyDelayMs is rendered into the chat page", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    s.setReplyDelayMs(1500);
    const chat = await fetch(`${s.url}/chat`, {
      headers: { cookie: "session=ok" },
    });
    expect(await chat.text()).toContain('name="reply-delay" content="1500"');
  });

  test("setChunkDelayMs is rendered into the chat page", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    s.setChunkDelayMs(7);
    const chat = await fetch(`${s.url}/chat`, {
      headers: { cookie: "session=ok" },
    });
    expect(await chat.text()).toContain('name="chunk-delay" content="7"');
  });

  test("serves the challenge page on /chat while blocked", async () => {
    const server = await startDummyChat(0);
    try {
      server.setBlocked(true);
      const res = await fetch(`${server.url}/chat`, {
        headers: { cookie: "session=ok" },
      });
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("<title>Just a moment...</title>");
      expect(html).not.toContain("message-input");
      server.setBlocked(false);
      const back = await fetch(`${server.url}/chat`, {
        headers: { cookie: "session=ok" },
      });
      expect(await back.text()).toContain("message-input");
    } finally {
      server.stop();
    }
  });
});

describe("dummyReply", () => {
  test("keeps the historical Echo shape for a plain prompt", () => {
    expect(dummyReply("hi")).toBe("Echo: hi");
  });

  test("answers an `md:` prompt with a fenced block and a table", () => {
    const reply = dummyReply("md: x");
    expect(reply.startsWith("Echo: md: x\n")).toBe(true);
    expect(reply).toContain("## Details");
    expect(reply).toContain("```ts\nconst a = 1;\n```");
    expect(reply).toContain("| k | v |\n| --- | --- |\n| a | 1 |");
  });
});

describe("renderDummyMarkdown", () => {
  test("renders every block kind the `md:` reply uses", () => {
    const html = renderDummyMarkdown(dummyReply("md: x"));
    expect(html).toContain("<p>Echo: md: x</p>");
    expect(html).toContain("<h2>Details</h2>");
    expect(html).toContain(
      "<ul><li><strong>bold</strong> item</li><li>second item</li></ul>",
    );
    expect(html).toContain(
      '<pre><code class="language-ts">const a = 1;</code></pre>',
    );
    expect(html).toContain(
      "<table><thead><tr><th>k</th><th>v</th></tr></thead>" +
        "<tbody><tr><td>a</td><td>1</td></tr></tbody></table>",
    );
  });

  test("escapes & < > before any inline handling", () => {
    expect(renderDummyMarkdown("a & <img src=x> **b**")).toBe(
      "<p>a &amp; &lt;img src=x&gt; <strong>b</strong></p>",
    );
  });
});

describe("GET /reply", () => {
  test("rejects a request without a session", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const res = await fetch(`${s.url}/reply?text=hi`);
    expect(res.status).toBe(401);
  });

  async function chunksFor(url: string, text: string): Promise<string[]> {
    const res = await fetch(`${url}/reply?text=${encodeURIComponent(text)}`, {
      headers: { cookie: "session=ok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chunks: string[] };
    return body.chunks;
  }

  test("grows a plain reply's paragraph over three cumulative states", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const chunks = await chunksFor(s.url, "hello");
    expect(chunks).toHaveLength(3);
    expect(chunks.at(-1)).toBe("<p>Echo: hello</p>");
    for (let i = 1; i < chunks.length; i++) {
      expect((chunks[i] ?? "").length).toBeGreaterThan(
        (chunks[i - 1] ?? "").length,
      );
      expect((chunks[i] ?? "").startsWith("<p>")).toBe(true);
    }
  });

  test("adds one top-level block per state for an `md:` reply", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const chunks = await chunksFor(s.url, "md: x");
    expect(chunks).toHaveLength(5);
    expect(chunks.at(-1)).toBe(renderDummyMarkdown(dummyReply("md: x")));
    for (let i = 1; i < chunks.length; i++) {
      expect((chunks[i] ?? "").startsWith(chunks[i - 1] ?? "")).toBe(true);
    }
  });

  test("escapes the prompt instead of reflecting it as HTML", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const chunks = await chunksFor(s.url, "<img src=x onerror=alert(1)>");
    const last = chunks.at(-1) ?? "";
    expect(last).not.toContain("<img");
    expect(last).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
