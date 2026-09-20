/** Built-in idle lifetime of an interactive session: a day. Long enough
 * that a session used daily is never closed under the user, short enough
 * that a forgotten one does not hold a core for a weekend. */
export const DEFAULT_IDLE_TIMEOUT_MS = 86_400_000;

/** The resolved idle setting a session is opened with. */
export interface IdleOptions {
  /** Milliseconds without a turn before the browser is closed. 0 disables. */
  timeoutMs: number;
}

export interface IdleWatchOptions {
  /** Must be > 0; the caller does not construct a watch for 0. */
  timeoutMs: number;
  /** Called at most once, after the watch has stopped itself. */
  onExpire: () => void;
  /** Default Date.now. Tests inject a clock they move by hand. */
  now?: () => number;
  /** How often the deadline is checked. Default 30 s. */
  tickMs?: number;
}

/** Coarse idle timer for a long-lived session.
 *
 * It compares wall-clock time on a repeating interval rather than arming
 * one long `setTimeout`, on purpose: timers run on a monotonic clock that
 * does not advance while the system sleeps, so a single timeout would fire
 * late by the length of the sleep. With the wall-clock check the first
 * tick after wake expires an already overdue session. */
export class IdleWatch {
  private readonly timeoutMs: number;
  private readonly onExpire: () => void;
  private readonly now: () => number;
  private readonly tickMs: number;
  private lastActivityAt: number;
  private paused = false;
  private expired = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: IdleWatchOptions) {
    this.timeoutMs = opts.timeoutMs;
    this.onExpire = opts.onExpire;
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? 30_000;
    this.lastActivityAt = this.now();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // A session that is idle is by definition not doing anything the
    // process should stay alive for.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Activity: restart the idle period. */
  touch(): void {
    this.lastActivityAt = this.now();
  }

  /** A turn is in flight: never expire underneath it. */
  pause(): void {
    this.paused = true;
  }

  /** The turn ended: the idle period starts again from now. */
  resume(): void {
    this.paused = false;
    this.touch();
  }

  /** Clears the interval. Idempotent. */
  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    if (this.paused || this.expired) return;
    if (this.now() - this.lastActivityAt < this.timeoutMs) return;
    this.expired = true;
    // Stopped before the callback: onExpire closes the session, which
    // stops the watch again — and a callback that throws must not leave a
    // live interval behind.
    this.stop();
    this.onExpire();
  }
}

/** The idle period as a short phrase for a progress line ("24 h",
 * "1.5 min"). Not a general duration formatter: whole values print
 * without a decimal, everything else with one. */
export function formatIdleDuration(ms: number): string {
  const minutes = ms / 60_000;
  const [value, unit] = minutes < 60 ? [minutes, "min"] : [minutes / 60, "h"];
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${text} ${unit}`;
}
