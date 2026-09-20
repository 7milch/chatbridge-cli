import {
  type Attachment,
  ChatBridgeError,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  type ProviderCommandResult,
  type ResolvedUrl,
  UrlHookError,
  closeOrKill,
  formatAttachment,
  totalSizeProblem,
} from "@chatbridge/core";
import type { Message, QueueEntry, State, Status } from "./protocol.js";

/** What the controller needs from a ChatSession; lets tests inject a fake. */
export interface ChatSessionLike {
  send(prompt: string): Promise<string>;
  runCommand?(name: string, args: string): Promise<ProviderCommandResult>;
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

/** Pushed when the idle timeout closed the browser; the next send reopens
 * it lazily, so the user is told the conversation starts over. */
export const IDLE_CLOSED_SEPARATOR = "closed after idle";

/** Controller-internal queue entry: the attachments keep their content. */
interface QueuedTurn {
  text: string;
  attachments: PendingAttachment[];
  /** Set for a provider `/command`; `text` is then the typed line. */
  command?: { name: string; args: string };
}

export type AddResult = { ok: true } | { ok: false; reason: string };

/** Error codes the extension can attach a remedy to. */
export type HintCode =
  | "BLOCKED"
  | "BROWSER_UNAVAILABLE"
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "RESPONSE_TIMEOUT";

export interface TakeBackResult {
  /** Every entry that was queued. `entries[i].attachments` lists everything
   * that entry carried, including attachments that were *not* restored to
   * pending: only their number is reported, in `droppedAttachments`. */
  entries: QueueEntry[];
  /** Attachments left out because restoring them would exceed MAX_TOTAL_BYTES. */
  droppedAttachments: number;
}

export interface SessionControllerOptions {
  /** Opens a ChatSession; called lazily on the first send after `closed`.
   * `onIdleExpired` is handed to the session so core can tell the
   * controller it closed the browser after the idle timeout. */
  openSession: (onIdleExpired: () => void) => Promise<ChatSessionLike>;
  /** How long newChat / discard / close wait before killing. Default 5 s. */
  closeTimeoutMs?: number;
  /** Called with the full state after every change. */
  onChange?: (state: State) => void;
  /** Extra line appended to the history entry of a failed turn, keyed by
   * `ChatBridgeError.code`. Core's messages carry no UI-specific remedy;
   * the extension adds the VSCode-side one. */
  hints?: Partial<Record<HintCode, string>>;
  /** URL hook expansion for the text of a turn; the extension builds it from
   * the provider's hooks and the timeout setting. Default: none. */
  expandUrls?: (text: string) => Promise<ResolvedUrl[]>;
}

export const CLOSE_TIMEOUT_MS = 5_000;

/** Errors a turn can fail with without ending the session: the browser is
 * still usable, so the controller returns to `idle` and drains its queue
 * instead of going `dead` and dropping the browser. */
export const NON_FATAL_CODES: ReadonlySet<string> = new Set([
  "RESPONSE_TIMEOUT",
  "COMMAND_UNAVAILABLE",
]);

const EMPTY: SendResult = {
  ok: false,
  code: "EMPTY",
  message: "Nothing to send.",
};

/** The stale-expansion refusal: the turn was claimed, then a reopen or a
 * close took the state over. Nothing was sent, so it is refused like a
 * hook refusal and the composer gets the text back. */
const REOPENED_STEM = "Reopened while resolving URLs; message not sent";
const REOPENED_MESSAGE = `${REOPENED_STEM}.`;

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
  /** The openSession in flight (first send or reopen), so close() can wait
   * for it instead of orphaning the browser it is about to produce. */
  private opening: Promise<ChatSessionLike> | undefined;
  /** True while a turn's URL hooks are being resolved: the turn is claimed
   * but no status change shows it yet, so a send arriving meanwhile must
   * queue rather than start a second turn. */
  private expanding = false;
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

  /** A `/help` listing, as a history entry. */
  pushHelp(text: string): void {
    this.push({ role: "help", text });
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
      return { ok: false, reason: totalSizeProblem(total) };
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
    if (this.expanding) return false;
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
    // A non-empty queue means the controller was not ready when the last
    // entry arrived and has not become ready since — every ready transition
    // drains first; `closed` after deactivate can still hold a queue, which
    // the next send queues behind. Either way, keep FIFO by queueing.
    if (!this.canStartTurn || this.queue.length > 0) {
      this.queue.push({ text: body, attachments });
      this.drain();
      this.emit();
      return { ok: true, queued: true };
    }
    return this.startTurn({ text: body, attachments });
  }

