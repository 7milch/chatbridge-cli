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

/** One-shot flow: restore auth -> new chat -> send -> wait -> return text. */
export async function runOneShot(opts: OneShotOptions): Promise<string> {
  const { provider, authStore, onProgress } = opts;
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
    rt.page.setDefaultTimeout(opts.timeoutMs);
    await rt.page.goto(provider.chatUrl);
    if (!(await provider.isLoggedIn(rt.page))) {
      throw new AuthExpiredError(
        `Auth state for "${provider.name}" is no longer valid. Run \`auth login\` again.`,
      );
    }
    await provider.startNewChat(rt.page);
    onProgress?.("Sending prompt...");
    await provider.sendMessage(rt.page, opts.prompt);
    onProgress?.("Waiting for response...");
    try {
      return await provider.waitForResponse(rt.page);
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new ResponseTimeoutError(
          `No complete response within ${opts.timeoutMs} ms.`,
        );
      }
      throw err;
    }
  } finally {
    await rt.close();
  }
}

export interface LoginOptions {
  provider: Provider;
  authStore: AuthStore;
  onProgress?: (message: string) => void;
}

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
    await provider.navigateToLogin(rt.page);
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
