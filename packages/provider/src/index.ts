import type { Page } from "playwright-core";

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
}

/** Identity helper: gives provider authors type inference and a future
 * validation hook without any runtime cost today. */
export function defineProvider(provider: Provider): Provider {
  return provider;
}

export type { Page };
