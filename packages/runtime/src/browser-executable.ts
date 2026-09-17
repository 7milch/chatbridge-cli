import { existsSync } from "node:fs";
import { chromium } from "playwright";

/** The path Playwright would launch, when nothing is installed there;
 * `undefined` when the browser is present. Both inputs are injectable so
 * the check is testable without touching the real cache directory. */
export function missingBrowserExecutable(
  executablePath: string = chromium.executablePath(),
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return exists(executablePath) ? undefined : executablePath;
}

/** Playwright reports a missing browser as a plain Error whose message
 * starts with this phrase, followed by its boxed install hint. Used as a
 * fallback when the pre-launch check passed (e.g. the headless shell is
 * missing while the full browser is present). */
export function isMissingExecutableError(err: unknown): boolean {
  return (
    err instanceof Error && err.message.includes("Executable doesn't exist at")
  );
}
