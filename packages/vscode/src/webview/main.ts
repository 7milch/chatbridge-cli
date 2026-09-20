import {
  type CommandInfo,
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
import {
  hintText,
  isActive,
  noticeFor,
  sendButtonState,
} from "./view-state.js";

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
const notice = document.getElementById("notice") as HTMLElement;
const attachButton = document.getElementById("attach") as HTMLButtonElement;
const hint = document.getElementById("composer-hint") as HTMLElement;
const sendIcon = sendButton.querySelector(".icon-send") as SVGElement;
const queueIcon = sendButton.querySelector(".icon-queue") as SVGElement;

/** Grows the composer with its content (wrapped lines included, via
 * scrollHeight) and shrinks it back; CSS max-height caps it at 8 rows. The
 * history stays pinned to its end when it was there before. */
function fitComposer(): void {
  const atBottom =
    history.scrollHeight - history.scrollTop - history.clientHeight < 2;
  input.style.height = "auto";
  // The textarea has no border of its own any more (the box around it
  // draws one), so scrollHeight is the exact content height; the CSS
  // min-height keeps it at two rows and max-height caps it at eight.
  input.style.height = `${input.scrollHeight}px`;
  if (atBottom) history.scrollTop = history.scrollHeight;
}

let config: UiConfig = {};
/** The provider's command names, from the `config` message. */
let commandNames: ReadonlySet<string> = new Set();
let lastState: State | undefined;
/** The last `progress` line, so a re-render keeps it instead of falling
 * back to the generic waiting text. Cleared when the status leaves the
 * active set. */
let lastProgress: string | undefined;

function applyConfig(c: UiConfig & { commands?: CommandInfo[] }): void {
  config = c;
  commandNames = new Set((c.commands ?? []).map((x) => x.name));
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

function button(
  label: string,
  onClick: () => void,
  className = "action",
): HTMLElement {
  const b = el("button", className, label);
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
  if (m.role === "help") {
    box.textContent = m.text;
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
  // Only progress lives here now; a dead session is the notice card's job.
  if (!isActive(s.status)) {
    status.hidden = true;
    return;
  }
  status.hidden = false;
  status.appendChild(el("span", "spinner"));
  const queued = s.queue.length > 0 ? ` \u00b7 ${s.queue.length} queued` : "";
  status.appendChild(
    el(
      "span",
      "progress-text",
      `${lastProgress ?? waitingText(s.status)}${queued}`,
    ),
  );
}

function renderNotice(s: State): void {
  const info = noticeFor(s);
  notice.replaceChildren();
  notice.hidden = info === undefined;
  if (!info) return;
  notice.appendChild(el("div", "notice-text", info.text));
  const actions = el("div", "notice-actions");
  for (const b of info.buttons) {
    actions.appendChild(
      button(
        b.label,
        () => vscode.postMessage({ type: "command", name: b.command }),
        b.primary ? "action primary" : "action",
      ),
    );
  }
  notice.appendChild(actions);
}

/** `hidden` is an HTMLElement property; on an SVG element assigning it only
 * makes an expando, so the attribute the CSS matches must be set directly. */
function showIcon(icon: SVGElement, show: boolean): void {
  if (show) icon.removeAttribute("hidden");
  else icon.setAttribute("hidden", "");
}

function renderComposer(s: State): void {
  const send = sendButtonState(s, input.value.trim() === "");
  showIcon(sendIcon, send.icon === "send");
  showIcon(queueIcon, send.icon === "queue");
  sendButton.disabled = send.disabled;
  sendButton.classList.toggle("secondary", send.secondary);
  sendButton.setAttribute("aria-label", send.label);
  sendButton.title = send.title;
  hint.textContent = hintText(s.status);
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
    const x = button(
      "\u00d7",
      () => vscode.postMessage({ type: "removeQueued", index }),
      "chip-remove",
    );
    li.appendChild(x);
    queue.appendChild(li);
  });
}

function renderAttachments(s: State): void {
  attachments.replaceChildren();
  s.pendingAttachments.forEach((a, index) => {
    const chip = el("span", "chip", `📎 ${a.path} (${formatSize(a.bytes)})`);
    const x = button(
      "×",
      () => vscode.postMessage({ type: "removeAttachment", index }),
      "chip-remove",
    );
    chip.appendChild(x);
    attachments.appendChild(chip);
  });
}

function render(s: State): void {
  // A status without a spinner ends the phase the progress line belonged to,
  // so the next opening/busy/reopening starts from its own default text.
  if (!isActive(s.status)) lastProgress = undefined;
  history.replaceChildren(...s.messages.map(renderMessage));
  history.scrollTop = history.scrollHeight;
  renderStatus(s);
  renderNotice(s);
  renderQueue(s);
  renderAttachments(s);
  // The welcome block takes over the history's space while it is shown, so
  // it is centred in the view rather than pinned above an empty history.
  welcome.hidden =
    s.messages.length > 0 || (!config.welcome && !config.bannerUri);
  history.hidden = !welcome.hidden;
  // The composer stays usable while a turn is in flight: what is typed then
  // is queued instead of sent.
  input.disabled = false;
  renderComposer(s);
  // Only when the status changed, and only when nothing else holds focus:
  // a render must not steal it from a selection in the history or from the
  // status and queue buttons.
  if (!lastState || lastState.status !== s.status) {
    if (
      document.activeElement === null ||
      document.activeElement === document.body
    ) {
      input.focus();
    }
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
  const slash = parseSlashCommand(text, commandNames);
  if (slash && "unknown" in slash) {
    showInlineError(unknownCommandMessage(slash.unknown));
    return;
  }
  if (slash && "error" in slash) {
    showInlineError(slash.error);
    return;
  }
  showInlineError(undefined);
  if (slash) {
    input.value = "";
    fitComposer();
    if ("custom" in slash) {
      vscode.postMessage({
        type: "customCommand",
        name: slash.custom,
        args: slash.args,
        text: text.trim(),
      });
      return;
    }
    const name = slash.command === "new" ? "newChat" : slash.command;
    vscode.postMessage({ type: "command", name });
    return;
  }
  vscode.postMessage({ type: "send", text });
  input.value = "";
  fitComposer();
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
    // The composer is filled from the host's `tookBack` answer, not from
    // `lastState`: an entry drained in between must never be re-sent.
    e.preventDefault();
    vscode.postMessage({ type: "takeBack" });
  }
});
input.addEventListener("input", () => {
  showInlineError(undefined);
  fitComposer();
  if (lastState) renderComposer(lastState);
});

