/** Minimal dummy web chat used for E2E verification of the framework.
 * Not a real service: fixed echo responses, cookie-based fake login. */

const LOGIN_HTML = `<!doctype html>
<title>Dummy Chat — Login</title>
<h1>Dummy Chat</h1>
<form method="post" action="/do-login">
  <button id="login-button" type="submit">Log in</button>
</form>`;

const CHAT_HTML = `<!doctype html>
<title>Dummy Chat</title>
<h1>Dummy Chat</h1>
<div id="chat-log" data-state="idle"></div>
<textarea id="message-input"></textarea>
<button id="send-button" type="button">Send</button>
<script>
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
    setTimeout(() => {
      const reply = document.createElement("div");
      reply.className = "message assistant";
      reply.textContent = "Echo: " + text;
      log.appendChild(reply);
      log.dataset.state = "idle";
    }, 300);
  });
</script>`;

function hasSession(req: Request): boolean {
  return (req.headers.get("cookie") ?? "").includes("session=ok");
}

export async function startDummyChat(
  port = 8735,
): Promise<{ url: string; stop(): void }> {
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
        return new Response(CHAT_HTML, {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}
