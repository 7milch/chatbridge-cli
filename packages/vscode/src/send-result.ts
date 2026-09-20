import type { QueueEntry } from "./protocol.js";
import type { SendResult } from "./session-controller.js";

/** Refusals that sent nothing and left the typed text nowhere: the webview
 * empties the composer as it posts `send`, so the host has to hand the text
 * back. Every other failure happened after the turn was accepted, and the
 * history entry is the record of it. */
export const REFUSED_CODES: ReadonlySet<string> = new Set([
  "URL_HOOK",
  "REOPENED",
]);

/** What the extension does with the result of a send from the webview's
 * composer. Split out of the wiring so it has a unit test of its own. */
export function onSendResult(
  result: SendResult,
  text: string,
  pushTookBack: (entries: QueueEntry[]) => void,
): void {
  if (result.ok || !REFUSED_CODES.has(result.code)) return;
  pushTookBack([{ text, attachments: [] }]);
}
