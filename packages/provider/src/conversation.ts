import type { Page } from "playwright-core";

/** Lets an interactive UI return to the same service-side conversation
 * after the browser was closed (idle timeout, reopen). The handle is an
 * opaque string owned by the provider; the framework only stores it and
 * hands it back. It must never embed credentials. */
export interface ProviderConversation {
  /** Handle of the conversation on the page; `undefined` when there is none
   * yet (a new chat before its first turn). Called after every turn. */
  handle(page: Page): Promise<string | undefined>;
  /** Bring the page to the conversation `handle` names. Called on the chat
   * page, after the login check. Throw when it cannot be opened: the
   * framework then starts a new chat instead. */
  open(page: Page, handle: string): Promise<void>;
}

/** The common case: the conversation id is in the page URL. `match` tells a
 * conversation URL from the plain chat page. It is tested against the whole
 * `page.url()`, including any query string or fragment, so do not anchor it
 * with `$` when conversation URLs can carry one — use a form such as
 * `/\/c\/[0-9a-f-]+(?:[/?#]|$)/`. A `match` that never matches makes `handle`
 * return `undefined` forever, and nothing is ever restored. */
export function urlConversation(options: {
  match: RegExp | ((url: string) => boolean);
}): ProviderConversation {
  const { match } = options;
  if (match instanceof RegExp && /[gy]/.test(match.flags)) {
    throw new Error(
      `urlConversation match ${match} must not use the g or y flag (it makes .test stateful).`,
    );
  }
  const matches = (url: string) =>
    match instanceof RegExp ? match.test(url) : match(url);
  return {
    async handle(page) {
      const url = page.url();
      return matches(url) ? url : undefined;
    },
    async open(page, handle) {
      // Messages stay free of the handle: it identifies a conversation.
      if (!matches(handle)) {
        throw new Error("The handle is not a conversation URL.");
      }
      await page.goto(handle);
      // A service answers an unknown id by redirecting to the plain chat
      // page; that must read as a failure, not as a restored conversation.
      if (!matches(page.url())) {
        throw new Error("The conversation did not open.");
      }
    },
  };
}
