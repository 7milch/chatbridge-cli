import type { ChatBridgeError } from "@chatbridge/core";

/** Single source of truth for `ChatBridgeError.code` → process exit code. */
const EXIT_CODES: Record<string, number> = {
  INVALID_ARGUMENT: 1,
  INVALID_CONFIG: 1,
  AUTH_REQUIRED: 2,
  AUTH_EXPIRED: 3,
  RESPONSE_TIMEOUT: 4,
  PROVIDER_LOAD: 5,
  INVALID_PROVIDER: 5,
  INVALID_STATE: 1,
  BLOCKED: 6,
  BROWSER_UNAVAILABLE: 7,
  // Shell convention for "terminated by Ctrl-C".
  LOGIN_ABORTED: 130,
};

export function exitCodeFor(code: string): number {
  return EXIT_CODES[code] ?? 1;
}

export const INSTALL_HINT = "Run: npx playwright install chromium";

/** The stderr text for a framework error: the message, plus the install
 * hint when Chromium is missing. */
export function describeError(err: ChatBridgeError): string {
  return err.code === "BROWSER_UNAVAILABLE"
    ? `${err.message}\n${INSTALL_HINT}`
    : err.message;
}
