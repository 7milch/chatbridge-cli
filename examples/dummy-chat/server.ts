/** Minimal dummy web chat used for E2E verification of the framework.
 * Not a real service: fixed echo responses, cookie-based fake login.
 * The reply is rendered Markdown and grows in chunks while the log is busy,
 * so streaming and Markdown extraction are exercised end to end.
 * Test hooks: invalidateSessions() (simulates an expired login),
 * setReplyDelayMs() (simulates a slow response), setChunkDelayMs() (the wait
 * between two reply chunks), setBlocked() (serves a challenge page instead of
 * the chat), a message starting with "slow:" (that one reply takes 5 s
 * regardless of the delay), and a message starting with "md:" (the reply is a
 * multi-block Markdown document instead of one line).
 * GET /hard/chat, /hard/login — the same chat behind a realistic DOM (see
 * hard-skin.ts).
 * A conversation gets its own URL after its first reply: the page rewrites
 * itself to /chat/c/<id>, and GET /chat/c/<id> serves the earlier turns
 * again (an unknown id redirects to /chat). The prompt "turns?" is answered
 * with that conversation's turn count, so a test can tell a restored
 * conversation from a fresh one. */

import { HARD_LOGIN_HTML, hardChatHtml } from "./hard-skin";

/** The Markdown source of the reply to `text`. The first line keeps the
 * historical "Echo: " shape every existing test asserts on. `turn` is the
 * 1-based position of this turn in its conversation, which only the
 * `turns?` prompt reports: it is how an E2E tells a restored conversation
 * from a fresh one. */
export function dummyReply(text: string, turn = 1): string {
  if (text === "turns?") return `Echo: turns? (turn ${turn})`;
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
function replyChunks(text: string, turn = 1): string[] {
  const source = dummyReply(text, turn);
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

/** One stored turn of a conversation: the prompt as typed, and the reply's
 * final HTML (the last streaming chunk), so a restored page shows exactly
 * what the live page ended up showing. */
interface Turn {
  prompt: string;
  replyHtml: string;
}

/** The earlier turns of a restored conversation, in the same markup the
 * page script appends for a live turn. */
function turnsHtml(turns: Turn[]): string {
  return turns
    .map(
      (turn) =>
        `<div class="message user">${escapeHtml(turn.prompt)}</div>` +
        `<div class="message assistant">${turn.replyHtml}</div>`,
    )
    .join("");
}

/** `conversation` is set only for a restored conversation: its id and the
 * turns already in it. A new chat passes nothing. */
function chatHtml(
  replyDelayMs: number,
  chunkDelayMs: number,
  conversation?: { id: string; turns: Turn[] },
): string {
  return `<!doctype html>
<title>Dummy Chat</title>
<meta name="reply-delay" content="${replyDelayMs}">
<meta name="chunk-delay" content="${chunkDelayMs}">${
    conversation
      ? `\n<meta name="conversation" content="${conversation.id}">`
      : ""
  }
<h1>Dummy Chat</h1>
<div id="chat-log" data-state="idle">${conversation ? turnsHtml(conversation.turns) : ""}</div>
<textarea id="message-input"></textarea>
<button id="send-button" type="button">Send</button>
<script>
  const meta = (name) => Number(document.querySelector('meta[name="' + name + '"]').content);
  const delay = meta("reply-delay");
  const chunkDelay = meta("chunk-delay");
  const conversationMeta = document.querySelector('meta[name="conversation"]');
  let conversationId = conversationMeta ? conversationMeta.content : null;
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
        const res = await fetch("/reply", {
          method: "POST",
          body: text,
          headers: conversationId ? { "x-conversation": conversationId } : {},
        });
        const { chunks, conversation } = await res.json();
        if (conversation && !conversationId) {
          // The service gives the conversation its own URL once it exists.
          conversationId = conversation;
          history.replaceState(null, "", "/chat/c/" + conversation);
        }
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
  /** Conversations live only in memory, for the life of the server. */
  const conversations = new Map<string, Turn[]>();

  function newConversationId(): string {
    let id = "";
    do {
      id = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
    } while (conversations.has(id));
    return id;
  }

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
        // Only the two known chat pages: never an open redirect.
        const next =
          url.searchParams.get("next") === "/hard/chat"
            ? "/hard/chat"
            : "/chat";
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
      const conversationPath = /^\/chat\/c\/([a-z0-9]{8})$/.exec(pathname);
      if (conversationPath) {
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
        const id = conversationPath[1] ?? "";
        const turns = conversations.get(id);
        // An unknown id is not an error page: the service drops the visitor
        // into a new chat, which is what makes a stale handle recoverable.
        if (!turns) {
          return new Response(null, {
            status: 302,
            headers: { location: "/chat" },
          });
        }
        return new Response(
          chatHtml(replyDelayMs, chunkDelayMs, { id, turns }),
          { headers: { "content-type": "text/html" } },
        );
      }
      if (pathname === "/reply") {
        // Same expiry rule as /chat: an invalidated session gets nothing.
        if (!hasSession(req)) {
          return new Response("unauthorized", { status: 401 });
        }
        const sent = req.headers.get("x-conversation") ?? "";
        const id = conversations.has(sent) ? sent : newConversationId();
        const turns = conversations.get(id) ?? [];
        conversations.set(id, turns);
        // The prompt is the body: no length limit to run into.
        const prompt = await req.text();
        const chunks = replyChunks(prompt, turns.length + 1);
        turns.push({ prompt, replyHtml: chunks.at(-1) ?? "" });
        return Response.json({ chunks, conversation: id });
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
