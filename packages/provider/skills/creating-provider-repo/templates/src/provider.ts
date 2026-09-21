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

/** What the composer holds: a form control's value, else its rendered text. */
const composerText = (composer: Locator): Promise<string> =>
  composer.evaluate((el) =>
    ("value" in el && typeof el.value === "string"
      ? el.value
      : ((el as { innerText?: string }).innerText ?? "")
    ).trim(),
  );

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
      const account = visibleOnly(page, S.ACCOUNT_CONTROL);
      // Decision table "no sign-in control found": SIGN_IN_CONTROL is empty
      // and the account control decides alone (a logged-out poll then takes
      // the full 10 s). An empty selector must never reach page.locator().
      const signIn =
        S.SIGN_IN_CONTROL.length > 0
          ? visibleOnly(page, S.SIGN_IN_CONTROL)
          : undefined;
      await (signIn ? signIn.or(account) : account)
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      // A guest composer proves nothing: account present AND sign-in absent.
      return (
        (await account.count()) > 0 &&
        (signIn === undefined || (await signIn.count()) === 0)
      );
    } catch {
      return false;
    }
  },

  async startNewChat(page) {
    // Decision table "new chat is a URL": NEW_CHAT_BUTTON stays empty and new
    // chat is a navigation to CHAT_URL, with no edit here. VARIANT: when new
    // chat has a URL of its own, add a NEW_CHAT_URL constant to selectors.ts
    // and goto that instead. An empty selector never reaches page.locator().
    const button =
      S.NEW_CHAT_BUTTON.length > 0
        ? visibleOnly(page, S.NEW_CHAT_BUTTON)
        : undefined;
    // count() does not auto-wait: without this the first paint after a
    // navigation would look like "there is no button" and take the fallback.
    await button
      ?.first()
      .waitFor({ state: "visible", timeout: 3_000 })
      .catch(() => {});
    if (button && (await button.count()) > 0) await button.first().click();
    else await page.goto(S.CHAT_URL);
    const composer = visibleOnly(page, S.COMPOSER).first();
    await composer.waitFor({ state: "visible" });
    // The contract is "visible AND empty": a draft the service restored would
    // be sent in front of the next prompt.
    const emptyBy = Date.now() + 10_000;
    while ((await composerText(composer)) !== "") {
      if (Date.now() > emptyBy)
        throw new Error("startNewChat: the composer still holds text");
      await page.waitForTimeout(200);
    }
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
    // Raise the timeout for a service that is slow to start. Skipped when
    // STOP_BUTTON is empty (decision table "`doneCandidates` is empty").
    if (S.STOP_BUTTON.length > 0)
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
    //    With STOP_BUTTON empty there is no done signal: the new turn's
    //    arrival (step 2, then given the whole budget) and the stability read
    //    carry the turn, and ASSISTANT_MESSAGE's placeholder exclusion is all
    //    that keeps a placeholder from being read as the answer.
    const hasDoneSignal = S.STOP_BUTTON.length > 0;
    if (hasDoneSignal)
      await page
        .locator(S.STOP_BUTTON)
        .first()
        .waitFor({ state: "hidden", timeout: TURN_LIMIT_MS });
    // 2. Then the new turn must exist.
    await page.waitForFunction(
      ({ selector, count }: { selector: string; count: number }) =>
        document.querySelectorAll(selector).length > count,
      { selector: S.ASSISTANT_MESSAGE, count: before },
      { timeout: hasDoneSignal ? NEW_TURN_TIMEOUT_MS : TURN_LIMIT_MS },
    );
    // 3. Stability read: two equal reads 500 ms apart. `deadline` was set
    //    before step 1, so the whole method shares one budget: if the done
    //    wait spent nearly all of it the loop runs zero times and the single
    //    read below is the answer; if it spent all of it, step 1 has thrown.
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
