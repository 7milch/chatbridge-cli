import { fenceFor } from "../fence.js";
import type { ShellResult } from "./run-command.js";

/** The command on one line: embedded newlines become ` ⏎ `. */
function headingFor(command: string): string {
  return `### $ ${command.replace(/\r?\n/g, " ⏎ ")}`;
}

/** Whole KB, rounded up, matching the mention size errors. */
function wholeKb(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB`;
}

/** The milestone 6 attachment shape for one command result:
 *
 *   ### $ <command>
 *   … (truncated: first N KB dropped)   ← only when bytes were dropped
 *   ```
 *   <output>
 *   ```
 *   exit code: N                        ← only when non-zero
 *   interrupted                         ← only when stopped or killed
 */
export function formatShellSection(result: ShellResult): string {
  const body =
    result.output === "" || result.output.endsWith("\n")
      ? result.output
      : `${result.output}\n`;
  const fence = fenceFor(body);
  const lines = [headingFor(result.command)];
  if (result.droppedBytes > 0) {
    lines.push(`… (truncated: first ${wholeKb(result.droppedBytes)} dropped)`);
  }
  lines.push(`${fence}\n${body}${fence}`);
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    lines.push(`exit code: ${result.exitCode}`);
  }
  if (result.interrupted) lines.push("interrupted");
  return lines.join("\n");
}

/** What is sent after a command finishes when autoSend is on. */
export function formatShellPrompt(leadIn: string, result: ShellResult): string {
  return `${leadIn}\n\n${formatShellSection(result)}`;
}
