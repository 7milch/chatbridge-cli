import type { LoginOptions } from "@chatbridge/core";
import { LoginAbortedError } from "@chatbridge/core";
import type { InstallBrowserOptions } from "./install-browser.js";
import type { SessionController } from "./session-controller.js";
import type { EditorSnapshot, VscodeUi } from "./vscode-ui.js";

export interface CommandDeps {
  displayName: string;
  controller: SessionController;
  ui: VscodeUi;
  runLogin: (opts: LoginOptions) => Promise<void>;
  installBrowser: (opts: InstallBrowserOptions) => Promise<void>;
  /** Provider, auth store, etc.; the command adds signal and onProgress. */
  loginOptions: () => Omit<LoginOptions, "signal" | "onProgress">;
  installOptions: () => Omit<InstallBrowserOptions, "onProgress">;
  clearAuth: () => Promise<void>;
}

export interface CommandHandlers {
  login(): Promise<void>;
  logout(): Promise<void>;
  newChat(): Promise<void>;
  installBrowser(): Promise<void>;
  sendSelection(): Promise<void>;
  sendFile(uri: unknown): Promise<void>;
  focus(): void;
  /** From the webview's input box. */
  send(text: string): Promise<void>;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createCommands(deps: CommandDeps): CommandHandlers {
  const { controller, ui } = deps;

  function isBusy(): boolean {
    const status = controller.getState().status;
    return status === "busy" || status === "opening";
  }

  async function runInstall(): Promise<boolean> {
    try {
      await ui.withProgress("Installing Chromium", false, (progress) =>
        deps.installBrowser({
          ...deps.installOptions(),
          onProgress: (l) => progress.report(l),
        }),
      );
      return true;
    } catch (err) {
      await ui.showErrorMessage(`Chromium install failed: ${message(err)}`);
      return false;
    }
  }

  function attach(path: string, text: string): void {
    const result = controller.addAttachment({
      path,
      bytes: utf8Bytes(text),
      content: text,
    });
    if (!result.ok) {
      ui.showWarningMessage(result.reason);
      return;
    }
    ui.focusView();
  }

  function attachEditor(editor: EditorSnapshot, useSelection: boolean): void {
    if (useSelection && editor.selection) {
      const s = editor.selection;
      attach(`${editor.path}:L${s.startLine}-L${s.endLine}`, s.text);
    } else {
      attach(editor.path, editor.text);
    }
  }

  return {
    async login() {
      if (isBusy()) {
        ui.showWarningMessage(
          "Wait for the current reply to finish, then log in.",
        );
        return;
      }
      try {
        await ui.withProgress(
          `Log in to ${deps.displayName}`,
          true,
          (progress, signal) =>
            deps.runLogin({
              ...deps.loginOptions(),
              signal,
              onProgress: (m) => progress.report(m),
            }),
        );
        controller.markLoggedIn();
      } catch (err) {
        if (err instanceof LoginAbortedError) return;
        await ui.showErrorMessage(`Login failed: ${message(err)}`);
      }
    },

    async logout() {
      if (!(await controller.discard("Logged out"))) {
        ui.showWarningMessage(
          "Wait for the current reply to finish, then log out.",
        );
        return;
      }
      await deps.clearAuth();
    },

    newChat: () => controller.newChat(),

    async installBrowser() {
      if (await runInstall()) ui.showInformationMessage("Chromium installed.");
    },

    async sendSelection() {
      const editor = ui.activeEditor();
      if (!editor) {
        ui.showWarningMessage("No active editor.");
        return;
      }
      attachEditor(editor, true);
    },

    async sendFile(uri) {
      if (uri !== undefined && uri !== null) {
        const doc = await ui.openDocument(uri);
        attach(doc.path, doc.text);
        return;
      }
      const editor = ui.activeEditor();
      if (!editor) {
        ui.showWarningMessage("No active editor.");
        return;
      }
      attachEditor(editor, false);
    },

    focus: () => ui.focusView(),

    async send(text) {
      const result = await controller.send(text);
      if (result.ok || result.code !== "BROWSER_UNAVAILABLE") return;
      const choice = await ui.showErrorMessage(result.message, "Install");
      if (choice !== "Install") return;
      if (await runInstall()) await controller.retryLast();
    },
  };
}