// The native picker, not a hidden <input type=file>: the host must read the
// files anyway (the webview has no filesystem access) and the size limit
// and error report are then shared with drag and drop.
attachButton.addEventListener("click", () => {
  vscode.postMessage({ type: "command", name: "pickFiles" });
});

// Observed with VSCode 1.138 (explorer item, Shift held): `text/uri-list` =
// `file:///abs/path` one per line, plus `text/plain`, `resourceurls`,
// `codefiles`, `codeeditors` and `application/vnd.code.uri-list`. The
// uri-list format also allows `#` comment lines, which are not URIs.
// Without Shift the workbench keeps the drag for itself (it sets
// `pointer-events: none` on the webview iframe and opens the file in an
// editor instead), so no event reaches this page at all.
function urisFromDrop(dt: DataTransfer | null): string[] {
  const list = dt?.getData("text/uri-list") ?? "";
  return list
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

function carriesFiles(dt: DataTransfer | null): boolean {
  return dt?.types.includes("text/uri-list") ?? false;
}
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (!carriesFiles(e.dataTransfer)) return;
  dragDepth++;
  document.body.classList.add("drop-target");
});
document.addEventListener("dragover", (e) => {
  // Only a file drag is ours; an in-view text drag keeps the default.
  if (carriesFiles(e.dataTransfer)) e.preventDefault();
});
document.addEventListener("dragleave", (e) => {
  if (!carriesFiles(e.dataTransfer)) return;
  // Fires for every child the pointer crosses; the class goes when the
  // drag leaves the document, i.e. the depth returns to zero.
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove("drop-target");
  }
});
document.addEventListener("drop", (e) => {
  if (!carriesFiles(e.dataTransfer)) return;
  e.preventDefault();
  dragDepth = 0;
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
    // Setting `value` fires no `input` event; the listener clears the
    // inline error and resizes the composer.
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  fitComposer();
}

input.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text/plain") ?? "";
  if (!text.includes("\n")) return; // single line: default paste
  e.preventDefault();
  const id = ++pasteSeq;
  const timer = setTimeout(() => {
    pendingPastes.delete(id);
    if (!input.disabled) insertAtCaret(text);
  }, PASTE_TIMEOUT_MS);
  pendingPastes.set(id, { text, timer });
  vscode.postMessage({ type: "pasted", id, text });
});
// Document-wide so it works with focus anywhere in the view; VSCode's own
// reload is a different chord (Ctrl+Shift+R / Cmd+R with focus outside the
// webview), so preventDefault only stops the browser's page reload inside
// the iframe.
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
  if (!m || typeof m !== "object" || typeof m.type !== "string") return;
  if (m.type === "state") {
    const { type: _type, ...state } = m;
    render(state);
  } else if (m.type === "config") {
    const { type: _type, ...rest } = m;
    applyConfig(rest);
  } else if (m.type === "progress") {
    // The idle close reports "Closing the browser after ... idle..." *after*
    // its `closed` frame, so a line that arrives outside a spinner phase must
    // not be cached: it would surface under the next `opening`.
    lastProgress =
      lastState && !isActive(lastState.status) ? undefined : m.text;
    const t = status.querySelector(".progress-text");
    if (t) t.textContent = m.text;
  } else if (m.type === "pasteResult") {
    const p = pendingPastes.get(m.id);
    if (!p) return;
    clearTimeout(p.timer);
    pendingPastes.delete(m.id);
    if (!m.attached) insertAtCaret(p.text);
  } else if (m.type === "tookBack") {
    input.value = m.entries.map((q) => q.text).join("\n\n");
    // Setting the value fires no `input` event, so clear the error here.
    showInlineError(undefined);
    fitComposer();
    if (lastState) renderComposer(lastState);
    input.focus();
  }
});

fitComposer();
vscode.postMessage({ type: "ready" });
