import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { urlConversation } from "./conversation.js";

/** A page that only knows its URL; `goto` lands on `landsOn ?? target`. */
function fakePage(start: string, landsOn?: string) {
  let current = start;
  const visited: string[] = [];
  const page = {
    url: () => current,
    goto: async (target: string) => {
      visited.push(target);
      current = landsOn ?? target;
      return null;
    },
  } as unknown as Page;
  return { page, visited };
}

const MATCH = /\/chat\/c\/[a-z0-9]+$/;

describe("urlConversation", () => {
  test("handle is the page URL on a conversation page", async () => {
    const { page } = fakePage("https://x.test/chat/c/abc1");
    expect(await urlConversation({ match: MATCH }).handle(page)).toBe(
      "https://x.test/chat/c/abc1",
    );
  });

  test("handle is undefined off a conversation page", async () => {
    const { page } = fakePage("https://x.test/chat");
    expect(
      await urlConversation({ match: MATCH }).handle(page),
    ).toBeUndefined();
  });

  test("a function match works the same", async () => {
    const { page } = fakePage("https://x.test/t/9");
    const conv = urlConversation({ match: (u) => u.includes("/t/") });
    expect(await conv.handle(page)).toBe("https://x.test/t/9");
  });

  test("open navigates to the handle", async () => {
    const { page, visited } = fakePage("https://x.test/chat");
    await urlConversation({ match: MATCH }).open(
      page,
      "https://x.test/chat/c/abc1",
    );
    expect(visited).toEqual(["https://x.test/chat/c/abc1"]);
  });

  test("open rejects a handle that is not a conversation URL, without navigating", async () => {
    const { page, visited } = fakePage("https://x.test/chat");
    await expect(
      urlConversation({ match: MATCH }).open(page, "https://evil.test/"),
    ).rejects.toThrow("not a conversation URL");
    expect(visited).toEqual([]);
  });

  test("open rejects when the service redirected away from the conversation", async () => {
    const { page } = fakePage("https://x.test/chat", "https://x.test/chat");
    await expect(
      urlConversation({ match: MATCH }).open(
        page,
        "https://x.test/chat/c/gone",
      ),
    ).rejects.toThrow("did not open");
  });

  test("the error never contains the handle", async () => {
    const { page } = fakePage("https://x.test/chat", "https://x.test/chat");
    const err = await urlConversation({ match: MATCH })
      .open(page, "https://x.test/chat/c/secretid")
      .catch((e: Error) => e);
    expect(String(err)).not.toContain("secretid");
  });

  test.each(["g", "y"])("rejects a RegExp with the %s flag", (flag) => {
    expect(() => urlConversation({ match: new RegExp("/c/", flag) })).toThrow(
      "must not use the g or y flag",
    );
  });
});
