import type {
  Page,
  Provider,
  ProviderCommandResult,
  ProviderConversation,
} from "@chatbridge/provider";
import {
  type AuthStore,
  BrowserRuntime,
  type LaunchOptions,
} from "@chatbridge/runtime";
import { closeOrKill } from "./close-session.js";
import {
  AuthExpiredError,
  AuthRequiredError,
  BlockedError,
  BrowserUnavailableError,
  InvalidStateError,
  ResponseTimeoutError,
} from "./errors.js";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  type IdleOptions,
  IdleWatch,
  formatIdleDuration,
} from "./idle-watch.js";
import { launchRuntime } from "./launch-runtime.js";
import { runStep } from "./run-step.js";

/** The part of BrowserRuntime a session needs; lets tests inject a fake. */
export interface RuntimeLike {
  readonly page: Page;
  saveAuthState(): Promise<void>;
  close(): Promise<void>;
  kill(): Promise<void>;
}

/** Resolved knobs for the opening phase. */
export interface OpenOptions {
  /** Per-step timeout for goto / isLoggedIn / startNewChat. */
  timeoutMs: number;
  /** Re-runs of the whole phase after a retryable failure. */
  retries: number;
}

/** How long the idle close waits for a clean close before killing the
 * browser. The same 5 s cap the UIs use for a reset. */
export const IDLE_CLOSE_BUDGET_MS = 5_000;

/** Default interval between `streaming.responseText` polls. */
export const DEFAULT_POLL_INTERVAL_MS = 250;

/** How long a turn may wait for the provider to name its conversation. */
export const HANDLE_BUDGET_MS = 5_000;

/** Resolves `fallback` when `p` has not settled within `ms`. The two
 * `conversation` hooks are best effort and run on a page the framework does
 * not control, so neither may park an open or a finished turn forever;
 * `runStep` only renames a Playwright timeout, it does not impose one. */
function withBudget<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const capped = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  // `p` may still reject after the budget expired, with nobody left to
  // receive it; this handler keeps that from becoming an unhandled rejection
  // without hiding a rejection that wins the race.
  void p.catch(() => {});
  return Promise.race([p, capped]).finally(() => clearTimeout(timer));
}

export interface SendOptions {
  /** Interactive UIs only. Receives the whole reply text so far — not a
   * delta — each time it changes, while the turn is pending. Never called
   * after `send` settles. Needs `provider.streaming`; without it, or without
   * this callback, the turn is not polled at all. */
  onPartial?: (textSoFar: string) => void;
}

export interface ChatSessionOptions {
  provider: Provider;
  authStore: AuthStore;
  headless: boolean;
  timeoutMs: number;
  /** Opening-phase knobs. Default: `{ timeoutMs, retries: 0 }`, which is
   * the pre-0.8.3 behaviour. */
  open?: OpenOptions;
  /** Interactive callers only. A handle from an earlier session's
   * `conversation` getter: the opening phase restores that conversation
   * instead of starting a new chat, when the provider has `conversation`.
   * Restoring never fails the open; see `restored`. */
  conversation?: string;
  /** Progress messages (stderr in the CLI). Never receives auth content. */
  onProgress?: (message: string) => void;
  /** Progress messages for the opening phase only (attempt lines). Defaults
   * to `onProgress`. The TUI splits the two: opening messages paint the live
   * status row, while later ones (from `close()`) are buffered for stderr. */
  onOpenProgress?: (message: string) => void;
  /** Test-only: replaces BrowserRuntime.launch. */
  launch?: (opts: LaunchOptions) => Promise<RuntimeLike>;
  /** Test-only: replaces the missing-browser pre-check. Defaults to the
   * runtime check for headed launches, and to "present" for headless
   * launches or when `launch` is injected. */
  missingBrowserExecutable?: () => string | undefined;
  /** Resolved idle timeout. Absent: the provider's `idle.timeoutMs`, then
   * 24 h. 0 disables the idle close entirely. Interactive callers only;
   * one-shot mode never opens a session long enough to matter. */
  idle?: IdleOptions;
  /** Called synchronously when the idle period expires, before anything is
   * awaited, so the UI has dropped its reference by the time the browser
   * starts closing. `closing` settles when that close (or its kill fallback)
   * has finished, and never rejects: a UI that is torn down meanwhile waits
   * for it, so the process does not exit under the auth-state save. */
  onIdleExpired?: (closing: Promise<void>) => void;
  /** Test-only: the clock the idle watch compares against. */
  idleNow?: () => number;
  /** Test-only: how often the idle watch checks its deadline. */
  idleTickMs?: number;
  /** Test-only: the wait between two `streaming.responseText` polls. */
  pollSleep?: (ms: number) => Promise<void>;
}

