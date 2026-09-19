import { describe, expect, test } from "bun:test";
import { ChatBridgeError } from "@chatbridge/core";
import { DEFAULT_OPEN_OPTIONS, resolveOpenOptions } from "./open-options.js";

describe("resolveOpenOptions", () => {
  test("built-in defaults when nothing is set", () => {
    expect(resolveOpenOptions({ provider: {}, config: {}, env: {} })).toEqual(
      DEFAULT_OPEN_OPTIONS,
    );
    expect(DEFAULT_OPEN_OPTIONS).toEqual({ timeoutMs: 120_000, retries: 0 });
  });

  test("provider overrides built-in, key by key", () => {
    expect(
      resolveOpenOptions({
        provider: { open: { retries: 2 } },
        config: {},
        env: {},
      }),
    ).toEqual({ timeoutMs: 120_000, retries: 2 });
  });

  test("config overrides provider, in seconds", () => {
    expect(
      resolveOpenOptions({
        provider: { open: { timeoutMs: 5_000, retries: 2 } },
        config: { open: { timeoutSec: 30 } },
        env: {},
      }),
    ).toEqual({ timeoutMs: 30_000, retries: 2 });
  });

  test("env overrides config; empty string is unset", () => {
    expect(
      resolveOpenOptions({
        provider: {},
        config: { open: { timeoutSec: 30, retries: 1 } },
        env: { CHATBRIDGE_OPEN_TIMEOUT: "45", CHATBRIDGE_OPEN_RETRIES: "" },
      }),
    ).toEqual({ timeoutMs: 45_000, retries: 1 });
  });

  test.each([
    [{ CHATBRIDGE_OPEN_TIMEOUT: "abc" }, "CHATBRIDGE_OPEN_TIMEOUT"],
    [{ CHATBRIDGE_OPEN_TIMEOUT: "0" }, "CHATBRIDGE_OPEN_TIMEOUT"],
    [{ CHATBRIDGE_OPEN_RETRIES: "-1" }, "CHATBRIDGE_OPEN_RETRIES"],
    [{ CHATBRIDGE_OPEN_RETRIES: "1.5" }, "CHATBRIDGE_OPEN_RETRIES"],
  ])("rejects %j naming the variable", (env, name) => {
    let err: unknown;
    try {
      resolveOpenOptions({ provider: {}, config: {}, env });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ChatBridgeError);
    expect((err as ChatBridgeError).code).toBe("INVALID_ARGUMENT");
    expect((err as Error).message).toContain(name);
  });
});
