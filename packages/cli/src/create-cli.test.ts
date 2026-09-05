import { describe, expect, test } from "bun:test";
import { type Provider, defineProvider } from "@chatbridge/core";

import { createCli } from "./create-cli";

/** Provider stub whose methods must never be reached: argument validation
 * happens before any browser is launched. */
function stubProvider(): Provider {
  const unreachable = () => {
    throw new Error("provider must not be used");
  };
  return defineProvider({
    name: "stub",
    chatUrl: "http://127.0.0.1:1/chat",
    navigateToLogin: unreachable,
    isLoggedIn: unreachable,
    startNewChat: unreachable,
    sendMessage: unreachable,
    waitForResponse: unreachable,
  });
}

describe("--timeout validation", () => {
  test("rejects a non-numeric value without launching a browser", async () => {
    const cli = createCli({ name: "test-cli", provider: stubProvider() });
    const code = await cli.run(["bun", "cli", "-p", "x", "--timeout", "abc"]);
    expect(code).toBe(1);
  });

  test.each([["--timeout=0"], ["--timeout=-5"], ["--timeout=Infinity"]])(
    "rejects %p",
    async (arg: string) => {
      const cli = createCli({ name: "test-cli", provider: stubProvider() });
      const code = await cli.run(["bun", "cli", "-p", "x", arg]);
      expect(code).toBe(1);
    },
  );
});
