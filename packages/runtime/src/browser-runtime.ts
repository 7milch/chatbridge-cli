import type { Provider } from "@chatbridge/provider";
import {
  type Browser,
  type BrowserContext,
  type Page,
  chromium,
} from "playwright";
import type { AuthStore } from "./auth-store";

export interface LaunchOptions {
  headless: boolean;
  provider: Provider;
  authStore: AuthStore;
}

/** Owns the Playwright lifecycle: browser, context (with restored auth
 * state), and a single page handed to Provider methods. */
export class BrowserRuntime {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly authStore: AuthStore,
  ) {}

  static async launch(opts: LaunchOptions): Promise<BrowserRuntime> {
    const browser = await chromium.launch({ headless: opts.headless });
    const storageState = opts.authStore.has()
      ? // Playwright accepts a file path for storageState.
        opts.authStore.path()
      : undefined;
    try {
      const context = await browser.newContext({ storageState });
      const page = await context.newPage();
      return new BrowserRuntime(browser, context, page, opts.authStore);
    } catch (err) {
      // Never leak a launched browser process when context/page setup fails.
      await browser.close();
      throw err;
    }
  }

  async saveAuthState(): Promise<void> {
    await this.authStore.save(await this.context.storageState());
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
