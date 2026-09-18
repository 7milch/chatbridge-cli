import {
  AuthExpiredError,
  AuthRequiredError,
  BrowserUnavailableError,
  InvalidStateError,
  LoginAbortedError,
  ResponseTimeoutError,
  closeOrKill,
  helpText,
  parseSlashCommand,
  unknownCommandMessage,
} from "@chatbridge/core";
import {
  type Attachment,
  type Expansion,
  MentionError,
  expandMentions,
} from "../mentions/expand-mentions.js";
import {
  formatShellPrompt,
  formatShellSection,
} from "../shell/format-result.js";
import {
  type RunOptions,
  type RunningCommand,
  type ShellResult,
  runCommand as runCommandDefault,
} from "../shell/run-command.js";
import {
  DEFAULT_SHELL_CONFIG,
  type ShellConfig,
} from "../shell/shell-config.js";

/** What the model needs from a ChatSession; lets tests inject a fake. */
export interface ChatSessionLike {
  send(prompt: string): Promise<string>;
  close(): Promise<void>;
  kill(): Promise<void>;
}

export type Role =
  | "user"
  | "assistant"
  | "error"
  | "separator"
  | "shell"
  | "help";
export interface Message {
  role: Role;
  text: string;
  /** Files appended to the prompt; the history shows one line per entry. */
  attachments?: Attachment[];
  /** `shell` entries: the command's result — updated live while it runs. */
  result?: ShellResult;
  /** `shell` entries: the result is waiting for the next submit. */
  held?: boolean;
  /** `shell` entries: the shell could not be started; outside a reset, the
   * error entry pushed right after it says why. */
  failed?: boolean;
}
/** opening: the first session is being opened; the UI is already up and
 * anything typed is queued. idle: accepting input. busy: a turn is in
 * flight; input is queued. running: a shell command is in flight (the input
 * box is locked to shell mode, Ctrl+C stops it); a message typed meanwhile
 * is queued too. resetting: the browser is being replaced. logging-in: a
 * `/login` browser window is open; Ctrl+C cancels it. dead: a fatal error
 * happened; only Ctrl+R (reset) or Ctrl+C (quit) make sense. */
export type Status =
  | "opening"
  | "idle"
  | "busy"
  | "running"
  | "resetting"
  | "logging-in"
  | "dead";

/** How long a reset waits for the old browser to close before killing it. */
export const RESET_CLOSE_TIMEOUT_MS = 5_000;
export const SEPARATOR_TEXT = "reopened";
/** `/new` marks the history with this instead of SEPARATOR_TEXT: the
 * browser is replaced either way, but the user asked for a fresh chat. */
export const NEW_CHAT_SEPARATOR = "new chat";
/** Remedies for the two failures a user can fix from inside the TUI. */
export const AUTH_HINT = "Type /login to log in.";
export const INSTALL_HINT = "Run: npx playwright install chromium";

export interface ChatModelOptions {
  /** Opens a session: called once by the constructor and by every reset.
   * The UI is up before it resolves, so an opening failure is an error
   * entry in the history rather than a crash before the first frame. */
  openSession: () => Promise<ChatSessionLike>;
  /** `/login`: the headful login; resolves when the auth state is saved. */
  login: (opts: {
    signal: AbortSignal;
    onProgress: (message: string) => void;
  }) => Promise<void>;
  /** `/logout`: deletes the saved auth state. */
  clearAuth: () => Promise<void>;
  /** Turns the typed text into the prompt to send. Default: expandMentions
   * against process.cwd(). Tests inject a fake. */
  expand?: (text: string) => Promise<Expansion>;
  /** Close cap before a reset kills the old browser. Tests shorten it. */
  closeTimeoutMs?: number;
  /** `!` shell mode settings. Default: DEFAULT_SHELL_CONFIG. */
  shell?: ShellConfig;
  /** Test-only: replaces runCommand. */
  runCommand?: (command: string, opts: RunOptions) => RunningCommand;
  /** Directory shell commands start in. Default: process.cwd(). */
  cwd?: string;
}

