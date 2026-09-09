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
import { styled, theme } from "./theme.js";

export const GUIDE =
  "Enter send · Shift+Enter (or Ctrl+J) newline · @ file · Ctrl+C quit";
/** Three fixed cells so legacy terminals keep the line aligned. */
const FRAMES = ["●○○", "○●○", "○○●", "○●○"];
const FRAME_INTERVAL_MS = 120;
const LABELS: Record<Role, () => StyledText> = {
  user: () => styled(theme.user("user")),
  assistant: () => styled(theme.assistant("assistant")),
  error: () => styled(theme.error("error")),
};
/** Input box (border + 4 lines) and the status line below the history. */
const INPUT_BOX_HEIGHT = 6;
const STATUS_HEIGHT = 1;

export interface ChatViewOptions {
  title: string;
  providerName: string;
  /** Response timeout budget shown next to the elapsed time. */
  timeoutMs: number;
  /** Shown in the header as "headless" or "headful". */
  headless: boolean;
  /** Startup banner lines, shown centred until the first message. */
  banner: StyledText[];
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
 * Layout: header / scrolling history / 4-line textarea / status line, plus
 * a mention popup drawn over the bottom of the history while the cursor is
 * inside an `@` mention. */
export class ChatView {
  private readonly body: BoxRenderable;
  private readonly banner: BoxRenderable;
  private bannerShown = true;
  private readonly history: ScrollBoxRenderable;
  private readonly input: TextareaRenderable;
  private readonly status: TextRenderable;
  private readonly popup: MentionPopup;
  private readonly index: FileIndex;
  private readonly onKeypress: (key: KeyEvent) => void;
  private rendered = 0;
  private spinner: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
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

    const inputBox = new BoxRenderable(renderer, {
      id: "input-box",
      border: true,
      height: INPUT_BOX_HEIGHT,
    });
    this.input = new TextareaRenderable(renderer, {
      id: "input",
      height: INPUT_BOX_HEIGHT - 2,
      placeholder: "Type a message",
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
      height: STATUS_HEIGHT,
      flexShrink: 0,
    });
    root.add(this.status);
    renderer.root.add(root);

    this.input.onSubmit = () => {
      const text = this.input.plainText;
      // Mirrors the cases ChatModel.submit drops synchronously, so the
      // textarea is never cleared for input the model is going to ignore.
      if (
        !text.trim() ||
        this.model.status === "busy" ||
        this.model.fatal !== undefined
      ) {
        return;
      }
      this.input.clear();
      // A mention problem is only known after expansion, and the box is
      // empty by then; put the text back so the user can fix it.
      void this.model.submit(text).then((accepted) => {
        // Trade-off: anything typed during expansion wins over the refill.
        if (!accepted && !this.destroyed && !this.input.plainText) {
          this.input.insertText(text);
        }
      });
    };
    // Global listener: runs before the focused textarea and can stop it.
    this.onKeypress = (key) => this.handlePopupKey(key);
    (renderer.keyInput as unknown as KeypressSource).on(
      "keypress",
      this.onKeypress,
    );
    this.input.onContentChange = () => this.refreshPopup();
    this.input.onCursorChange = () => this.refreshPopup();
    this.model.onChange = () => this.update();
    this.input.focus();
    this.update();
  }

  /** Appends messages not yet drawn and syncs the status line. */
  update(): void {
    // A turn still in flight when the view is destroyed would otherwise
    // write to renderables the renderer has already torn down.
    if (this.destroyed) return;
    if (this.bannerShown && this.model.messages.length > 0) {
      this.bannerShown = false;
      this.body.remove(this.banner);
      this.body.add(this.history);
    }
    for (; this.rendered < this.model.messages.length; this.rendered++) {
      const message = this.model.messages[this.rendered];
      if (message) this.history.add(this.messageBox(message));
    }
    if (this.statusPinned) return;
    if (this.model.status === "busy") {
      this.startSpinner();
    } else {
      this.stopSpinner();
      this.status.content = styled(theme.muted(GUIDE));
    }
  }

  /** Pins a message on the status line (e.g. "Closing browser...") so the
   * user sees that teardown started. Later model changes leave it alone. */
  setStatus(text: string): void {
    if (this.destroyed) return;
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

  /** While the popup is open, navigation and accept keys belong to it and
   * never reach the textarea. Everything else falls through and the
   * content/cursor hooks re-run the search. */
  private handlePopupKey(key: KeyEvent): void {
    if (this.destroyed || !this.popup.visible) return;
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

  /** Reads the textarea and shows or hides the popup accordingly. */
  private refreshPopup(): void {
    if (this.destroyed) return;
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
    const tick = () => {
      this.frame = (this.frame + 1) % FRAMES.length;
      const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
      this.status.content = `${FRAMES[this.frame]} Thinking…  ${elapsed}s / ${this.budgetSec}s`;
    };
    tick();
    this.spinner = setInterval(tick, FRAME_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = undefined;
  }
}
