import type { Provider } from "@chatbridge/provider";
import {
  type AuthStore,
  BrowserRuntime,
  type LaunchOptions,
} from "@chatbridge/runtime";
import { ChatSession, type RuntimeLike } from "./chat-session.js";
import { launchRuntime } from "./launch-runtime.js";
import { runStep } from "./run-step.js";

export interface OneShotOptions {
  provider: Provider;
  authStore: AuthStore;
  prompt: string;
  headless: boolean;
  timeoutMs: number;
  /** Progress messages (stderr in the CLI). Never receives auth content. */
  onProgress?: (message: string) => void;
}

/** One-shot flow: one ChatSession turn, then close. */
export async function runOneShot(opts: OneShotOptions): Promise<string> {
  const session = await ChatSession.open(opts);
  try {
    return await session.send(opts.prompt);
  } finally {
    await session.close();
  }
}

export interface LoginOptions {
  provider: Provider;
  authStore: AuthStore;
  onProgress?: (message: string) => void;
  /** Test-only: replaces BrowserRuntime.launch. */
  launch?: (opts: LaunchOptions) => Promise<RuntimeLike>;
  /** Test-only: see ChatSessionOptions.missingBrowserExecutable. */
  missingBrowserExecutable?: () => string | undefined;
}

const LOGIN_NAVIGATION_TIMEOUT_MS = 30_000;

/** Headful login flow: the user logs in manually; we poll for completion. */
export async function runLogin(opts: LoginOptions): Promise<void> {
  const { provider, authStore, onProgress } = opts;
  onProgress?.("Opening browser...");
  const launch = opts.launch ?? BrowserRuntime.launch;
  const rt = await launchRuntime(
    () => launch({ headless: false, provider, authStore }),
    opts.missingBrowserExecutable ??
      (opts.launch ? () => undefined : undefined),
  );
  try {
    rt.page.setDefaultTimeout(LOGIN_NAVIGATION_TIMEOUT_MS);
    await runStep("navigateToLogin", LOGIN_NAVIGATION_TIMEOUT_MS, () =>
      provider.navigateToLogin(rt.page),
    );
    onProgress?.(`Please log in to ${provider.name}.`);
    // Poll until the provider reports completion. No overall deadline:
    // the user may need time for MFA; Ctrl-C aborts.
    while (!(await provider.isLoggedIn(rt.page))) {
      await rt.page.waitForTimeout(1000);
    }
    onProgress?.("✓ Login detected");
    await rt.saveAuthState();
    onProgress?.("✓ Session saved");
  } finally {
    await rt.close();
  }
}
