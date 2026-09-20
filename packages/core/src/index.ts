export * from "./errors.js";
export {
  type LoginOptions,
  type OneShotOptions,
  runLogin,
  runOneShot,
} from "./session.js";
export {
  ChatSession,
  type ChatSessionOptions,
  DEFAULT_POLL_INTERVAL_MS,
  IDLE_CLOSE_BUDGET_MS,
  type SendOptions,
  type OpenOptions,
  type RuntimeLike,
  isRetryableOpenError,
} from "./chat-session.js";
export { launchRuntime } from "./launch-runtime.js";
export { createAuthStore } from "./create-auth-store.js";
export {
  AuthStore,
  type AuthStoreOptions,
  BrowserRuntime,
  validateProviderName,
} from "@chatbridge/runtime";
export type {
  Provider,
  ProviderCommand,
  ProviderCommandResult,
  ProviderOpenDefaults,
  UrlHook,
  UrlHookResult,
} from "@chatbridge/provider";
export { BUILTIN_COMMAND_NAMES, defineProvider } from "@chatbridge/provider";
export {
  type Attachment,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  fenceFor,
  formatAttachment,
  formatSize,
  totalSizeProblem,
} from "./attachment.js";
export {
  type ClosableSession,
  type KillableSession,
  closeOrKill,
  closeWithTimeout,
} from "./close-session.js";
export {
  DEFAULT_IDLE_TIMEOUT_MS,
  IdleWatch,
  type IdleOptions,
  type IdleWatchOptions,
  formatIdleDuration,
} from "./idle-watch.js";
export {
  type CommandInfo,
  type ParsedSlash,
  SLASH_COMMANDS,
  type SlashCommand,
  commandInfoOf,
  commandNamesOf,
  helpText,
  parseSlashCommand,
  unknownCommandMessage,
} from "./slash-commands.js";
export {
  type ResolvedUrl,
  type UrlExpansion,
  type UrlHookOptions,
  UrlHookError,
  expandUrlHooks,
  findUrls,
  resolveUrlHooks,
} from "./expand-url-hooks.js";
