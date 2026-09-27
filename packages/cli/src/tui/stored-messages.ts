import type { StoredMessage, StoredShell } from "@chatbridge/core";
import type { ShellResult } from "../shell/run-command.js";
import type { Message } from "./chat-model.js";

function shellOf(result: ShellResult): StoredShell {
  return {
    command: result.command,
    output: result.output,
    droppedBytes: result.droppedBytes,
    // JSON has no undefined: a killed command's exit code is null on disk.
    exitCode: result.exitCode ?? null,
    interrupted: result.interrupted,
    durationMs: result.durationMs,
    ...(result.signal === undefined ? {} : { signal: result.signal }),
  };
}

function resultOf(shell: StoredShell): ShellResult {
  return {
    command: shell.command,
    output: shell.output,
    droppedBytes: shell.droppedBytes,
    exitCode: shell.exitCode ?? undefined,
    interrupted: shell.interrupted,
    durationMs: shell.durationMs,
    ...(shell.signal === undefined
      ? {}
      : { signal: shell.signal as NodeJS.Signals }),
  };
}

/** The TUI history as it is saved. `help` entries are left out: a command
 * listing is not part of the conversation. `held` is left out too: a
 * resumed session has no result waiting to be sent. */
export function toStored(messages: readonly Message[]): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (const m of messages) {
    if (m.role === "help") continue;
    const stored: StoredMessage = { role: m.role, text: m.text };
    if (m.attachments !== undefined && m.attachments.length > 0) {
      stored.attachments = m.attachments.map(({ path, bytes }) => ({
        path,
        bytes,
      }));
    }
    if (m.format === "markdown") stored.format = "markdown";
    if (m.incomplete === true) stored.incomplete = true;
    if (m.failed === true) stored.failed = true;
    if (m.result !== undefined) stored.shell = shellOf(m.result);
    out.push(stored);
  }
  return out;
}

/** A saved history as TUI messages. */
export function fromStored(stored: readonly StoredMessage[]): Message[] {
  return stored.map((s) => {
    const m: Message = { role: s.role, text: s.text };
    if (s.attachments !== undefined) {
      m.attachments = s.attachments.map(({ path, bytes }) => ({ path, bytes }));
    }
    if (s.format === "markdown") m.format = "markdown";
    if (s.incomplete === true) m.incomplete = true;
    if (s.failed === true) m.failed = true;
    if (s.shell !== undefined) m.result = resultOf(s.shell);
    return m;
  });
}
