import type { StoredMessage } from "@chatbridge/core";
import type { Message } from "./protocol.js";

/** The stored form of the entries this view cannot express. Keyed by the
 * controller's own message objects, so an entry that leaves the history
 * is forgotten with it. */
export type Origins = WeakMap<Message, StoredMessage>;

export function toStored(
  messages: readonly Message[],
  origins: Origins,
): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (const m of messages) {
    // A command listing is not part of the conversation.
    if (m.role === "help") continue;
    const origin = origins.get(m);
    if (origin !== undefined) {
      out.push(origin);
      continue;
    }
    const stored: StoredMessage = { role: m.role, text: m.text };
    if (m.attachments !== undefined && m.attachments.length > 0) {
      stored.attachments = m.attachments.map(({ path, bytes }) => ({
        path,
        bytes,
      }));
    }
    if (m.format === "markdown") stored.format = "markdown";
    if (m.incomplete === true) stored.incomplete = true;
    out.push(stored);
  }
  return out;
}

/** A TUI `!` command: this view has no shell role, so it reads as what
 * was typed and what came back. */
function shellText(stored: StoredMessage): string {
  const command = `$ ${stored.shell?.command ?? stored.text}`;
  const output = stored.shell?.output ?? "";
  return output === "" ? command : `${command}\n${output}`;
}

export function fromStored(
  stored: readonly StoredMessage[],
  origins: Origins,
): Message[] {
  return stored.map((s) => {
    if (s.role === "shell") {
      const shown: Message = {
        role: "user",
        text: shellText(s),
        attachments: [],
      };
      origins.set(shown, s);
      return shown;
    }
    const m: Message = { role: s.role, text: s.text };
    if (s.role === "user") {
      m.attachments = (s.attachments ?? []).map(({ path, bytes }) => ({
        path,
        bytes,
      }));
    }
    if (s.format === "markdown") m.format = "markdown";
    if (s.incomplete === true) m.incomplete = true;
    return m;
  });
}
