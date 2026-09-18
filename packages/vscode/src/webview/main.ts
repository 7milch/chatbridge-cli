import type {
  Message,
  State,
  ToHost,
  ToWebview,
  UiConfig,
} from "../protocol.js";

declare function acquireVsCodeApi(): { postMessage(m: ToHost): void };
const vscode = acquireVsCodeApi();

const history = document.getElementById("history") as HTMLElement;
const status = document.getElementById("status") as HTMLElement;
const attachments = document.getElementById("attachments") as HTMLElement;
const form = document.getElementById("composer") as HTMLFormElement;
const input = document.getElementById("input") as HTMLTextAreaElement;
const sendButton = document.getElementById("send") as HTMLButtonElement;
const welcome = document.getElementById("welcome") as HTMLElement;
const welcomeText = document.getElementById("welcome-text") as HTMLElement;
const banner = document.getElementById("banner") as HTMLImageElement;
const footer = document.getElementById("footer") as HTMLElement;

let config: UiConfig = {};

function applyConfig(c: UiConfig): void {
  config = c;
  if (c.sendButton?.background) {
    sendButton.style.setProperty("--cb-send-bg", c.sendButton.background);
  }
  if (c.sendButton?.foreground) {
    sendButton.style.setProperty("--cb-send-fg", c.sendButton.foreground);
  }
  welcomeText.textContent = c.welcome ?? "";
  if (c.bannerUri) {
    banner.src = c.bannerUri;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
  footer.textContent = c.footer ?? "";
  footer.hidden = !c.footer;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, onClick: () => void): HTMLElement {
  const b = el("button", "action", label);
  b.setAttribute("type", "button");
  b.addEventListener("click", onClick);
  return b;
}

// Duplicated from @chatbridge/core on purpose: this bundle runs in the
// browser and core's entry point pulls in Playwright.
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderMessage(m: Message): HTMLElement {
  const box = el("div", `message ${m.role}`);
  if (m.role === "separator") {
    box.textContent = `— ${m.text} —`;
    return box;
  }
  box.appendChild(el("div", "text", m.text));
  for (const a of m.attachments ?? []) {
    box.appendChild(
      el("div", "attachment", `📎 ${a.path} (${formatSize(a.bytes)})`),
    );
  }
  return box;
}

function renderStatus(s: State): void {
  status.replaceChildren();
  status.hidden = false;
  if (s.status === "busy" || s.status === "opening") {
    status.appendChild(el("span", "spinner"));
    status.appendChild(
      el(
        "span",
        "progress-text",
        s.status === "opening" ? "Opening browser..." : "Waiting...",
      ),
    );
    return;
  }
  if (s.status === "dead") {
    const auth =
      s.lastError === "AUTH_REQUIRED" || s.lastError === "AUTH_EXPIRED";
    status.appendChild(
      el(
        "span",
        "progress-text",
        auth ? "Not logged in." : "The chat stopped.",
      ),
    );
    if (auth) {
      status.appendChild(
        button("Log in", () =>
          vscode.postMessage({ type: "command", name: "login" }),
        ),
      );
    }
    status.appendChild(
      button("New chat", () =>
        vscode.postMessage({ type: "command", name: "newChat" }),
      ),
    );
    return;
  }
  status.hidden = true;
}

function renderAttachments(s: State): void {
  attachments.replaceChildren();
  s.pendingAttachments.forEach((a, index) => {
    const chip = el("span", "chip", `📎 ${a.path} (${formatSize(a.bytes)})`);
    const x = button("×", () =>
      vscode.postMessage({ type: "removeAttachment", index }),
    );
    x.className = "chip-remove";
    chip.appendChild(x);
    attachments.appendChild(chip);
  });
}

function render(s: State): void {
  history.replaceChildren(...s.messages.map(renderMessage));
  history.scrollTop = history.scrollHeight;
  renderStatus(s);
  renderAttachments(s);
  // The welcome block takes over the history's space while it is shown, so
  // it is centred in the view rather than pinned above an empty history.
  welcome.hidden =
    s.messages.length > 0 || (!config.welcome && !config.bannerUri);
  history.hidden = !welcome.hidden;
  const locked = s.status === "busy" || s.status === "opening";
  input.disabled = locked;
  sendButton.disabled = locked;
  if (!locked) input.focus();
}

function submit(): void {
  const text = input.value;
  if (text.trim() === "" && attachments.childElementCount === 0) return;
  vscode.postMessage({ type: "send", text });
  input.value = "";
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  submit();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const m = event.data;
  if (m.type === "state") {
    const { type: _type, ...state } = m;
    render(state);
  } else if (m.type === "config") {
    const { type: _type, ...rest } = m;
    applyConfig(rest);
  } else if (m.type === "progress") {
    const t = status.querySelector(".progress-text");
    if (t) t.textContent = m.text;
  }
});

vscode.postMessage({ type: "ready" });
