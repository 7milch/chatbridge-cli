import type {
  Page,
  Provider,
  ProviderCommandResult,
} from "@chatbridge/provider";
import {
  type AuthStore,
  BrowserRuntime,
  type LaunchOptions,
} from "@chatbridge/runtime";
import {
  AuthExpiredError,
  AuthRequiredError,
  BlockedError,
  BrowserUnavailableError,
  InvalidStateError,
  ResponseTimeoutError,
} from "./errors.js";
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

export interface ChatSessionOptions {
  provider: Provider;
  authStore: AuthStore;
  headless: boolean;
  timeoutMs: number;
  /** Opening-phase knobs. Default: `{ timeoutMs, retries: 0 }`, which is
   * the pre-0.8.3 behaviour. */
  open?: OpenOptions;
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

  private constructor(
    private readonly rt: RuntimeLike,
    private readonly provider: Provider,
    private readonly timeoutMs: number,
    private readonly onProgress?: (message: string) => void,
  ) {}

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
        const rt = await ChatSession.attempt(
          () => launch({ headless: opts.headless, provider, authStore }),
          preCheck,
          provider,
          open.timeoutMs,
        );
        // The opening phase set the page default to open.timeoutMs; turns
        // run under --timeout, so hand the page back to that budget.
        rt.page.setDefaultTimeout(timeoutMs);
        return new ChatSession(rt, provider, timeoutMs, onProgress);
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

  /** One opening attempt: launch → goto chatUrl → isLoggedIn →
   * startNewChat. If any step after launch fails, the browser is closed
   * before the error propagates. */
  private static async attempt(
    launch: () => Promise<RuntimeLike>,
    preCheck: (() => string | undefined) | undefined,
    provider: Provider,
    timeoutMs: number,
  ): Promise<RuntimeLike> {
    const rt = await launchRuntime(launch, preCheck);
    try {
      rt.page.setDefaultTimeout(timeoutMs);
      await runStep("goto", timeoutMs, () => rt.page.goto(provider.chatUrl));
      await ChatSession.assertLoggedIn(provider, rt.page, timeoutMs);
      await runStep("startNewChat", timeoutMs, () =>
        provider.startNewChat(rt.page),
      );
    } catch (err) {
      // A failing close must not mask the step error that caused it.
      await rt.close().catch(() => {});
      throw err;
    }
    return rt;
  }

  /** sendMessage → waitForResponse for one turn. A timeout leaves the
   * session usable; the caller may send again. */
  async send(prompt: string): Promise<string> {
    if (this.closed) {
      throw new InvalidStateError("ChatSession is closed.");
    }
    if (this.pending) {
      throw new InvalidStateError("A send is already in progress.");
    }
    this.pending = true;
    try {
      this.onProgress?.("Sending prompt...");
      await runStep("sendMessage", this.timeoutMs, () =>
        this.provider.sendMessage(this.rt.page, prompt),
      );
      this.onProgress?.("Waiting for response...");
      return await runStep("waitForResponse", this.timeoutMs, () =>
        this.provider.waitForResponse(this.rt.page),
      );
    } catch (err) {
      if (err instanceof ResponseTimeoutError) await this.diagnoseTimeout();
      throw err;
    } finally {
      this.pending = false;
    }
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
   * never blocks the close. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
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
