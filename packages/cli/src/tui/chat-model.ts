import { ResponseTimeoutError } from "@chatbridge/core";
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
import { closeOrKill } from "./close-session.js";

/** What the model needs from a ChatSession; lets tests inject a fake. */
export interface ChatSessionLike {
  send(prompt: string): Promise<string>;
  close(): Promise<void>;
  kill(): Promise<void>;
}

export type Role = "user" | "assistant" | "error" | "separator" | "shell";
export interface Message {
  role: Role;
  text: string;
  /** Files appended to the prompt; the history shows one line per entry. */
  attachments?: Attachment[];
  /** `shell` entries: the command's result — updated live while it runs. */
  result?: ShellResult;
  /** `shell` entries: the result is waiting for the next submit. */
  held?: boolean;
}
/** idle: accepting input. busy: a turn is in flight; input is queued.
 * running: a shell command is in flight (the input box is locked to shell
 * mode, Ctrl+C stops it); a message typed meanwhile is queued too.
 * resetting: the browser is being replaced. dead: a fatal error happened;
 * only Ctrl+R (reset) or Ctrl+C (quit) make sense. */
export type Status = "idle" | "busy" | "running" | "resetting" | "dead";

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
  status: Status = "idle";
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
  private current: ChatSessionLike;
  /** Bumped by every reset; a send from an older generation is stale and
   * its outcome is dropped. */
  private generation = 0;
  /** The reset currently in flight, so teardown can wait for the new
   * session to exist before closing it. */
  private pending: Promise<void> | undefined;
  /** The shell command in flight, so stopShell() and reset() can end it. */
  private running: RunningCommand | undefined;
  private readonly openSession: () => Promise<ChatSessionLike>;
  private readonly expand: (text: string) => Promise<Expansion>;
  private readonly closeTimeoutMs: number;
  private readonly shell: ShellConfig;
  private readonly runCommand: (
    command: string,
    opts: RunOptions,
  ) => RunningCommand;
  private readonly cwd: string;

  constructor(session: ChatSessionLike, opts: ChatModelOptions) {
    this.current = session;
    this.openSession = opts.openSession;
    this.expand =
      opts.expand ?? ((text) => expandMentions(text, process.cwd()));
    this.closeTimeoutMs = opts.closeTimeoutMs ?? RESET_CLOSE_TIMEOUT_MS;
    this.shell = opts.shell ?? DEFAULT_SHELL_CONFIG;
    this.runCommand = opts.runCommand ?? runCommandDefault;
    this.cwd = opts.cwd ?? process.cwd();
  }

  /** The session in use right now; teardown closes this one. */
  get session(): ChatSessionLike {
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
      if (generation !== this.generation) return true; // stale: reset ran
      const message = err instanceof Error ? err.message : String(err);
      this.messages.push({
        role: "error",
        text: `could not start shell: ${message}`,
      });
      this.status = "idle";
      // A turn end like any other: anything typed while the command was
      // starting is next in line.
      this.drain();
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
      this.status = "idle";
      // The result is held before draining, so a queued message carries it
      // out exactly as a typed one would.
      this.drain();
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
    const session = this.current;
    const generation = this.generation;
    try {
      const reply = await session.send(prompt);
      if (generation !== this.generation) return; // stale: reset ran
      if (releasesHeld) this.releaseHeld();
      this.messages.push({ role: "assistant", text: reply });
      this.status = "idle";
    } catch (err) {
      if (generation !== this.generation) return; // stale: reset ran
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
    this.stopShell();
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
