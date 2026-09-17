import {
  type Attachment,
  ChatBridgeError,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  closeOrKill,
  formatAttachment,
  formatSize,
} from "@chatbridge/core";
import type { Message, State, Status } from "./protocol.js";

/** What the controller needs from a ChatSession; lets tests inject a fake. */
export interface ChatSessionLike {
  send(prompt: string): Promise<string>;
  close(): Promise<void>;
  kill(): Promise<void>;
}

/** A queued attachment: what the history shows plus the content to send. */
export interface PendingAttachment extends Attachment {
  content: string;
}

export type SendResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export type AddResult = { ok: true } | { ok: false; reason: string };

export interface SessionControllerOptions {
  /** Opens a ChatSession; called lazily on the first send after `closed`. */
  openSession: () => Promise<ChatSessionLike>;
  /** How long newChat / discard / close wait before killing. Default 5 s. */
  closeTimeoutMs?: number;
  /** Called with the full state after every change. */
  onChange?: (state: State) => void;
}

export const CLOSE_TIMEOUT_MS = 5_000;

const EMPTY: SendResult = {
  ok: false,
  code: "EMPTY",
  message: "Nothing to send.",
};

/** Owns the history, the pending attachments and the ChatSession. No
 * vscode import: the extension wires it to the webview and the commands. */
export class SessionController {
  private status: Status = "closed";
  private messages: Message[] = [];
  private pending: PendingAttachment[] = [];
  private lastError: string | undefined;
  private session: ChatSessionLike | undefined;
  /** The full prompt of the last send, for retryLast(). */
  private lastPrompt: string | undefined;
  private readonly closeTimeoutMs: number;

  constructor(private readonly opts: SessionControllerOptions) {
    this.closeTimeoutMs = opts.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  }

  getState(): State {
    const state: State = {
      status: this.status,
      messages: this.messages.map((m) => ({
        ...m,
        ...(m.attachments ? { attachments: [...m.attachments] } : {}),
      })),
      pendingAttachments: this.pending.map(({ path, bytes }) => ({
        path,
        bytes,
      })),
    };
    if (this.lastError !== undefined) state.lastError = this.lastError;
    return state;
  }

  private setStatus(status: Status): void {
    this.status = status;
    this.emit();
  }

  private push(message: Message): void {
    this.messages.push(message);
    this.emit();
  }

  private emit(): void {
    this.opts.onChange?.(this.getState());
  }

  addAttachment(a: PendingAttachment): AddResult {
    if (a.bytes > MAX_FILE_BYTES) {
      return {
        ok: false,
        reason: `${a.path}: ${Math.ceil(a.bytes / 1024)} KB exceeds ${MAX_FILE_BYTES / 1024} KB`,
      };
    }
    const total = this.pending.reduce((n, p) => n + p.bytes, 0) + a.bytes;
    if (total > MAX_TOTAL_BYTES) {
      return {
        ok: false,
        reason: `attachments total ${formatSize(total)} exceeds ${formatSize(MAX_TOTAL_BYTES).replace(".0", "")}`,
      };
    }
    this.pending.push(a);
    this.emit();
    return { ok: true };
  }

  removeAttachment(index: number): void {
    if (index < 0 || index >= this.pending.length) return;
    this.pending.splice(index, 1);
    this.emit();
  }

  /** Sends the text plus the pending attachments as one turn. Never
   * throws: the outcome is the result and the history. */
  async send(text: string): Promise<SendResult> {
    if (this.status === "busy" || this.status === "opening") {
      return {
        ok: false,
        code: "INVALID_STATE",
        message: "A send is already in progress.",
      };
    }
    const body = text.trim() === "" ? "" : text;
    if (body === "" && this.pending.length === 0) return EMPTY;
    const sections = this.pending.map((a) =>
      formatAttachment(a.path, a.content),
    );
    const prompt = [body, ...sections].filter((s) => s !== "").join("\n\n");
    const attachments = this.pending.map(({ path, bytes }) => ({
      path,
      bytes,
    }));
    this.pending = [];
    this.push({ role: "user", text: body, attachments });
    this.lastPrompt = prompt;
    return this.runTurn(prompt);
  }

  /** Re-runs the last prompt after a recoverable fatal error (a missing
   * browser that was just installed). Drops the trailing error entry so
   * the history reads user → assistant. */
  async retryLast(): Promise<SendResult> {
    if (this.lastPrompt === undefined) return EMPTY;
    if (this.status === "busy" || this.status === "opening") {
      return {
        ok: false,
        code: "INVALID_STATE",
        message: "A send is already in progress.",
      };
    }
    if (this.messages.at(-1)?.role === "error") this.messages.pop();
    this.lastError = undefined;
    if (this.status === "dead") this.status = "closed";
    this.emit();
    return this.runTurn(this.lastPrompt);
  }

  private async runTurn(prompt: string): Promise<SendResult> {
    // A new turn supersedes whatever killed the previous one: a stale
    // `lastError` would keep the webview's error banner up after a
    // successful send from `dead`.
    this.lastError = undefined;
    try {
      if (this.session === undefined) {
        this.setStatus("opening");
        this.session = await this.opts.openSession();
      }
      this.setStatus("busy");
      const reply = await this.session.send(prompt);
      this.messages.push({ role: "assistant", text: reply });
      this.setStatus("idle");
      return { ok: true };
    } catch (err) {
      return this.fail(err);
    }
  }

  private async fail(err: unknown): Promise<SendResult> {
    const code = err instanceof ChatBridgeError ? err.code : "UNKNOWN";
    const message = err instanceof Error ? err.message : String(err);
    this.messages.push({ role: "error", text: message });
    // Show the error before `dropSession` (up to `closeTimeoutMs`) runs.
    this.emit();
    if (code === "RESPONSE_TIMEOUT") {
      this.setStatus("idle");
    } else {
      this.lastError = code;
      await this.dropSession();
      this.setStatus("dead");
    }
    return { ok: false, code, message };
  }

  private async dropSession(): Promise<void> {
    const old = this.session;
    this.session = undefined;
    if (old !== undefined) await closeOrKill(old, this.closeTimeoutMs);
  }

  /** Ctrl+R of the TUI: drop the browser, mark the break, reopen lazily. */
  async newChat(): Promise<void> {
    await this.discard("New chat");
  }

  /** Closes the session (if any) and pushes `separator`. Refused while a
   * turn is in flight. Clears a dead state. */
  async discard(separator: string): Promise<void> {
    if (this.status === "busy" || this.status === "opening") return;
    await this.dropSession();
    this.lastError = undefined;
    // A fresh chat must not re-send a prompt from before the break.
    this.lastPrompt = undefined;
    this.status = "closed";
    this.push({ role: "separator", text: separator });
  }

  /** After a successful login command: a dead controller may try again. */
  markLoggedIn(): void {
    if (this.status === "dead") {
      this.lastError = undefined;
      this.status = "closed";
    }
    this.push({ role: "separator", text: "Logged in" });
  }

  /** deactivate: close the browser, keep the history. Idempotent. */
  async close(): Promise<void> {
    await this.dropSession();
    if (this.status !== "dead") this.status = "closed";
    this.emit();
  }
}