  /** Pushes the user entry and runs the turn (or the command). Shared by
   * send, runCommand and drain. `fromQueue` marks a turn `drain()` started:
   * its result has no caller, so a refusal cannot reach the composer. */
  private async startTurn(
    turn: QueuedTurn,
    fromQueue = false,
  ): Promise<SendResult> {
    // URL expansion is a network wait; a reopen or a close during it makes
    // this turn stale, and it must not open a browser of its own.
    const generation = this.generation;
    if (turn.command) {
      this.push({ role: "user", text: turn.text, attachments: [] });
      return this.runProviderCommand(turn.command, generation);
    }
    let attachments = turn.attachments;
    if (this.opts.expandUrls) {
      this.expanding = true;
      try {
        const urls = await this.opts.expandUrls(turn.text);
        if (generation !== this.generation) {
          // Stale: the reopen/close owns the state now. The turn is not
          // sent, and its attachments go back to the composer either way.
          // From the composer, the refusal below hands the text back, so
          // the entry does not repeat it. From the queue there is no caller
          // to refuse to, and a takeBack would overwrite whatever the user
          // is typing now, so the text stays in the entry instead.
          this.expanding = false;
          const dropped = this.restorePending(turn.attachments);
          const note =
            dropped === 0 ? "" : `\n${droppedAttachmentsLine(dropped)}`;
          const head = fromQueue
            ? `${REOPENED_STEM}: ${turn.text}`
            : REOPENED_MESSAGE;
          this.messages.push({
            role: "error",
            text: `${head}${note}`,
          });
          // Nothing else will run the entries queued behind this one. Only
          // from `idle`: a stale turn from `close()` must not open a browser
          // after deactivate.
          if (this.status === "idle") this.drain();
          this.emit();
          return { ok: false, code: "REOPENED", message: REOPENED_MESSAGE };
        }
        attachments = [
          ...attachments,
          ...urls.map((u) => ({
            path: u.label,
            bytes: u.bytes,
            content: u.content,
          })),
        ];
      } catch (err) {
        if (!(err instanceof UrlHookError)) throw err;
        // The user's to fix: report, send nothing, leave the status alone.
        const message = err.message;
        // Cleared here rather than only in `finally`, which runs after the
        // push and the drain below: both must see the turn released.
        this.expanding = false;
        // The composer was emptied by `send`; give the attachments back so
        // the user only has to re-type the text.
        const dropped = this.restorePending(turn.attachments);
        this.push({
          role: "error",
          text:
            dropped === 0
              ? message
              : `${message}\n${droppedAttachmentsLine(dropped)}`,
        });
        // Nothing else will run the entries that queued behind this one.
        this.drain();
        return { ok: false, code: "URL_HOOK", message };
      } finally {
        this.expanding = false;
      }
    }
    const sections = attachments.map((a) =>
      formatAttachment(a.path, a.content),
    );
    const prompt = [turn.text, ...sections]
      .filter((s) => s !== "")
      .join("\n\n");
    this.push({
      role: "user",
      text: turn.text,
      attachments: attachments.map(({ path, bytes }) => ({ path, bytes })),
    });
    this.lastPrompt = prompt;
    return this.runTurn(prompt, generation);
  }

  /** A provider `/command` from the webview. Queued like a message when a
   * turn is running; `text` is the line as typed, which is what the
   * history shows. */
  async runCommand(
    name: string,
    args: string,
    text: string,
  ): Promise<SendResult> {
    const turn: QueuedTurn = { text, attachments: [], command: { name, args } };
    if (!this.canStartTurn || this.queue.length > 0) {
      this.queue.push(turn);
      this.drain();
      this.emit();
      return { ok: true, queued: true };
    }
    return this.startTurn(turn);
  }

