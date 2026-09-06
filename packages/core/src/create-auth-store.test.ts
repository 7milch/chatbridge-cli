import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createAuthStore } from "./create-auth-store.js";
import { InvalidProviderError } from "./errors.js";

describe("createAuthStore", () => {
  test("returns a store for a valid name", () => {
    const store = createAuthStore({
      configDir: "chatbridge",
      providerName: "dummy-chat",
      baseDir: tmpdir(),
    });
    expect(store.path().endsWith("dummy-chat.json")).toBe(true);
  });

  test("wraps an invalid name in InvalidProviderError with cause", () => {
    let caught: unknown;
    try {
      createAuthStore({
        configDir: "chatbridge",
        providerName: "../escape",
        baseDir: tmpdir(),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidProviderError);
    expect((caught as InvalidProviderError).cause).toBeInstanceOf(RangeError);
  });
});
