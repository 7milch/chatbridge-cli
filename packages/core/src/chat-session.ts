import type { Page, Provider } from "@chatbridge/provider";
import {
  type AuthStore,
  BrowserRuntime,
  type LaunchOptions,
} from "@chatbridge/runtime";
import {
  AuthExpiredError,
  AuthRequiredError,
  InvalidStateError,
} from "./errors.js";
import { runStep } from "./run-step.js";

/** The part of BrowserRuntime a session needs; lets tests inject a fake. */
export interface RuntimeLike {
  readonly page: Page;
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
      const loggedIn = await runStep("isLoggedIn", timeoutMs, () =>
        provider.isLoggedIn(rt.page),
      );
      if (!loggedIn) {
        throw new AuthExpiredError(
          `Auth state for "${provider.name}" is no longer valid. Run \`auth login\` again.`,
        );
      }
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
    } finally {
      this.pending = false;
    }
  }

  /** Closes the browser. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.rt.close();
  }
}
