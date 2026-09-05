import { afterEach, describe, expect, test } from "bun:test";
import { startDummyChat } from "./server";

let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe("dummy chat server", () => {
  test("redirects /chat to /login without a session cookie", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const res = await fetch(`${s.url}/chat`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("login sets a session cookie and /chat then serves the chat page", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const login = await fetch(`${s.url}/do-login`, {
      method: "POST",
      redirect: "manual",
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("session=ok");
    const chat = await fetch(`${s.url}/chat`, {
      headers: { cookie: "session=ok" },
    });
    expect(chat.status).toBe(200);
    expect(await chat.text()).toContain('id="message-input"');
  });
});
