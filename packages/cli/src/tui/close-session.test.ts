import { describe, expect, test } from "bun:test";
import { closeOrKill, closeWithTimeout } from "./close-session.js";

describe("closeWithTimeout", () => {
  test("returns true when the session closes in time", async () => {
    expect(await closeWithTimeout({ close: async () => {} }, 1000)).toBe(true);
  });

  test("returns false when the close never settles", async () => {
    const started = Date.now();
    const stuck = { close: () => new Promise<void>(() => {}) };
    expect(await closeWithTimeout(stuck, 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("swallows a rejecting close", async () => {
    const failing = {
      close: async () => {
        throw new Error("browser already gone");
      },
    };
    expect(await closeWithTimeout(failing, 1000)).toBe(true);
  });
});

describe("closeOrKill", () => {
  test("does not kill when close finishes in time", async () => {
    let killed = 0;
    await closeOrKill(
      {
        close: async () => {},
        kill: async () => {
          killed++;
        },
      },
      1000,
    );
    expect(killed).toBe(0);
  });

  test("kills when close exceeds the cap", async () => {
    let killed = 0;
    await closeOrKill(
      {
        close: () => new Promise<void>(() => {}),
        kill: async () => {
          killed++;
        },
      },
      50,
    );
    expect(killed).toBe(1);
  });

  test("swallows a rejecting kill", async () => {
    await closeOrKill(
      {
        close: () => new Promise<void>(() => {}),
        kill: async () => {
          throw new Error("no process");
        },
      },
      50,
    );
  });
});
