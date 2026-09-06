import { describe, expect, test } from "bun:test";
import {
  AuthExpiredError,
  AuthRequiredError,
  ChatBridgeError,
  InvalidProviderError,
  ProviderLoadError,
  ResponseTimeoutError,
} from "./errors.js";

describe("error hierarchy", () => {
  test("subclasses extend ChatBridgeError with stable codes", () => {
    const cases: Array<[ChatBridgeError, string]> = [
      [new AuthRequiredError("no auth"), "AUTH_REQUIRED"],
      [new AuthExpiredError("expired"), "AUTH_EXPIRED"],
      [new ResponseTimeoutError("timed out"), "RESPONSE_TIMEOUT"],
      [new ProviderLoadError("bad provider"), "PROVIDER_LOAD"],
    ];
    for (const [err, code] of cases) {
      expect(err).toBeInstanceOf(ChatBridgeError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.message.length).toBeGreaterThan(0);
    }
  });
});

describe("cause", () => {
  test("is carried through to Error.cause", () => {
    const inner = new Error("root");
    const err = new ResponseTimeoutError("timed out", { cause: inner });
    expect(err.cause).toBe(inner);
  });

  test("InvalidProviderError maps to INVALID_PROVIDER", () => {
    const err = new InvalidProviderError("bad name");
    expect(err).toBeInstanceOf(ChatBridgeError);
    expect(err.code).toBe("INVALID_PROVIDER");
  });
});
