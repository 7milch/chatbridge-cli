import {
  type Attachment,
  ChatBridgeError,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  closeOrKill,
  formatAttachment,
  formatSize,
} from "@chatbridge/core";
import type { Message, QueueEntry, State, Status } from "./protocol.js";

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
  | { ok: true; queued?: true }
  | { ok: false; code: string; message: string };

/** The separator pushed into the history by `reopen()`. */
export const REOPENED_SEPARATOR = "reopened";

/** Controller-internal queue entry: the attachments keep their content. */
interface QueuedTurn {
  text: string;
  attachments: PendingAttachment[];
}

export type AddResult = { ok: true } | { ok: false; reason: string };

export interface SessionControllerOptions {
  /** Opens a ChatSession; called lazily on the first send after `closed`. */
  openSession: () => Promise<ChatSessionLike>;
  /** How long newChat / discard / close wait before killing. Default 5 s. */
  closeTimeoutMs?: number;
  /** Called with the full state after every change. */
  onChange?: (state: State) => void;
  /** Extra line appended to the history entry of a failed turn, keyed by
   * `ChatBridgeError.code`. Core's messages are CLI-flavoured (`Try
   * --headful.`); the extension adds the VSCode-side remedy. */
  hints?: Partial<Record<string, string>>;
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
  /** Turns sent while the controller was not ready, oldest first. */
  private queue: QueuedTurn[] = [];
  /** Bumped by every reopen; a send from an older generation is stale. */
  private generation = 0;
  /** The reopen in flight, so a second Ctrl+R joins it instead of racing. */
  private reopening: Promise<void> | undefined;
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
      queue: this.queue.map((q) => ({
        text: q.text,
        attachments: q.attachments.map(({ path, bytes }) => ({ path, bytes })),
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

  /** True when a turn can start right now. `dead` counts: an explicit
   * send is the user retrying, and only automatic draining must stop
   * while the controller is dead. */
  private get canStartTurn(): boolean {
    return (
      this.status === "idle" ||
      this.status === "closed" ||
      this.status === "dead"
    );
  }

  /** Sends the text plus the pending attachments as one turn, or queues it
   * when a turn is already running. Never throws: the outcome is the
   * result and the history. */
  async send(text: string): Promise<SendResult> {
    const body = text.trim() === "" ? "" : text;
    if (body === "" && this.pending.length === 0) return EMPTY;
    const attachments = this.pending;
    this.pending = [];
    if (!this.canStartTurn) {
      this.queue.push({ text: body, attachments });
      this.emit();
      return { ok: true, queued: true };
    }
    return this.startTurn({ text: body, attachments });
  }

  /** Pushes the user entry and runs the turn. Shared by send and drain. */
  private startTurn(turn: QueuedTurn): Promise<SendResult> {
    const sections = turn.attachments.map((a) =>
      formatAttachment(a.path, a.content),
    );
    const prompt = [turn.text, ...sections]
      .filter((s) => s !== "")
      .join("\n\n");
    this.push({
      role: "user",
      text: turn.text,
      attachments: turn.attachments.map(({ path, bytes }) => ({ path, bytes })),
    });
    this.lastPrompt = prompt;
    return this.runTurn(prompt);
  }

  /** Starts the oldest queued entry, if any. Called at every transition
   * back to a ready state, before the caller emits, so the webview never
   * sees an idle frame with a queue still waiting. */
  private drain(): void {
    const next = this.queue.shift();
    if (next === undefined) return;
    void this.startTurn(next);
  }

  /** Empties the queue back into the composer: the entries are returned
   * and their attachments become pending again. */
  takeBack(): QueueEntry[] {
    if (this.queue.length === 0) return [];
    const entries = this.queue.splice(0);
    for (const e of entries) this.pending.push(...e.attachments);
    this.emit();
    return entries.map((e) => ({
      text: e.text,
      attachments: e.attachments.map(({ path, bytes }) => ({ path, bytes })),
    }));
  }

  removeQueued(index: number): void {
    if (index < 0 || index >= this.queue.length) return;
    this.queue.splice(index, 1);
    this.emit();
  }

  /** Re-runs the last prompt after a recoverable fatal error (a missing
   * browser that was just installed). Drops the trailing error entry so
   * the history reads user → assistant. */
  async retryLast(): Promise<SendResult> {
    if (this.lastPrompt === undefined) return EMPTY;
    if (!this.canStartTurn) {
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
    const generation = this.generation;
    try {
      if (this.session === undefined) {
        this.setStatus("opening");
        const session = await this.opts.openSession();
        // A reopen ran while we were opening: this browser is an orphan.
        if (generation !== this.generation) {
          await closeOrKill(session, this.closeTimeoutMs);
          return { ok: true };
        }
        this.session = session;
      }
      this.setStatus("busy");
      const reply = await this.session.send(prompt);
      if (generation !== this.generation) return { ok: true }; // stale
      this.messages.push({ role: "assistant", text: reply });
      // Claim the next turn before emitting, so no idle frame is shown.
      this.status = "idle";
      this.drain();
      this.emit();
      return { ok: true };
    } catch (err) {
      if (generation !== this.generation) return { ok: true }; // stale
      return this.fail(err);
    }
  }

  private async fail(err: unknown): Promise<SendResult> {
    const code = err instanceof ChatBridgeError ? err.code : "UNKNOWN";
    const message = err instanceof Error ? err.message : String(err);
    const hint = this.opts.hints?.[code];
    this.messages.push({
      role: "error",
      text: hint === undefined ? message : `${message}\n${hint}`,
    });
    // Show the error before `dropSession` (up to `closeTimeoutMs`) runs.
    this.emit();
    if (code === "RESPONSE_TIMEOUT") {
      this.status = "idle";
      this.drain();
      this.emit();
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

  /** Ctrl+R of the TUI: drop the browser, mark the break, reopen lazily.
   * False when a turn is in flight, so the caller can warn. */
  async newChat(): Promise<boolean> {
    return this.discard("New chat");
  }

  /** Replaces the browser in every state. The in-flight turn, if any, is
   * abandoned: its result is dropped by the generation check. A second
   * call while one is running joins the first. */
  reopen(): Promise<void> {
    if (this.reopening) return this.reopening;
    const run = this.runReopen().finally(() => {
      this.reopening = undefined;
    });
    this.reopening = run;
    return run;
  }

  private async runReopen(): Promise<void> {
    this.generation++;
    this.setStatus("reopening");
    await this.dropSession();
    try {
      this.session = await this.opts.openSession();
      this.lastError = undefined;
      this.messages.push({ role: "separator", text: REOPENED_SEPARATOR });
      this.status = "idle";
      this.drain();
      this.emit();
    } catch (err) {
      const code = err instanceof ChatBridgeError ? err.code : "UNKNOWN";
      const message = err instanceof Error ? err.message : String(err);
      const hint = this.opts.hints?.[code];
      this.messages.push({
        role: "error",
        text: hint === undefined ? message : `${message}\n${hint}`,
      });
      this.lastError = code;
      this.setStatus("dead");
    }
  }

  /** Closes the session (if any) and pushes `separator`. Refused (returns
   * false) while a turn is in flight. Clears a dead state. */
  async discard(separator: string): Promise<boolean> {
    if (!this.canStartTurn) return false;
    await this.dropSession();
    this.lastError = undefined;
    // A fresh chat must not re-send a prompt from before the break.
    this.lastPrompt = undefined;
    this.status = "closed";
    this.messages.push({ role: "separator", text: separator });
    // The queue outlives the break: drain it into the new chat.
    this.drain();
    this.emit();
    return true;
  }

  /** After a successful login command: a dead controller may try again. */
  markLoggedIn(): void {
    if (this.status === "dead") {
      this.lastError = undefined;
      this.status = "closed";
    }
    this.messages.push({ role: "separator", text: "Logged in" });
    this.drain();
    this.emit();
  }

  /** deactivate: close the browser, keep the history. Idempotent. */
  async close(): Promise<void> {
    await this.dropSession();
    if (this.status !== "dead") this.status = "closed";
    this.emit();
  }
}
