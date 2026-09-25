import type { CommandInfo } from "@chatbridge/core";
import type {
  ActiveFile,
  QueueEntry,
  State,
  ToHost,
  ToWebview,
  UiConfig,
  WebviewCommand,
} from "./protocol.js";

/** The slice of vscode.Webview the bridge uses; a fake in tests. */
export interface WebviewLike {
  postMessage(message: ToWebview): Thenable<boolean>;
  onDidReceiveMessage(listener: (message: ToHost) => void): { dispose(): void };
}

export interface ChatViewHandlers {
  send(text: string): void;
  removeAttachment(index: number): void;
  takeBack(): void;
  removeQueued(index: number): void;
  command(name: WebviewCommand): void;
  customCommand(name: string, args: string, text: string): void;
  attachUris(uris: string[]): void;
  pasted(id: number, text: string): void;
  copyText(text: string): void;
}

/** Every command the webview may post; the bridge rejects the rest. */
export const COMMAND_LIST = [
  "login",
  "logout",
  "newChat",
  "installBrowser",
  "reopen",
  "copy",
  "help",
  "pickFiles",
] satisfies WebviewCommand[];
const COMMANDS: ReadonlySet<string> = new Set(COMMAND_LIST);

function isToHost(m: unknown): m is ToHost {
  if (typeof m !== "object" || m === null) return false;
  const msg = m as Record<string, unknown>;
  switch (msg.type) {
    case "ready":
      return true;
    case "send":
      return typeof msg.text === "string";
    case "removeAttachment":
      return typeof msg.index === "number";
    case "takeBack":
      return true;
    case "removeQueued":
      return typeof msg.index === "number";
    case "command":
      return typeof msg.name === "string" && COMMANDS.has(msg.name);
    case "customCommand":
      return (
        typeof msg.name === "string" &&
        typeof msg.args === "string" &&
        typeof msg.text === "string"
      );
    case "attachUris":
      return (
        Array.isArray(msg.uris) && msg.uris.every((u) => typeof u === "string")
      );
    case "pasted":
      return typeof msg.id === "number" && typeof msg.text === "string";
    case "copyText":
      return typeof msg.text === "string";
    default:
      return false;
  }
}

/** Translates webview messages into handler calls and pushes state to
 * whichever webview is currently attached (VSCode recreates it). */
export class ChatViewBridge {
  private webview: WebviewLike | undefined;
  /** The last active file pushed; re-posted after `ready` because VSCode
   * recreates the webview and the new page starts with no tip. */
  private lastActiveFile: ActiveFile | undefined;
  private hasActiveFile = false;

  constructor(
    private readonly getState: () => State,
    private readonly handlers: ChatViewHandlers,
  ) {}

  attach(
    webview: WebviewLike,
    uiConfig?: UiConfig,
    commands?: CommandInfo[],
  ): { dispose(): void } {
    this.webview = webview;
    const sub = webview.onDidReceiveMessage((raw) => {
      if (!isToHost(raw)) return;
      switch (raw.type) {
        case "ready":
          if (uiConfig || commands) {
            void webview.postMessage({
              type: "config",
              ...uiConfig,
              ...(commands ? { commands } : {}),
            });
          }
          this.pushState(this.getState());
          if (this.hasActiveFile) this.postActiveFile();
          break;
        case "send":
          this.handlers.send(raw.text);
          break;
        case "removeAttachment":
          this.handlers.removeAttachment(raw.index);
          break;
        case "takeBack":
          this.handlers.takeBack();
          break;
        case "removeQueued":
          this.handlers.removeQueued(raw.index);
          break;
        case "command":
          this.handlers.command(raw.name);
          break;
        case "customCommand":
          this.handlers.customCommand(raw.name, raw.args, raw.text);
          break;
        case "attachUris":
          this.handlers.attachUris(raw.uris);
          break;
        case "pasted":
          this.handlers.pasted(raw.id, raw.text);
          break;
        case "copyText":
          this.handlers.copyText(raw.text);
          break;
      }
    });
    return {
      dispose: () => {
        sub.dispose();
        if (this.webview === webview) this.webview = undefined;
      },
    };
  }

  pushState(state: State): void {
    void this.webview?.postMessage({ type: "state", ...state });
  }

  get activeFile(): ActiveFile | undefined {
    return this.lastActiveFile;
  }

  /** The active editor's file for the composer's attach tip; `undefined`
   * clears it. Not a state frame: an editor switch is not a session event
   * and must not re-send the history. */
  pushActiveFile(file: ActiveFile | undefined): void {
    this.lastActiveFile = file;
    this.hasActiveFile = true;
    this.postActiveFile();
  }

  private postActiveFile(): void {
    const file = this.lastActiveFile;
    void this.webview?.postMessage(
      file ? { type: "activeFile", file } : { type: "activeFile" },
    );
  }

  pushPasteResult(id: number, attached: boolean): void {
    void this.webview?.postMessage({ type: "pasteResult", id, attached });
  }

  pushTookBack(entries: QueueEntry[]): void {
    void this.webview?.postMessage({ type: "tookBack", entries });
  }

  /** The reply streaming right now, whole text so far. Posted far more
   * often than a state frame, which is why it carries no history. */
  pushPartial(text: string, format: "markdown" | "text"): void {
    void this.webview?.postMessage({ type: "partial", text, format });
  }

  pushProgress(text: string): void {
    void this.webview?.postMessage({ type: "progress", text });
  }
}
