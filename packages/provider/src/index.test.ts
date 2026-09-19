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

  test("accepts the optional detectBlock method", () => {
    const p: Provider = {
      name: "test",
      chatUrl: "http://localhost:1/chat",
      navigateToLogin: async () => {},
      isLoggedIn: async () => false,
      startNewChat: async () => {},
      sendMessage: async () => {},
      waitForResponse: async () => "reply",
      detectBlock: async () => "challenge page",
    };
    expect(defineProvider(p).detectBlock).toBe(p.detectBlock);
  });
});

test("defineProvider keeps the optional open defaults", () => {
  const p = defineProvider({
    name: "x",
    chatUrl: "http://127.0.0.1:1/",
    async navigateToLogin() {},
    async isLoggedIn() {
      return true;
    },
    async startNewChat() {},
    async sendMessage() {},
    async waitForResponse() {
      return "";
    },
    open: { timeoutMs: 5_000, retries: 2 },
  });
  expect(p.open).toEqual({ timeoutMs: 5_000, retries: 2 });
});
