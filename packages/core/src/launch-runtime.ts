import {
  isMissingExecutableError,
  missingBrowserExecutable,
} from "@chatbridge/runtime";
import { BrowserUnavailableError } from "./errors.js";

/** Runs a browser launch under the missing-Chromium classification: a
 * failed pre-check throws before anything is spawned, and a launch that
 * still fails with Playwright's missing-executable error is wrapped. Every
 * other failure passes through unchanged. */
export async function launchRuntime<T>(
  launch: () => Promise<T>,
  missing: () => string | undefined = missingBrowserExecutable,
): Promise<T> {
  const path = missing();
  if (path !== undefined) {
    throw new BrowserUnavailableError(
      `Chromium is not installed (expected at ${path}).`,
    );
  }
  try {
    return await launch();
  } catch (err) {
    if (isMissingExecutableError(err)) {
      const firstLine = (err as Error).message.split("\n")[0];
      throw new BrowserUnavailableError(
        `Chromium is not installed: ${firstLine}`,
        { cause: err },
      );
    }
    throw err;
  }
}
