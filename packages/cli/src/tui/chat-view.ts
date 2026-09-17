import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  ScrollBoxRenderable,
  type StyledText,
  TextRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { formatSize } from "../mentions/expand-mentions.js";
import type { FileIndex } from "../mentions/file-index.js";
import { mentionAtCursor } from "../mentions/parse-mentions.js";
import type { ChatModel, Message, Role } from "./chat-model.js";
import { MAX_ROWS, MentionPopup } from "./mention-popup.js";
import type { ResolvedSpinner } from "./spinner.js";
import { MUTED_COLOR, colored, styled, theme } from "./theme.js";

export const GUIDE =
  "Enter send · Shift+Enter/Ctrl+J newline · @ file · Ctrl+R reopen · Ctrl+C quit";
/** Shown instead of GUIDE once a fatal error left the session unusable. */
export const DEAD_GUIDE = "Ctrl+R reopen · Ctrl+C quit";
/** Idle or dead guide while queued entries are waiting. */
export const QUEUE_GUIDE = "Up take back · Ctrl+R reopen · Ctrl+C quit";
/** Rows the queue list may take; a longer queue ends with a "+N more" row. */
export const MAX_QUEUE_ROWS = 5;
export const RESETTING_STATUS = "Reopening browser...";
const LABELS: Record<Exclude<Role, "separator">, () => StyledText> = {
  user: () => styled(theme.user("user")),
  assistant: () => styled(theme.assistant("assistant")),
  error: () => styled(theme.error("error")),
};
/** The input starts one row tall and grows with its content up to this. */
export const MAX_INPUT_ROWS = 5;

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
}

/** KeyHandler's `on` is typed through a generic EventEmitter that does not
 * type-check under our config; this is the shape we rely on at runtime. */
interface KeypressSource {
  on(event: "keypress", handler: (key: KeyEvent) => void): unknown;
  off(event: "keypress", handler: (key: KeyEvent) => void): unknown;
}

/** Builds the OpenTUI tree for one ChatModel and mirrors its state.
 * Layout, top to bottom: badge header / banner-or-history / queue list
 * (hidden while the queue is empty) / hairline input (1–5 rows) / inline
 * mention popup (hidden unless the cursor is in an `@`
 * mention) / status line. */
