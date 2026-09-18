import { fenceFor } from "@chatbridge/core";
import type { ShellResult } from "./run-command.js";

/** The command on one line: embedded newlines become ` ⏎ `. */
function headingFor(command: string): string {
  return `### $ ${command.replace(/\r?\n/g, " ⏎ ")}`;
}

/** The note that says the head of the output was dropped by the cap.
 * Whole KB, rounded up, matching the mention size errors. Shared with the
 * TUI footer so both places word it the same way. */
export function truncatedNote(droppedBytes: number): string {
  return `… (truncated: first ${Math.ceil(droppedBytes / 1024)} KB dropped)`;
}

/** The milestone 6 attachment shape for one command result:
 *
 *   ### $ <command>
 *   … (truncated: first N KB dropped)   ← only when bytes were dropped
 *   ```
 *   <output>
 *   ```
 *   exit code: N                        ← only when non-zero
 *   killed by SIGKILL                   ← only when a signal we did not send ended it
 *   interrupted                         ← only when stopped or killed by the cap
 */
export function formatShellSection(result: ShellResult): string {
  const body =
    result.output === "" || result.output.endsWith("\n")
      ? result.output
      : `${result.output}\n`;
  const fence = fenceFor(body);
  const lines = [headingFor(result.command)];
  if (result.droppedBytes > 0) {
    lines.push(truncatedNote(result.droppedBytes));
  }
  lines.push(`${fence}\n${body}${fence}`);
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    lines.push(`exit code: ${result.exitCode}`);
  }
  if (result.signal !== undefined) lines.push(`killed by ${result.signal}`);
  if (result.interrupted) lines.push("interrupted");
  return lines.join("\n");
}

/** What is sent after a command finishes when autoSend is on. */
export function formatShellPrompt(leadIn: string, result: ShellResult): string {
  return `${leadIn}\n\n${formatShellSection(result)}`;
}
