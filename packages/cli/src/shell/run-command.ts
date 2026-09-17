import { spawn } from "node:child_process";

export interface RunOptions {
  /** Directory the command starts in. */
  cwd: string;
  /** Output cap in bytes. Past it the command is killed and only the tail
   * is kept. Default MAX_OUTPUT_BYTES. */
  maxBytes?: number;
  /** Called with the whole output so far whenever it changes, throttled
   * to OUTPUT_THROTTLE_MS. */
  onOutput?: (text: string) => void;
  /** Test-only: the shell binary. Default $SHELL or /bin/sh. */
  shell?: string;
}

export interface ShellResult {
  command: string;
  /** stdout and stderr interleaved in arrival order, decoded as UTF-8
   * (invalid bytes become U+FFFD). */
  output: string;
  /** Bytes dropped from the head by the cap; 0 when nothing was dropped. */
  droppedBytes: number;
  /** Exit code on normal exit; undefined when killed or stopped. */
  exitCode: number | undefined;
  /** True when stop() ran or the cap killed the command. */
  interrupted: boolean;
  durationMs: number;
}

export interface RunningCommand {
  readonly done: Promise<ShellResult>;
  /** SIGTERM to the process group, SIGKILL after KILL_GRACE_MS. `done`
   * always settles. Idempotent: later calls, and calls after exit, do
   * nothing. */
  stop(): void;
}

export const MAX_OUTPUT_BYTES = 200 * 1024;
export const KILL_GRACE_MS = 2_000;
const OUTPUT_THROTTLE_MS = 100;

export function defaultShell(): string {
  return process.env.SHELL || "/bin/sh";
}

/** Merges the command's stderr into its stdout inside the shell, so both
 * streams reach us through a single pipe and arrival order is preserved
 * (two pipes are read independently and would interleave arbitrarily).
 * The prefix stays on the command's first line so shell error messages
 * keep the user's line numbering. */
function mergeStderr(command: string): string {
  return `exec 2>&1;${command}`;
}

/** Runs `command` through `<shell> -c` in its own process group, with
 * stdin closed and the environment inherited. Never throws synchronously:
 * a shell that cannot start rejects `done`. */
export function runCommand(command: string, opts: RunOptions): RunningCommand {
  const maxBytes = opts.maxBytes ?? MAX_OUTPUT_BYTES;
  const startedAt = Date.now();
  let buf = Buffer.alloc(0);
  let dropped = 0;
  let interrupted = false;
  let settled = false;
  let stopRequested = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let notifyTimer: ReturnType<typeof setTimeout> | undefined;
  /** Output has changed since the last onOutput call. */
  let unnotified = false;

  const text = () => buf.toString("utf8");

  const flush = () => {
    notifyTimer = undefined;
    unnotified = false;
    opts.onOutput?.(text());
  };

  let stop: () => void = () => {};

  const done = new Promise<ShellResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        opts.shell ?? defaultShell(),
        ["-c", mergeStderr(command)],
        {
          cwd: opts.cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (err) {
      reject(err);
      return;
    }

    const signal = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        // Negative pid: the whole process group (detached: true gave the
        // shell its own), so grandchildren go too.
        process.kill(-child.pid, sig);
      } catch {
        // Already gone.
      }
    };

    stop = () => {
      if (settled || stopRequested) return;
      stopRequested = true;
      interrupted = true;
      signal("SIGTERM");
      killTimer = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
    };

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > maxBytes) {
        dropped += buf.length - maxBytes;
        buf = buf.subarray(buf.length - maxBytes);
        stop();
      }
      unnotified = true;
      if (notifyTimer === undefined) {
        notifyTimer = setTimeout(flush, OUTPUT_THROTTLE_MS);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const finish = () => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (notifyTimer !== undefined) clearTimeout(notifyTimer);
    };

    child.on("error", (err) => {
      finish();
      reject(err);
    });
    // "close": every stdio pipe has drained, so the output is complete.
    child.on("close", (code) => {
      if (settled) return;
      finish();
      // The last throttled tick may still be pending: deliver the final
      // output before resolving so onOutput never lags the result.
      if (unnotified) flush();
      resolve({
        command,
        output: text(),
        droppedBytes: dropped,
        exitCode: code ?? undefined,
        interrupted,
        durationMs: Date.now() - startedAt,
      });
    });
  });

  return {
    done,
    stop: () => stop(),
  };
}
