import { expect, test } from "bun:test";
import provider from "./provider.js";

test("provider shape", () => {
  expect(provider.name).toBe("<vendor>");
  expect(new URL(provider.chatUrl).protocol).toBe("https:");
  for (const method of [
    "navigateToLogin",
    "isLoggedIn",
    "startNewChat",
    "sendMessage",
    "waitForResponse",
  ] as const)
    expect(typeof provider[method]).toBe("function");
  expect(provider.responseFormat).toBe("markdown");
  expect(typeof provider.streaming?.responseText).toBe("function");
});
