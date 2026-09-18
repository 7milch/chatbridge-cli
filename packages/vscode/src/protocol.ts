import type { Attachment } from "@chatbridge/core";

export type Role = "user" | "assistant" | "error" | "separator";

export interface Message {
  role: Role;
  text: string;
  /** `user` entries: files appended to the prompt, one line each. */
  attachments?: Attachment[];
}

/** closed: no browser. opening: ChatSession.open in flight. idle: ready.
 * busy: a turn is in flight. dead: fatal error; New chat or Log in recover. */
export type Status = "closed" | "opening" | "idle" | "busy" | "dead";

export interface State {
  status: Status;
  messages: Message[];
  pendingAttachments: Attachment[];
  /** `ChatBridgeError.code` of the error that made the status `dead`. */
  lastError?: string;
}

/** webview → host */
export type ToHost =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "removeAttachment"; index: number }
  | { type: "command"; name: "login" | "newChat" | "installBrowser" };

/** Vendor UI customisation, as the webview receives it. */
export interface UiConfig {
  welcome?: string;
  /** Webview URI (already converted with `asWebviewUri`). */
  bannerUri?: string;
  footer?: string;
  sendButton?: { background?: string; foreground?: string };
}

/** host → webview */
export type ToWebview =
  | ({ type: "state" } & State)
  | { type: "progress"; text: string }
  | ({ type: "config" } & UiConfig);
