import { type ChildProcess, spawn } from "node:child_process";
import { constants, access } from "node:fs/promises";

export interface RunOptions {
  /** Directory the command starts in. */
  cwd: string;
  /** Output cap in bytes. Past it the command is killed and only the tail
   * is kept. Default MAX_OUTPUT_BYTES. */
  maxBytes?: number;
  /** Called with the whole output so far whenever it changes, throttled
   * to OUTPUT_THROTTLE_MS. */
  onOutput?: (text: string) => void;
  /** The shell binary that runs the command. Default $SHELL or /bin/sh. */
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
  /** The signal that ended the command when something other than stop()
   * killed it — a `kill` from elsewhere, a crash of the shell itself.
   * Absent on a normal exit and on an interrupted result. */
  signal?: NodeJS.Signals;
  durationMs: number;
}

export interface RunningCommand {
  readonly done: Promise<ShellResult>;
  /** SIGTERM to the process group, SIGKILL after KILL_GRACE_MS, then the
   * output pipes are destroyed. `done` always settles, even if a process
   * left the group and still holds a pipe. Idempotent: later calls, and
   * calls after exit, do nothing. */
  stop(): void;
}

export const MAX_OUTPUT_BYTES = 200 * 1024;
export const KILL_GRACE_MS = 2_000;
/** Grace after SIGKILL before the output pipes are destroyed. */
const PIPE_TEARDOWN_MS = 500;
const OUTPUT_THROTTLE_MS = 100;

/** The user's login shell, used unvalidated: it only ever receives
 * `-c <command>`, and the stderr merge is done by the POSIX wrapper below
 * rather than by this shell, so non-POSIX shells (fish, csh) work too. */
export function defaultShell(): string {
  return process.env.SHELL || "/bin/sh";
}

/** `/bin/sh` script that execs its arguments with stderr merged into
 * stdout, so both streams reach us through a single pipe and arrival order
 * is preserved (two pipes are read independently and would interleave
 * arbitrarily). The redirection lives here, in a POSIX shell, and the
 * user's command string is handed to the user's own shell untouched. */
const MERGE_WRAPPER = 'exec "$@" 2>&1';

/** Runs `command` through `<shell> -c` in its own process group, with
 * stdin closed and the environment inherited. Never throws synchronously:
 * a shell that cannot start rejects `done`. */
export function runCommand(command: string, opts: RunOptions): RunningCommand {
  const maxBytes = opts.maxBytes ?? MAX_OUTPUT_BYTES;
  const startedAt = Date.now();
  /** Output so far, in arrival order; joined only when read, so a chunk
   * costs one push rather than a copy of everything before it. */
  const chunks: Buffer[] = [];
  /** Total bytes in `chunks`. */
  let size = 0;
  let dropped = 0;
  let interrupted = false;
  let settled = false;
  let stopRequested = false;
  let child: ChildProcess | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let notifyTimer: ReturnType<typeof setTimeout> | undefined;
  /** Output has changed since the last onOutput call. */
  let unnotified = false;

  const text = () => Buffer.concat(chunks, size).toString("utf8");

  /** Only ever runs before `settled`: finish() clears the pending timer,
   * which is what keeps onOutput from firing after the result is out. */
  const flush = () => {
    notifyTimer = undefined;
    unnotified = false;
    opts.onOutput?.(text());
  };

  const signal = (sig: NodeJS.Signals) => {
    const pid = child?.pid;
    if (pid === undefined) return;
    try {
      // Negative pid: the whole process group (detached: true gave the
      // wrapper its own), so grandchildren go too.
      process.kill(-pid, sig);
    } catch {
      // Already gone.
    }
  };

  const terminate = () => {
    signal("SIGTERM");
    killTimer = setTimeout(() => {
      signal("SIGKILL");
      // "close" waits for the output pipes to reach EOF, and only a
      // process that left the group (setsid, a daemonizing tool that kept
      // our stdio) can still hold them open now. Force them shut so `done`
      // settles instead of waiting on a process we cannot signal. Doing
      // this here rather than on the child's "exit" keeps an in-group
      // `cmd &` job — which the runner deliberately waits for — intact.
      killTimer = setTimeout(() => {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
      }, PIPE_TEARDOWN_MS);
    }, KILL_GRACE_MS);
  };

  const stop = () => {
    if (settled || stopRequested) return;
    stopRequested = true;
    interrupted = true;
    // Before the spawn (during the shell preflight) there is nothing to
    // signal yet; the spawn step checks stopRequested instead.
    if (child !== undefined) terminate();
  };

  const finish = () => {
    if (settled) return;
    settled = true;
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (notifyTimer !== undefined) clearTimeout(notifyTimer);
  };

  const done = new Promise<ShellResult>((resolve, reject) => {
    const settle = (code: number | null, sig: NodeJS.Signals | null) => {
      finish();
      // The last throttled tick may still be pending: deliver the final
      // output before resolving so onOutput never lags the result.
      if (unnotified) flush();
      const result: ShellResult = {
        command,
        output: text(),
        droppedBytes: dropped,
        // A stopped command reports no exit code even when it happened to
        // exit on its own before the signal landed.
        exitCode: interrupted ? undefined : (code ?? undefined),
        interrupted,
        durationMs: Date.now() - startedAt,
      };
      // Our own SIGTERM/SIGKILL is `interrupted`; only a signal we did
      // not send is worth naming.
      if (!interrupted && sig !== null) result.signal = sig;
      resolve(result);
    };

    const start = async () => {
      const shell = opts.shell ?? defaultShell();
      // The wrapper would turn a missing shell into exit 127 instead of a
      // spawn error, so check a path-like shell up front and let `done`
      // reject with its ENOENT / EACCES. A bare name is left to the
      // wrapper's PATH lookup and surfaces as 127 in the output.
      if (shell.includes("/")) await access(shell, constants.X_OK);
      if (stopRequested) {
        settle(null, null);
        return;
      }

      // "sh" is $0 for the wrapper; shell/-c/command become its "$@".
      child = spawn(
        "/bin/sh",
        ["-c", MERGE_WRAPPER, "sh", shell, "-c", command],
        {
          cwd: opts.cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size > maxBytes) {
          // Drop from the head until the cap holds. The cap bounds the
          // bytes kept, not the length of the decoded string, and the cut
          // can split a multi-byte character.
          let excess = size - maxBytes;
          dropped += excess;
          size = maxBytes;
          while (excess > 0) {
            const head = chunks[0];
            if (head === undefined) break;
            if (head.length <= excess) {
              chunks.shift();
              excess -= head.length;
            } else {
              chunks[0] = head.subarray(excess);
              excess = 0;
            }
          }
          stop();
        }
        unnotified = true;
        if (notifyTimer === undefined) {
          notifyTimer = setTimeout(flush, OUTPUT_THROTTLE_MS);
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      child.on("error", (err) => {
        if (settled) return;
        finish();
        reject(err);
      });
      // "close": every stdio pipe has drained, so the output is complete.
      child.on("close", (code, sig) => {
        if (settled) return;
        settle(code, sig);
      });
    };

    start().catch((err) => {
      if (settled) return;
      finish();
      reject(err);
    });
  });

  return { done, stop: () => stop() };
}
