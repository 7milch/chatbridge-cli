import {
  type CommandInfo,
  commandWordAt,
  matchCommands,
  slashPrefixAt,
} from "@chatbridge/core/slash-commands";
import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  MarkdownRenderable,
  type Renderable,
  ScrollBoxRenderable,
  type StyledText,
  TextRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { formatSize } from "../mentions/expand-mentions.js";
import type { FileIndex } from "../mentions/file-index.js";
import { mentionAtCursor } from "../mentions/parse-mentions.js";
import { truncatedNote } from "../shell/format-result.js";
import type { ChatModel, Message, Role } from "./chat-model.js";
import { MAX_ROWS, MentionPopup, type PopupRow } from "./mention-popup.js";
import type { ResolvedSpinner } from "./spinner.js";
import {
  MUTED_COLOR,
  type Styler,
  colored,
  markdownSyntaxStyle,
  styled,
  theme,
} from "./theme.js";

// Status-row texts must fit 80 columns: the row is one fixed line and
// clips. Shift+Enter and Ctrl+J are left out for room (README documents
// them): with `/ commands` added the newline hint no longer fits.
export const GUIDE =
  "Enter send · @ file · ! shell · / commands · Ctrl+R reopen · Ctrl+C quit";
export const SHELL_GUIDE =
  "Enter run · Esc exit shell · Ctrl+R reopen · Ctrl+C quit";
/** The idle guide while shell results are held; shorter to leave room for
 * the `📎 N held · ` prefix. */
export const HELD_GUIDE =
  "Enter send · @ file · ! shell · Ctrl+R reopen · Ctrl+C quit";
/** Shown instead of GUIDE once a fatal error left the session unusable. */
export const DEAD_GUIDE = "Ctrl+R reopen · /login · Ctrl+C quit";
/** Idle or dead guide while queued entries are waiting. */
export const QUEUE_GUIDE = "Up take back · Ctrl+R reopen · Ctrl+C quit";

/** Shown after the idle close took the browser; there is nothing to do
 * about it, so the guide is the explanation. */
export const IDLE_CLOSED_GUIDE =
  "Browser closed after being idle · your next prompt reopens it";
/** The muted line under a reply that stopped before the service said it was
 * done: the text above it is whatever had arrived. */
export const INCOMPLETE_NOTE = "(incomplete)";
/** The key guide appended to the busy status line. The frame and the label
 * moved to the pending row, which leaves room for it. */
export const BUSY_GUIDE = "Ctrl+R reopen · Ctrl+C quit";
/** How long a `model.notice` (a `/copy` outcome) stays on the status line
 * before the state's own line comes back. */
export const NOTICE_MS = 2_000;
/** Rows the queue list may take; a longer queue ends with a "+N more" row. */
export const MAX_QUEUE_ROWS = 5;
export const RESETTING_STATUS = "Reopening browser...";
/** Shown while the first session is being opened, before the chat is
 * usable; the UI is already up and anything typed is queued. */
export const OPENING_STATUS = "Opening browser...";
/** Shown while `/login` holds a browser window open. */
export const LOGIN_STATUS = "Log in in the browser window… (Ctrl+C cancel)";
const RUNNING_LABEL = "Running…";
export const SHELL_PLACEHOLDER = "Run a shell command";
const PLACEHOLDER = "Type a message";
const HELD_FOOTER = "📎 held, sent with your next message";
/** Footer of a shell entry whose shell could not be spawned. */
const FAILED_FOOTER = "did not start";
// `help` is the app talking, not the service: its entry is the text alone.
const LABELS: Record<Exclude<Role, "separator" | "help">, () => StyledText> = {
  user: () => styled(theme.user("user")),
  assistant: () => styled(theme.assistant("assistant")),
  error: () => styled(theme.error("error")),
  shell: () => styled(theme.shell("shell")),
};
/** The input starts one row tall and grows with its content up to this. */
export const MAX_INPUT_ROWS = 5;

/** The idle status text for the given shell-mode flag, held count and queue
 * length. Shell mode keeps its own guide even with entries waiting: `Up`
 * take-back is off there, and `Esc` leaves the mode and brings it back. */
export function idleGuide(
  shellMode: boolean,
  held: number,
  queued: number,
  idleClosed = false,
): string {
  const base = shellMode
    ? SHELL_GUIDE
    : queued > 0
      ? QUEUE_GUIDE
      : idleClosed
        ? IDLE_CLOSED_GUIDE
        : held > 0
          ? HELD_GUIDE
          : GUIDE;
  return held === 0 ? base : `📎 ${held} held · ${base}`;
}

/** The muted line under a shell entry's output; empty when nothing
 * applies. */
