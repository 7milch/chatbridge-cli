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

/** The idle-close setting, in minutes. Unlike the step timeout, 0 is a
 * valid value: it turns the idle close off. `invalid` is true when a value
 * was set but unusable, so the caller can warn once. */
export function parseIdleTimeoutMin(
  raw: unknown,
  fallbackMs: number,
): { timeoutMs: number; invalid: boolean } {
  if (raw === undefined) return { timeoutMs: fallbackMs, invalid: false };
  const minutes = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return { timeoutMs: fallbackMs, invalid: true };
  }
  return { timeoutMs: minutes * 60_000, invalid: false };
}

/** The subset of `WorkspaceConfiguration.inspect()` we read. */
export interface InspectedSetting<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

/** The value the user actually set, most specific scope first, or undefined.
 * The manifest `default` is deliberately ignored: it exists so the Settings
 * UI can show the effective value, and must not shadow the vendor's
 * `createExtension` option. */
export function userSetting<T>(
  inspected: InspectedSetting<T> | undefined,
): T | undefined {
  if (!inspected) return undefined;
  return (
    inspected.workspaceFolderValue ??
    inspected.workspaceValue ??
    inspected.globalValue
  );
}
