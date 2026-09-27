/** `<id>.saveSessions`: unset means on. `invalid` is true when a value was
 * set that is not a boolean, so the caller can warn once; saving stays on,
 * which is what an unset value does. */
export function parseSaveSessions(raw: unknown): {
  enabled: boolean;
  invalid: boolean;
} {
  if (raw === undefined) return { enabled: true, invalid: false };
  if (typeof raw !== "boolean") return { enabled: true, invalid: true };
  return { enabled: raw, invalid: false };
}
