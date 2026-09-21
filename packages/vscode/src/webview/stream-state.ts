import type { Message, Status } from "../protocol.js";

/** Identity of a rendered message: two messages with the same key render
 * the same DOM, so the node can be kept. */
export function messageKey(m: Message): string {
  return JSON.stringify([
    m.role,
    m.text,
    m.format ?? "text",
    m.incomplete === true,
    (m.attachments ?? []).map((a) => [a.path, a.bytes]),
  ]);
}

/** How many leading rendered messages survive a new state frame. The
 * history is append-mostly (a retry pops the trailing error), so a common
 * prefix is all the diff it needs. */
export function commonPrefix(
  prev: readonly string[],
  next: readonly string[],
): number {
  const max = Math.min(prev.length, next.length);
  let i = 0;
  while (i < max && prev[i] === next[i]) i++;
  return i;
}

/** The reply being streamed. `at` is the history length when it started:
 * a state frame with a different length means the turn moved on. */
export interface StreamState {
  text: string;
  format: "markdown" | "text";
  at: number;
}

export function onPartial(
  current: StreamState | undefined,
  text: string,
  format: "markdown" | "text",
  messageCount: number,
): StreamState {
  return { text, format, at: current?.at ?? messageCount };
}

/** A partial lives only while its own turn is in flight. */
export function onState(
  current: StreamState | undefined,
  status: Status,
  messageCount: number,
): StreamState | undefined {
  if (current === undefined) return undefined;
  return status === "busy" && messageCount === current.at ? current : undefined;
}
