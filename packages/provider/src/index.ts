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

/** Provider preferences for the browser context the runtime creates. */
export interface ProviderBrowserDefaults {
  /** Emulated `prefers-reduced-motion`. Defaults to "reduce": an idle
   * headless page that keeps animating is rasterised on the CPU forever.
   * Set "no-preference" only when the service misbehaves under reduced
   * motion (an animation the completion detection keys on). */
  reducedMotion?: "reduce" | "no-preference";
}

/** Provider default for the idle lifetime of an interactive session. */
export interface ProviderIdleDefaults {
  /** After this long without a turn the browser is closed and the UI
   * reopens it on the next prompt. Built-in default 86 400 000 (24 h);
   * 0 disables. Users override it via config.json, an env var, or the
   * VSCode setting. */
  timeoutMs?: number;
}

/** What a provider command hands back. `show`: the UI prints `text` in the
 * history. `send`: the UI sends `prompt` as an ordinary turn; the history
 * keeps the `/command` line the user typed, the service alone sees the
 * prompt. */
export type ProviderCommandResult =
  | { kind: "show"; text: string }
  | { kind: "send"; prompt: string };

/** A `/command` a provider adds to the interactive UIs (TUI, VSCode). Not
 * available in one-shot mode. Runs on the chat page like every other
 * provider method, under the session timeout. */
export interface ProviderCommand {
  /** Typed as `/name`. Lower-case letters only; the built-in names
   * (BUILTIN_COMMAND_NAMES) are reserved. */
  name: string;
  /** One line for `/help`. */
  description: string;
  /** `args` is the rest of the line after the command word, trimmed; `""`
   * when there is none. May contain newlines. */
  run(page: Page, args: string): Promise<ProviderCommandResult>;
}

/** Commands the framework itself defines; a provider cannot redefine them.
 * Core's slash-command table is built from this list. */
export const BUILTIN_COMMAND_NAMES = [
  "login",
  "logout",
  "new",
  "reopen",
  "help",
] as const;

export interface UrlHookResult {
  /** The attachment line shown in the history, e.g. "Confluence: Title". */
  label: string;
  content: string;
}

/** Expands a URL typed in a message into an attachment. The framework never
 * fetches anything itself: `resolve` is the provider's, and so is whatever
 * credential it needs. The interactive UIs only. */
export interface UrlHook {
  /** Which URLs this hook takes. A RegExp is used with `.test`, so it must
   * not carry the `g` or `y` flag. */
  match: RegExp | ((url: string) => boolean);
  /** Return the content, or throw with a message meant for the user
   * ("403 from Confluence", "script not found"). Runs under the session
   * timeout. */
  resolve(url: string): Promise<UrlHookResult>;
}

/** Lets interactive UIs show the reply while it is being written. Core polls
 * `responseText` while `waitForResponse` is pending; completion, the final
 * text and timeouts still come from `waitForResponse`. */
export interface ProviderStreaming {
  /** Text so far of the reply to the most recent `sendMessage`, in
   * `responseFormat`. `undefined` while only a placeholder exists. Must
   * never return an earlier turn's text. */
  responseText(page: Page): Promise<string | undefined>;
  /** Poll interval in ms. Default 250. */
  pollIntervalMs?: number;
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
  /** Optional. What `waitForResponse` (and `streaming.responseText`) return.
   * "text" (default) is shown verbatim. "markdown" is rendered as Markdown
   * by UIs that support it; `elementToMarkdown` produces it from the DOM. */
  responseFormat?: "markdown" | "text";
  /** Optional. See ProviderStreaming. */
  streaming?: ProviderStreaming;
  /** Optional. A slow service may raise the opening timeout; a flaky one
   * may ask for retries. See ProviderOpenDefaults. */
  open?: ProviderOpenDefaults;
  /** Optional. Browser context preferences; see ProviderBrowserDefaults. */
  browser?: ProviderBrowserDefaults;
  /** Optional. Idle lifetime of an interactive session; see
   * ProviderIdleDefaults. */
  idle?: ProviderIdleDefaults;
  /** Optional. `/commands` for the interactive UIs, listed by `/help` after
   * the built-ins. Validated by defineProvider. */
  commands?: ProviderCommand[];
  /** Optional. Tried in order for every URL in a message; the first hook
   * whose `match` accepts the URL resolves it. Validated by defineProvider. */
  urlHooks?: UrlHook[];
}

const COMMAND_NAME = /^[a-z]+$/;
const BUILTINS: ReadonlySet<string> = new Set(BUILTIN_COMMAND_NAMES);

/** Identity helper with validation: gives provider authors type inference
 * and fails fast, at definition time, on a command list or URL hook the
 * UIs could not use. */
export function defineProvider(provider: Provider): Provider {
  const seen = new Set<string>();
  for (const c of provider.commands ?? []) {
    if (!COMMAND_NAME.test(c.name)) {
      throw new Error(
        `Provider command name "${c.name}" must match /^[a-z]+$/.`,
      );
    }
    if (BUILTINS.has(c.name)) {
      throw new Error(
        `Provider command "/${c.name}" collides with a built-in command.`,
      );
    }
    if (seen.has(c.name)) {
      throw new Error(`Provider command "/${c.name}" is defined twice.`);
    }
    seen.add(c.name);
  }
  for (const h of provider.urlHooks ?? []) {
    if (h.match instanceof RegExp && /[gy]/.test(h.match.flags)) {
      throw new Error(
        `URL hook RegExp ${h.match} must not use the g or y flag (it makes .test stateful).`,
      );
    }
  }
  const reducedMotion = provider.browser?.reducedMotion;
  if (
    reducedMotion !== undefined &&
    reducedMotion !== "reduce" &&
    reducedMotion !== "no-preference"
  ) {
    throw new Error(
      `Provider browser.reducedMotion must be "reduce" or "no-preference", got ${JSON.stringify(reducedMotion)}.`,
    );
  }
  const idleTimeout = provider.idle?.timeoutMs;
  if (
    idleTimeout !== undefined &&
    (!Number.isFinite(idleTimeout) || idleTimeout < 0)
  ) {
    throw new Error(
      `Provider idle.timeoutMs must be a non-negative finite number, got ${idleTimeout}.`,
    );
  }
  const format = provider.responseFormat;
  if (format !== undefined && format !== "markdown" && format !== "text") {
    throw new Error(
      `Provider responseFormat must be "markdown" or "text", got ${JSON.stringify(format)}.`,
    );
  }
  if (provider.streaming !== undefined) {
    if (typeof provider.streaming.responseText !== "function") {
      throw new Error("Provider streaming.responseText must be a function.");
    }
    const poll = provider.streaming.pollIntervalMs;
    if (poll !== undefined && (!Number.isFinite(poll) || poll <= 0)) {
      throw new Error(
        `Provider streaming.pollIntervalMs must be a finite number greater than 0, got ${poll}.`,
      );
    }
  }
  return provider;
}

export type { Page };
