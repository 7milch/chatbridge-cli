import { describe, expect, test } from "bun:test";
import { type Provider, defineProvider } from "./index.js";

describe("defineProvider", () => {
  test("returns the same provider object", () => {
    const p: Provider = {
      name: "test",
      chatUrl: "http://localhost:1/chat",
      navigateToLogin: async () => {},
      isLoggedIn: async () => true,
      startNewChat: async () => {},
      sendMessage: async () => {},
      waitForResponse: async () => "reply",
    };
    expect(defineProvider(p)).toBe(p);
  });
});
