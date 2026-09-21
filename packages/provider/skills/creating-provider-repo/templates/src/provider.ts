import { defineProvider, elementToMarkdown } from "@chatbridge/provider";
import type { Locator, Page } from "playwright-core";
import * as S from "./selectors.js";

/** The framework times a turn out by racing `waitForResponse`; it cannot
 * abort it. Every wait here is bounded so a timed-out turn leaves nothing
 * polling the page. Longer than any session timeout a user would set. */
const TURN_LIMIT_MS = 30 * 60_000;

/** Bound for "the new turn must have appeared" once the service says it is
 * done. It is a DOM insertion that already happened, not a generation. */
const NEW_TURN_TIMEOUT_MS = 30_000;

/** Assistant turns that existed before the pending prompt was sent. */
const countBefore = new WeakMap<Page, number>();

// `.first()` picks DOM order, so a hidden match would stall every wait.
const visibleOnly = (page: Page, selector: string): Locator =>
  page.locator(selector).locator("visible=true");

/** The newest assistant turn's readable content. ASSISTANT_MESSAGE_BODY is a
 * selector for a DESCENDANT of one turn, so a `:scope > …` form is fine here.
 * VARIANT (decision table "the reply has no content child"): when the turn
 * element is itself the content, drop the second locator call —
 * `page.locator(S.ASSISTANT_MESSAGE).last()`. */
const newestBody = (page: Page): Locator =>
  page
    .locator(S.ASSISTANT_MESSAGE)
    .last()
    .locator(S.ASSISTANT_MESSAGE_BODY)
    .first();

export default defineProvider({
  name: "<vendor>",
  chatUrl: S.CHAT_URL,
  responseFormat: "markdown",

  async navigateToLogin(page) {
    await page.goto(S.ENTRY_URL);
  },

  async isLoggedIn(page) {
    // The IdP page: never touch its DOM. When the service's login page is on
    // the chat page's own origin this check is simply a no-op, and the
    // sign-in / account pair below decides on its own — which is what it is
    // there for. Do not replace the pair with a URL test.
    if (
      !page.url().startsWith("http") ||
      new URL(page.url()).origin !== new URL(S.CHAT_URL).origin
    )
      return false;
    try {
      const signIn = visibleOnly(page, S.SIGN_IN_CONTROL);
      const account = visibleOnly(page, S.ACCOUNT_CONTROL);
      await signIn
        .or(account)
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      // A guest composer proves nothing: account present AND sign-in absent.
      return (await account.count()) > 0 && (await signIn.count()) === 0;
    } catch {
      return false;
    }
  },

  async startNewChat(page) {
    // VARIANT (decision table "new chat is a URL"): replace the click with
    // page.goto(<new chat URL>).
    const button = visibleOnly(page, S.NEW_CHAT_BUTTON);
    // count() does not auto-wait: without this the first paint after a
    // navigation would look like "there is no button" and take the fallback.
    await button
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => {});
    if ((await button.count()) > 0) await button.first().click();
    else await page.goto(S.CHAT_URL);
    const composer = visibleOnly(page, S.COMPOSER).first();
    await composer.waitFor({ state: "visible" });
  },

  async sendMessage(page, prompt) {
    countBefore.set(page, await page.locator(S.ASSISTANT_MESSAGE).count());
    // fill() works on contenteditable composers too.
    await visibleOnly(page, S.COMPOSER).first().fill(prompt);
    // VARIANT (decision table "no send button"): replace with
    // page.keyboard.press("Enter").
    await visibleOnly(page, S.SEND_BUTTON).first().click();
    // Let the generating state begin. Timing out here is harmless when the
    // reply was simply faster than the wait — but if the service takes
    // LONGER than this to start generating, waitForResponse's done check
    // passes immediately and the whole turn rests on the stability read.
    // Raise the timeout for a service that is slow to start.
    await page
      .locator(S.STOP_BUTTON)
      .first()
      .waitFor({ state: "visible", timeout: 3_000 })
      .catch(() => {});
  },

  async waitForResponse(page) {
    const before = countBefore.get(page) ?? 0;
    const deadline = Date.now() + TURN_LIMIT_MS;
    // 1. Done signal first: a placeholder turn may come and go before the
    //    real one. VARIANT (decision table "state attribute"): wait for the
    //    attribute's idle value instead.
    await page
      .locator(S.STOP_BUTTON)
      .first()
      .waitFor({ state: "hidden", timeout: TURN_LIMIT_MS });
    // 2. Then the new turn must exist.
    await page.waitForFunction(
      ({ selector, count }: { selector: string; count: number }) =>
        document.querySelectorAll(selector).length > count,
      { selector: S.ASSISTANT_MESSAGE, count: before },
      { timeout: NEW_TURN_TIMEOUT_MS },
    );
    // 3. Stability read: two equal reads 500 ms apart.
    let previous = await elementToMarkdown(newestBody(page));
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      const current = await elementToMarkdown(newestBody(page));
      if (current === previous && current !== "") return current;
      previous = current;
    }
    return previous;
  },

  streaming: {
    async responseText(page) {
      // Until the new turn exists, the newest element is the previous reply.
      const before = countBefore.get(page) ?? 0;
      if ((await page.locator(S.ASSISTANT_MESSAGE).count()) <= before)
        return undefined;
      const body = newestBody(page);
      if ((await body.count()) === 0) return undefined;
      const text = await elementToMarkdown(body);
      return text === "" ? undefined : text;
    },
  },

  async detectBlock(page) {
    try {
      return (await page.title()) === S.CHALLENGE_TITLE
        ? "challenge page"
        : undefined;
    } catch {
      return undefined;
    }
  },
});