function shellFooter(message: Message): string {
  const r = message.result;
  if (!r) return "";
  const parts: string[] = [];
  if (r.droppedBytes > 0) parts.push(truncatedNote(r.droppedBytes));
  if (r.exitCode !== undefined && r.exitCode !== 0) {
    parts.push(`exit code: ${r.exitCode}`);
  }
  if (r.signal !== undefined) parts.push(`killed by ${r.signal}`);
  if (r.interrupted) parts.push("interrupted");
  if (message.failed) parts.push(FAILED_FOOTER);
  if (message.held) parts.push(HELD_FOOTER);
  return parts.join(" · ");
}

/** `/name  description` rows for the popup, aligned the way `/help` is. */
function commandRows(commands: readonly CommandInfo[]): PopupRow[] {
  if (commands.length === 0) return [];
  const width = Math.max(...commands.map((c) => c.name.length)) + 1;
  return commands.map((c) => ({
    value: c.name,
    label: `/${c.name.padEnd(width)} ${c.description}`,
  }));
}

export interface ChatViewOptions {
  title: string;
  providerName: string;
  /** Response timeout budget shown next to the elapsed time. */
  timeoutMs: number;
  /** Shown in the header as "headless" or "headful". */
  headless: boolean;
  /** Startup banner lines, shown centred until the first message. */
  banner: StyledText[];
  /** Busy-status spinner; see resolveSpinner(). */
  spinner: ResolvedSpinner;
  /** Candidates for `@` mentions. */
  index: FileIndex;
  /** The provider's commands; the `/` popup lists them after the built-ins. */
  commands?: readonly CommandInfo[];
  /** How long a `model.notice` stays on the status line. Tests shorten it. */
  noticeMs?: number;
}

/** KeyHandler's `on` is typed through a generic EventEmitter that does not
 * type-check under our config; this is the shape we rely on at runtime. */
interface KeypressSource {
  on(event: "keypress", handler: (key: KeyEvent) => void): unknown;
  off(event: "keypress", handler: (key: KeyEvent) => void): unknown;
}

/** The renderables of one shell entry that change after it is drawn. */
interface ShellEntry {
  message: Message;
  output: TextRenderable;
  footer: TextRenderable;
  drawnOutput: string;
  drawnFooter: string;
}

/** The renderables of the turn in flight, drawn as the last row of the
 * history. `body` appears with the first partial; until then the whole row
 * is the indicator written into `label`. */
interface PendingRow {
  box: BoxRenderable;
  label: TextRenderable;
  /** Plain text, or a MarkdownRenderable for a `markdown` session. */
  body: Renderable | undefined;
  tail: TextRenderable;
}

/** Builds the OpenTUI tree for one ChatModel and mirrors its state.
 * Layout, top to bottom: badge header / banner-or-history / queue list
 * (hidden while the queue is empty) / hairline input (1–5 rows) / inline
 * completion popup (hidden unless the cursor is in an `@` mention or a
 * leading `/` command word) / status line. */
export class ChatView {
  private readonly body: BoxRenderable;
  private readonly banner: BoxRenderable;
  private bannerShown = true;
  private readonly history: ScrollBoxRenderable;
  private readonly prompt: TextRenderable;
  private readonly input: TextareaRenderable;
  private readonly status: TextRenderable;
  private readonly queueList: BoxRenderable;
  private readonly queueRows: TextRenderable[] = [];
  private readonly popup: MentionPopup;
  private readonly index: FileIndex;
  private readonly commands: readonly CommandInfo[];
  private readonly onKeypress: (key: KeyEvent) => void;
  private rendered = 0;
  /** Shell entries already drawn; their output and footer are refreshed
   * from the model on every update (live output, held → sent). */
  private readonly shellEntries: ShellEntry[] = [];
  /** The row of the turn in flight, while there is one. */
  private pendingRow: PendingRow | undefined;
  private spinner: ReturnType<typeof setInterval> | undefined;
  /** Clears `model.notice` when its time is up; undefined while none is
   * showing. */
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  /** The notice the timer in flight belongs to, so a repaint of the same
   * notice does not keep pushing its end away. */
  private shownNotice: string | undefined;
  private readonly noticeMs: number;
  private spinnerMode: "busy" | "running" | undefined;
  private frame = 0;
  private readonly spinnerSpec: ResolvedSpinner;
  /** Built once: every Markdown body shares it, and it owns a native handle
   * that destroy() releases. */
  private readonly markdownStyle = markdownSyntaxStyle();
  /** Built once from the vendor colours so a tick does not rebuild them. */
  private readonly frameStyler: Styler | undefined;
  private readonly labelStyler: Styler | undefined;
  private label = "";
  private readonly budgetSec: number;
  private startedAt = 0;
  private destroyed = false;
  private statusPinned = false;
  /** Shell mode is a property of the input box, not of the conversation. */
  private shell = false;
  /** The textarea content before the latest change, for the `!`-on-empty
   * detection. */
  private lastContent = "";

