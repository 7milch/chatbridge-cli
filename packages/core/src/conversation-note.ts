/** Wording shared by the interactive UIs, so the TUI and the VSCode view
 * describe a restore the same way. */
export const RESTORED_NOTE = "conversation restored";
export const NOT_RESTORED_NOTE = "conversation could not be restored";

/** `undefined`: no restore was attempted, so there is nothing to say. */
export function restoreNote(restored: boolean | undefined): string | undefined {
  if (restored === undefined) return undefined;
  return restored ? RESTORED_NOTE : NOT_RESTORED_NOTE;
}

export function withRestoreNote(
  separator: string,
  restored: boolean | undefined,
): string {
  const note = restoreNote(restored);
  return note === undefined ? separator : `${separator} · ${note}`;
}