export class ChatView {
  private readonly body: BoxRenderable;
  private readonly banner: BoxRenderable;
  private bannerShown = true;
  private readonly history: ScrollBoxRenderable;
  private readonly input: TextareaRenderable;
  private readonly status: TextRenderable;
  private readonly queueList: BoxRenderable;
  private readonly queueRows: TextRenderable[] = [];
  private readonly popup: MentionPopup;
  private readonly index: FileIndex;
  private readonly onKeypress: (key: KeyEvent) => void;
  private rendered = 0;
  private spinner: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private readonly spinnerSpec: ResolvedSpinner;
  private label = "";
  private readonly budgetSec: number;
  private startedAt = 0;
  private destroyed = false;
  private statusPinned = false;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly model: ChatModel,
    opts: ChatViewOptions,
  ) {
    this.budgetSec = Math.round(opts.timeoutMs / 1000);
    this.index = opts.index;
    this.spinnerSpec = opts.spinner;
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
    inputBox.add(
      new TextRenderable(renderer, {
        id: "prompt",
        content: styled(theme.muted("> ")),
        flexShrink: 0,
      }),
    );
    this.input = new TextareaRenderable(renderer, {
      id: "input",
      flexGrow: 1,
      height: 1,
      wrapMode: "word",
      placeholder: "Type a message",
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

    this.input.onSubmit = () => {
      const text = this.input.plainText;
      // Blank input is the one case ChatModel.submit drops synchronously;
      // anything else is sent or queued, so the box is cleared.
      if (!text.trim()) {
        return;
      }
      this.input.clear();
      this.fitInput();
      // A mention problem on a typed message is only known after expansion,
      // and the box is empty by then; put the text back so the user can fix
      // it. A queued entry that fails goes back to the queue instead.
      void this.model.submit(text).then((accepted) => {
        // Trade-off: anything typed during expansion wins over the refill.
        if (!accepted && !this.torn && !this.input.plainText) {
          this.input.insertText(text);
          this.fitInput();
        }
      });
    };
    // Global listener: runs before the focused textarea and can stop it.
    this.onKeypress = (key) => this.handleKey(key);
    (renderer.keyInput as unknown as KeypressSource).on(
      "keypress",
      this.onKeypress,
    );
    this.input.onContentChange = () => {
      this.fitInput();
      this.refreshPopup();
    };
    this.input.onCursorChange = () => this.refreshPopup();
    this.model.onChange = () => this.update();
    this.input.focus();
    this.update();
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

  /** Appends messages not yet drawn and syncs the status line. */
  update(): void {
    // A turn still in flight when the view is destroyed would otherwise
    // write to renderables the renderer has already torn down.
    if (this.torn) return;
    if (this.bannerShown && this.model.messages.length > 0) {
      this.bannerShown = false;
      this.body.remove(this.banner);
      this.body.add(this.history);
    }
    for (; this.rendered < this.model.messages.length; this.rendered++) {
      const message = this.model.messages[this.rendered];
      if (!message) continue;
      this.history.add(this.messageBox(message));
      // A drained turn starts while the view is still busy, so the spinner
      // is never restarted; the user message drawn exactly once per turn is
      // what restarts the elapsed timer.
      if (message.role === "user") this.startedAt = Date.now();
    }
    this.renderQueue();
    if (this.statusPinned) return;
    switch (this.model.status) {
      case "busy":
        this.startSpinner();
        // The spinner only repaints on its interval; an entry queued in
        // between must show up in the count right away.
        this.paintBusyStatus();
        break;
      case "resetting":
        this.stopSpinner();
        this.status.content = styled(theme.muted(RESETTING_STATUS));
        break;
      case "dead":
        this.stopSpinner();
        this.status.content = styled(
          theme.errorText(this.queued > 0 ? QUEUE_GUIDE : DEAD_GUIDE),
        );
        break;
      default:
        this.stopSpinner();
        this.status.content = styled(
          theme.muted(this.queued > 0 ? QUEUE_GUIDE : GUIDE),
        );
    }
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
  }

  /** Ctrl+R reopens the browser in every state. While the popup is open,
   * navigation and accept keys belong to it and never reach the textarea.
   * Everything else falls through and the content/cursor hooks re-run the
   * search. */
  private handleKey(key: KeyEvent): void {
    if (this.torn) return;
    if (key.ctrl && key.name === "r") {
      key.preventDefault();
      void this.model.reset();
      return;
    }
    if (
      key.name === "up" &&
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

  /** Reads the textarea and shows or hides the popup accordingly. */
  private refreshPopup(): void {
    if (this.torn) return;
    const mention = mentionAtCursor(
      this.input.plainText,
      this.input.cursorOffset,
    );
    if (!mention) {
      this.popup.hide();
      return;
    }
    this.popup.show(this.index.search(mention.path, MAX_ROWS));
  }

  /** Replaces the mention under the cursor with `@<path> ` and puts the
   * cursor after it. `insertText` on a selection replaces the selection. */
  private acceptSelection(): void {
    const path = this.popup.selected;
    const mention = mentionAtCursor(
      this.input.plainText,
      this.input.cursorOffset,
    );
    if (path === undefined || !mention) {
      this.popup.hide();
      return;
    }
    this.input.setSelection(mention.start, mention.end);
    this.input.insertText(`@${path} `);
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
    box.add(
      new TextRenderable(this.renderer, { content: LABELS[message.role]() }),
    );
    box.add(
      new TextRenderable(this.renderer, {
        content:
          message.role === "error"
            ? styled(theme.errorText(message.text))
            : message.text,
        wrapMode: "word",
      }),
    );
    for (const a of message.attachments ?? []) {
      box.add(
        new TextRenderable(this.renderer, {
          content: styled(theme.muted(`📎 ${a.path} (${formatSize(a.bytes)})`)),
        }),
      );
    }
    return box;
  }

  private startSpinner(): void {
    if (this.spinner) return;
    this.startedAt = Date.now();
    this.label = this.pickLabel();
    const tick = () => {
      // The renderer can be destroyed from under a running turn (SIGINT);
      // the interval outlives it until teardown reaches this view.
      if (this.torn) return this.stopSpinner();
      this.frame = (this.frame + 1) % this.spinnerSpec.frames.length;
      this.paintBusyStatus();
    };
    tick();
    this.spinner = setInterval(tick, this.spinnerSpec.intervalMs);
  }

  /** One label per turn, chosen when the spinner starts so the row does not
   * flicker between frames. Empty list: no label. */
  private pickLabel(): string {
    const { labels } = this.spinnerSpec;
    if (labels.length === 0) return "";
    return labels[Math.floor(Math.random() * labels.length)] ?? "";
  }

  /** Draws the current spinner frame, elapsed time and queue count. The
   * frame and label take the vendor colours; the counter never does. */
  private paintBusyStatus(): void {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const queued = this.queued > 0 ? `  · ${this.queued} queued` : "";
    const { frames, frameColor, labelColor } = this.spinnerSpec;
    const frame = frames[this.frame] ?? "";
    this.status.content = styled(
      frameColor === undefined ? frame : colored(frameColor)(frame),
      " ",
      labelColor === undefined ? this.label : colored(labelColor)(this.label),
      `  ${elapsed}s / ${this.budgetSec}s${queued}`,
    );
  }

  private stopSpinner(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = undefined;
  }
}
