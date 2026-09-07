import {
  BoxRenderable,
  type CliRenderer,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
} from "@opentui/core";
import type { ChatModel, Message, Role } from "./chat-model.js";

export const GUIDE = "Enter send · Shift+Enter / Ctrl+J newline · Ctrl+C quit";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const LABELS: Record<Role, string> = {
  user: "You",
  assistant: "Assistant",
  error: "Error",
};

export interface ChatViewOptions {
  title: string;
  providerName: string;
}

/** Builds the OpenTUI tree for one ChatModel and mirrors its state.
 * Layout: header / scrolling history / 4-line textarea / status line. */
export class ChatView {
  private readonly history: ScrollBoxRenderable;
  private readonly input: TextareaRenderable;
  private readonly status: TextRenderable;
  private rendered = 0;
  private spinner: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private destroyed = false;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly model: ChatModel,
    opts: ChatViewOptions,
  ) {
    const root = new BoxRenderable(renderer, {
      id: "root",
      flexDirection: "column",
      width: "100%",
      height: "100%",
    });
    root.add(
      new TextRenderable(renderer, {
        id: "header",
        content: `${opts.title} · ${opts.providerName}`,
        marginBottom: 1,
      }),
    );
    this.history = new ScrollBoxRenderable(renderer, {
      id: "history",
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    root.add(this.history);

    const inputBox = new BoxRenderable(renderer, {
      id: "input-box",
      border: true,
      height: 6,
    });
    this.input = new TextareaRenderable(renderer, {
      id: "input",
      height: 4,
      placeholder: "Type a message",
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "kpenter", action: "submit" },
        // Shift+Enter needs the kitty keyboard protocol; Ctrl+J arrives
        // as a linefeed byte on every terminal.
        { name: "return", shift: true, action: "newline" },
        { name: "linefeed", action: "newline" },
      ],
    });
    inputBox.add(this.input);
    root.add(inputBox);

    this.status = new TextRenderable(renderer, {
      id: "status",
      content: GUIDE,
    });
    root.add(this.status);
    renderer.root.add(root);

    this.input.onSubmit = () => {
      const text = this.input.plainText;
      if (!text.trim() || this.model.status === "busy") return;
      this.input.clear();
      void this.model.submit(text);
    };
    this.model.onChange = () => this.update();
    this.input.focus();
    this.update();
  }

  /** Appends messages not yet drawn and syncs the status line. */
  update(): void {
    // A turn still in flight when the view is destroyed would otherwise
    // write to renderables the renderer has already torn down.
    if (this.destroyed) return;
    for (; this.rendered < this.model.messages.length; this.rendered++) {
      const message = this.model.messages[this.rendered];
      if (message) this.history.add(this.messageBox(message));
    }
    if (this.model.status === "busy") {
      this.startSpinner();
    } else {
      this.stopSpinner();
      this.status.content = GUIDE;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.model.onChange = () => {};
    this.stopSpinner();
  }

  private messageBox(message: Message): BoxRenderable {
    const box = new BoxRenderable(this.renderer, {
      flexDirection: "column",
      marginBottom: 1,
    });
    box.add(
      new TextRenderable(this.renderer, { content: LABELS[message.role] }),
    );
    box.add(
      new TextRenderable(this.renderer, {
        content: message.text,
        wrapMode: "word",
      }),
    );
    return box;
  }

  private startSpinner(): void {
    if (this.spinner) return;
    const tick = () => {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.status.content = `${SPINNER[this.frame]} Waiting for response...`;
    };
    tick();
    this.spinner = setInterval(tick, SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = undefined;
  }
}
