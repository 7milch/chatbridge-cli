import type { Attachment } from "@chatbridge/core";
import type { ActiveFile, State, Status } from "../protocol.js";

/** A turn, an open or a reopen is running: Enter queues instead of
 * sending, and the status line shows the spinner. Also decides whether a
 * progress line may be cached for the next render: a quiet status means the
 * next spinner phase starts from its own default text. */
export function isActive(status: Status): boolean {
  return status === "busy" || status === "opening" || status === "reopening";
}

export interface SendButtonState {
  icon: "send" | "queue";
  /** `aria-label`; also what a screen reader announces on focus. */
  label: string;
  /** Tooltip; names the key so the hint is not the only place it appears. */
  title: string;
  disabled: boolean;
  /** Queueing is not the primary action, so it drops the accent colours. */
  secondary: boolean;
}

/** What the composer's send button looks like. `inputEmpty` is the caller's
 * view of the textarea, so this stays free of the DOM. */
export function sendButtonState(
  state: State,
  inputEmpty: boolean,
): SendButtonState {
  const active = isActive(state.status);
  // An attachment on its own is a sendable turn: the prompt is then just
  // the files.
  const empty = inputEmpty && state.pendingAttachments.length === 0;
  return {
    icon: active ? "queue" : "send",
    label: active ? "Queue" : "Send",
    title: active ? "Queue (Enter)" : "Send (Enter)",
    disabled: empty,
    secondary: active,
  };
}

/** The muted line in the action row. Dropped by CSS on a narrow view, so it
 * never carries information that is not also in a tooltip. */
export function hintText(status: Status): string {
  return isActive(status)
    ? "Enter to queue"
    : "Enter to send · Shift+Enter newline";
}

export interface NoticeButton {
  label: string;
  command: "login" | "reopen" | "newChat";
  primary: boolean;
}

export interface Notice {
  text: string;
  buttons: NoticeButton[];
}

/** The card between the history and the composer while the session is
 * dead. The three recoveries are always offered; only which one is the
 * accented default follows the cause. */
export function noticeFor(state: State): Notice | undefined {
  if (state.status !== "dead") return undefined;
  const auth =
    state.lastError === "AUTH_REQUIRED" || state.lastError === "AUTH_EXPIRED";
  return {
    text: auth ? "Not logged in." : "The chat stopped.",
    buttons: [
      { label: "Log in", command: "login", primary: auth },
      { label: "Reopen", command: "reopen", primary: !auth },
      { label: "New chat", command: "newChat", primary: false },
    ],
  };
}

/** The ghost chip in the attachment row: the active editor's file, unless
 * it is already a pending attachment. Compared by `path`, which is what
 * `attachUris` stores on the `Attachment`. */
export function attachTipState(
  activeFile: ActiveFile | undefined,
  pending: Attachment[],
): ActiveFile | undefined {
  if (!activeFile) return undefined;
  return pending.some((a) => a.path === activeFile.path)
    ? undefined
    : activeFile;
}