  /** Runs the command on the session (opening one lazily, like a turn).
   * `show` prints; `send` continues as an ordinary turn with the prompt. */
  private async runProviderCommand(
    command: { name: string; args: string },
    generation: number,
  ): Promise<SendResult> {
    this.lastError = undefined;
    // A `show` sets no prompt; leaving the previous turn's would make a
    // retryLast after a failure resend that message instead. A `send`
    // result sets it again below.
    this.lastPrompt = undefined;
    this.claimTurn();
    try {
      const session = await this.ensureSession(generation);
      if (session === undefined) return { ok: true }; // stale
      if (session.runCommand === undefined) {
        // Unreachable with the real ChatSession. A coded error keeps it out
        // of `fail()`'s fatal branch: a session that cannot run a command is
        // a caller bug, not a reason to close the user's browser.
        throw new ChatBridgeError(
          "COMMAND_UNAVAILABLE",
          `/${command.name} is not available in this session.`,
        );
      }
      if (this.status !== "busy") this.setStatus("busy");
      const result = await session.runCommand(command.name, command.args);
      if (generation !== this.generation) return { ok: true }; // stale
      if (result.kind === "show") {
        this.messages.push({ role: "help", text: result.text });
        // Claim the next turn before emitting, so no idle frame is shown.
        this.status = "idle";
        this.drain();
        this.emit();
        return { ok: true };
      }
      this.lastPrompt = result.prompt;
      return this.runTurn(result.prompt, generation);
    } catch (err) {
      if (generation !== this.generation) return { ok: true }; // stale
      return this.fail(err);
    }
  }

  /** Leaves a ready status synchronously, before the first await, so a
   * send arriving in the same tick queues instead of starting a second
   * turn on the session. */
  private claimTurn(): void {
    this.setStatus(this.session === undefined ? "opening" : "busy");
  }

  /** The open session, opening one when there is none. Undefined when a
   * reopen ran meanwhile (the caller's generation is stale). */
  private async ensureSession(
    generation: number,
  ): Promise<ChatSessionLike | undefined> {
    if (this.session !== undefined) return this.session;
    const session = await this.trackOpen(this.open());
    // A reopen ran while we were opening: this browser is an orphan.
    // dropSession may have closed it already; close/kill are idempotent.
    if (generation !== this.generation) {
      await closeOrKill(session, this.closeTimeoutMs);
      return undefined;
    }
    this.session = session;
    return session;
  }

  /** Starts the oldest queued entry, if any, when the controller is ready
   * for a turn. Called at every transition back to a ready state, before
   * the caller emits, so the webview never sees an idle frame with a
   * queue still waiting. */
  private drain(): void {
    // markLoggedIn() can arrive in any status; never start a second turn
    // on top of a running one. The other call sites are already ready.
    if (!this.canStartTurn) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    // A URL_HOOK failure here pushes its error entry and drops the entry:
    // the queue is not a composer, so there is nowhere to hand the text
    // back to — the user reads the error and re-types.
    void this.startTurn(next, true);
  }

  /** Puts attachments back in front of whatever is pending, skipping the
   * ones that no longer fit: `send` empties the composer before a turn's
   * expansion runs, so the user can have dropped files in meanwhile, and
   * forcing these back would leave a composer that refuses every further
   * attachment. Returns how many were left out. `place` is "back" for
   * `takeBack`, whose entries belong after what the user typed since. */
  private restorePending(
    list: readonly PendingAttachment[],
    place: "front" | "back" = "front",
  ): number {
    let total = this.pending.reduce((n, p) => n + p.bytes, 0);
    const kept: PendingAttachment[] = [];
    let dropped = 0;
    for (const a of list) {
      if (total + a.bytes > MAX_TOTAL_BYTES) {
        dropped++;
        continue;
      }
      total += a.bytes;
      kept.push(a);
    }
    this.pending =
      place === "front"
        ? [...kept, ...this.pending]
        : [...this.pending, ...kept];
    return dropped;
  }

  /** Empties the queue back into the composer: the entries are returned
   * and their attachments become pending again. */
  takeBack(): TakeBackResult {
    if (this.queue.length === 0) return { entries: [], droppedAttachments: 0 };
    const entries = this.queue.splice(0);
    // Oldest first, appended after what is already pending: the queue's
    // order is the user's, and restorePending puts each batch in front of
    // the batches still to come.
    const restored = entries.flatMap((e) => e.attachments);
    const dropped = this.restorePending(restored, "back");
    this.emit();
    return {
      entries: entries.map((e) => ({
        text: e.text,
        attachments: e.attachments.map(({ path, bytes }) => ({ path, bytes })),
      })),
      droppedAttachments: dropped,
    };
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
    return this.runTurn(this.lastPrompt, this.generation);
  }

