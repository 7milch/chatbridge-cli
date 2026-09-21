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
  CommandMenuModel,
  TYPING_MENU_OWNER_ATTRS,
  buildSections,
  buttonMenuAction,
  replaceCommandWord,
  typingMenuAction,
  typingMenuPrefix,
} from "./command-menu.js";
import { type TreeNode, safeHref, toTree } from "./markdown-tree.js";
import {
  type StreamState,
  commonPrefix,
  messageKey,
  nextRenderDelay,
  onPartial,
  onState,
} from "./stream-state.js";
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
const commandsButton = document.getElementById("commands") as HTMLButtonElement;
const commandMenu = document.getElementById("command-menu") as HTMLElement;
const hint = document.getElementById("composer-hint") as HTMLElement;
const sendIcon = sendButton.querySelector(".icon-send") as SVGElement;
const queueIcon = sendButton.querySelector(".icon-queue") as SVGElement;

/** Grows the composer with its content (wrapped lines included, via
 * scrollHeight) and shrinks it back; CSS max-height caps it at 8 rows. The
 * history stays pinned to its end when it was there before. */
function fitComposer(): void {
  const atBottom = isAtBottom();
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
/** The same commands, in order, for the `/` menu. */
let providerCommands: readonly CommandInfo[] = [];
let lastState: State | undefined;
/** The last `progress` line, so a re-render keeps it instead of falling
 * back to the generic waiting text. Cleared when the status leaves the
 * active set. */
let lastProgress: string | undefined;

function applyConfig(c: UiConfig & { commands?: CommandInfo[] }): void {
  config = c;
  commandNames = new Set((c.commands ?? []).map((x) => x.name));
  providerCommands = c.commands ?? [];
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

// --- Markdown replies -------------------------------------------------
// `toTree` decides everything; this layer only creates elements, sets text
// and sets the handful of attributes listed below. No markup string is ever
// parsed here, so nothing a reply carries can become a node of its own.

/** Every tag `toTree` can emit. Anything else becomes a `span`. */
const RENDERABLE_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "span",
  "ul",
  "ol",
  "li",
  "blockquote",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "hr",
  "br",
  "strong",
  "em",
  "del",
  "code",
  "a",
  "input",
]);

/** How long the code block's button says `Copied` after a click. */
const COPIED_LABEL_MS = 1500;

/** The `start-N` class `toTree` puts on an ordered list that does not
 * start at 1; it becomes the `start` attribute and the class is dropped. */
function listStart(className: string | undefined): string | undefined {
  const match = /^start-(-?\d+)$/.exec(className ?? "");
  return match?.[1];
}

function copyButton(text: string): HTMLElement {
  const b = button(
    "Copy",
    () => {
      // The host owns the clipboard and reports success or failure itself;
      // the label flip is only the local acknowledgement of the click.
      vscode.postMessage({ type: "copyText", text });
      b.textContent = "Copied";
      setTimeout(() => {
        b.textContent = "Copy";
      }, COPIED_LABEL_MS);
    },
    "action code-copy",
  );
  b.title = "Copy this code block";
  return b;
}

function codeBlock(node: TreeNode): HTMLElement {
  const code = node.text ?? "";
  const wrapper = el("div", "code-block");
  const header = el("div", "code-header");
  header.appendChild(el("span", "code-lang", node.lang ?? ""));
  header.appendChild(copyButton(code));
  wrapper.appendChild(header);
  const pre = document.createElement("pre");
  const body = document.createElement("code");
  body.textContent = code;
  pre.appendChild(body);
  wrapper.appendChild(pre);
  return wrapper;
}

