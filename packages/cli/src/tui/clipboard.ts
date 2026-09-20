import { spawn } from "node:child_process";

export interface ClipboardProcess {
  /** Resolves with the exit code, or rejects when the command cannot start. */
  run(
    command: string,
    args: string[],
    stdin: string,
    timeoutMs: number,
  ): Promise<number>;
}

export interface ClipboardDeps {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  process: ClipboardProcess;
  /** Writes an OSC 52 sequence; true when it was written. */
  osc52: (text: string) => boolean;
}

export const CLIPBOARD_TIMEOUT_MS = 2_000;

/** The platform's clipboard writer, or undefined when there is none we know. */
export function clipboardCommand(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): { command: string; args: string[] } | undefined {
  if (platform === "darwin") return { command: "pbcopy", args: [] };
  if (platform === "win32") return { command: "clip.exe", args: [] };
  if (platform === "linux") {
    return env.WAYLAND_DISPLAY
      ? { command: "wl-copy", args: [] }
      : { command: "xclip", args: ["-selection", "clipboard"] };
  }
  return undefined;
}

/** Puts `text` on the system clipboard. Over SSH only OSC 52 reaches the
 * user's machine; a platform command would fill the remote clipboard.
 * Locally the command goes first, because OSC 52 cannot report success and
 * some terminals (macOS Terminal.app) ignore it. The text goes to stdin,
 * never to argv, and is never logged. */
export async function copyToClipboard(
  text: string,
  deps: ClipboardDeps,
): Promise<boolean> {
  const remote = Boolean(deps.env.SSH_TTY || deps.env.SSH_CONNECTION);
  const command = remote
    ? undefined
    : clipboardCommand(deps.platform, deps.env);
  if (command !== undefined) {
    try {
      const code = await deps.process.run(
        command.command,
        command.args,
        text,
        CLIPBOARD_TIMEOUT_MS,
      );
      if (code === 0) return true;
    } catch {
      // Not installed, or it timed out: OSC 52 is the fallback.
    }
  }
  return deps.osc52(text);
}

export const spawnClipboardProcess: ClipboardProcess = {
  run(command, args, stdin, timeoutMs) {
    return new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["pipe", "ignore", "ignore"],
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${command} timed out`));
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
      child.stdin.on("error", () => {}); // EPIPE when the command exits early
      child.stdin.end(stdin);
    });
  },
};