/** Conversation state for the interactive UI. No OpenTUI dependency. */
export class ChatModel {
  readonly messages: Message[] = [];
  status: Status = "opening";
  /** The last fatal error; the reason the model is `dead`. Cleared by a
   * successful reset. Reported by the app when the user quits. */
  fatal: unknown = undefined;
  /** Results waiting for the next submit (autoSend: false). */
  readonly heldResults: ShellResult[] = [];
  /** Messages typed while a turn or a shell command was in flight (or the
   * model was resetting or dead), trimmed, in arrival order. Drained one
   * entry per turn. */
  readonly queue: string[] = [];
  /** Called after every state change. */
  onChange: () => void = () => {};
  /** Resolves when the initial open settled (idle or dead). Never rejects,
   * so teardown can always wait for it. */
  readonly ready: Promise<void>;
  /** The last progress line from the running login, for the status row. */
  loginProgress: string | undefined;
  /** Where a turn that ended while `/login` was running left the model.
   * The login owns the status meanwhile, so the turn records its outcome
   * here and runLogin restores it instead of the status it captured. */
  private settledDuringLogin: Status | undefined;
  /** Undefined until the first open succeeds, and between a reset's close
   * and the replacement. */
  private current: ChatSessionLike | undefined;
  /** The AbortController of the running login, or undefined when none. */
  private loginAbort: AbortController | undefined;
  /** Bumped by every reset; a send from an older generation is stale and
   * its outcome is dropped. */
  private generation = 0;
  /** The reset currently in flight, so teardown can wait for the new
   * session to exist before closing it. */
  private pending: Promise<void> | undefined;
  /** The shell command in flight, so stopShell() and reset() can end it. */
  private running: RunningCommand | undefined;
  private readonly openSession: () => Promise<ChatSessionLike>;
  private readonly login: ChatModelOptions["login"];
  private readonly clearAuth: () => Promise<void>;
  private readonly expand: (text: string) => Promise<Expansion>;
  private readonly closeTimeoutMs: number;
  private readonly shell: ShellConfig;
  private readonly runCommand: (
    command: string,
    opts: RunOptions,
  ) => RunningCommand;
  private readonly cwd: string;

  constructor(opts: ChatModelOptions) {
    this.openSession = opts.openSession;
    this.login = opts.login;
    this.clearAuth = opts.clearAuth;
    this.expand =
      opts.expand ?? ((text) => expandMentions(text, process.cwd()));
    this.closeTimeoutMs = opts.closeTimeoutMs ?? RESET_CLOSE_TIMEOUT_MS;
    this.shell = opts.shell ?? DEFAULT_SHELL_CONFIG;
    this.runCommand = opts.runCommand ?? runCommandDefault;
    this.cwd = opts.cwd ?? process.cwd();
    // Last: openInitial may settle synchronously enough to touch the
    // fields above.
    this.ready = this.openInitial();
  }

  /** The session in use right now; teardown closes this one. Undefined
   * while the first open is in flight, and after it failed. */
  get session(): ChatSessionLike | undefined {
    return this.current;
  }

  /** The eager first open. Anything typed meanwhile is queued by submit()
   * and drained here, so startup never swallows input. A reset (Ctrl+R,
   * `/new`, `/reopen`, `/logout`) typed meanwhile takes over: this open is
   * then stale, and the session it produces would be a second live browser
   * nobody ever closes. */
  private async openInitial(): Promise<void> {
    const generation = this.generation;
    let session: ChatSessionLike;
    try {
      session = await this.openSession();
    } catch (err) {
      if (generation !== this.generation) return; // stale: reset ran
      this.messages.push({ role: "error", text: this.describe(err) });
      this.fatal = err;
      this.status = "dead";
      this.onChange();
      return;
    }
    if (generation !== this.generation) {
      await closeOrKill(session, this.closeTimeoutMs);
      return; // stale: the reset owns the session now
    }
    this.current = session;
    this.status = "idle";
    this.drain();
    this.onChange();
  }

