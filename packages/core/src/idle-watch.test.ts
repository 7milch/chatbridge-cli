import { describe, expect, test } from "bun:test";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  IdleWatch,
  formatIdleDuration,
} from "./idle-watch.js";

/** A clock the test moves by hand; the watch compares wall-clock values. */
function clock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

/** Polls until `cond` holds, failing loudly rather than sleeping blind. */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A few ticks of the 5 ms interval, so "did not fire" means something. */
async function ticks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

function watchWith(c: ReturnType<typeof clock>, timeoutMs = 1000) {
  let expired = 0;
  const watch = new IdleWatch({
    timeoutMs,
    now: c.now,
    tickMs: 5,
    onExpire: () => {
      expired++;
    },
  });
  return { watch, expired: () => expired };
}

describe("IdleWatch", () => {
  test("expires once the timeout has passed", async () => {
    const c = clock();
    const w = watchWith(c);
    await ticks();
    expect(w.expired()).toBe(0);
    c.advance(1001);
    await waitFor(() => w.expired() === 1, "expiry");
    w.watch.stop();
  });

  test("touch() restarts the idle period", async () => {
    const c = clock();
    const w = watchWith(c);
    c.advance(900);
    w.watch.touch();
    c.advance(900);
    await ticks();
    expect(w.expired()).toBe(0);
    c.advance(200);
    await waitFor(() => w.expired() === 1, "expiry after the extension");
    w.watch.stop();
  });

  test("never expires while paused, and resume() restarts the period", async () => {
    const c = clock();
    const w = watchWith(c);
    w.watch.pause();
    c.advance(10_000);
    await ticks();
    expect(w.expired()).toBe(0);
    w.watch.resume();
    c.advance(900);
    await ticks();
    expect(w.expired()).toBe(0);
    c.advance(200);
    await waitFor(() => w.expired() === 1, "expiry after resume");
    w.watch.stop();
  });

  test("a wall-clock jump (sleep/wake) expires on the next tick", async () => {
    const c = clock();
    const w = watchWith(c, 86_400_000);
    // The machine slept for two days: a monotonic timer would still be
    // waiting, the wall-clock comparison is already overdue.
    c.advance(2 * 86_400_000);
    await waitFor(() => w.expired() === 1, "expiry after the clock jump");
    w.watch.stop();
  });

  test("fires at most once", async () => {
    const c = clock();
    const w = watchWith(c);
    c.advance(5000);
    await waitFor(() => w.expired() === 1, "expiry");
    c.advance(5000);
    await ticks();
    expect(w.expired()).toBe(1);
  });

  test("stop() is idempotent and prevents expiry", async () => {
    const c = clock();
    const w = watchWith(c);
    w.watch.stop();
    w.watch.stop();
    c.advance(5000);
    await ticks();
    expect(w.expired()).toBe(0);
  });
});

describe("formatIdleDuration", () => {
  test.each([
    [DEFAULT_IDLE_TIMEOUT_MS, "24 h"],
    [3_600_000, "1 h"],
    [5_400_000, "1.5 h"],
    [600_000, "10 min"],
    [90_000, "1.5 min"],
  ])("%p is %p", (ms, text) => {
    expect(formatIdleDuration(ms)).toBe(text);
  });
});