function renderNode(node: TreeNode): Node {
  if (node.tag === "#text") return document.createTextNode(node.text ?? "");
  if (node.tag === "pre") return codeBlock(node);
  const known = RENDERABLE_TAGS.has(node.tag);
  const e = document.createElement(known ? node.tag : "span");
  if (!known) {
    // Not a tag `toTree` produces. Its text still reaches the reader; the
    // element it asked for does not get created.
    if (node.text !== undefined)
      e.appendChild(document.createTextNode(node.text));
    e.appendChild(renderTree(node.children ?? []));
    return e;
  }
  if (node.className) e.className = node.className;
  if (node.tag === "a") {
    // Checked again here, where the attribute is set: this sink must stay
    // safe whatever produced the node. A link left without a target still
    // shows its words.
    const href = node.href === undefined ? undefined : safeHref(node.href);
    if (href !== undefined) e.setAttribute("href", href);
    e.setAttribute("rel", "noopener noreferrer");
  } else if (node.tag === "input") {
    const box = e as HTMLInputElement;
    box.type = "checkbox";
    box.disabled = true;
    box.checked = node.checked === true;
  } else if (node.tag === "ol") {
    const start = listStart(node.className);
    if (start !== undefined) {
      e.setAttribute("start", start);
      e.removeAttribute("class");
    }
  }
  if (node.children) e.appendChild(renderTree(node.children));
  return e;
}

function renderTree(nodes: readonly TreeNode[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const node of nodes) fragment.appendChild(renderNode(node));
  return fragment;
}

/** The message body: a Markdown reply is a node tree, everything else is
 * the text as it came. */
