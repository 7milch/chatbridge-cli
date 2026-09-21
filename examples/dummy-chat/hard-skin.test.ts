import { afterEach, describe, expect, test } from "bun:test";
import { startDummyChat } from "./server";

let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe("hard skin", () => {
  test("guests get the chat page with a composer and a sign-in link", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const res = await fetch(`${s.url}/hard/chat`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="sign-in-link"');
    expect(html).toContain('data-testid="composer-input"');
    expect(html).not.toContain('data-testid="account-menu"');
  });

  test("members get the account menu and no sign-in link", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const html = await (
      await fetch(`${s.url}/hard/chat`, { headers: { cookie: "session=ok" } })
    ).text();
    expect(html).toContain('data-testid="account-menu"');
    expect(html).not.toContain('data-testid="sign-in-link"');
  });

  test("the markup has no ids and only generated class names", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const html = await (await fetch(`${s.url}/hard/chat`)).text();
    const markup = html.slice(0, html.indexOf("<script>"));
    expect(markup).not.toMatch(/\sid="/);
    for (const m of markup.matchAll(/class="([^"]+)"/g)) {
      for (const cls of (m[1] ?? "").split(/\s+/))
        expect(cls).toMatch(/^css-[a-z0-9]{6}$/);
    }
  });

  test("login honours ?next= for the hard skin only", async () => {
    const s = await startDummyChat(0);
    stop = s.stop;
    const hard = await fetch(`${s.url}/do-login?next=/hard/chat`, {
      method: "POST",
      redirect: "manual",
    });
    expect(hard.headers.get("location")).toBe("/hard/chat");
    const evil = await fetch(`${s.url}/do-login?next=https://example.com`, {
      method: "POST",
      redirect: "manual",
    });
    expect(evil.headers.get("location")).toBe("/chat");
  });
});
