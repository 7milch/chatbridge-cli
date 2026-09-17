import { ResponseTimeoutError } from "@chatbridge/core";
import {
  type Attachment,
  type Expansion,
  MentionError,
  expandMentions,
} from "../mentions/expand-mentions.js";
import { closeOrKill } from "./close-session.js";

/** What the model needs from a ChatSession; lets tests inject a fake. */
export interface ChatSessionLike {
  send(prompt: string): Promise<string>;
  close(): Promise<void>;
  kill(): Promise<void>;
}

export type Role = "user" | "assistant" | "error" | "separator";
export interface Message {
  role: Role;
  text: string;
  /** Files appended to the prompt; the history shows one line per entry. */
  attachments?: Attachment[];
}
/** idle: accepting input. busy: a turn is in flight; input is queued.
 * resetting: the browser is being replaced. dead: a fatal error happened;
 * only Ctrl+R (reset) or Ctrl+C (quit) make sense. */
export type Status = "idle" | "busy" | "resetting" | "dead";

/** How long a reset waits for the old browser to close before killing it. */
export const RESET_CLOSE_TIMEOUT_MS = 5_000;
export const SEPARATOR_TEXT = "reopened";

export interface ChatModelOptions {
  /** Opens a replacement session for reset(). The first session is opened
   * by the caller before any UI exists so startup errors surface plainly. */
  openSession: () => Promise<ChatSessionLike>;
  /** Turns the typed text into the prompt to send. Default: expandMentions
   * against process.cwd(). Tests inject a fake. */
  expand?: (text: string) => Promise<Expansion>;
  /** Close cap before a reset kills the old browser. Tests shorten it. */
  closeTimeoutMs?: number;
}

/** Conversation state for the interactive UI. No OpenTUI dependency. */
export class ChatModel {
  readonly messages: Message[] = [];
  status: Status = "idle";
  /** The last fatal error; the reason the model is `dead`. Cleared by a
   * successful reset. Reported by the app when the user quits. */
  fatal: unknown = undefined;
  /** Messages typed while a turn was in flight (or the model was resetting
   * or dead), trimmed, in arrival order. Drained one entry per turn. */
  readonly queue: string[] = [];
  /** Called after every state change. */
  onChange: () => void = () => {};
  private current: ChatSessionLike;
  /** Bumped by every reset; a send from an older generation is stale and
   * its outcome is dropped. */
  private generation = 0;
  /** The reset currently in flight, so teardown can wait for the new
   * session to exist before closing it. */
  private pending: Promise<void> | undefined;
  private readonly openSession: () => Promise<ChatSessionLike>;
  private readonly expand: (text: string) => Promise<Expansion>;
  private readonly closeTimeoutMs: number;

  constructor(session: ChatSessionLike, opts: ChatModelOptions) {
    this.current = session;
    this.openSession = opts.openSession;
    this.expand =
      opts.expand ?? ((text) => expandMentions(text, process.cwd()));
    this.closeTimeoutMs = opts.closeTimeoutMs ?? RESET_CLOSE_TIMEOUT_MS;
  }

  /** The session in use right now; teardown closes this one. */
  get session(): ChatSessionLike {
    return this.current;
  }

  /** Sends one turn, or queues the text when the model is not idle. Resolves
   * true when the message was taken (sent or queued: the view clears the
   * textarea), false when it was ignored — blank input — or blocked by a
   * mention problem, which is shown as an error entry without sending. */
  async submit(text: string): Promise<boolean> {
    const prompt = text.trim();
    if (!prompt) {
      return false;
    }
    if (this.status !== "idle") {
      this.queue.push(prompt);
      this.onChange();
      return true;
    }
    return this.runTurn(prompt, false);
  }

  /** Sends the oldest queued entry as the next turn, if any. Called at every
   * transition to idle that may continue the conversation. */
  private drain(): void {
    const next = this.queue.shift();
    if (next === undefined) return;
    void this.runTurn(next, true);
  }

  /** One turn. `fromQueue` selects what a MentionError does with the text:
   * a typed message is refilled by the view (submit resolves false), a
   * dequeued entry goes back to the front of the queue and draining pauses
   * so the same failure is not retried until the next turn end. */
  private async runTurn(prompt: string, fromQueue: boolean): Promise<boolean> {
    // Claim the turn before awaiting, so a second Enter in the same tick is
    // queued by the guard in submit() instead of racing through expansion.
    // No onChange yet: nothing observable has changed for the view.
    this.status = "busy";
    let expansion: Expansion;
    try {
      expansion = await this.expand(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({ role: "error", text: message });
      // A mention problem is the user's to fix; anything else is a bug.
      if (err instanceof MentionError) {
        if (fromQueue) this.queue.unshift(prompt);
        this.status = "idle";
      } else {
        this.fatal = err;
        this.status = "dead";
      }
      this.onChange();
      return false;
    }
    const message: Message = { role: "user", text: prompt };
    if (expansion.attachments.length > 0) {
      message.attachments = expansion.attachments;
    }
    this.messages.push(message);
    this.onChange();
    const session = this.current;
    const generation = this.generation;
    try {
      const reply = await session.send(expansion.prompt);
      if (generation !== this.generation) return true; // stale: reset ran
      this.messages.push({ role: "assistant", text: reply });
      this.status = "idle";
    } catch (err) {
      if (generation !== this.generation) return true; // stale: reset ran
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({ role: "error", text: message });
      // A timeout leaves the browser usable; anything else ends the session.
      if (err instanceof ResponseTimeoutError) {
        this.status = "idle";
      } else {
        this.fatal = err;
        this.status = "dead";
      }
    }
    // Claim the next turn before the view sees this one end, so it never
    // draws an idle frame with entries still waiting. The one exception is a
    // MentionError on a dequeued entry: that puts the entry back at the front
    // of the queue while the model is idle, and the view shows the take-back
    // guide.
    if (this.status === "idle") this.drain();
    this.onChange();
    return true;
  }

  /** Removes every queued entry and returns them in order, for the view to
   * put back into the input box. */
  takeBack(): string[] {
    if (this.queue.length === 0) return [];
    const entries = this.queue.splice(0);
    this.onChange();
    return entries;
  }

  /** The in-flight reset, or undefined when none is running. Teardown awaits
   * it so the session it opens is not leaked. */
  get pendingReset(): Promise<void> | undefined {
    return this.pending;
  }

  /** Replaces the browser: close-or-kill the current session, open a new
   * one, mark the history. Works in every state — the main use is a hung
   * page mid-turn. Ignored while a reset is already running. On failure the
   * model is `dead` with the reopen error as `fatal`. */
  reset(): Promise<void> {
    if (this.status === "resetting") return Promise.resolve();
    // runReset sets the status synchronously, so the guard above rejects a
    // second Ctrl+R in the same tick.
    const run = this.runReset();
    this.pending = run;
    return run.finally(() => {
      if (this.pending === run) this.pending = undefined;
    });
  }

  private async runReset(): Promise<void> {
    this.status = "resetting";
    this.generation++;
    this.onChange();
    const old = this.current;
    await closeOrKill(old, this.closeTimeoutMs);
    try {
      this.current = await this.openSession();
      this.messages.push({ role: "separator", text: SEPARATOR_TEXT });
      this.fatal = undefined;
      this.status = "idle";
      this.drain();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({ role: "error", text: message });
      this.fatal = err;
      this.status = "dead";
    }
    this.onChange();
  }
}
