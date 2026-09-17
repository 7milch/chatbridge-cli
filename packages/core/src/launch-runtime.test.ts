import { describe, expect, test } from "bun:test";
import { BrowserUnavailableError } from "./errors.js";
import { launchRuntime } from "./launch-runtime.js";

describe("launchRuntime", () => {
  test("throws BrowserUnavailableError before launching when the check fails", async () => {
    let launched = 0;
    const p = launchRuntime(
      async () => {
        launched++;
        return "rt";
      },
      () => "/cache/chromium-1/chrome",
    );
    await expect(p).rejects.toBeInstanceOf(BrowserUnavailableError);
    await expect(p).rejects.toThrow("/cache/chromium-1/chrome");
    expect(launched).toBe(0);
  });

  test("returns the runtime when the check passes", async () => {
    expect(
      await launchRuntime(
        async () => "rt",
        () => undefined,
      ),
    ).toBe("rt");
  });

  test("wraps Playwright's missing-executable error", async () => {
    const cause = new Error(
      "Executable doesn't exist at /x/headless_shell\n╔═╗",
    );
    const p = launchRuntime(
      async () => {
        throw cause;
      },
      () => undefined,
    );
    await expect(p).rejects.toBeInstanceOf(BrowserUnavailableError);
    const err = await p.catch((e) => e);
    expect(err.code).toBe("BROWSER_UNAVAILABLE");
    expect(err.cause).toBe(cause);
    expect(err.message).not.toContain("╔");
  });

  test("passes other launch errors through unchanged", async () => {
    const cause = new Error("spawn ENOENT");
    await expect(
      launchRuntime(
        async () => {
          throw cause;
        },
        () => undefined,
      ),
    ).rejects.toBe(cause);
  });
});
