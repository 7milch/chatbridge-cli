import { describe, expect, test } from "bun:test";
import {
  AuthExpiredError,
  AuthRequiredError,
  ChatBridgeError,
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
