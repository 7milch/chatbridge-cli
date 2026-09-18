import {
  helpText,
  parseSlashCommand,
  unknownCommandMessage,
} from "@chatbridge/core/slash-commands";
import type {
  Message,
  State,
  Status,
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
const queue = document.getElementById("queue") as HTMLElement;
const inlineError = document.getElementById("inline-error") as HTMLElement;

let config: UiConfig = {};
let lastState: State | undefined;

function applyConfig(c: UiConfig): void {
  config = c;
  if (c.sendButton?.background) {
    sendButton.style.setProperty("--cb-send-bg", c.sendButton.background);
  }
  if (c.sendButton?.foreground) {
    sendButton.style.setProperty("--cb-send-fg", c.sendButton.foreground);
  }
  if (c.userMessage?.borderColor) {
    // On the root element: message nodes are created after this runs.
    document.documentElement.style.setProperty(
      "--cb-user-border",
      c.userMessage.borderColor,
    );
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

function waitingText(status: Status): string {
  if (status === "reopening") return "Reopening browser...";
  if (status === "opening") return "Opening browser...";
  return "Waiting...";
}

function renderStatus(s: State): void {
  status.replaceChildren();
  status.hidden = false;
  if (
    s.status === "busy" ||
    s.status === "opening" ||
    s.status === "reopening"
  ) {
    status.appendChild(el("span", "spinner"));
    const queued = s.queue.length > 0 ? ` \u00b7 ${s.queue.length} queued` : "";
    status.appendChild(
      el("span", "progress-text", `${waitingText(s.status)}${queued}`),
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
      button("Reopen", () =>
        vscode.postMessage({ type: "command", name: "reopen" }),
      ),
    );
    status.appendChild(
      button("New chat", () =>
        vscode.postMessage({ type: "command", name: "newChat" }),
      ),
    );
    return;
  }
  status.hidden = true;
}

function renderQueue(s: State): void {
  queue.replaceChildren();
  queue.hidden = s.queue.length === 0;
  s.queue.forEach((entry, index) => {
    const li = document.createElement("li");
    const firstLine = entry.text.split("\n")[0] ?? "";
    const label =
      entry.attachments.length > 0
        ? `${firstLine} \u{1f4ce} ${entry.attachments.length}`
        : firstLine;
    li.appendChild(el("span", "queue-text", `\u25b9 ${label}`));
    const x = button("\u00d7", () =>
      vscode.postMessage({ type: "removeQueued", index }),
    );
    x.className = "chip-remove";
    li.appendChild(x);
    queue.appendChild(li);
  });
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
  renderQueue(s);
  renderAttachments(s);
  // The welcome block takes over the history's space while it is shown, so
  // it is centred in the view rather than pinned above an empty history.
  welcome.hidden =
    s.messages.length > 0 || (!config.welcome && !config.bannerUri);
  history.hidden = !welcome.hidden;
  // The composer stays usable while a turn is in flight: what is typed then
  // is queued instead of sent.
  const active =
    s.status === "busy" || s.status === "opening" || s.status === "reopening";
  input.disabled = false;
  sendButton.disabled = false;
  sendButton.textContent = active ? "Queue" : "Send";
  // Only when nothing else holds focus: a render must not steal it from a
  // selection in the history or from the status and queue buttons.
  if (
    document.activeElement === null ||
    document.activeElement === document.body
  ) {
    input.focus();
  }
  lastState = s;
}

function showInlineError(text: string | undefined): void {
  inlineError.textContent = text ?? "";
  inlineError.hidden = text === undefined;
}

function submit(): void {
  const text = input.value;
  if (text.trim() === "" && attachments.childElementCount === 0) return;
  const slash = parseSlashCommand(text);
  if (slash && "unknown" in slash) {
    showInlineError(unknownCommandMessage(slash.unknown));
    return;
  }
  showInlineError(undefined);
  if (slash) {
    input.value = "";
    if (slash.command === "help") {
      // The welcome block hides the history; the help block must be seen.
      welcome.hidden = true;
      history.hidden = false;
      history.appendChild(el("div", "message help", helpText()));
      history.scrollTop = history.scrollHeight;
      return;
    }
    const name = slash.command === "new" ? "newChat" : slash.command;
    vscode.postMessage({ type: "command", name });
    return;
  }
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
    return;
  }
  // Up on an empty composer pulls the whole queue back for editing.
  if (
    e.key === "ArrowUp" &&
    input.value === "" &&
    (lastState?.queue.length ?? 0) > 0
  ) {
    e.preventDefault();
    const entries = lastState?.queue ?? [];
    input.value = entries.map((q) => q.text).join("\n\n");
    // Setting the value fires no `input` event, so clear the error here.
    showInlineError(undefined);
    vscode.postMessage({ type: "takeBack" });
  }
});
input.addEventListener("input", () => showInlineError(undefined));

// VSCode's explorer puts one file URI per line on `text/uri-list`; the format
// also allows `#` comment lines, which are not URIs.
function urisFromDrop(dt: DataTransfer | null): string[] {
  const list = dt?.getData("text/uri-list") ?? "";
  return list
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

document.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("drop-target");
});
document.addEventListener("dragleave", () =>
  document.body.classList.remove("drop-target"),
);
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("drop-target");
  const uris = urisFromDrop(e.dataTransfer);
  if (uris.length > 0) vscode.postMessage({ type: "attachUris", uris });
});

// A paste of several lines may be an editor selection the host can turn into
// an attachment chip. Ask it, and insert the text as typed if it says no or
// does not answer in time.
const PASTE_TIMEOUT_MS = 500;
let pasteSeq = 0;
const pendingPastes = new Map<
  number,
  { text: string; timer: ReturnType<typeof setTimeout> }
>();

function insertAtCaret(text: string): void {
  input.focus();
  if (!document.execCommand("insertText", false, text)) {
    const { selectionStart, selectionEnd, value } = input;
    input.value =
      value.slice(0, selectionStart) + text + value.slice(selectionEnd);
    const pos = selectionStart + text.length;
    input.setSelectionRange(pos, pos);
  }
}

input.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text/plain") ?? "";
  if (!text.includes("\n")) return; // single line: default paste
  e.preventDefault();
  const id = ++pasteSeq;
  const timer = setTimeout(() => {
    pendingPastes.delete(id);
    insertAtCaret(text);
  }, PASTE_TIMEOUT_MS);
  pendingPastes.set(id, { text, timer });
  vscode.postMessage({ type: "pasted", id, text });
});
document.addEventListener("keydown", (e) => {
  if (
    e.key.toLowerCase() === "r" &&
    (e.ctrlKey || e.metaKey) &&
    !e.shiftKey &&
    !e.altKey
  ) {
    e.preventDefault();
    vscode.postMessage({ type: "command", name: "reopen" });
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
  } else if (m.type === "pasteResult") {
    const p = pendingPastes.get(m.id);
    if (!p) return;
    clearTimeout(p.timer);
    pendingPastes.delete(m.id);
    if (!m.attached) insertAtCaret(p.text);
  }
});

vscode.postMessage({ type: "ready" });
