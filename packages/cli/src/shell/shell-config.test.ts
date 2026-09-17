import { describe, expect, test } from "bun:test";
import { DEFAULT_SHELL_CONFIG, resolveShellConfig } from "./shell-config.js";

describe("resolveShellConfig", () => {
  test("no layers: the built-in default", () => {
    expect(resolveShellConfig()).toEqual(DEFAULT_SHELL_CONFIG);
    expect(DEFAULT_SHELL_CONFIG).toEqual({
      leadIn: "Please check the execution result.",
      autoSend: true,
    });
  });

  test("later layers override earlier ones key by key", () => {
    expect(
      resolveShellConfig({ leadIn: "vendor" }, { autoSend: false }),
    ).toEqual({ leadIn: "vendor", autoSend: false });
    expect(
      resolveShellConfig({ leadIn: "vendor" }, { leadIn: "user" }),
    ).toEqual({ leadIn: "user", autoSend: true });
  });

  test("undefined layers and undefined keys do not erase earlier values", () => {
    expect(
      resolveShellConfig(
        undefined,
        { leadIn: "vendor", autoSend: false },
        {
          leadIn: undefined,
        },
      ),
    ).toEqual({ leadIn: "vendor", autoSend: false });
  });

  test("returns a fresh object each time", () => {
    const a = resolveShellConfig();
    a.leadIn = "changed";
    expect(resolveShellConfig().leadIn).toBe(DEFAULT_SHELL_CONFIG.leadIn);
  });
});