/** The default missing-browser pre-check looks for the *headed*
 * `chromium-<rev>` binary, but a headless session launches
 * `chromium_headless_shell-<rev>`: on a `playwright install chromium
 * --only-shell` machine the pre-check would reject a launch that works.
 * So it runs for headed launches only; a genuinely missing headless shell
 * is still caught by launchRuntime's `isMissingExecutableError` fallback.
 * An injected `launch` (tests) never needs one. */
export function needsHeadedPreCheck(opts: {
  launch?: unknown;
  headless: boolean;
}): boolean {
  return opts.launch === undefined && !opts.headless;
}

/** A conversation that keeps the browser open across turns. Turns are
 * sequential: `send` rejects while a previous send is pending. */
export class ChatSession {
  private pending = false;
  private closed = false;
  private killed = false;
  /** Undefined when the idle close is disabled (timeout 0). */
  private idleWatch: IdleWatch | undefined;
  /** The close in flight, so a second close joins it rather than
   * returning while the first is still saving the auth state. */
  private closing: Promise<void> | undefined;
  /** Outcome of the opening phase's restore; see the `restored` getter. */
  private restoredFlag: boolean | undefined;
  /** Last known conversation handle; see the `conversation` getter. */
  private handle: string | undefined;

  private constructor(
    private readonly rt: RuntimeLike,
    private readonly provider: Provider,
    private readonly timeoutMs: number,
    private readonly pollSleep: (ms: number) => Promise<void>,
    private readonly onProgress?: (message: string) => void,
  ) {}

  /** What `send` resolves with, for the UI to pick a renderer. */
  get responseFormat(): "markdown" | "text" {
    return this.provider.responseFormat ?? "text";
  }

  /** Handle of the conversation on the page, as of the last successful
   * turn. A UI keeps it to pass as `conversation` on its next open. */
  get conversation(): string | undefined {
    return this.handle;
  }

  /** `true`: the opening phase restored `opts.conversation`. `false`: it
   * tried and fell back to a new chat. `undefined`: nothing to restore. */
  get restored(): boolean | undefined {
    return this.restoredFlag;
  }

  /** Arms the idle close, unless the resolved timeout disables it. */
  private startIdleWatch(opts: ChatSessionOptions): void {
    const timeoutMs =
      opts.idle?.timeoutMs ??
      opts.provider.idle?.timeoutMs ??
      DEFAULT_IDLE_TIMEOUT_MS;
    if (timeoutMs <= 0) return;
    this.idleWatch = new IdleWatch({
      timeoutMs,
      now: opts.idleNow,
      tickMs: opts.idleTickMs,
      onExpire: () => {
        // Fires from a timer: there is no caller to reject, and the UI's
        // callback is not ours to trust with an exception.
        void this.expireIdle(timeoutMs, opts.onIdleExpired).catch(() => {});
      },
    });
  }

