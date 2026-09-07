/** Minimal dummy web chat used for E2E verification of the framework.
 * Not a real service: fixed echo responses, cookie-based fake login.
 * Test hooks: invalidateSessions() (simulates an expired login),
 * setReplyDelayMs() (simulates a slow response), and a message starting
 * with "slow:" (that one reply takes 5 s regardless of the delay). */

const LOGIN_HTML = `<!doctype html>
<title>Dummy Chat — Login</title>
<h1>Dummy Chat</h1>
<form method="post" action="/do-login">
  <button id="login-button" type="submit">Log in</button>
</form>`;

function chatHtml(replyDelayMs: number): string {
  return `<!doctype html>
<title>Dummy Chat</title>
<meta name="reply-delay" content="${replyDelayMs}">
<h1>Dummy Chat</h1>
<div id="chat-log" data-state="idle"></div>
<textarea id="message-input"></textarea>
<button id="send-button" type="button">Send</button>
<script>
  const delay = Number(document.querySelector('meta[name="reply-delay"]').content);
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
    setTimeout(() => {
      const reply = document.createElement("div");
      reply.className = "message assistant";
      reply.textContent = "Echo: " + text;
      log.appendChild(reply);
      log.dataset.state = "idle";
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
}

export async function startDummyChat(port = 8735): Promise<DummyChat> {
  let sessionsValid = true;
  let replyDelayMs = 300;

  function hasSession(req: Request): boolean {
    return (
      sessionsValid && (req.headers.get("cookie") ?? "").includes("session=ok")
    );
  }

  const server = Bun.serve({
    port,
    fetch(req) {
      const { pathname } = new URL(req.url);
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
        if (!hasSession(req)) {
          return new Response(null, {
            status: 302,
            headers: { location: "/login" },
          });
        }
        return new Response(chatHtml(replyDelayMs), {
          headers: { "content-type": "text/html" },
        });
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
  };
}