  private async runTurn(
    prompt: string,
    generation: number,
  ): Promise<SendResult> {
    // A new turn supersedes whatever killed the previous one: a stale
    // `lastError` would keep the webview's error banner up after a
    // successful send from `dead`.
    this.lastError = undefined;
    this.claimTurn();
    try {
      const session = await this.ensureSession(generation);
      if (session === undefined) return { ok: true }; // stale
      if (this.status !== "busy") this.setStatus("busy");
      const reply = await session.send(prompt);
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

  /** Pushes the error entry (message plus the extension's remedy, if any)
   * and reports the code back to the caller. */
  private pushError(err: unknown): { code: string; message: string } {
    const code = err instanceof ChatBridgeError ? err.code : "UNKNOWN";
    const message = err instanceof Error ? err.message : String(err);
    const hint = this.opts.hints?.[code as HintCode];
    this.messages.push({
      role: "error",
      text: hint === undefined ? message : `${message}\n${hint}`,
    });
    return { code, message };
  }

  private async fail(err: unknown): Promise<SendResult> {
    const { code, message } = this.pushError(err);
    // Show the error before `dropSession` (up to `closeTimeoutMs`) runs.
    this.emit();
    if (NON_FATAL_CODES.has(code)) {
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

  /** Tracks an openSession so close()/dropSession can wait for it. */
  private async trackOpen(
    p: Promise<ChatSessionLike>,
  ): Promise<ChatSessionLike> {
    this.opening = p;
    try {
      return await p;
    } finally {
      if (this.opening === p) this.opening = undefined;
    }
  }

  /** One open, wired so this session's idle expiry reaches the controller.
   * The callback closes over a holder because the session does not exist
   * yet; comparing by identity later is what makes a stale session's
   * expiry a no-op. */
  private open(): Promise<ChatSessionLike> {
    let opened: ChatSessionLike | undefined;
    return this.opts
      .openSession(() => {
        if (opened !== undefined) this.idleExpired(opened);
      })
      .then((session) => {
        opened = session;
        return session;
      });
  }

  /** Core closed `session`'s browser after the idle timeout. It is already
   * closing, so the session is only forgotten here; the lazy open on the
   * next send does the rest. */
  private idleExpired(session: ChatSessionLike): void {
    if (this.session !== session) return; // stale: a reopen replaced it
    this.session = undefined;
    // A fresh chat must not re-send a prompt from before the break.
    this.lastPrompt = undefined;
    this.messages.push({ role: "separator", text: IDLE_CLOSED_SEPARATOR });
    this.setStatus("closed");
  }

  private async dropSession(): Promise<void> {
    // An open still in flight would assign `this.session` after we return,
    // so wait for it and close the browser it produced here: the caller
    // (close(), discard()) must not return with one still running.
    const opened = await this.opening?.catch(() => undefined);
    const old = this.session;
    this.session = undefined;
    if (old !== undefined) await closeOrKill(old, this.closeTimeoutMs);
    // The opener's own generation check will close this one too; close()
    // and kill() are idempotent, so closing it twice is harmless.
    else if (opened !== undefined) {
      await closeOrKill(opened, this.closeTimeoutMs);
    }
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
    const generation = ++this.generation;
    this.setStatus("reopening");
    await this.dropSession();
    try {
      const session = await this.trackOpen(this.open());
      // `close()` (deactivate) ran while the browser was opening: this one
      // is an orphan, and the controller is closed. dropSession may have
      // closed it already; close/kill are idempotent.
      if (generation !== this.generation) {
        await closeOrKill(session, this.closeTimeoutMs);
        return;
      }
      this.session = session;
      this.lastError = undefined;
      this.messages.push({ role: "separator", text: REOPENED_SEPARATOR });
      this.status = "idle";
      this.drain();
      this.emit();
    } catch (err) {
      const { code } = this.pushError(err);
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
    // A reopen in flight is stale from here on: its new browser must be
    // closed rather than adopted by a controller the user has shut down.
    this.generation++;
    await this.dropSession();
    if (this.status !== "dead") this.status = "closed";
    this.emit();
  }
}

/** Why attachments went missing, for the message the user reads (or hears):
 * a restore that no longer fits under MAX_TOTAL_BYTES, and the same thing
 * `takeBack` warns about in `create-extension.ts`. One helper so the two
 * sites cannot drift, with a real plural — a screen reader reads
 * "attachment(s)" out literally. Not exported from `index.ts`: internal. */
export function droppedAttachmentsLine(dropped: number): string {
  const noun = dropped === 1 ? "attachment" : "attachments";
  return `${dropped} ${noun} left out: total size limit.`;
}
