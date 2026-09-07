import { ResponseTimeoutError } from "@chatbridge/core";

/** What the model needs from a ChatSession; lets tests inject a fake. */
export interface ChatSessionLike {
  send(prompt: string): Promise<string>;
  close(): Promise<void>;
}

export type Role = "user" | "assistant" | "error";
export interface Message {
  role: Role;
  text: string;
}
export type Status = "idle" | "busy";

/** Conversation state for the interactive UI. No OpenTUI dependency. */
export class ChatModel {
  readonly messages: Message[] = [];
  status: Status = "idle";
  /** Set when submit hit an unrecoverable error; the app must exit. */
  fatal: unknown = undefined;
  /** Called after every state change. */
  onChange: () => void = () => {};

  constructor(private readonly session: ChatSessionLike) {}

  /** Sends one turn. Blank input, input while busy, and input after a
   * fatal error are ignored. */
  async submit(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt || this.status === "busy" || this.fatal !== undefined) return;
    this.messages.push({ role: "user", text: prompt });
    this.status = "busy";
    this.onChange();
    try {
      const reply = await this.session.send(prompt);
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
  }
}