  constructor(
    private readonly renderer: CliRenderer,
    private readonly model: ChatModel,
    opts: ChatViewOptions,
  ) {
    this.budgetSec = Math.round(opts.timeoutMs / 1000);
    this.index = opts.index;
    this.commands = opts.commands ?? [];
    this.spinnerSpec = opts.spinner;
    this.noticeMs = opts.noticeMs ?? NOTICE_MS;
    this.frameStyler =
      opts.spinner.frameColor === undefined
        ? undefined
        : colored(opts.spinner.frameColor);
    this.labelStyler =
      opts.spinner.labelColor === undefined
        ? undefined
        : colored(opts.spinner.labelColor);
    const root = new BoxRenderable(renderer, {
      id: "root",
      flexDirection: "column",
      width: "100%",
      height: "100%",
    });
    root.add(
      new TextRenderable(renderer, {
        id: "header",
        content: styled(
          theme.badge(` ${opts.title} `),
          " ",
          theme.muted(
            `${opts.providerName} · ${opts.headless ? "headless" : "headful"} · ${this.budgetSec}s budget`,
          ),
        ),
        wrapMode: "none",
        marginBottom: 1,
      }),
    );
    this.body = new BoxRenderable(renderer, {
      id: "body",
      flexGrow: 1,
      // The slot's content (banner, then a growing history) must never size
      // it: without a zero basis the body takes a row from the input box.
      flexShrink: 1,
      flexBasis: 0,
      minHeight: 0,
      flexDirection: "column",
    });
    root.add(this.body);
    this.banner = new BoxRenderable(renderer, {
      id: "banner",
      flexGrow: 1,
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
    });
    for (const line of opts.banner) {
      this.banner.add(
        new TextRenderable(renderer, { content: line, wrapMode: "none" }),
      );
    }
    this.history = new ScrollBoxRenderable(renderer, {
      id: "history",
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    this.body.add(this.banner);

    // Inline above the input: hidden it takes no rows. Rows are created once
    // and re-labelled, so queueing never churns renderables.
    this.queueList = new BoxRenderable(renderer, {
      id: "queue",
      flexDirection: "column",
      flexShrink: 0,
      visible: false,
    });
    for (let i = 0; i < MAX_QUEUE_ROWS; i++) {
      const row = new TextRenderable(renderer, {
        content: "",
        visible: false,
        wrapMode: "none",
      });
      this.queueRows.push(row);
      this.queueList.add(row);
    }
    root.add(this.queueList);

    const inputBox = new BoxRenderable(renderer, {
      id: "input-box",
      flexDirection: "row",
      flexShrink: 0,
      border: ["top", "bottom"],
      borderColor: MUTED_COLOR,
    });
    this.prompt = new TextRenderable(renderer, {
      id: "prompt",
      content: styled(theme.muted("> ")),
      flexShrink: 0,
    });
    inputBox.add(this.prompt);
    this.input = new TextareaRenderable(renderer, {
      id: "input",
      flexGrow: 1,
      height: 1,
      wrapMode: "word",
      placeholder: PLACEHOLDER,
      placeholderColor: MUTED_COLOR,
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "kpenter", action: "submit" },
        // Shift+Enter needs the kitty keyboard protocol. Ctrl+J arrives as
        // a linefeed byte on legacy terminals and as ctrl+j under kitty.
        { name: "return", shift: true, action: "newline" },
        { name: "linefeed", action: "newline" },
        { name: "j", ctrl: true, action: "newline" },
      ],
    });
    inputBox.add(this.input);
    root.add(inputBox);

    // Inline: the popup occupies the rows between the input and the status.
    this.popup = new MentionPopup(renderer, root);

    this.status = new TextRenderable(renderer, {
      id: "status",
      content: styled(theme.muted(GUIDE)),
      // Fixed: a guide longer than the terminal must not wrap and push the
      // input box off the bottom.
      height: 1,
      flexShrink: 0,
    });
    root.add(this.status);
    renderer.root.add(root);

    this.input.onSubmit = () => this.submit();
    // Global listener: runs before the focused textarea and can stop it.
    this.onKeypress = (key) => this.handleKey(key);
    (renderer.keyInput as unknown as KeypressSource).on(
      "keypress",
      this.onKeypress,
    );
    this.input.onContentChange = () => {
      this.detectShellMode();
      this.fitInput();
      this.refreshPopup();
    };
    this.input.onCursorChange = () => this.refreshPopup();
    this.model.onChange = () => this.update();
    this.input.focus();
    this.update();
  }

  /** True while the input box is in `!` shell mode. */
  get shellMode(): boolean {
    return this.shell;
  }

  /** Test hook: the textarea's current text. */
  get inputText(): string {
    return this.input.plainText;
  }

  /** True once this view — or the renderer under it — is gone. OpenTUI
   * destroys the renderer on SIGINT without telling the view, so a write
   * after that would throw from the native text buffer. */
  private get torn(): boolean {
    return this.destroyed || this.renderer.isDestroyed;
  }

