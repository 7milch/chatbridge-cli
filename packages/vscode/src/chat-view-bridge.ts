import type { State, ToHost, ToWebview } from "./protocol.js";

/** The slice of vscode.Webview the bridge uses; a fake in tests. */
export interface WebviewLike {
  postMessage(message: ToWebview): Thenable<boolean>;
  onDidReceiveMessage(listener: (message: ToHost) => void): { dispose(): void };
}

export interface ChatViewHandlers {
  send(text: string): void;
  removeAttachment(index: number): void;
  command(name: "login" | "newChat" | "installBrowser"): void;
}

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
    case "command":
      return (
        msg.name === "login" ||
        msg.name === "newChat" ||
        msg.name === "installBrowser"
      );
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

  attach(webview: WebviewLike): { dispose(): void } {
    this.webview = webview;
    const sub = webview.onDidReceiveMessage((raw) => {
      if (!isToHost(raw)) return;
      switch (raw.type) {
        case "ready":
          this.pushState(this.getState());
          break;
        case "send":
          this.handlers.send(raw.text);
          break;
        case "removeAttachment":
          this.handlers.removeAttachment(raw.index);
          break;
        case "command":
          this.handlers.command(raw.name);
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

  pushProgress(text: string): void {
    void this.webview?.postMessage({ type: "progress", text });
  }
}