  /** The idle close. The UI is told first and synchronously, so it has
   * dropped this session before anything awaits: from here `send` and
   * `runCommand` reject as closed. A normal close runs first, to save the
   * rotated auth state; a wedged page is killed after the budget. The UI
   * also gets the promise of this close, because it no longer holds the
   * session to join it. */
  private async expireIdle(
    timeoutMs: number,
    onIdleExpired: ((closing: Promise<void>) => void) | undefined,
  ): Promise<void> {
    let settle!: () => void;
    const closing = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      onIdleExpired?.(closing);
      this.onProgress?.(
        `Closing the browser after ${formatIdleDuration(timeoutMs)} idle...`,
      );
      await closeOrKill(this, IDLE_CLOSE_BUDGET_MS);
    } finally {
      settle();
    }
  }

  /** isLoggedIn → true: return. false: ask detectBlock (when the provider
   * has it); a description means BlockedError, otherwise AuthExpiredError.
   * Both provider calls run under runStep so a hang maps to a timeout. */
  private static async assertLoggedIn(
    provider: Provider,
    page: Page,
    timeoutMs: number,
  ): Promise<void> {
    const loggedIn = await runStep("isLoggedIn", timeoutMs, () =>
      provider.isLoggedIn(page),
    );
    if (loggedIn) return;
    const detectBlock = provider.detectBlock;
    const block = detectBlock
      ? await runStep("detectBlock", timeoutMs, () =>
          detectBlock.call(provider, page),
        )
      : undefined;
    if (block !== undefined) {
      throw new BlockedError(`Blocked by "${provider.name}": ${block}.`);
    }
    throw new AuthExpiredError(
      `Auth state for "${provider.name}" is no longer valid. Run \`auth login\` again.`,
    );
  }

  /** authStore.has(), then up to `open.retries + 1` attempts of the opening
   * phase (see `attempt`). A retryable failure closes the browser and opens
   * again; the last attempt's error propagates unchanged. */
  static async open(opts: ChatSessionOptions): Promise<ChatSession> {
    const { provider, authStore, onProgress, timeoutMs } = opts;
    if (!authStore.has()) {
      throw new AuthRequiredError(
        `No saved auth state for provider "${provider.name}". Run \`auth login\` first.`,
      );
    }
    // No explicit knobs: fall back to the provider's own defaults (a caller
    // like the VSCode extension never passes `open`), then to no retries.
    const open = opts.open ?? {
      timeoutMs: provider.open?.timeoutMs ?? timeoutMs,
      retries: provider.open?.retries ?? 0,
    };
    const reportOpen = opts.onOpenProgress ?? onProgress;
    const launch =
      opts.launch ?? ((o: LaunchOptions) => BrowserRuntime.launch(o));
    const preCheck =
      opts.missingBrowserExecutable ??
      (needsHeadedPreCheck(opts) ? undefined : () => undefined);
    const attempts = open.retries + 1;
    for (let attempt = 1; ; attempt++) {
      reportOpen?.(
        attempt === 1
          ? "Opening browser..."
          : `Opening browser... (attempt ${attempt}/${attempts})`,
      );
      try {
        const { rt, restored } = await ChatSession.attempt(
          () => launch({ headless: opts.headless, provider, authStore }),
          preCheck,
          provider,
          open.timeoutMs,
          opts.conversation,
        );
        // The opening phase set the page default to open.timeoutMs; turns
        // run under --timeout, so hand the page back to that budget.
        rt.page.setDefaultTimeout(timeoutMs);
        const session = new ChatSession(
          rt,
          provider,
          timeoutMs,
          opts.pollSleep ??
            ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
          onProgress,
        );
        session.restoredFlag = restored;
        // Only a restored conversation is the one on the page; a fallback
        // starts a new chat, whose handle the first turn will name.
        if (restored === true) session.handle = opts.conversation;
        // Only once the opening phase succeeded: a session that never
        // opened has no browser to close.
        session.startIdleWatch(opts);
        return session;
      } catch (err) {
        if (attempt >= attempts || !isRetryableOpenError(err)) throw err;
        // The error is about to be swallowed by the next attempt; leave a
        // trace so a retried failure is not invisible.
        reportOpen?.(
          `Attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** One opening attempt: launch → goto chatUrl → isLoggedIn → restore the
   * conversation, or startNewChat. If any step after launch fails, the
   * browser is closed before the error propagates. */
  private static async attempt(
    launch: () => Promise<RuntimeLike>,
    preCheck: (() => string | undefined) | undefined,
    provider: Provider,
    timeoutMs: number,
    conversation: string | undefined,
  ): Promise<{ rt: RuntimeLike; restored: boolean | undefined }> {
    const rt = await launchRuntime(launch, preCheck);
    try {
      rt.page.setDefaultTimeout(timeoutMs);
      await runStep("goto", timeoutMs, () => rt.page.goto(provider.chatUrl));
      await ChatSession.assertLoggedIn(provider, rt.page, timeoutMs);
      let restored: boolean | undefined;
      if (conversation !== undefined && provider.conversation !== undefined) {
        restored = await ChatSession.restore(
          provider,
          provider.conversation,
          rt.page,
          conversation,
          timeoutMs,
        );
        // The failed restore may have left the page anywhere.
        if (!restored) {
          await runStep("goto", timeoutMs, () =>
            rt.page.goto(provider.chatUrl),
          );
        }
      }
      if (restored !== true) {
        await runStep("startNewChat", timeoutMs, () =>
          provider.startNewChat(rt.page),
        );
      }
      return { rt, restored };
    } catch (err) {
      // A failing close must not mask the step error that caused it.
      await rt.close().catch(() => {});
      throw err;
    }
  }

  /** True when the page now shows the conversation. Every failure is a
   * `false`, never a throw: a conversation that cannot be restored costs the
   * user the context, not the session. A provider's `open` must not be able
   * to park the session on another site, or on nothing at all, either. */
  private static async restore(
    provider: Provider,
    conversation: ProviderConversation,
    page: Page,
    handle: string,
    timeoutMs: number,
  ): Promise<boolean> {
    try {
      const opened = await withBudget(
        runStep("openConversation", timeoutMs, () =>
          conversation.open(page, handle),
        ).then(() => true),
        timeoutMs,
        false,
      );
      if (!opened) return false;
      return new URL(page.url()).origin === new URL(provider.chatUrl).origin;
    } catch {
      // The error may name the conversation, so it is dropped here rather
      // than reported: the handle never reaches a message or a log.
      return false;
    }
  }

  /** sendMessage → waitForResponse for one turn. A timeout leaves the
   * session usable; the caller may send again.
   *
   * With `opts.onPartial` and a provider that has `streaming`, the reply text
   * so far is reported while the turn is pending (see `pollPartial`); the
   * resolved value, completion and timeouts are unaffected. */
  async send(prompt: string, opts: SendOptions = {}): Promise<string> {
    if (this.closed) {
      throw new InvalidStateError("ChatSession is closed.");
    }
    if (this.pending) {
      throw new InvalidStateError("A send is already in progress.");
    }
    this.pending = true;
    this.idleWatch?.pause();
    try {
      this.onProgress?.("Sending prompt...");
      await runStep("sendMessage", this.timeoutMs, () =>
        this.provider.sendMessage(this.rt.page, prompt),
      );
      this.onProgress?.("Waiting for response...");
      const waiting = runStep("waitForResponse", this.timeoutMs, () =>
        this.provider.waitForResponse(this.rt.page),
      );
      this.pollPartial(waiting, opts.onPartial);
      const reply = await waiting;
      await this.refreshConversation();
      return reply;
    } catch (err) {
      if (err instanceof ResponseTimeoutError) await this.diagnoseTimeout();
      throw err;
    } finally {
      this.pending = false;
      this.idleWatch?.resume();
    }
  }

  /** After a turn: a new chat only gets its id once the first reply exists.
   * Best effort, and capped well below the turn timeout: the reply is
   * already here and must not wait on a wedged page. */
  private async refreshConversation(): Promise<void> {
    const conversation = this.provider.conversation;
    if (conversation === undefined) return;
    const budget = Math.min(this.timeoutMs, HANDLE_BUDGET_MS);
    try {
      const handle = await withBudget(
        runStep("conversationHandle", budget, () =>
          conversation.handle(this.rt.page),
        ),
        budget,
        undefined,
      );
      if (typeof handle === "string" && handle !== "") this.handle = handle;
    } catch {
      // Keep the previous handle. The error may name the conversation, so
      // it is dropped rather than reported.
    }
  }

  /** Feeds `onPartial` while `waiting` is pending. Completion, the final text
   * and the timeout all stay with `waitForResponse`; this only reads. One
   * poll at a time, and nothing is emitted once the turn has settled — the
   * loop is not awaited, so a `responseText` parked on a wedged page costs
   * the turn nothing. */
  private pollPartial(
    waiting: Promise<unknown>,
    onPartial: ((textSoFar: string) => void) | undefined,
  ): void {
    const streaming = this.provider.streaming;
    if (onPartial === undefined || streaming === undefined) return;
    let settled = false;
    const done = () => {
      settled = true;
    };
    // Both handlers: the derived promise resolves either way, so a turn that
    // times out leaves no unhandled rejection behind.
    waiting.then(done, done);
    const interval = streaming.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    void (async () => {
      let last: string | undefined;
      while (!settled) {
        // The sleep leads every iteration, so a throwing responseText retries
        // on the next tick rather than spinning.
        await this.pollSleep(interval);
        if (settled) return;
        let text: string | undefined;
        try {
          text = await streaming.responseText(this.rt.page);
        } catch {
          continue; // a node detached mid-read; the next poll sees the new one
        }
        if (settled) return;
        if (typeof text !== "string" || text === last) continue;
        last = text;
        try {
          onPartial(text);
        } catch {
          // The UI's callback is not ours to trust with the turn.
        }
      }
    })();
  }

  /** Runs one provider `/command` on the chat page. Same guards as `send`:
   * one thing at a time on the page. The result is returned untouched: a
   * `send` result is the UI's to send (it owns the turn and its history),
   * never core's. A timeout runs the same login diagnosis as a slow turn. */
  async runCommand(name: string, args: string): Promise<ProviderCommandResult> {
    if (this.closed) {
      throw new InvalidStateError("ChatSession is closed.");
    }
    if (this.pending) {
      throw new InvalidStateError("A send is already in progress.");
    }
    const command = this.provider.commands?.find((c) => c.name === name);
    if (command === undefined) {
      throw new InvalidStateError(`Unknown provider command "/${name}".`);
    }
    this.pending = true;
    this.idleWatch?.pause();
    try {
      this.onProgress?.(`Running /${name}...`);
      return await runStep(`command:${name}`, this.timeoutMs, () =>
        command.run(this.rt.page, args),
      );
    } catch (err) {
      if (err instanceof ResponseTimeoutError) await this.diagnoseTimeout();
      throw err;
    } finally {
      this.pending = false;
      this.idleWatch?.resume();
    }
  }

  /** A timeout may really be a lost login. Throws AuthExpiredError or
   * BlockedError when the page is no longer logged in; returns when it
   * still is, or when the check itself fails (the caller then rethrows the
   * original timeout, which stays the primary failure). */
  private async diagnoseTimeout(): Promise<void> {
    try {
      await ChatSession.assertLoggedIn(
        this.provider,
        this.rt.page,
        this.timeoutMs,
      );
    } catch (err) {
      if (err instanceof AuthExpiredError || err instanceof BlockedError) {
        throw err;
      }
      // Anything else (page gone, a second timeout): swallow; the caller
      // rethrows the original ResponseTimeoutError.
    }
  }

  /** Closes the browser, first saving the current storage state when the page
   * is still logged in (services rotate tokens, so the state saved at login
   * goes stale). A lost login or a failed save is reported via onProgress and
   * never blocks the close. Idempotent, and *joinable*: a caller that arrives
   * while the idle close is still saving the auth state waits for it rather
   * than exiting underneath it. */
  async close(): Promise<void> {
    // Before the join: a kill leaves the earlier close parked forever on the
    // hung page, and joining it would cost the caller another close budget.
    if (this.killed) return;
    if (this.closing !== undefined) return this.closing;
    if (this.closed) return;
    this.closed = true;
    this.idleWatch?.stop();
    const run = this.runClose();
    this.closing = run;
    return run;
  }

  private async runClose(): Promise<void> {
    try {
      const ok = await runStep("isLoggedIn", this.timeoutMs, () =>
        this.provider.isLoggedIn(this.rt.page),
      );
      if (ok) {
        await this.rt.saveAuthState();
      } else {
        this.onProgress?.(
          "Session is no longer logged in; auth state not saved.",
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onProgress?.(`Could not save auth state: ${message}`);
    } finally {
      await this.rt.close();
    }
  }

  /** Force-ends the browser without saving the auth state: the page is
   * presumed hung, so `isLoggedIn` cannot be trusted.
   *
   * A kill always wins: it runs even while a `close()` is still parked on the
   * hung page (the usual case — the caller falls back to kill after a close
   * timed out). That `close()` then fails its `isLoggedIn`, swallows the
   * error, and its `rt.close()` is a no-op after the kill. A `close()` started
   * after a kill is a no-op, and a second `kill()` is a no-op. */
  async kill(): Promise<void> {
    if (this.killed) return;
    this.killed = true;
    this.closed = true;
    this.idleWatch?.stop();
    await this.rt.kill();
  }
}

/** Auth, block and missing-Chromium failures cannot be fixed by opening
 * again; everything else (launch errors, step timeouts, page errors) can. */
export function isRetryableOpenError(err: unknown): boolean {
  return !(
    err instanceof AuthRequiredError ||
    err instanceof AuthExpiredError ||
    err instanceof BlockedError ||
    err instanceof BrowserUnavailableError
  );
}
