import type { Page } from "playwright-core";

/** Provider defaults for the opening phase (launch → goto → isLoggedIn →
 * startNewChat). Users override both via config.json and env vars. */
export interface ProviderOpenDefaults {
  /** Per-step timeout in milliseconds. Built-in default 120 000. */
  timeoutMs?: number;
  /** How many times the whole phase is re-run after a launch or
   * navigation failure. Built-in default 0. */
  retries?: number;
}

/**
 * A Provider implements all service-specific browser behaviour for one
 * web chat AI service. The framework owns the browser lifecycle and auth
 * state; the provider owns URLs, selectors, and completion detection.
 */
export interface Provider {
  /** Identifier; also names the auth-state storage file. */
  name: string;
  /** Chat page URL; the runtime navigates here before startNewChat. */
  chatUrl: string;
  /** Navigate to the login page (called during `auth login`, headful). */
  navigateToLogin(page: Page): Promise<void>;
  /** Login-completion check; also the auth-validity check at startup. */
  isLoggedIn(page: Page): Promise<boolean>;
  /** Bring the page to a state where a new chat can start. */
  startNewChat(page: Page): Promise<void>;
  /** Submit the prompt. Called once per turn on the same `Page` for a
   * multi-turn conversation. */
  sendMessage(page: Page, prompt: string): Promise<void>;
  /** Wait for response completion and return the response text. Must
   * return the response to the most recent `sendMessage` only, never an
   * earlier turn's. */
  waitForResponse(page: Page): Promise<string>;
  /** Optional. When the page shows a block that logging in again would not
   * clear (a bot challenge interstitial, an IdP refusing the automated
   * browser), return a short description of it; otherwise undefined. The
   * core calls this only after `isLoggedIn` returned false. Must not throw
   * on an ordinary logged-out page. */
  detectBlock?(page: Page): Promise<string | undefined>;
  /** Optional. A slow service may raise the opening timeout; a flaky one
   * may ask for retries. See ProviderOpenDefaults. */
  open?: ProviderOpenDefaults;
}

/** Identity helper: gives provider authors type inference and a future
 * validation hook without any runtime cost today. */
export function defineProvider(provider: Provider): Provider {
  return provider;
}

export type { Page };
