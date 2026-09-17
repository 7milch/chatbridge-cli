import type { Provider } from "@chatbridge/provider";
import {
  type AuthStore,
  BrowserRuntime,
  type LaunchOptions,
} from "@chatbridge/runtime";
import { ChatSession, type RuntimeLike } from "./chat-session.js";
import { LoginAbortedError } from "./errors.js";
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
  /** Cancels the login: polling stops, the browser is killed, the promise
   * rejects with LoginAbortedError. */
  signal?: AbortSignal;
  /** Test-only: replaces BrowserRuntime.launch. */
  launch?: (opts: LaunchOptions) => Promise<RuntimeLike>;
  /** Test-only: see ChatSessionOptions.missingBrowserExecutable. */
  missingBrowserExecutable?: () => string | undefined;
  /** Test-only: isLoggedIn poll interval; default 1 000 ms. */
  pollIntervalMs?: number;
}

const LOGIN_NAVIGATION_TIMEOUT_MS = 30_000;
const LOGIN_POLL_INTERVAL_MS = 1_000;

/** Resolves after `ms`, or rejects with LoginAbortedError as soon as the
 * signal aborts, so a cancel never waits out the interval. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new LoginAbortedError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Headful login flow: the user logs in manually; we poll for completion.
 * No overall deadline (MFA may take a while); `signal` cancels. */
export async function runLogin(opts: LoginOptions): Promise<void> {
  const { provider, authStore, onProgress, signal } = opts;
  if (signal?.aborted) throw new LoginAbortedError();
  onProgress?.("Opening browser...");
  const launch = opts.launch ?? BrowserRuntime.launch;
  const rt = await launchRuntime(
    () => launch({ headless: false, provider, authStore }),
    opts.missingBrowserExecutable ??
      (opts.launch ? () => undefined : undefined),
  );
  let aborted = false;
  try {
    if (signal?.aborted) throw new LoginAbortedError();
    rt.page.setDefaultTimeout(LOGIN_NAVIGATION_TIMEOUT_MS);
    await runStep("navigateToLogin", LOGIN_NAVIGATION_TIMEOUT_MS, () =>
      provider.navigateToLogin(rt.page),
    );
    onProgress?.(`Please log in to ${provider.name}.`);
    // isLoggedIn itself is not interruptible: an abort raised while it is
    // running takes effect at the next sleep, not mid-call.
    while (!(await provider.isLoggedIn(rt.page))) {
      await sleepUnlessAborted(
        opts.pollIntervalMs ?? LOGIN_POLL_INTERVAL_MS,
        signal,
      );
    }
    onProgress?.("✓ Login detected");
    await rt.saveAuthState();
    onProgress?.("✓ Session saved");
  } catch (err) {
    if (err instanceof LoginAbortedError) aborted = true;
    throw err;
  } finally {
    // A cancelled login presumes nothing about the page: kill, don't close.
    if (aborted) await rt.kill();
    else await rt.close();
  }
}