  /** Error text plus the TUI-side remedy for the failures a user can fix
   * without leaving the app. */
  private describe(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AuthRequiredError || err instanceof AuthExpiredError) {
      return `${message}\n${AUTH_HINT}`;
    }
    if (err instanceof BrowserUnavailableError) {
      return `${message}\n${INSTALL_HINT}`;
    }
    return message;
  }

  /** The session for a send; only reachable from `idle`, where it exists.
   * The guard keeps that invariant honest instead of asserting it away. */
  private requireSession(): ChatSessionLike {
    if (this.current === undefined) {
      throw new InvalidStateError("No chat session is open.");
    }
    return this.current;
  }

  /** Sends one turn, or queues the text when the model is not idle (a turn,
   * a shell command, a reset or a fatal error). Resolves true when the
   * message was taken (sent or queued: the view clears the textarea), false
   * when it was ignored — blank input — or blocked by a mention problem,
   * which is shown as an error entry without sending. Held shell results go
   * out with the message, after the expanded prompt. */
  async submit(text: string): Promise<boolean> {
    const prompt = text.trim();
    if (!prompt) {
      return false;
    }
    // A command is never queued: it acts on the model itself, so it runs in
    // whatever state the model is in.
    const slash = parseSlashCommand(prompt);
    if (slash) return this.runSlash(slash);
    if (this.status !== "idle") {
      this.queue.push(prompt);
      this.onChange();
      return true;
    }
    return this.runTurn(prompt, false);
  }

  /** Ends a turn: moves to the settled status and continues the queue.
   * While `/login` is running the login owns the status and the browser
   * window, so the outcome is only recorded — restoring `idle` here would
   * overwrite `logging-in`, drain the queue onto the old session and turn
   * Ctrl+C from "cancel the login" into "quit". `drains` is false for the
   * one end that deliberately does not continue: a MentionError put the
   * entry back at the front of the queue. */
  private settle(status: "idle" | "dead", drains = true): void {
    if (this.status === "logging-in") {
      this.settledDuringLogin = status;
      return;
    }
    this.status = status;
    if (status === "idle" && drains) this.drain();
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
        this.settle("idle", false);
      } else {
        this.fatal = err;
        this.settle("dead");
      }
      this.onChange();
      return false;
    }
    const message: Message = { role: "user", text: prompt };
    if (expansion.attachments.length > 0) {
      message.attachments = expansion.attachments;
    }
    this.messages.push(message);
    let outgoing = expansion.prompt;
    // The held results ride along but are released only when the reply
    // arrives: a timeout returns to idle for a retry, and that retry must
    // carry them again.
    const carriesHeld = this.heldResults.length > 0;
    if (carriesHeld) {
      outgoing = [outgoing, ...this.heldResults.map(formatShellSection)].join(
        "\n\n",
      );
    }
    this.onChange();
    await this.sendPrompt(outgoing, carriesHeld);
    return true;
  }

  /** Runs one shell command from `idle`. The entry is pushed at once and
   * its `result` is updated as output arrives. When it finishes the result
   * is sent under the lead-in (autoSend) or held for the next submit.
   * Resolves false when ignored: blank command, or not idle — unlike a
   * message, a command typed while something is in flight is dropped rather
   * than queued, so it never runs against a state the user cannot see. */
  async runShell(command: string): Promise<boolean> {
    const cmd = command.trim();
    if (!cmd || this.status !== "idle") return false;
    // Only to fail loudly if `idle` ever stops implying an open session.
    this.requireSession();
    this.status = "running";
    const entry: Message = {
      role: "shell",
      text: cmd,
      result: {
        command: cmd,
        output: "",
        droppedBytes: 0,
        exitCode: undefined,
        interrupted: false,
        durationMs: 0,
      },
    };
    this.messages.push(entry);
    this.onChange();
    const generation = this.generation;
    let result: ShellResult;
    // Only this run's own handle may be cleared: stop() does not settle
    // `done` synchronously, so a command stopped by a reset can settle
    // after the next one has started, and clearing then would leave the
    // new command un-stoppable.
    let running: RunningCommand | undefined;
    try {
      running = this.runCommand(cmd, {
        cwd: this.cwd,
        onOutput: (output) => {
          if (entry.result) entry.result = { ...entry.result, output };
          this.onChange();
        },
      });
      this.running = running;
      result = await running.done;
    } catch (err) {
      if (this.running === running) this.running = undefined;
      // The entry belongs to the history, which survives a reset, so it is
      // marked — and the view told — even when the reset makes the rest
      // stale and no error entry is pushed.
      entry.failed = true;
      if (generation !== this.generation) {
        this.onChange();
        return true; // stale: reset ran
      }
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({
        role: "error",
        text: `could not start shell: ${message}`,
      });
      // A turn end like any other: anything typed while the command was
      // starting is next in line.
      this.settle("idle");
      this.onChange();
      return true;
    }
    if (this.running === running) this.running = undefined;
    // The entry belongs to the history, which survives a reset, so it
    // always gets the final result (an interrupted one after a reset).
    entry.result = result;
    if (generation !== this.generation) {
      this.onChange();
      return true; // stale: reset ran; nothing is sent or held
    }
    if (!this.shell.autoSend) {
      this.heldResults.push(result);
      entry.held = true;
      // The result is held before draining, so a queued message carries it
      // out exactly as a typed one would.
      this.settle("idle");
      this.onChange();
      return true;
    }
    this.status = "busy";
    this.onChange();
    await this.sendPrompt(formatShellPrompt(this.shell.leadIn, result));
    return true;
  }

  /** Stops the running shell command; no-op in every other state. The
   * command settles as interrupted and runShell continues from there. */
  stopShell(): void {
    this.running?.stop();
  }

  /** The send half of a turn, shared by runTurn and runShell. The caller has
   * already set `busy` and notified the view. Draining happens here, so
   * every turn end — typed, queued or auto-sent — continues the queue
   * exactly once. `releasesHeld`: the prompt carries the held shell
   * results; they are released when the reply arrives, so a failed or
   * stale send keeps them for the next message. */
  private async sendPrompt(
    prompt: string,
    releasesHeld = false,
  ): Promise<void> {
    const session = this.requireSession();
    const generation = this.generation;
    try {
      const reply = await session.send(prompt);
      if (generation !== this.generation) return; // stale: reset ran
      if (releasesHeld) this.releaseHeld();
      this.messages.push({ role: "assistant", text: reply });
      this.settle("idle");
    } catch (err) {
      if (generation !== this.generation) return; // stale: reset ran
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({ role: "error", text: message });
      // A timeout leaves the browser usable; anything else ends the session.
      if (err instanceof ResponseTimeoutError) {
        this.settle("idle");
      } else {
        this.fatal = err;
        this.settle("dead");
      }
    }
    // settle() claimed the next turn before the view sees this one end, so
    // it never draws an idle frame with entries still waiting.
    this.onChange();
  }

  /** Forgets the held results and clears the flag on their entries. Runs
   * before drain(), so a queued entry never re-attaches them. */
  private releaseHeld(): void {
    this.heldResults.length = 0;
    for (const m of this.messages) if (m.held) m.held = false;
  }

  /** Removes every queued entry and returns them in order, for the view to
   * put back into the input box. */
  takeBack(): string[] {
    if (this.queue.length === 0) return [];
    const entries = this.queue.splice(0);
    this.onChange();
    return entries;
  }

  /** Runs one `/command`. Resolves like submit(): true when the input was
   * taken, false for an unknown command, which the view refills so the
   * user can fix the typo. */
  private async runSlash(
    slash: NonNullable<ReturnType<typeof parseSlashCommand>>,
  ): Promise<boolean> {
    if ("unknown" in slash) {
      this.messages.push({
        role: "error",
        text: unknownCommandMessage(slash.unknown),
      });
      this.onChange();
      return false;
    }
    switch (slash.command) {
      case "help":
        this.messages.push({ role: "help", text: helpText() });
        this.onChange();
        return true;
      case "new":
        await this.reset(NEW_CHAT_SEPARATOR);
        return true;
      case "reopen":
        await this.reset();
        return true;
      case "logout": {
        // Announced before the reset, so the history reads in the order the
        // steps happened even when reopening then fails.
        this.messages.push({ role: "separator", text: "Logged out" });
        this.onChange();
        try {
          await this.clearAuth();
        } catch (err) {
          // The auth state is still on disk, so the session is still valid:
          // say so and leave both alone rather than closing a usable chat.
          this.messages.push({ role: "error", text: this.describe(err) });
          this.onChange();
          return true;
        }
        await this.reset();
        return true;
      }
      case "login":
        await this.runLogin();
        return true;
    }
  }

  /** `/login`. Ignored while one is already running: there is a single
   * browser window and a second one would fight over the auth state. On
   * success the session is reopened so the new auth state is used. */
  private async runLogin(): Promise<void> {
    if (this.loginAbort) return;
    const ac = new AbortController();
    // Claimed before the first await, so a `/login` typed while the open
    // below settles is ignored like any other second one.
    this.loginAbort = ac;
    try {
      // The status the login returns to has to be one the model can leave
      // again: `opening` and `resetting` belong to work in flight, and
      // restoring either would strand the model there forever. Let that
      // work settle first and go back to whatever it produced. A loop, not
      // one check: a reset starting during the wait puts the model back
      // into `resetting`.
      while (this.status === "opening" || this.status === "resetting") {
        await (this.status === "opening" ? this.ready : this.pendingReset);
      }
      // A reset in that window already aborted this controller, and the
      // login below would only learn of it through a listener it has yet to
      // register — it would never settle. Report it as cancelled here.
      if (ac.signal.aborted) {
        this.messages.push({ role: "separator", text: "Login cancelled" });
        this.onChange();
        return;
      }
      const previous = this.status;
      this.settledDuringLogin = undefined;
      this.status = "logging-in";
      this.onChange();
      try {
        await this.login({
          signal: ac.signal,
          onProgress: (message) => {
            this.loginProgress = message;
            this.onChange();
          },
        });
        this.messages.push({ role: "separator", text: "Logged in" });
        this.loginProgress = undefined;
        this.status = this.settledDuringLogin ?? previous;
        // The guard is still held: a `/login` typed during this reset would
        // otherwise open a second browser window to log in with.
        await this.reset();
        return;
      } catch (err) {
        this.messages.push(
          err instanceof LoginAbortedError
            ? { role: "separator", text: "Login cancelled" }
            : {
                role: "error",
                text: err instanceof Error ? err.message : String(err),
              },
        );
        // Only when nothing else has claimed the model since: a reset that
        // cancelled this login owns the status now. A turn that ended
        // during the login left its outcome in `settledDuringLogin`; that
        // is where the model really is, and its queue is still waiting.
        if (this.status === "logging-in") {
          this.status = this.settledDuringLogin ?? previous;
          if (this.status === "idle") this.drain();
        }
      }
      this.onChange();
    } finally {
      this.loginAbort = undefined;
      this.loginProgress = undefined;
      this.settledDuringLogin = undefined;
    }
  }

  /** Ctrl+C during `/login`; the login rejects with LoginAbortedError. No-op
   * in every other state. */
  cancelLogin(): void {
    this.loginAbort?.abort();
  }

  /** The in-flight reset, or undefined when none is running. Teardown awaits
   * it so the session it opens is not leaked. */
  get pendingReset(): Promise<void> | undefined {
    return this.pending;
  }

  /** Replaces the browser: close-or-kill the current session, open a new
   * one, mark the history. Works in every state — the main use is a hung
   * page mid-turn. A running shell command is stopped first and its output
   * is neither sent nor held. Ignored while a reset is already running. On
   * failure the model is `dead` with the reopen error as `fatal`. */
  reset(separator: string = SEPARATOR_TEXT): Promise<void> {
    if (this.status === "resetting") return Promise.resolve();
    // A login holds a browser window the user is no longer waiting on; the
    // reset wins, and runLogin reports it as cancelled.
    this.cancelLogin();
    // runReset sets the status synchronously, so the guard above rejects a
    // second Ctrl+R in the same tick.
    const run = this.runReset(separator);
    this.pending = run;
    return run.finally(() => {
      if (this.pending === run) this.pending = undefined;
    });
  }

  private async runReset(separator: string): Promise<void> {
    this.stopShell();
    this.status = "resetting";
    this.generation++;
    this.onChange();
    const old = this.current;
    // Undefined when the first open failed: there is nothing to close.
    if (old !== undefined) await closeOrKill(old, this.closeTimeoutMs);
    this.current = undefined;
    try {
      this.current = await this.openSession();
      this.messages.push({ role: "separator", text: separator });
      this.fatal = undefined;
      this.status = "idle";
      this.drain();
    } catch (err) {
      this.messages.push({ role: "error", text: this.describe(err) });
      this.fatal = err;
      this.status = "dead";
    }
    this.onChange();
  }
}
