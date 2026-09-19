import type {
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
  attachUris(uris: string[]): void;
  pasted(id: number, text: string): void;
}

/** Every command the webview may post; the bridge rejects the rest. */
export const COMMAND_LIST = [
  "login",
  "logout",
  "newChat",
  "installBrowser",
  "reopen",
  "help",
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
    case "attachUris":
      return (
        Array.isArray(msg.uris) && msg.uris.every((u) => typeof u === "string")
      );
    case "pasted":
      return typeof msg.id === "number" && typeof msg.text === "string";
    default:
      return false;
  }
}

/** Translates webview messages into handler calls and pushes state to
 * whichever webview is currently attached (VSCode recreates it). */
export class ChatViewBridge {
  private webview: WebviewLike | undefined;

  constructor(
    private readonly getState: () => State,
    private readonly handlers: ChatViewHandlers,
  ) {}

  attach(webview: WebviewLike, uiConfig?: UiConfig): { dispose(): void } {
    this.webview = webview;
    const sub = webview.onDidReceiveMessage((raw) => {
      if (!isToHost(raw)) return;
      switch (raw.type) {
        case "ready":
          if (uiConfig)
            void webview.postMessage({ type: "config", ...uiConfig });
          this.pushState(this.getState());
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
        case "attachUris":
          this.handlers.attachUris(raw.uris);
          break;
        case "pasted":
          this.handlers.pasted(raw.id, raw.text);
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

  pushPasteResult(id: number, attached: boolean): void {
    void this.webview?.postMessage({ type: "pasteResult", id, attached });
  }

  pushTookBack(entries: QueueEntry[]): void {
    void this.webview?.postMessage({ type: "tookBack", entries });
  }

  pushProgress(text: string): void {
    void this.webview?.postMessage({ type: "progress", text });
  }
}
