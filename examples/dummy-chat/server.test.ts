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
  test("a fence right after text, with no blank line, is still a code block", () => {
    // A prompt is echoed verbatim, and people type a fence straight under a
    // sentence; folding it into the paragraph would turn the whole block into
    // one line that Markdown then reads as an inline code span.
    expect(
      renderDummyMarkdown("see:\n```ts\nconst a = 1;\nconst b = 2;\n```\ndone"),
    ).toBe(
      '<p>see:</p><pre><code class="language-ts">const a = 1;\nconst b = 2;</code></pre><p>done</p>',
    );
  });

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

  // A fence language comes from the prompt and lands in an attribute value,
  // so a quote in it must not be able to close that attribute.
  test("escapes quotes, including in a fence language", () => {
    expect(renderDummyMarkdown('say "hi"')).toBe("<p>say &quot;hi&quot;</p>");
    expect(renderDummyMarkdown('```ts" onload="x\ncode\n```')).toContain(
      'class="language-ts&quot; onload=&quot;x"',
    );
  });
});

describe("POST /reply", () => {
  test("rejects a request without a session", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const res = await fetch(`${s.url}/reply`, { method: "POST", body: "hi" });
    expect(res.status).toBe(401);
  });

  async function chunksFor(url: string, text: string): Promise<string[]> {
    const res = await fetch(`${url}/reply`, {
      method: "POST",
      body: text,
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

  test("answers a 50 KB prompt", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const text = "x".repeat(50_000);
    const chunks = await chunksFor(s.url, text);
    expect(chunks.at(-1)).toBe(`<p>Echo: ${text}</p>`);
  });
});

describe("conversations", () => {
  /** One turn of a conversation: the id comes back, and is sent along on
   * every later turn the way the chat page's script does it. */
  async function reply(
    url: string,
    text: string,
    conversation?: string,
  ): Promise<{ chunks: string[]; conversation: string }> {
    const res = await fetch(`${url}/reply`, {
      method: "POST",
      body: text,
      headers: {
        cookie: "session=ok",
        ...(conversation ? { "x-conversation": conversation } : {}),
      },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { chunks: string[]; conversation: string };
  }

  test("the first reply mints an id and later turns keep it", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const first = await reply(s.url, "hello");
    expect(first.conversation).toMatch(/^[a-z0-9]{8}$/);
    const second = await reply(s.url, "again", first.conversation);
    expect(second.conversation).toBe(first.conversation);
  });

  test("`turns?` answers with that conversation's turn count", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const first = await reply(s.url, "hello");
    const second = await reply(s.url, "turns?", first.conversation);
    expect(second.chunks.at(-1)).toContain("turn 2");
  });

  test("a known id serves the earlier turns and the id in a meta tag", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const { conversation } = await reply(s.url, "hello there");
    const res = await fetch(`${s.url}/chat/c/${conversation}`, {
      headers: { cookie: "session=ok" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("hello there");
    expect(html).toContain(
      `<meta name="conversation" content="${conversation}">`,
    );
  });

  test("an unknown id redirects to a new chat", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const res = await fetch(`${s.url}/chat/c/zzzzzzzz`, {
      headers: { cookie: "session=ok" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/chat");
  });

  test("a conversation page without a session redirects to /login", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const { conversation } = await reply(s.url, "hello");
    const res = await fetch(`${s.url}/chat/c/${conversation}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("a prior prompt is escaped in the restored page", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const { conversation } = await reply(s.url, "<b>x</b>");
    const res = await fetch(`${s.url}/chat/c/${conversation}`, {
      headers: { cookie: "session=ok" },
    });
    const html = await res.text();
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });
});
