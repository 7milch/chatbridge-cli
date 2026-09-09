import { ResponseTimeoutError } from "@chatbridge/core";
import {
  type Attachment,
  type Expansion,
  MentionError,
  expandMentions,
} from "../mentions/expand-mentions.js";

/** What the model needs from a ChatSession; lets tests inject a fake. */
export interface ChatSessionLike {
  send(prompt: string): Promise<string>;
  close(): Promise<void>;
}

export type Role = "user" | "assistant" | "error";
export interface Message {
  role: Role;
  text: string;
  /** Files appended to the prompt; the history shows one line per entry. */
  attachments?: Attachment[];
}
export type Status = "idle" | "busy";

export interface ChatModelOptions {
  /** Turns the typed text into the prompt to send. Default: expandMentions
   * against process.cwd(). Tests inject a fake. */
  expand?: (text: string) => Promise<Expansion>;
}

/** Conversation state for the interactive UI. No OpenTUI dependency. */
export class ChatModel {
  readonly messages: Message[] = [];
  status: Status = "idle";
  /** Set when submit hit an unrecoverable error; the app must exit. */
  fatal: unknown = undefined;
  /** Called after every state change. */
  onChange: () => void = () => {};
  private readonly expand: (text: string) => Promise<Expansion>;

  constructor(
    private readonly session: ChatSessionLike,
    opts: ChatModelOptions = {},
  ) {
    this.expand =
      opts.expand ?? ((text) => expandMentions(text, process.cwd()));
  }

  /** Sends one turn. Resolves true when the message was accepted (the view
   * clears the textarea), false when it was ignored — blank input, input
   * while busy, input after a fatal error — or blocked by a mention
   * problem, which is shown as an error entry without sending anything. */
  async submit(text: string): Promise<boolean> {
    const prompt = text.trim();
    if (!prompt || this.status === "busy" || this.fatal !== undefined) {
      return false;
    }
    let expansion: Expansion;
    try {
      expansion = await this.expand(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({ role: "error", text: message });
      // A mention problem is the user's to fix; anything else is a bug.
      if (!(err instanceof MentionError)) this.fatal = err;
      this.onChange();
      return false;
    }
    const message: Message = { role: "user", text: prompt };
    if (expansion.attachments.length > 0) {
      message.attachments = expansion.attachments;
    }
    this.messages.push(message);
    this.status = "busy";
    this.onChange();
    try {
      const reply = await this.session.send(expansion.prompt);
      this.messages.push({ role: "assistant", text: reply });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({ role: "error", text: message });
      // A timeout leaves the browser usable; anything else ends the session.
      if (!(err instanceof ResponseTimeoutError)) this.fatal = err;
    } finally {
      this.status = "idle";
      this.onChange();
    }
    return true;
  }
}