  /** Appends messages not yet drawn, refreshes live shell entries, and
   * syncs the status line. */
  update(): void {
    // A turn still in flight when the view is destroyed would otherwise
    // write to renderables the renderer has already torn down.
    if (this.torn) return;
    // A pending row is enough to swap the banner out: a shell turn is
    // auto-sent and has no user message to do it.
    if (
      this.bannerShown &&
      (this.model.messages.length > 0 || this.model.status === "busy")
    ) {
      this.bannerShown = false;
      this.body.remove(this.banner);
      this.body.add(this.history);
    }
    for (; this.rendered < this.model.messages.length; this.rendered++) {
      const message = this.model.messages[this.rendered];
      if (!message) continue;
      const row = this.pendingRow;
      if (
        row?.body !== undefined &&
        message.role === "assistant" &&
        message.incomplete === undefined
      ) {
        // The streamed row already shows this reply: settle it in place
        // rather than drawing a second box under it.
        this.promotePending(row, message);
      } else {
        // The row is always last; anything appended has to go above it.
        this.dropPending();
        this.history.add(this.messageBox(message));
      }
      // A drained turn starts while the view is still busy, so the spinner
      // is never restarted; the user message drawn exactly once per turn is
      // what restarts the elapsed timer, the frame cycle and the label.
      if (message.role === "user") this.beginTurn();
    }
    for (const entry of this.shellEntries) this.refreshShell(entry);
    this.renderQueue();
    // After the status: startSpinner() picks the turn's label there, and the
    // pending row paints it.
    if (this.statusPinned) {
      this.syncPending();
      return;
    }
    this.paintStatus();
    // After paintStatus, which keeps the spinner running for the state the
    // model is in: the notice only borrows the line it painted.
    if (this.model.notice !== undefined) this.paintNotice(this.model.notice);
    this.syncPending();
  }

