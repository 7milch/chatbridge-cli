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
