import { existsSync } from "node:fs";
import { chromium } from "playwright";

/** The path of the *headed* Chromium build (`chromium-<rev>`) when nothing
 * is installed there; `undefined` when it is present. It says nothing about
 * the headless shell (`chromium_headless_shell-<rev>`), which a
 * `--only-shell` install provides instead, so callers should use it as a
 * pre-check for headed launches only. Both inputs are injectable so the
 * check is testable without touching the real cache directory. */
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
