import type { Attachment, CommandInfo } from "@chatbridge/core";

export type Role = "user" | "assistant" | "error" | "separator" | "help";

export interface Message {
  role: Role;
  text: string;
  /** `user` entries: files appended to the prompt, one line each. */
  attachments?: Attachment[];
  /** `assistant` entries: how to render `text`. Absent means "text". */
  format?: "markdown" | "text";
  /** `assistant` entries: the turn failed after this much had streamed. */
  incomplete?: true;
}

/** closed: no browser. opening: ChatSession.open in flight. idle: ready.
 * busy: a turn is in flight. reopening: Ctrl+R is replacing the browser.
 * dead: fatal error; New chat, Log in or Reopen recover. */
export type Status =
  | "closed"
  | "opening"
  | "idle"
  | "busy"
  | "reopening"
  | "dead";

/** A message waiting for its turn: sent while the controller was not idle. */
export interface QueueEntry {
  text: string;
  attachments: Attachment[];
}

/** The file behind the active text editor, for the composer's attach tip.
 * Never part of `State`: an editor switch is not a session event. */
export interface ActiveFile {
  /** `vscode.Uri.toString()`, what `attachUris` takes. */
  uri: string;
  /** Workspace-relative, `/`-separated; absolute outside a workspace. */
  path: string;
  /** Basename, what the chip shows. */
  name: string;
}

export interface State {
  status: Status;
  messages: Message[];
  pendingAttachments: Attachment[];
  /** Oldest first; drained one entry per turn end. */
  queue: QueueEntry[];
  /** `ChatBridgeError.code` of the error that made the status `dead`. */
  lastError?: string;
}

export type WebviewCommand =
  | "login"
  | "logout"
  | "newChat"
  | "installBrowser"
  | "reopen"
  /** The host copies the last reply to the clipboard. */
  | "copy"
  /** The host answers with a `help` history entry. Sent by the webview and
   * by the `<id>.help` VS Code command. */
  | "help"
  /** Webview only: the composer's `+` opens the native file picker; the
   * chosen files go through the same path as a drop. */
  | "pickFiles";

/** webview → host */
export type ToHost =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "removeAttachment"; index: number }
  | { type: "takeBack" }
  | { type: "removeQueued"; index: number }
  | { type: "command"; name: WebviewCommand }
  /** A provider `/command`; `text` is the line as typed, for the history. */
  | { type: "customCommand"; name: string; args: string; text: string }
  /** Files dropped on the webview, as URI strings. */
  | { type: "attachUris"; uris: string[] }
  /** A paste into the input box; `id` pairs it with its `pasteResult`. */
  | { type: "pasted"; id: number; text: string }
  /** The host copies `text` to the clipboard: a part of a reply the webview
   * picked out, rather than the whole last one the `copy` command takes. */
  | { type: "copyText"; text: string };

/** Vendor UI customisation, as the webview receives it. */
export interface UiConfig {
  welcome?: string;
  /** Webview URI (already converted with `asWebviewUri`). */
  bannerUri?: string;
  footer?: string;
  sendButton?: { background?: string; foreground?: string };
  userMessage?: { borderColor?: string };
}

/** host → webview */
export type ToWebview =
  | ({ type: "state" } & State)
  | { type: "progress"; text: string }
  | ({ type: "config" } & UiConfig & {
        /** The provider's commands, so the webview can parse `/name args`. */
        commands?: CommandInfo[];
      })
  /** Answer to `pasted`: when attached, the webview drops the pasted text. */
  | { type: "pasteResult"; id: number; attached: boolean }
  /** Answer to `takeBack`: the entries removed from the queue. */
  | { type: "tookBack"; entries: QueueEntry[] }
  /** The reply being streamed, whole text so far. Not part of `State`: a
   * state frame carries the whole history and is far too heavy for the
   * polling rate. The next `state` frame that is not `busy` ends it. */
  | { type: "partial"; text: string; format: "markdown" | "text" }
  /** The active editor's file, or none. Posted on every editor switch and
   * once after `ready`, since VSCode recreates the webview. */
  | { type: "activeFile"; file?: ActiveFile };
