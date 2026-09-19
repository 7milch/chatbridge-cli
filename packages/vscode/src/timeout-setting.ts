/** Mirrors the CLI's parseTimeoutMs: finite and > 0, else the default.
 * `invalid` is true when a value was set but unusable, so the caller can
 * warn once. */
export function parseTimeoutSec(
  raw: unknown,
  fallbackMs: number,
): { timeoutMs: number; invalid: boolean } {
  if (raw === undefined) return { timeoutMs: fallbackMs, invalid: false };
  const seconds = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { timeoutMs: fallbackMs, invalid: true };
  }
  return { timeoutMs: seconds * 1000, invalid: false };
}
