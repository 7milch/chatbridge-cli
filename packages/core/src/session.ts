import type { Provider } from "@chatbridge/provider";
import { type AuthStore, BrowserRuntime } from "@chatbridge/runtime";
import { ChatSession } from "./chat-session.js";
import { runStep } from "./run-step.js";
export { runStep };

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
}

const LOGIN_NAVIGATION_TIMEOUT_MS = 30_000;

/** Headful login flow: the user logs in manually; we poll for completion. */
export async function runLogin(opts: LoginOptions): Promise<void> {
  const { provider, authStore, onProgress } = opts;
  onProgress?.("Opening browser...");
  const rt = await BrowserRuntime.launch({
    headless: false,
    provider,
    authStore,
  });
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
