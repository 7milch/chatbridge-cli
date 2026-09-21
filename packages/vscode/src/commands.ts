import type { CommandInfo, LoginOptions } from "@chatbridge/core";
import { LoginAbortedError } from "@chatbridge/core";
import { helpText } from "@chatbridge/core/slash-commands";
import type { InstallBrowserOptions } from "./install-browser.js";
import type { SendResult, SessionController } from "./session-controller.js";
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
  /** The provider's own commands, listed by `/help`. */
  commands?: readonly CommandInfo[];
  /** `/copy`: puts text on the system clipboard. Optional, so a vendor's
   * older wiring still type-checks; `/copy` then reports a failure rather
   * than silently doing nothing. */
  writeClipboard?: (text: string) => Thenable<void>;
}

export interface CommandHandlers {
  login(): Promise<void>;
  logout(): Promise<void>;
  newChat(): Promise<void>;
  reopen(): Promise<void>;
  installBrowser(): Promise<void>;
  /** From the webview's `/copy`: the last reply, as the provider returned
   * it, onto the system clipboard. Nothing is sent and nothing is logged. */
  copy(): Promise<void>;
  /** From the webview's copy button: a part of a reply the view picked
   * out. Same clipboard, same failure warning, same silence in the logs.
   * No success toast: the button itself flips to "Copied". */
  copyText(text: string): Promise<void>;
  /** From the webview's `/help`: the listing joins the history. */
  help(): void;
  /** From the webview's `/name args`. */
  customCommand(name: string, args: string, text: string): Promise<void>;
  sendSelection(): Promise<void>;
  sendFile(uri: unknown): Promise<void>;
  focus(): void;
  /** From the webview's input box. The result is returned so the caller can
   * hand the text back to the composer when the turn was refused. */
  send(text: string): Promise<SendResult>;
  /** Files dropped on the webview; unreadable URIs are reported together. */
  attachUris(uris: string[]): Promise<void>;
  /** The composer's `+`: the native picker feeds `attachUris`, so the size
   * limit and the error report are shared with drag and drop. */
  pickFiles(): Promise<void>;
  /** The title bar's Help entry: focus the view, then push the same
   * listing the webview's `/help` produces. */
  helpInView(): void;
  /** A paste into the input box; true when it became a selection chip. */
  pasted(text: string): boolean;
}

/** Everything both copy paths share: a missing or rejecting clipboard is a
 * warning the user can act on, never an unhandled rejection. The text
 * itself never reaches a message, a log or the warning. `announce` raises
 * the success toast; the copy button flips to "Copied" in the view on its
 * own, so that path stays quiet and several copies do not stack toasts. */
async function writeToClipboard(
  write: ((text: string) => Thenable<void>) | undefined,
  text: string,
  ui: VscodeUi,
  subject: string,
  announce: boolean,
): Promise<void> {
  if (write === undefined) {
    ui.showWarningMessage(`Could not copy ${subject}.`);
    return;
  }
  try {
    await write(text);
  } catch {
    ui.showWarningMessage(`Could not copy ${subject}.`);
    return;
  }
  if (announce) ui.showInformationMessage(`Copied ${subject}.`);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Pasted text arrives with the platform's line endings; the editor's
 * selection text does not. Compare them on the same footing. */
const normalise = (s: string) => s.replace(/\r\n/g, "\n");

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createCommands(deps: CommandDeps): CommandHandlers {
  const { controller, ui } = deps;

  /** `deps.writeClipboard` is read per call: the seam is optional and the
   * two copy paths must report the same way when it is missing. */
  const copyToClipboard = (
    text: string,
    subject: string,
    announce: boolean,
  ): Promise<void> =>
    writeToClipboard(deps.writeClipboard, text, ui, subject, announce);

  function isBusy(): boolean {
    const status = controller.getState().status;
    return status === "busy" || status === "opening" || status === "reopening";
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

  function help(): void {
    controller.pushHelp(helpText(deps.commands ?? []));
  }

  async function attachUris(uris: string[]): Promise<void> {
    const skipped: string[] = [];
    for (const raw of new Set(uris)) {
      try {
        const doc = await ui.openDocument(ui.parseUri(raw));
        attach(doc.path, doc.text);
      } catch {
        skipped.push(raw);
      }
    }
    if (skipped.length > 0) {
      ui.showWarningMessage(`Skipped: ${skipped.join(", ")}`);
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
      if (isBusy()) {
        ui.showWarningMessage(
          "Wait for the current reply to finish, then log out.",
        );
        return;
      }
      // The auth state goes first: `discard` drains the queue, and a queued
      // entry would otherwise reopen the browser — and send — under the
      // credentials the user just asked to delete.
      await deps.clearAuth();
      if (!(await controller.discard("Logged out"))) {
        // A turn started while the auth state was being deleted. The file
        // is gone either way; only the session is still open, so warn about
        // that alone.
        ui.showWarningMessage(
          "Wait for the current reply to finish, then log out.",
        );
      }
    },

    async newChat() {
      if (!(await controller.newChat())) {
        ui.showWarningMessage(
          "Wait for the current reply to finish, or press Ctrl+R to reopen.",
        );
      }
    },

    reopen: () => controller.reopen(),

    async copy() {
      const reply = controller.lastReply();
      if (reply === undefined) {
        ui.showInformationMessage("Nothing to copy yet.");
        return;
      }
      await copyToClipboard(reply, "the last reply", true);
    },

    copyText: (text) => copyToClipboard(text, "the text", false),

    help,

    helpInView() {
      // The title bar can be clicked while the view is collapsed or another
      // view is showing; the listing is only useful once it is visible.
      ui.focusView();
      help();
    },

    async customCommand(name, args, text) {
      const result = await controller.runCommand(name, args, text);
      if (result.ok || result.code !== "BROWSER_UNAVAILABLE") return;
      const choice = await ui.showErrorMessage(result.message, "Install");
      if (choice !== "Install") return;
      if (await runInstall()) await controller.retryLast();
    },

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
        if (!ui.isUri(uri)) {
          ui.showWarningMessage("Nothing to attach.");
          return;
        }
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

    attachUris,

    async pickFiles() {
      // No picker on this UI (a vendor's own, written against 0.9.0): the
      // command does nothing rather than throwing.
      const uris = (await ui.pickFiles?.()) ?? [];
      // Cancelling is not an error and must not clear anything.
      if (uris.length === 0) return;
      await attachUris(uris);
    },

    pasted(text) {
      const editor = ui.activeEditor();
      const selection = editor?.selection;
      if (!editor || !selection || selection.text.trim() === "") return false;
      if (normalise(text) !== normalise(selection.text)) return false;
      attachEditor(editor, true);
      return true;
    },

    async send(text) {
      const result = await controller.send(text);
      if (result.ok || result.code !== "BROWSER_UNAVAILABLE") return result;
      const choice = await ui.showErrorMessage(result.message, "Install");
      if (choice !== "Install") return result;
      if (await runInstall()) await controller.retryLast();
      return result;
    },
  };
}
