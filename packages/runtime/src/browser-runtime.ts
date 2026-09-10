import type { Provider } from "@chatbridge/provider";
import {
  type BrowserContext,
  type BrowserServer,
  type Page,
  chromium,
} from "playwright";
import type { AuthStore } from "./auth-store.js";

export interface LaunchOptions {
  headless: boolean;
  provider: Provider;
  authStore: AuthStore;
}

/** Owns the Playwright lifecycle: browser, context (with restored auth
 * state), and a single page handed to Provider methods.
 *
 * The browser runs as its own process via `launchServer()` (rather than
 * `chromium.launch()`) specifically so `kill()` has a real process to
 * SIGKILL: a plain `Browser` from `launch()` does not expose its OS
 * process on the public Playwright API, but `BrowserServer` does. */
export class BrowserRuntime {
  private killed = false;

  private constructor(
    private readonly browserServer: BrowserServer,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly authStore: AuthStore,
  ) {}

  static async launch(opts: LaunchOptions): Promise<BrowserRuntime> {
    const browserServer = await chromium.launchServer({
      headless: opts.headless,
    });
    try {
      const browser = await chromium.connect(browserServer.wsEndpoint());
      try {
        const storageState = opts.authStore.has()
          ? // Playwright accepts a file path for storageState.
            opts.authStore.path()
          : undefined;
        const context = await browser.newContext({ storageState });
        const page = await context.newPage();
        return new BrowserRuntime(browserServer, context, page, opts.authStore);
      } catch (err) {
        // Never leak a connected browser when context/page setup fails.
        await browser.close().catch(() => {});
        throw err;
      }
    } catch (err) {
      // Never leak a launched browser process when connect/setup fails.
      await browserServer.close().catch(() => {});
      throw err;
    }
  }

  async saveAuthState(): Promise<void> {
    // Services may keep the session in IndexedDB; the default state excludes it.
    // Playwright throws if a service stores values it cannot serialise (e.g. Blobs).
    await this.authStore.save(
      await this.context.storageState({ indexedDB: true }),
    );
  }

  async close(): Promise<void> {
    // After kill(), the process is already gone; closing it again is
    // expected to reject and is not a real failure for the caller.
    if (this.killed) return;
    // Closes the actual browser process (not just this connection); the
    // connected `browser` client observes the resulting disconnect.
    await this.browserServer.close();
  }

  /** Force-ends the browser process (SIGKILL) and drops the connection.
   * For a wedged browser that `close()` cannot finish; nothing is saved.
   * No-op when the process is already gone. Never throws. */
  async kill(): Promise<void> {
    this.killed = true;
    await this.browserServer.kill().catch(() => {});
  }
}
