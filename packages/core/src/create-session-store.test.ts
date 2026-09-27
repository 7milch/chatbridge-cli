import { describe, expect, test } from "bun:test";
import { createSessionStore } from "./create-session-store.js";
import { InvalidProviderError } from "./errors.js";
import { SessionStore } from "./session-store.js";

describe("createSessionStore", () => {
  test("builds a SessionStore", () => {
    expect(
      createSessionStore({ configDir: "test-cli", providerName: "dummy-chat" }),
    ).toBeInstanceOf(SessionStore);
  });

  test("maps an unusable provider name to InvalidProviderError", () => {
    expect(() =>
      createSessionStore({ configDir: "test-cli", providerName: "../escape" }),
    ).toThrow(InvalidProviderError);
  });
});
