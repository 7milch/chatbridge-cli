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

/** A resume that had no handle to open, or a provider that cannot name its
 * conversations: the transcript is back, the service starts a new chat. */
export const TRANSCRIPT_ONLY_NOTE = "transcript only";
export const RESUMED_SEPARATOR = "resumed";

/** The separator a `/resume` leaves. Unlike a reopen it always carries a
 * note: a transcript on screen with no word on whether the service still
 * knows it would mislead. */
export function resumedSeparator(restored: boolean | undefined): string {
  return `${RESUMED_SEPARATOR} · ${restoreNote(restored) ?? TRANSCRIPT_ONLY_NOTE}`;
}
