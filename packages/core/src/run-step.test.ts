import { describe, expect, test } from "bun:test";
import { ResponseTimeoutError } from "./errors.js";
import { runStep } from "./run-step.js";

function playwrightTimeout(): Error {
  const err = new Error("Timeout 1000ms exceeded.");
  err.name = "TimeoutError";
  return err;
}

describe("runStep", () => {
  test("returns the step result", async () => {
    expect(await runStep("goto", 1000, async () => 42)).toBe(42);
  });

  test("maps TimeoutError to ResponseTimeoutError naming the step", async () => {
    const inner = playwrightTimeout();
    let caught: unknown;
    try {
      await runStep("sendMessage", 1000, async () => {
        throw inner;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResponseTimeoutError);
    const e = caught as ResponseTimeoutError;
    expect(e.message).toContain("sendMessage");
    expect(e.message).toContain("1000 ms");
    expect(e.cause).toBe(inner);
  });

  test("passes other errors through unchanged", async () => {
    const inner = new Error("boom");
    await expect(
      runStep("goto", 1000, async () => {
        throw inner;
      }),
    ).rejects.toBe(inner);
  });
});
