// Every URL and selector the provider uses. Each constant cites the section
// of docs/dom-notes.md that justifies it; fill them from the census, never
// from a guess. CSS selectors only, so window.__cbProbe.verify() can check them.

/** dom-notes §Login — where `auth login` sends the user. */
export const ENTRY_URL = "";
/** dom-notes §Chat page — the page a logged-in user chats on. */
export const CHAT_URL = "";
/** dom-notes §Login — visible only when logged OUT. */
export const SIGN_IN_CONTROL = "";
/** dom-notes §Login — visible only when logged IN. */
export const ACCOUNT_CONTROL = "";
/** dom-notes §Composer — must not match a hidden twin. */
export const COMPOSER = "";
/** dom-notes §Composer — may exist only while the composer is non-empty. */
export const SEND_BUTTON = "";
/** dom-notes §Generation indicator — present while a reply is generated. */
export const STOP_BUTTON = "";
/** dom-notes §New chat. */
export const NEW_CHAT_BUTTON = "";
/** dom-notes §Messages — every assistant turn, placeholders excluded. */
export const ASSISTANT_MESSAGE = "";
/** dom-notes §Messages — every user turn. */
export const USER_MESSAGE = "";
/** dom-notes §Messages — inside one assistant turn: content without chrome
 * (replyShape().contentRoot). */
export const ASSISTANT_MESSAGE_BODY = "";
/** dom-notes §Errors and rate limits — document.title of a bot challenge. */
export const CHALLENGE_TITLE = "Just a moment...";

/** Selectors that match a collection; verify() accepts `count >= 1` for them. */
export const MANY = [
  "ASSISTANT_MESSAGE",
  "USER_MESSAGE",
  "ASSISTANT_MESSAGE_BODY",
] as const;
