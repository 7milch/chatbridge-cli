import type { Provider } from "@chatbridge/provider";
import { type AuthStore, BrowserRuntime } from "@chatbridge/runtime";
import {
  AuthExpiredError,
  AuthRequiredError,
  ResponseTimeoutError,
} from "./errors.js";

export interface OneShotOptions {
  provider: Provider;
  authStore: AuthStore;
  prompt: string;
  headless: boolean;
  timeoutMs: number;
  /** Progress messages (stderr in the CLI). Never receives auth content. */
  onProgress?: (message: string) => void;
}

/** Runs one browser step; a Playwright TimeoutError becomes a framework
 * ResponseTimeoutError that names the step and keeps the original as cause. */
export async function runStep<T>(
  name: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ResponseTimeoutError(
        `Timed out during ${name} after ${timeoutMs} ms.`,
        { cause: err },
      );
    }
    throw err;
  }
}

/** One-shot flow: restore auth -> new chat -> send -> wait -> return text. */
export async function runOneShot(opts: OneShotOptions): Promise<string> {
  const { provider, authStore, onProgress, timeoutMs } = opts;
  if (!authStore.has()) {
    throw new AuthRequiredError(
      `No saved auth state for provider "${provider.name}". Run \`auth login\` first.`,
    );
  }
  onProgress?.("Opening browser...");
  const rt = await BrowserRuntime.launch({
    headless: opts.headless,
    provider,
    authStore,
  });
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
    onProgress?.("Sending prompt...");
    await runStep("sendMessage", timeoutMs, () =>
      provider.sendMessage(rt.page, opts.prompt),
    );
    onProgress?.("Waiting for response...");
    return await runStep("waitForResponse", timeoutMs, () =>
      provider.waitForResponse(rt.page),
    );
  } finally {
    await rt.close();
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
