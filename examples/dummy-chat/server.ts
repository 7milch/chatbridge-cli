/** Minimal dummy web chat used for E2E verification of the framework.
 * Not a real service: fixed echo responses, cookie-based fake login.
 * The reply is rendered Markdown and grows in chunks while the log is busy,
 * so streaming and Markdown extraction are exercised end to end.
 * Test hooks: invalidateSessions() (simulates an expired login),
 * setReplyDelayMs() (simulates a slow response), setChunkDelayMs() (the wait
 * between two reply chunks), setBlocked() (serves a challenge page instead of
 * the chat), a message starting with "slow:" (that one reply takes 5 s
 * regardless of the delay), and a message starting with "md:" (the reply is a
 * multi-block Markdown document instead of one line). */

/** The Markdown source of the reply to `text`. The first line keeps the
 * historical "Echo: " shape every existing test asserts on. */
export function dummyReply(text: string): string {
  if (!text.startsWith("md:")) return `Echo: ${text}`;
  return [
    `Echo: ${text}`,
    "",
    "## Details",
    "",
    "- **bold** item",
    "- second item",
    "",
    "```ts",
    "const a = 1;",
    "```",
    "",
    "| k | v |",
    "| --- | --- |",
    "| a | 1 |",
  ].join("\n");
}

/** Quotes included: a fence language reaches an attribute value, so a quote
 * in it must not be able to close that attribute. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escape first, so a prompt can never reach the page as markup, then apply
 * the one inline rule this renderer knows. */
