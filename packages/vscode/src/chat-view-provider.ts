import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { ChatViewBridge } from "./chat-view-bridge.js";
import { buildHtml } from "./webview-html.js";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly title: string,
    private readonly bridge: ChatViewBridge,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    view.webview.html = buildHtml({
      cspSource: view.webview.cspSource,
      nonce: randomBytes(16).toString("base64url"),
      scriptUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(root, "main.js"))
        .toString(),
      styleUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(root, "style.css"))
        .toString(),
      title: this.title,
    });
    const sub = this.bridge.attach(view.webview);
    view.onDidDispose(() => sub.dispose());
  }
}
