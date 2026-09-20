import { describe, expect, test } from "bun:test";
import { ChatBridgeError } from "@chatbridge/core";
import { DEFAULT_IDLE_OPTIONS, resolveIdleOptions } from "./idle-options.js";

describe("resolveIdleOptions", () => {
  test("built-in default when nothing is set", () => {
    expect(resolveIdleOptions({ provider: {}, config: {}, env: {} })).toEqual(
      DEFAULT_IDLE_OPTIONS,
    );
    expect(DEFAULT_IDLE_OPTIONS).toEqual({ timeoutMs: 86_400_000 });
  });

  test("provider overrides the built-in", () => {
    expect(
      resolveIdleOptions({
        provider: { idle: { timeoutMs: 60_000 } },
        config: {},
        env: {},
      }),
    ).toEqual({ timeoutMs: 60_000 });
  });

  test("config overrides the provider, in minutes", () => {
    expect(
      resolveIdleOptions({
        provider: { idle: { timeoutMs: 60_000 } },
        config: { idle: { timeoutMin: 30 } },
        env: {},
      }),
    ).toEqual({ timeoutMs: 1_800_000 });
  });

  test("env overrides config; empty string is unset", () => {
    expect(
      resolveIdleOptions({
        provider: {},
        config: { idle: { timeoutMin: 30 } },
        env: { CHATBRIDGE_IDLE_TIMEOUT: "45" },
      }),
    ).toEqual({ timeoutMs: 2_700_000 });
    expect(
      resolveIdleOptions({
        provider: {},
        config: { idle: { timeoutMin: 30 } },
        env: { CHATBRIDGE_IDLE_TIMEOUT: "" },
      }),
    ).toEqual({ timeoutMs: 1_800_000 });
  });

  test("0 disables the idle close, from config and from the env", () => {
    expect(
      resolveIdleOptions({
        provider: {},
        config: { idle: { timeoutMin: 0 } },
        env: {},
      }),
    ).toEqual({ timeoutMs: 0 });
    expect(
      resolveIdleOptions({
        provider: {},
        config: {},
        env: { CHATBRIDGE_IDLE_TIMEOUT: "0" },
      }),
    ).toEqual({ timeoutMs: 0 });
  });

  test.each([["abc"], ["-1"]])("rejects %p naming the variable", (raw) => {
    let err: unknown;
    try {
      resolveIdleOptions({
        provider: {},
        config: {},
        env: { CHATBRIDGE_IDLE_TIMEOUT: raw },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ChatBridgeError);
    expect((err as ChatBridgeError).code).toBe("INVALID_ARGUMENT");
    expect((err as Error).message).toContain("CHATBRIDGE_IDLE_TIMEOUT");
  });
});