function inlineHtml(text: string): string {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function tableHtml(lines: string[]): string {
  const cells = (row: string) =>
    row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
  const [head, , ...body] = lines;
  const head2 = cells(head ?? "")
    .map((cell) => `<th>${inlineHtml(cell)}</th>`)
    .join("");
  const rows = body
    .map(
      (row) =>
        `<tr>${cells(row)
          .map((cell) => `<td>${inlineHtml(cell)}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<table><thead><tr>${head2}</tr></thead><tbody>${rows}</tbody></table>`;
}

function blockHtml(lines: string[]): string {
  const first = lines[0] ?? "";
  const heading = /^(#{1,6}) (.*)$/.exec(first);
  if (heading) {
    const level = (heading[1] ?? "").length;
    return `<h${level}>${inlineHtml(heading[2] ?? "")}</h${level}>`;
  }
  if (first.startsWith("```")) {
    const lang = first.slice(3).trim();
    const attr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    // The closing fence is the block's last line; the code is what is between.
    const code = lines.slice(1, -1).join("\n");
    return `<pre><code${attr}>${escapeHtml(code)}</code></pre>`;
  }
  if (lines.every((line) => line.startsWith("- "))) {
    const items = lines
      .map((line) => `<li>${inlineHtml(line.slice(2))}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }
  if (/^\|(\s*-+\s*\|)+$/.test(lines[1] ?? "")) return tableHtml(lines);
  return `<p>${inlineHtml(lines.join(" "))}</p>`;
}

/** The top-level blocks of `source`, rendered to HTML. Blank lines separate
 * blocks, except inside a fence. */
function markdownBlocks(source: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let fenced = false;
  const flush = () => {
    if (current.length > 0) out.push(blockHtml(current));
    current = [];
  };
  for (const line of source.split("\n")) {
    if (line.startsWith("```")) {
      // An opening fence starts its own block even without a blank line
      // above it; left in the paragraph, the code would be joined into one
      // line and read back as an inline code span.
      if (!fenced) flush();
      current.push(line);
      if (fenced) flush();
      fenced = !fenced;
      continue;
    }
    if (!fenced && line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return out;
}

/** Renders the tiny Markdown subset `dummyReply` uses. Not a general
 * renderer: headings, paragraphs, bold, flat lists, fenced code, tables. */
export function renderDummyMarkdown(source: string): string {
  return markdownBlocks(source).join("");
}

/** The reply to `text` as cumulative innerHTML states: `chunks[i]` is the
 * whole reply element after step `i`, so every state is well-formed HTML.
 * A multi-block reply gains one block per state; a one-paragraph reply grows
 * its text over three states instead. */
function replyChunks(text: string): string[] {
  const source = dummyReply(text);
  const blocks = markdownBlocks(source);
  if (blocks.length > 1) {
    return blocks.map((_, i) => blocks.slice(0, i + 1).join(""));
  }
  const steps = 3;
  return Array.from({ length: steps }, (_, i) =>
    inlineHtml(source.slice(0, Math.ceil((source.length * (i + 1)) / steps))),
  ).map((html) => `<p>${html}</p>`);
}

const LOGIN_HTML = `<!doctype html>
<title>Dummy Chat — Login</title>
<h1>Dummy Chat</h1>
<form method="post" action="/do-login">
  <button id="login-button" type="submit">Log in</button>
</form>`;

/** Stand-in for a bot-protection interstitial: same title Cloudflare uses,
 * no chat controls, served regardless of session. */
const CHALLENGE_HTML = `<!doctype html>
<title>Just a moment...</title>
<h1>Checking your browser</h1>`;

function chatHtml(replyDelayMs: number, chunkDelayMs: number): string {
  return `<!doctype html>
<title>Dummy Chat</title>
<meta name="reply-delay" content="${replyDelayMs}">
<meta name="chunk-delay" content="${chunkDelayMs}">
<h1>Dummy Chat</h1>
<div id="chat-log" data-state="idle"></div>
<textarea id="message-input"></textarea>
<button id="send-button" type="button">Send</button>
<script>
  const meta = (name) => Number(document.querySelector('meta[name="' + name + '"]').content);
  const delay = meta("reply-delay");
  const chunkDelay = meta("chunk-delay");
  const log = document.getElementById("chat-log");
  const input = document.getElementById("message-input");
  document.getElementById("send-button").addEventListener("click", () => {
    const text = input.value;
    if (!text) return;
    input.value = "";
    const you = document.createElement("div");
    you.className = "message user";
    you.textContent = text;
    log.appendChild(you);
    log.dataset.state = "busy";
    const wait = text.startsWith("slow:") ? 5000 : delay;
    setTimeout(async () => {
      const reply = document.createElement("div");
      reply.className = "message assistant";
      log.appendChild(reply);
      try {
        // POST, not a query string: a long prompt (an attached file) would
        // otherwise overrun the server's request-line limit.
        const res = await fetch("/reply", { method: "POST", body: text });
        const { chunks } = await res.json();
        for (const html of chunks) {
          reply.innerHTML = html;
          await new Promise((r) => setTimeout(r, chunkDelay));
        }
      } catch (err) {
        reply.textContent = "reply failed: " + err;
      } finally {
        // Always: a turn that never leaves "busy" would burn the caller's
        // whole timeout instead of failing.
        log.dataset.state = "idle";
      }
    }, wait);
  });
</script>`;
}

export interface DummyChat {
  url: string;
  stop(): void;
  /** After this call, existing session cookies are rejected (auth expired). */
  invalidateSessions(): void;
  /** Delay between send and the assistant reply; default 300 ms. */
  setReplyDelayMs(ms: number): void;
  /** Wait between two chunks of a growing reply; default 40 ms. */
  setChunkDelayMs(ms: number): void;
  /** While true, /chat serves a challenge page instead of the chat. */
  setBlocked(blocked: boolean): void;
}

export async function startDummyChat(port = 8735): Promise<DummyChat> {
  let sessionsValid = true;
  let replyDelayMs = 300;
  let chunkDelayMs = 40;
  let blocked = false;

  function hasSession(req: Request): boolean {
    return (
      sessionsValid && (req.headers.get("cookie") ?? "").includes("session=ok")
    );
  }

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;
      if (pathname === "/login") {
        return new Response(LOGIN_HTML, {
          headers: { "content-type": "text/html" },
        });
      }
      if (pathname === "/do-login" && req.method === "POST") {
        sessionsValid = true;
        return new Response(null, {
          status: 302,
          headers: {
            location: "/chat",
            "set-cookie": "session=ok; Path=/; HttpOnly",
          },
        });
      }
      if (pathname === "/chat") {
        if (blocked) {
          return new Response(CHALLENGE_HTML, {
            headers: { "content-type": "text/html" },
          });
        }
        if (!hasSession(req)) {
          return new Response(null, {
            status: 302,
            headers: { location: "/login" },
          });
        }
        return new Response(chatHtml(replyDelayMs, chunkDelayMs), {
          headers: { "content-type": "text/html" },
        });
      }
      if (pathname === "/reply") {
        // Same expiry rule as /chat: an invalidated session gets nothing.
        if (!hasSession(req)) {
          return new Response("unauthorized", { status: 401 });
        }
        // The prompt is the body: no length limit to run into.
        return Response.json({ chunks: replyChunks(await req.text()) });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
    invalidateSessions: () => {
      sessionsValid = false;
    },
    setReplyDelayMs: (ms: number) => {
      replyDelayMs = ms;
    },
    setChunkDelayMs: (ms: number) => {
      chunkDelayMs = ms;
    },
    setBlocked: (value: boolean) => {
      blocked = value;
    },
  };
}
