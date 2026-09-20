import { randomBytes } from "node:crypto";
import type { CommandInfo } from "@chatbridge/core";
import * as vscode from "vscode";
import type { ChatViewBridge } from "./chat-view-bridge.js";
import type { UiConfig } from "./protocol.js";
import type { ResolvedUiConfig } from "./ui-config.js";
import { buildHtml } from "./webview-html.js";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly title: string,
    private readonly bridge: ChatViewBridge,
    private readonly ui?: ResolvedUiConfig,
    private readonly commands?: CommandInfo[],
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const bannerUri = this.ui?.bannerPath
      ? vscode.Uri.file(this.ui.bannerPath)
      : undefined;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: bannerUri
        ? [root, vscode.Uri.joinPath(bannerUri, "..")]
        : [root],
    };
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
    let uiConfig: UiConfig | undefined;
    if (this.ui) {
      const { bannerPath: _bannerPath, ...rest } = this.ui;
      uiConfig = bannerUri
        ? {
            ...rest,
            bannerUri: view.webview.asWebviewUri(bannerUri).toString(),
          }
        : rest;
    }
    const sub = this.bridge.attach(view.webview, uiConfig, this.commands);
    view.onDidDispose(() => sub.dispose());
  }
}
