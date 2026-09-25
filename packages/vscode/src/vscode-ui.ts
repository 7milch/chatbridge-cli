import type * as vscode from "vscode";
import type { ActiveFile } from "./protocol.js";

export interface EditorSnapshot {
  /** Workspace-relative, `/`-separated; absolute when outside a workspace. */
  path: string;
  text: string;
  /** Present when the selection is non-empty; lines are 1-based inclusive. */
  selection?: { text: string; startLine: number; endLine: number };
}

export interface ProgressReporter {
  report(text: string): void;
}

/** The slice of the vscode API the commands use; a fake in unit tests. */
export interface VscodeUi {
  showErrorMessage(
    message: string,
    ...items: string[]
  ): Promise<string | undefined>;
  showWarningMessage(message: string): void;
  showInformationMessage(message: string): void;
  withProgress<T>(
    title: string,
    cancellable: boolean,
    task: (progress: ProgressReporter, signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  activeEditor(): EditorSnapshot | undefined;
  /** True when the value is a real vscode.Uri: a command argument from an
   * unexpected caller is not. */
  isUri(value: unknown): boolean;
  /** Parses a URI string; throws when it is not a valid URI. */
  parseUri(uri: string): unknown;
  /** Opens the document behind an explorer Uri (or any Uri) read-only. */
  openDocument(uri: unknown): Promise<{ path: string; text: string }>;
  focusView(): void;
  /** Native file picker for the composer's `+`. The URIs are returned as
   * strings so they take the same path as a drop; empty when cancelled.
   * Optional: a vendor's own VscodeUi written against 0.9.0 has none, and
   * the `+` command is then a no-op. */
  pickFiles?(): Promise<string[]>;
  /** Fires with the active editor's file, or `undefined` when there is no
   * editor or its document is not a `file:` URI; also called once with the
   * current value on subscribe. Optional: without it the composer shows no
   * attach tip. */
  onDidChangeActiveEditor?(listener: (file: ActiveFile | undefined) => void): {
    dispose(): void;
  };
}

/** The tip's view of an editor: only a `file:` document has a file. Pure,
 * so the mapping is unit-tested without a VSCode host. */
export function activeFileOf(
  editor: Pick<vscode.TextEditor, "document"> | undefined,
  relPath: (uri: vscode.Uri) => string,
): ActiveFile | undefined {
  const uri = editor?.document.uri;
  if (!uri || uri.scheme !== "file") return undefined;
  const name = uri.path.slice(uri.path.lastIndexOf("/") + 1);
  return { uri: uri.toString(), path: relPath(uri), name };
}

export function createVscodeUi(api: typeof vscode, id: string): VscodeUi {
  function relPath(uri: vscode.Uri): string {
    return api.workspace.asRelativePath(uri, false).split("\\").join("/");
  }
  return {
    showErrorMessage: (message, ...items) =>
      Promise.resolve(
        api.window.showErrorMessage(
          message,
          { modal: items.length > 0 },
          ...items,
        ),
      ),
    showWarningMessage: (message) =>
      void api.window.showWarningMessage(message),
    showInformationMessage: (message) =>
      void api.window.showInformationMessage(message),
    withProgress: (title, cancellable, task) =>
      Promise.resolve(
        api.window.withProgress(
          { location: api.ProgressLocation.Notification, title, cancellable },
          (progress, token) => {
            const ac = new AbortController();
            token.onCancellationRequested(() => ac.abort());
            return task(
              { report: (message) => progress.report({ message }) },
              ac.signal,
            );
          },
        ),
      ),
    activeEditor: () => {
      const editor = api.window.activeTextEditor;
      if (!editor) return undefined;
      const doc = editor.document;
      const snap: EditorSnapshot = {
        path: relPath(doc.uri),
        text: doc.getText(),
      };
      if (!editor.selection.isEmpty) {
        snap.selection = {
          text: doc.getText(editor.selection),
          startLine: editor.selection.start.line + 1,
          endLine: editor.selection.end.line + 1,
        };
      }
      return snap;
    },
    isUri: (v) => v instanceof api.Uri,
    parseUri: (uri) => api.Uri.parse(uri, true),
    openDocument: async (uri) => {
      const doc = await api.workspace.openTextDocument(uri as vscode.Uri);
      return { path: relPath(doc.uri), text: doc.getText() };
    },
    focusView: () => void api.commands.executeCommand(`${id}.chat.focus`),
    pickFiles: async () => {
      const picked = await api.window.showOpenDialog({
        canSelectMany: true,
        canSelectFolders: false,
        openLabel: "Attach",
      });
      return (picked ?? []).map((uri) => uri.toString());
    },
    onDidChangeActiveEditor: (listener) => {
      listener(activeFileOf(api.window.activeTextEditor, relPath));
      return api.window.onDidChangeActiveTextEditor((editor) =>
        listener(activeFileOf(editor, relPath)),
      );
    },
  };
}
