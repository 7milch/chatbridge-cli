export * from "./protocol.js";
export {
  type AddResult,
  type ChatSessionLike,
  type HintCode,
  type PendingAttachment,
  type SendResult,
  SessionController,
  type SessionControllerOptions,
  type TakeBackResult,
} from "./session-controller.js";
export {
  type ChildLike,
  installBrowser,
  type InstallBrowserOptions,
  type SpawnFn,
  splitProgressLines,
} from "./install-browser.js";
export {
  COMMAND_NAMES,
  type CommandName,
  expectedContributions,
  missingContributions,
} from "./manifest.js";
export {
  ChatViewBridge,
  type ChatViewHandlers,
  type WebviewLike,
} from "./chat-view-bridge.js";
export { buildHtml, type HtmlInputs } from "./webview-html.js";
export {
  type ExtensionUiOptions,
  type ResolvedUiConfig,
  resolveUiConfig,
} from "./ui-config.js";
export {
  createVscodeUi,
  type EditorSnapshot,
  type ProgressReporter,
  type VscodeUi,
} from "./vscode-ui.js";
export {
  type CommandDeps,
  type CommandHandlers,
  createCommands,
} from "./commands.js";
export {
  createExtension,
  type CreateExtensionOptions,
  type ExtensionApi,
} from "./create-extension.js";
