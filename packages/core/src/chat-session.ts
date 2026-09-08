import type { Page, Provider } from "@chatbridge/provider";
import {
  type AuthStore,
  BrowserRuntime,
  type LaunchOptions,
} from "@chatbridge/runtime";
import {
  AuthExpiredError,
  AuthRequiredError,
  BlockedError,
  InvalidStateError,
  ResponseTimeoutError,
} from "./errors.js";
import { runStep } from "./run-step.js";

/** The part of BrowserRuntime a session needs; lets tests inject a fake. */
export interface RuntimeLike {
  readonly page: Page;
  saveAuthState(): Promise<void>;
  close(): Promise<void>;
}

export interface ChatSessionOptions {
  provider: Provider;
  authStore: AuthStore;
  headless: boolean;
  timeoutMs: number;
  /** Progress messages (stderr in the CLI). Never receives auth content. */
  onProgress?: (message: string) => void;
  /** Test-only: replaces BrowserRuntime.launch. */
  launch?: (opts: LaunchOptions) => Promise<RuntimeLike>;
}

/** A conversation that keeps the browser open across turns. Turns are
 * sequential: `send` rejects while a previous send is pending. */
export class ChatSession {
  private pending = false;
  private closed = false;

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
      throw new BlockedError(
        `Blocked by "${provider.name}": ${block}. Try --headful.`,
      );
    }
    throw new AuthExpiredError(
      `Auth state for "${provider.name}" is no longer valid. Run \`auth login\` again.`,
    );
  }

  /** authStore.has() → launch → goto chatUrl → isLoggedIn → startNewChat.
   * If any step after launch fails, the browser is closed first. */
  static async open(opts: ChatSessionOptions): Promise<ChatSession> {
    const { provider, authStore, onProgress, timeoutMs } = opts;
    if (!authStore.has()) {
      throw new AuthRequiredError(
        `No saved auth state for provider "${provider.name}". Run \`auth login\` first.`,
      );
    }
    onProgress?.("Opening browser...");
    const launch =
      opts.launch ?? ((o: LaunchOptions) => BrowserRuntime.launch(o));
    const rt = await launch({ headless: opts.headless, provider, authStore });
    try {
      rt.page.setDefaultTimeout(timeoutMs);
      await runStep("goto", timeoutMs, () => rt.page.goto(provider.chatUrl));
      await ChatSession.assertLoggedIn(provider, rt.page, timeoutMs);
      await runStep("startNewChat", timeoutMs, () =>
        provider.startNewChat(rt.page),
      );
    } catch (err) {
      await rt.close();
      throw err;
    }
    return new ChatSession(rt, provider, timeoutMs, onProgress);
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
}