function renderText(text: string, markdown: boolean): HTMLElement {
  if (!markdown) return el("div", "text", text);
  const box = el("div", "text markdown");
  box.appendChild(renderTree(toTree(text)));
  return box;
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
  if (m.incomplete) box.classList.add("incomplete");
  box.appendChild(
    renderText(m.text, m.role === "assistant" && m.format === "markdown"),
  );
  for (const a of m.attachments ?? []) {
    box.appendChild(
      el("div", "attachment", `📎 ${a.path} (${formatSize(a.bytes)})`),
    );
  }
  if (m.incomplete) {
    box.appendChild(el("div", "incomplete-note", "(incomplete)"));
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

/** What `renderNotice` last painted, serialized. The card carries
 * `role="alert"`, so rebuilding an unchanged one would re-announce it and
 * destroy the focus on a recovery button the user is tabbing through. */
let lastNoticeKey: string | undefined;

function renderNotice(s: State): void {
  const info = noticeFor(s);
  const key = info === undefined ? undefined : JSON.stringify(info);
  if (key === lastNoticeKey) return;
  lastNoticeKey = key;
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

// --- the history and the streaming node -------------------------------

/** The keys of the messages currently rendered into `#history`, in order.
 * The history is append-mostly, so a state frame only has to remove what
 * changed and append what is new — rebuilding it would drop the reader's
 * selection and scroll position on every frame. */
let renderedKeys: string[] = [];
/** The reply being streamed, or `undefined` between turns. */
let stream: StreamState | undefined;
/** The node showing `stream`; always the last child of `#history`. */
let streamNode: HTMLElement | undefined;

function isAtBottom(): boolean {
  return history.scrollHeight - history.scrollTop - history.clientHeight < 2;
}

/** Creates the streaming node on first use, keeps it last in the history and
 * removes it once the turn is over. Drawing is `drawStreamNode`'s job, so a
 * state frame that leaves the stream alone costs nothing. */
function placeStreamNode(): void {
  if (stream === undefined) {
    streamNode?.remove();
    streamNode = undefined;
    return;
  }
  if (!streamNode) {
    streamNode = el("div", "message assistant streaming");
    // `#history` is a polite live region and this node's content is replaced
    // wholesale several times a second; without this a screen reader would
    // re-announce the whole growing reply on every redraw. The settled
    // message, appended to the history below, is the one announcement.
    streamNode.setAttribute("aria-live", "off");
  }
  // Always last: the settled reply arrives as a history message below it.
  // Moving a node that is already there would be a remove plus an insert.
  if (history.lastElementChild !== streamNode) history.appendChild(streamNode);
}

/** Paints `stream` into the node `placeStreamNode` put in the history. */
function drawStreamNode(): void {
  if (stream === undefined || !streamNode) return;
  streamNode.replaceChildren(
    renderText(stream.text, stream.format === "markdown"),
  );
}

/** Set while a render is pending, so a burst of partials coalesces into one.
 * `renderNotBefore` is the timestamp the next one may start at. */
let streamRenderPending = false;
let renderNotBefore = 0;

function scheduleStreamRender(): void {
  if (streamRenderPending) return;
  streamRenderPending = true;
  const run = (): void => {
    if (stream === undefined) {
      // The turn ended before the frame. Stop here rather than re-queueing
      // for the rest of the budget.
      streamRenderPending = false;
      return;
    }
    if (performance.now() < renderNotBefore) {
      // Still inside the budget the last render earned; try again next frame.
      requestAnimationFrame(run);
      return;
    }
    streamRenderPending = false;
    const atBottom = isAtBottom();
    const started = performance.now();
    placeStreamNode();
    drawStreamNode();
    const done = performance.now();
    renderNotBefore = done + nextRenderDelay(done - started);
    if (atBottom) history.scrollTop = history.scrollHeight;
  };
  requestAnimationFrame(run);
}

function render(s: State): void {
  // A status without a spinner ends the phase the progress line belonged to,
  // so the next opening/busy/reopening starts from its own default text.
  if (!isActive(s.status)) lastProgress = undefined;
  const atBottom = isAtBottom();
  // The streaming node sits after the history messages, so it comes out
  // before the diff counts children and goes back in with `syncStreamNode`.
  streamNode?.remove();
  const next = s.messages.map(messageKey);
  const keep = commonPrefix(renderedKeys, next);
  while (history.childElementCount > keep) {
    history.removeChild(
      history.children[history.childElementCount - 1] as Node,
    );
  }
  const added = s.messages.slice(keep);
  for (const m of added) history.appendChild(renderMessage(m));
  renderedKeys = next;
  stream = onState(stream, s.status, s.messages.length);
  // Only place it: a stream that survived is already drawn, and re-lexing it
  // here would run outside the render budget.
  placeStreamNode();
  renderStatus(s);
  renderNotice(s);
  renderQueue(s);
  renderAttachments(s);
  // The welcome block takes over the history's space while it is shown, so
  // it is centred in the view rather than pinned above an empty history.
  welcome.hidden =
    s.messages.length > 0 || (!config.welcome && !config.bannerUri);
  history.hidden = !welcome.hidden;
  // Follow the end only when the reader was already there, or when the turn
  // they just started put their own message at the bottom. Scrolling after
  // the unhide above: a hidden element has no scroll height to reach.
  if (atBottom || added.some((m) => m.role === "user")) {
    history.scrollTop = history.scrollHeight;
  }
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

/** Empties the composer after a send. Setting `.value` fires no `input`
 * event, so the resize and the send button's state are refreshed here —
 * otherwise the button stays enabled over an empty box. */
function clearInput(): void {
  input.value = "";
  fitComposer();
  if (lastState) renderComposer(lastState);
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
    clearInput();
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
  clearInput();
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
  refreshTypingMenu();
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
  } else if (m.type === "partial") {
    // The host always posts the turn's `state` frame first, so the history
    // length here is the one the partial belongs to.
    stream = onPartial(
      stream,
      m.text,
      m.format,
      lastState?.messages.length ?? 0,
    );
    scheduleStreamRender();
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

// --- `/` command menu -------------------------------------------------
// The model is shared with the typed-`/` completion (#86); everything
// below is only the DOM around it.
let menu: CommandMenuModel | undefined;
/** The focused element an open menu belongs to. It carries `aria-expanded`
 * and `aria-activedescendant`, and its keys — and the popup's — are the only
 * ones the menu may take. Today only the `/` button opens the menu; #86
 * opens the same one from `#input`, which then owns both, so the owner is a
 * variable rather than hard-wired into each of these functions. */
let menuOwner: HTMLElement = commandsButton;
/** The composer text an Escape dismissed the typing menu over. Without it the
 * next caret event would reopen the menu over the same text and Escape would
 * be useless; any edit clears it. */
let dismissedText: string | undefined;

/** The owner's state while the menu is open. On the textarea the combobox
 * attributes (TYPING_MENU_OWNER_ATTRS) are added and removed with the menu —
 * `#commands` carries its own in the HTML, so there only `aria-expanded`
 * flips. */
function setOwnerExpanded(open: boolean): void {
  if (menuOwner === input) {
    for (const [name, value] of TYPING_MENU_OWNER_ATTRS) {
      if (open) input.setAttribute(name, value);
      else input.removeAttribute(name);
    }
  } else {
    menuOwner.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (!open) menuOwner.removeAttribute("aria-activedescendant");
}

function paintSelection(): void {
  const selectedId =
    menu && menu.selectedIndex >= 0
      ? `command-option-${menu.selectedIndex}`
      : "";
  // Array.from, not for...of: the webview tsconfig's lib has no DOM.Iterable,
  // so a NodeList is not iterable there.
  for (const node of Array.from(commandMenu.querySelectorAll(".menu-item"))) {
    const on = node.id === selectedId;
    node.classList.toggle("selected", on);
    node.setAttribute("aria-selected", String(on));
  }
  if (selectedId) {
    menuOwner.setAttribute("aria-activedescendant", selectedId);
    document.getElementById(selectedId)?.scrollIntoView({ block: "nearest" });
  } else {
    menuOwner.removeAttribute("aria-activedescendant");
  }
}

/** `focusTarget` is only ever given when the user's own gesture asks for the
 * move — choosing an entry, or Escape. A menu dismissed by a click or a Tab
 * elsewhere must not pull focus back. */
function closeMenu(focusTarget?: HTMLElement): void {
  if (!menu) return;
  menu = undefined;
  commandMenu.hidden = true;
  commandMenu.replaceChildren();
  setOwnerExpanded(false);
  focusTarget?.focus();
}

function chooseCommand(index: number): void {
  const picked = menu?.items[index];
  if (!picked) return;
  // `replaceCommandWord` falls back to `insertCommand` when nothing under the
  // cursor is a command word, which is the button's case; a half-typed `/lo`
  // is replaced rather than left in front of the chosen command.
  const { text, cursor } = replaceCommandWord(
    input.value,
    input.selectionStart ?? 0,
    picked.name,
  );
  closeMenu();
  input.value = text;
  input.focus();
  input.setSelectionRange(cursor, cursor);
  // Setting `value` fires no `input` event; that listener is what clears
  // the inline error, resizes the box and re-enables the send button.
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Builds and shows the menu. With a `prefix` the list is filtered to the
 * command word being typed and the textarea stays focused and owns the menu;
 * without one it is the button's full menu. */
function openMenu(prefix?: string): void {
  // The display name is only in the document title (buildHtml puts it
  // there); the protocol carries no provider name.
  const sections = buildSections(document.title, providerCommands, prefix);
  // Only the typing menu can come up empty: nothing matches what was typed,
  // so there is nothing to offer and any menu already up is dismissed.
  if (sections.length === 0) {
    closeMenu();
    return;
  }
  menu = new CommandMenuModel(sections);
  const owner = prefix === undefined ? commandsButton : input;
  if (owner !== menuOwner) {
    // Hand the ARIA state over rather than leaving it stale on the old owner.
    setOwnerExpanded(false);
    menuOwner = owner;
  }
  commandMenu.replaceChildren();
  let index = 0;
  for (const section of menu.sections) {
    const group = el("div", "menu-group");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", section.title);
    const header = el("div", "menu-header", section.title);
    header.setAttribute("aria-hidden", "true");
    group.appendChild(header);
    for (const item of section.items) {
      const i = index++;
      const node = el("div", "menu-item");
      node.id = `command-option-${i}`;
      node.setAttribute("role", "option");
      node.appendChild(el("span", "menu-name", `/${item.name}`));
      node.appendChild(el("span", "menu-desc", item.description));
      // `mousedown`, not `click`: the button's own blur must not close the
      // menu before the choice lands.
      node.addEventListener("mousedown", (e) => {
        e.preventDefault();
        chooseCommand(i);
      });
      group.appendChild(node);
    }
    commandMenu.appendChild(group);
  }
  commandMenu.hidden = false;
  setOwnerExpanded(true);
  paintSelection();
  // Focus stays on the owner: on the button that is what makes
  // `aria-activedescendant` announce the active option while the composer's
  // own Enter, arrows and IME are left untouched, and in typing mode it means
  // the caret never leaves the textarea at all.
  if (menuOwner === commandsButton) menuOwner.focus();
}

commandsButton.addEventListener("click", () => {
  // A typing menu is already gone by now: the click's `mousedown` is outside
  // its owner and the popup, so the listener below closed it. Pressing the
  // button therefore swaps a filtered menu for the full one, which is what it
  // says it does.
  if (menu) closeMenu(input);
  else openMenu();
});

/** Opens, updates or closes the menu for the `/` word being typed. */
function refreshTypingMenu(): void {
  if (input.value !== dismissedText) dismissedText = undefined;
  const prefix = typingMenuPrefix(
    input.value,
    input.selectionStart ?? 0,
    dismissedText,
  );
  if (prefix === undefined) {
    // A menu the button opened is the button's business; only the typing one
    // follows the caret. Closing must not move the focus or the caret.
    if (menuOwner === input) closeMenu();
    return;
  }
  openMenu(prefix);
}

// A click or an arrow key inside the word changes what is being completed,
// and neither fires `input`; `selectionchange` covers both.
document.addEventListener("selectionchange", () => {
  if (document.activeElement === input) refreshTypingMenu();
});

/** Menu keys are only the ones pressed on the owner or inside the popup.
 * The listener is document-wide, so without this an Enter on the focused
 * send button would be swallowed and insert a command. */
function isMenuKeyEvent(target: EventTarget | null): boolean {
  const node = target as Node | null;
  return (
    node !== null && (menuOwner.contains(node) || commandMenu.contains(node))
  );
}

// Registered on the document in the capture phase so the arrows and Enter
// reach the menu before anything else claims them. `buttonMenuAction` decides
// what is the menu's; everything else falls through untouched.
document.addEventListener(
  "keydown",
  (e) => {
    if (!menu || !isMenuKeyEvent(e.target)) return;
    if (menuOwner === input) {
      const action = typingMenuAction(
        e,
        input.value,
        input.selectionStart ?? 0,
        menu.selected,
      );
      if (action === "pass") return;
      if (action === "submit") {
        // Nothing left to complete: the key falls through untouched to the
        // composer's own handler, whose Enter branch sends.
        closeMenu();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (action === "up" || action === "down") {
        menu.move(action === "down" ? 1 : -1);
        paintSelection();
      } else if (action === "accept") {
        chooseCommand(menu.selectedIndex);
      } else {
        // Escape. Focus and caret stay where they are, and the text is
        // remembered so the next caret event does not reopen the menu over it.
        dismissedText = input.value;
        closeMenu();
      }
      return;
    }
    const action = buttonMenuAction(e);
    if (action === "pass") return;
    e.preventDefault();
    e.stopPropagation();
    if (action === "up" || action === "down") {
      menu.move(action === "down" ? 1 : -1);
      paintSelection();
    } else if (action === "choose") {
      chooseCommand(menu.selectedIndex);
    } else {
      closeMenu(input);
    }
  },
  true,
);

// Tab (or any other focus move) out of the owner and the popup leaves the
// menu behind, still claiming `aria-expanded="true"`. Close it, and let the
// focus go where it was headed.
document.addEventListener("focusout", (e) => {
  if (!menu) return;
  const next = e.relatedTarget as Node | null;
  if (next !== null && isMenuKeyEvent(next)) return;
  closeMenu();
});

document.addEventListener("mousedown", (e) => {
  if (!menu) return;
  if (isMenuKeyEvent(e.target)) return;
  // A click elsewhere in the view dismisses it without stealing focus.
  // `focusout` would catch most of these, but not a click on a part of the
  // view that takes no focus at all.
  closeMenu();
});

fitComposer();
vscode.postMessage({ type: "ready" });