  /** Puts a short-lived notice on the status line and schedules its end.
   * The state's own line comes back when the timer clears `model.notice`
   * and repaints. */
  private paintNotice(text: string): void {
    this.status.content = styled(theme.muted(text));
    if (this.shownNotice === text && this.noticeTimer !== undefined) return;
    this.shownNotice = text;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = undefined;
      this.shownNotice = undefined;
      this.model.notice = undefined;
      this.update();
    }, this.noticeMs);
  }

  /** Puts the model's status on the status line and runs or stops the
   * spinner interval that repaints it. */
  private paintStatus(): void {
    switch (this.model.status) {
      case "busy":
        this.startSpinner("busy");
        // The spinner only repaints on its interval; an entry queued in
        // between must show up in the count right away.
        this.paintSpinnerStatus();
        break;
      case "running":
        this.startSpinner("running");
        this.paintSpinnerStatus();
        break;
      case "resetting":
        this.stopSpinner();
        // A retrying open reports the attempt; show it instead of the
        // static line so the wait is not silent.
        this.status.content = styled(
          theme.muted(this.model.openProgress ?? RESETTING_STATUS),
        );
        break;
      case "opening":
        this.stopSpinner();
        this.status.content = styled(
          theme.muted(this.model.openProgress ?? OPENING_STATUS),
        );
        break;
      case "logging-in": {
        this.stopSpinner();
        // The progress line replaces the hint once the login reports one;
        // it says what the login is waiting for.
        const base = this.model.loginProgress ?? LOGIN_STATUS;
        this.status.content = styled(
          theme.muted(
            this.model.turnHeldByLogin
              ? `${base} · reply held until login finishes`
              : base,
          ),
        );
        break;
      }
      case "dead":
        this.stopSpinner();
        this.status.content = styled(
          theme.errorText(
            this.queued > 0 && !this.shell ? QUEUE_GUIDE : DEAD_GUIDE,
          ),
        );
        break;
      default:
        this.stopSpinner();
        this.status.content = styled(
          theme.muted(
            idleGuide(
              this.shell,
              this.model.heldResults.length,
              this.queued,
              this.model.idleClosed,
            ),
          ),
        );
    }
  }

  /** Adds, refreshes or removes the row of the turn in flight. It is the
   * last child of the history and is not a message: it never reaches
   * `model.messages`, and nothing in it is selectable. */
  private syncPending(): void {
    if (this.model.status !== "busy") {
      this.dropPending();
      return;
    }
    this.pendingRow ??= this.buildPending();
    const row = this.pendingRow;
    const partial = this.model.partial;
    if (partial !== undefined) {
      if (row.body === undefined) {
        // First partial: the row stops being an indicator and becomes the
        // reply taking shape, with the spinner demoted to the tail.
        const body = this.bodyFor(
          { text: partial, ...this.pendingFormat() },
          true,
        );
        body.selectable = false;
        row.body = body;
        row.label.content = LABELS.assistant();
        row.tail.visible = true;
        row.box.insertBefore(body, row.tail);
      } else {
        this.setBody(row.body, partial);
      }
    }
    this.paintPending();
  }

  /** The empty row, added to the history as its last child. */
  private buildPending(): PendingRow {
    const box = new BoxRenderable(this.renderer, {
      id: "pending",
      flexDirection: "column",
      marginBottom: 1,
    });
    const label = new TextRenderable(this.renderer, {
      content: "",
      wrapMode: "none",
      selectable: false,
    });
    // Hidden until a partial arrives: with no body the indicator is the
    // whole row, and a hidden renderable takes no rows.
    const tail = new TextRenderable(this.renderer, {
      content: "",
      wrapMode: "none",
      selectable: false,
      visible: false,
    });
    box.add(label);
    box.add(tail);
    this.history.add(box);
    return { box, label, body: undefined, tail };
  }

  /** Writes the current frame and elapsed time into the row: into the label
   * while the row is the indicator, into the tail once a body is there. */
  private paintPending(): void {
    const row = this.pendingRow;
    if (row === undefined || this.torn) return;
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const raw = this.spinnerSpec.frames[this.frame] ?? "";
    const frame = this.frameStyler === undefined ? raw : this.frameStyler(raw);
    if (row.body === undefined) {
      row.label.content = styled(
        frame,
        " ",
        this.labelStyler === undefined
          ? this.label
          : this.labelStyler(this.label),
        `  ${elapsed}s`,
      );
      return;
    }
    row.tail.content = styled(frame, theme.muted(` ${elapsed}s`));
  }

  /** Retires the row without settling it: an interrupted turn, or a message
   * that has to be appended under it. */
  private dropPending(): void {
    const row = this.pendingRow;
    if (row === undefined) return;
    this.pendingRow = undefined;
    // The renderer may already be gone (SIGINT under a running turn).
    if (this.torn) return;
    this.history.remove(row.box);
    row.box.destroyRecursively();
  }

  /** Turns the row of the turn in flight into the settled reply's box: the
   * same renderables stay where they are, so nothing flickers or jumps. */
  private promotePending(row: PendingRow, message: Message): void {
    this.pendingRow = undefined;
    // The id is the handle on the row in flight; the settled box is an
    // ordinary message and must not answer to it.
    row.box.id = `reply-${this.rendered}`;
    row.box.remove(row.tail);
    row.tail.destroyRecursively();
    if (row.body !== undefined) {
      // The final text is not always the last partial: some providers only
      // send the finished reply's own text at the end.
      this.setBody(row.body, message.text, true);
      row.body.selectable = true;
    }
  }

  /** The reply format the row in flight is drawn with: the session's, since
   * the row is always the assistant's reply taking shape. */
  private pendingFormat(): { format?: "markdown" } {
    return this.model.session?.responseFormat === "markdown"
      ? { format: "markdown" }
      : {};
  }

  /** The renderable carrying a message's text, whether settled or still
   * streaming. Only a reply of a `markdown` provider carries the format, so
   * user, error and shell text is never reinterpreted as markup. Markdown
   * concealment is asynchronous and fails open: when tree-sitter cannot
   * highlight, the raw markers show rather than an error. */
  private bodyFor(
    message: { text: string; role?: Role; format?: "markdown" },
    streaming: boolean,
  ): Renderable {
    if (message.format === "markdown") {
      return new MarkdownRenderable(this.renderer, {
        content: message.text,
        syntaxStyle: this.markdownStyle,
        conceal: true,
        streaming,
      });
    }
    return new TextRenderable(this.renderer, {
      content:
        message.role === "error"
          ? styled(theme.errorText(message.text))
          : message.text,
      wrapMode: "word",
    });
  }

  /** Rewrites a body's text. `settled` says the turn is over, which is what
   * takes the Markdown body out of streaming mode so its trailing block is
   * parsed as finished. */
  private setBody(body: Renderable, text: string, settled = false): void {
    if (body instanceof MarkdownRenderable) {
      body.content = text;
      if (settled) body.streaming = false;
      return;
    }
    (body as TextRenderable).content = text;
  }

  /** Number of entries waiting in the queue. */
  private get queued(): number {
    return this.model.queue.length;
  }

  /** Re-labels the queue rows from the model. At most MAX_QUEUE_ROWS rows;
   * a longer queue spends the last one on a "+N more" line. Only the first
   * line of a multi-line entry is shown. */
  private renderQueue(): void {
    const entries = this.model.queue;
    this.queueList.visible = entries.length > 0;
    const overflow = entries.length > MAX_QUEUE_ROWS;
    const shown = overflow ? MAX_QUEUE_ROWS - 1 : entries.length;
    this.queueRows.forEach((row, i) => {
      if (i < shown) {
        const entry = entries[i] ?? "";
        row.visible = true;
        row.content = styled(theme.muted(`▹ ${entry.split("\n")[0] ?? ""}`));
        return;
      }
      if (i === shown && overflow) {
        row.visible = true;
        row.content = styled(theme.muted(`… +${entries.length - shown} more`));
        return;
      }
      row.visible = false;
    });
  }

  /** Pins a message on the status line (e.g. "Closing browser...") so the
   * user sees that teardown started. Later model changes leave it alone. */
  setStatus(text: string): void {
    if (this.torn) {
      // Nothing can be drawn any more, but the spinner interval must not
      // outlive the buffer it writes to.
      this.stopSpinner();
      return;
    }
    this.statusPinned = true;
    this.stopSpinner();
    this.status.content = text;
  }

  destroy(): void {
    this.destroyed = true;
    // Deliberately severs the model→view link: a turn still in flight must
    // not reach renderables the renderer is about to tear down.
    this.model.onChange = () => {};
    (this.renderer.keyInput as unknown as KeypressSource).off(
      "keypress",
      this.onKeypress,
    );
    this.popup.destroy();
    this.stopSpinner();
    clearTimeout(this.noticeTimer);
    this.noticeTimer = undefined;
    // Forgets the row without touching the renderer, which may be gone.
    this.dropPending();
    // Owns a native handle of its own, independent of the renderer.
    this.markdownStyle.destroy();
  }

  /** Enter: a message, or in shell mode a command. Mirrors the cases the
   * model drops synchronously, so the textarea is never cleared for input
   * the model is going to ignore. A message while something is in flight is
   * queued, so the box is cleared; a command is not — runShell rejects it
   * rather than queueing it, and the text stays for the user to resend. */
  private submit(): void {
    const text = this.input.plainText;
    if (!text.trim()) {
      return;
    }
    if (this.shell) {
      if (this.model.status !== "idle") return;
      this.input.clear();
      this.fitInput();
      // Back to message mode at once: what follows a command is almost
      // always a message about its output. `!` re-enters shell mode.
      this.setShellMode(false);
      void this.model.runShell(text);
      return;
    }
    this.input.clear();
    this.fitInput();
    // A mention problem is only known after expansion, and the box is
    // empty by then; put the text back so the user can fix it.
    void this.model.submit(text).then((accepted) => {
      // Trade-off: anything typed during expansion wins over the refill.
      if (!accepted && !this.torn && !this.input.plainText) {
        // The clear() above left lastContent empty, which would let a
        // refill starting with `!` trip the shell-mode detector; this text
        // was typed as a message, so pre-seed the detector with it.
        this.lastContent = text;
        this.input.insertText(text);
        this.fitInput();
      }
    });
  }

  /** Ctrl+R reopens the browser in every state. In shell mode, Escape /
   * Backspace / Ctrl+U on an empty input leave the mode. While the popup
   * is open, navigation and accept keys belong to it and never reach the
   * textarea. Everything else falls through and the content/cursor hooks
   * re-run the search. */
  private handleKey(key: KeyEvent): void {
    if (this.torn) return;
    if (key.ctrl && key.name === "r") {
      key.preventDefault();
      void this.model.reset();
      return;
    }
    if (this.shell && this.input.plainText === "") {
      const exits =
        key.name === "escape" ||
        key.name === "backspace" ||
        (key.ctrl && key.name === "u");
      if (exits) {
        key.preventDefault();
        this.setShellMode(false);
        return;
      }
    }
    // Not in shell mode: the box is for a command there, and dropping a
    // queued message into it would run as one. Esc leaves shell mode first.
    if (
      key.name === "up" &&
      !this.shell &&
      !this.popup.visible &&
      this.model.queue.length > 0 &&
      this.onFirstLine()
    ) {
      key.preventDefault();
      this.takeBack();
      return;
    }
    if (!this.popup.visible) return;
    switch (key.name) {
      case "up":
        this.popup.move(-1);
        break;
      case "down":
        this.popup.move(1);
        break;
      case "tab":
      case "return":
      case "kpenter":
        if (key.shift || key.ctrl) return;
        // Returning without preventDefault leaves the key to the textarea,
        // whose `return` binding submits.
        if (key.name !== "tab" && this.commandIsComplete()) {
          this.popup.hide();
          return;
        }
        this.acceptSelection();
        break;
      case "escape":
        this.popup.hide();
        break;
      default:
        return;
    }
    key.preventDefault();
  }

  /** `!` typed or pasted into an empty input switches to shell mode; the
   * `!` itself is removed and anything after it (a paste) is kept. The
   * clear/insert below does not re-enter this hook synchronously, but it
   * does schedule further top-level calls carrying the post-mutation text;
   * keying on "the input was empty before this change and the new content
   * starts with `!`" makes those follow-ups no-ops. */
  private detectShellMode(): void {
    const text = this.input.plainText;
    if (!this.shell && this.lastContent === "" && text.startsWith("!")) {
      this.setShellMode(true);
      const rest = text.slice(1);
      this.input.clear();
      if (rest) this.input.insertText(rest);
    }
    this.lastContent = this.input.plainText;
  }

  private setShellMode(on: boolean): void {
    if (this.shell === on) return;
    this.shell = on;
    this.prompt.content = on
      ? styled(theme.shell("! "))
      : styled(theme.muted("> "));
    this.input.placeholder = on ? SHELL_PLACEHOLDER : PLACEHOLDER;
    if (on) this.popup.hide();
    this.update();
  }

  /** True when the cursor sits on the first logical line of the textarea. */
  private onFirstLine(): boolean {
    const before = this.input.plainText.slice(0, this.input.cursorOffset);
    return !before.includes("\n");
  }

  /** Moves every queued entry into the input box, one per line, ahead of
   * the typed text. Enter then queues (or sends) the box as one entry. */
  private takeBack(): void {
    const entries = this.model.takeBack();
    if (entries.length === 0) return;
    const typed = this.input.plainText;
    const text = typed ? `${entries.join("\n")}\n${typed}` : entries.join("\n");
    // The refill is a message, not a command: pre-seed the shell-mode
    // detector so an entry starting with `!` does not switch modes.
    this.lastContent = text;
    this.input.clear();
    this.input.insertText(text);
    this.fitInput();
  }

  /** One row when empty, then one row per *visual* line up to
   * MAX_INPUT_ROWS; beyond that the textarea scrolls internally and the
   * history gives up rows. The visual rows are estimated from the text
   * rather than read off OpenTUI: its `virtualLineCount` is computed
   * against the current viewport, so at height 1 it always reports 1 and
   * only catches up after the height is raised and a layout pass runs. */
  private fitInput(): void {
    // Before the first frame the textarea has no laid-out width; the box is
    // the full terminal minus the 2-cell "> " prompt.
    const usable = Math.max(
      1,
      this.input.width || this.renderer.terminalWidth - 2,
    );
    let rows = 0;
    for (const line of this.input.plainText.split("\n")) {
      rows += Math.max(1, Math.ceil(line.length / usable));
    }
    this.input.height = Math.min(MAX_INPUT_ROWS, Math.max(1, rows));
  }

  /** True when the command word is already the selected command, so there is
   * nothing left to complete and Enter should send instead — `/new⏎` stays
   * one keystroke. */
  private commandIsComplete(): boolean {
    const word = commandWordAt(this.input.plainText, this.input.cursorOffset);
    return word !== undefined && word.word === this.popup.selected;
  }

  /** Reads the textarea and shows or hides the popup accordingly. The
   * leading `/` word wins over a mention, and the two cannot both apply: a
   * mention needs an `@` word under the cursor. No popup in shell mode: `@`
   * and `/` are ordinary characters there. */
  private refreshPopup(): void {
    if (this.torn) return;
    if (this.shell) {
      this.popup.hide();
      return;
    }
    const text = this.input.plainText;
    const cursor = this.input.cursorOffset;
    const prefix = slashPrefixAt(text, cursor);
    if (prefix !== undefined) {
      this.popup.show(commandRows(matchCommands(prefix, this.commands)));
      return;
    }
    const mention = mentionAtCursor(text, cursor);
    if (!mention) {
      this.popup.hide();
      return;
    }
    this.popup.show(
      this.index
        .search(mention.path, MAX_ROWS)
        .map((path) => ({ value: path, label: path })),
    );
  }

  /** Replaces what is under the cursor with the selection followed by a
   * space, and puts the cursor after it: `/name ` for a command, `@<path> `
   * for a mention. `insertText` on a selection replaces the selection.
   * Accepting a command never runs it. */
  private acceptSelection(): void {
    const value = this.popup.selected;
    if (value === undefined) {
      this.popup.hide();
      return;
    }
    const text = this.input.plainText;
    const cursor = this.input.cursorOffset;
    const word = commandWordAt(text, cursor);
    if (word) {
      this.input.setSelection(0, word.end);
      this.input.insertText(`/${value} `);
      this.popup.hide();
      return;
    }
    const mention = mentionAtCursor(text, cursor);
    if (!mention) {
      this.popup.hide();
      return;
    }
    this.input.setSelection(mention.start, mention.end);
    this.input.insertText(`@${value} `);
    this.popup.hide();
  }

  private messageBox(message: Message): BoxRenderable {
    const box = new BoxRenderable(this.renderer, {
      flexDirection: "column",
      marginBottom: 1,
    });
    if (message.role === "separator") {
      box.add(
        new TextRenderable(this.renderer, {
          content: styled(theme.muted(`── ${message.text} ──`)),
          wrapMode: "none",
        }),
      );
      return box;
    }
    if (message.role === "help") {
      // Pre-aligned columns: wrapping would break them, so a narrow
      // terminal clips instead.
      box.add(
        new TextRenderable(this.renderer, {
          content: styled(theme.muted(message.text)),
          wrapMode: "none",
        }),
      );
      return box;
    }
    box.add(
      new TextRenderable(this.renderer, { content: LABELS[message.role]() }),
    );
    if (message.role === "shell") {
      box.add(
        new TextRenderable(this.renderer, {
          content: styled(theme.shell(`$ ${message.text}`)),
          wrapMode: "word",
        }),
      );
      const output = new TextRenderable(this.renderer, {
        content: "",
        wrapMode: "word",
        visible: false,
      });
      const footer = new TextRenderable(this.renderer, {
        content: "",
        wrapMode: "word",
        visible: false,
      });
      box.add(output);
      box.add(footer);
      const entry: ShellEntry = {
        message,
        output,
        footer,
        drawnOutput: "",
        drawnFooter: "",
      };
      this.shellEntries.push(entry);
      this.refreshShell(entry);
      return box;
    }
    box.add(this.bodyFor(message, false));
    if (message.incomplete) {
      box.add(
        new TextRenderable(this.renderer, {
          content: styled(theme.muted(INCOMPLETE_NOTE)),
          wrapMode: "none",
          selectable: false,
        }),
      );
    }
    for (const a of message.attachments ?? []) {
      box.add(
        new TextRenderable(this.renderer, {
          content: styled(theme.muted(`📎 ${a.path} (${formatSize(a.bytes)})`)),
        }),
      );
    }
    return box;
  }

  /** Rewrites a shell entry's output and footer when they changed. Hidden
   * renderables take no rows, so an empty output or footer costs nothing. */
  private refreshShell(entry: ShellEntry): void {
    const output = entry.message.result?.output ?? "";
    if (output !== entry.drawnOutput) {
      entry.drawnOutput = output;
      // Trailing newline would draw an empty row under the output.
      entry.output.content = output.endsWith("\n")
        ? output.slice(0, -1)
        : output;
      entry.output.visible = output !== "";
    }
    const footer = shellFooter(entry.message);
    if (footer !== entry.drawnFooter) {
      entry.drawnFooter = footer;
      entry.footer.content = styled(theme.muted(footer));
      entry.footer.visible = footer !== "";
    }
  }

  private startSpinner(mode: "busy" | "running"): void {
    if (this.spinner && this.spinnerMode === mode) return;
    this.stopSpinner();
    this.spinnerMode = mode;
    this.beginTurn();
    const tick = () => {
      // The renderer can be destroyed from under a running turn (SIGINT);
      // the interval outlives it until teardown reaches this view.
      if (this.torn) return this.stopSpinner();
      this.frame = (this.frame + 1) % this.spinnerSpec.frames.length;
      this.paintSpinnerStatus();
      // The same interval animates the row in flight and ticks its elapsed
      // time; the status line alone would leave the row frozen.
      this.paintPending();
    };
    tick();
    this.spinner = setInterval(tick, this.spinnerSpec.intervalMs);
  }

  /** Resets the per-turn spinner state: elapsed timer, frame cycle and
   * label. Called for every turn, including one drained from the queue
   * while the spinner is already running. */
  private beginTurn(): void {
    this.startedAt = Date.now();
    this.frame = 0;
    this.label = this.pickLabel();
  }

  /** One label per turn, chosen when the turn starts so the row does not
   * flicker between frames. Empty list: no label. */
  private pickLabel(): string {
    const { labels } = this.spinnerSpec;
    if (labels.length === 0) return "";
    return labels[Math.floor(Math.random() * labels.length)] ?? "";
  }

  /** Draws the current spinner frame, elapsed time and queue count, for
   * whichever spinner is running. The frame takes the vendor colour in both
   * modes and the vendor label only in the busy row, which is the one it
   * describes; the counter never does.  */
  private paintSpinnerStatus(): void {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const n = this.queued;
    const raw = this.spinnerSpec.frames[this.frame] ?? "";
    const frame = this.frameStyler === undefined ? raw : this.frameStyler(raw);
    if (this.spinnerMode === "running") {
      // The running row already separates its parts with " · ", so the count
      // joins with one space; the busy row keeps its wider gap.
      const queued = n > 0 ? ` · ${n} queued` : "";
      this.status.content = styled(
        frame,
        ` ${RUNNING_LABEL}  ${elapsed}s · Ctrl+C stop${queued}`,
      );
      return;
    }
    // The frame and the label are on the pending row, where the reply will
    // land; the status line is left with the wait's numbers and the keys.
    // A notice owns the line while it is up; the tick still animates the
    // pending row.
    if (this.model.notice !== undefined) return;
    const queued = n > 0 ? `  · ${n} queued` : "";
    this.status.content = styled(
      theme.muted(`${elapsed}s / ${this.budgetSec}s${queued} · ${BUSY_GUIDE}`),
    );
  }

  private stopSpinner(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = undefined;
    this.spinnerMode = undefined;
  }
}
