import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ChatSession,
  DEFAULT_IDLE_TIMEOUT_MS,
  type Provider,
  commandInfoOf,
  createAuthStore,
  resolveUrlHooks,
  runLogin,
} from "@chatbridge/core";
import * as vscode from "vscode";
import { ChatViewBridge } from "./chat-view-bridge.js";
import { ChatViewProvider } from "./chat-view-provider.js";
import { type CommandHandlers, createCommands } from "./commands.js";
import { installBrowser } from "./install-browser.js";
import {
  COMMAND_NAMES,
  missingContributions,
  recommendedContributions,
} from "./manifest.js";
import { SessionController } from "./session-controller.js";
import { parseIdleTimeoutMin, parseTimeoutSec } from "./timeout-setting.js";
import { type ExtensionUiOptions, resolveUiConfig } from "./ui-config.js";
import { createVscodeUi } from "./vscode-ui.js";

export interface CreateExtensionOptions {
  /** Prefix for every contributed ID, e.g. "company-ai". */
  id: string;
  /** Shown as the view title and in notifications. */
  displayName: string;
  /** Always pinned; no dynamic provider loading. */
  provider: Provider;
  /** Directory name under ~/.config; defaults to `id`. Use the vendor
   * CLI's `configDir` so one `auth login` serves both. */
  configDir?: string;
  /** Defaults; the user's `<id>.timeoutSec` / `<id>.headless` settings win. */
  timeoutMs?: number;
  headless?: boolean;
  /** Test-only: overrides the config/auth-store base directory. */
  baseDir?: string;
  /** Vendor UI customisation: welcome text, banner, footer, Send colours. */
  ui?: ExtensionUiOptions;
  /** Path of `playwright/cli.js`; defaults to
   * `<extension>/node_modules/playwright/cli.js`. */
  playwrightCliPath?: string;
}

/** What `activate` returns: the E2E drives the controller directly. */
export interface ExtensionApi {
  controller: SessionController;
  /** The E2E drives the command handlers directly. */
  handlers: CommandHandlers;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function createExtension(opts: CreateExtensionOptions) {
  let controller: SessionController | undefined;

  async function activate(
    context: vscode.ExtensionContext,
  ): Promise<ExtensionApi> {
    const missing = missingContributions(
      context.extension.packageJSON,
      opts.id,
    );
    if (missing.length > 0) {
      throw new Error(
        `${opts.displayName}: package.json lacks contributes entries for "${opts.id}": ${missing.join(", ")}`,
      );
    }
    // Not fatal: an extension whose manifest predates the title-bar actions
    // still gets the composer, the `/` menu and the notice card, and the
    // `/` menu reaches every action the title bar would show.
    const recommended = recommendedContributions(
      context.extension.packageJSON,
      opts.id,
    );
    if (recommended.length > 0) {
      console.warn(
        `${opts.displayName}: package.json lacks recommended contributes entries for "${opts.id}" (the view title bar stays empty): ${recommended.join(", ")}`,
      );
    }
    const uiConfig = resolveUiConfig(
      opts.ui,
      context.extensionPath,
      existsSync,
    );
    const authStore = createAuthStore({
      configDir: opts.configDir ?? opts.id,
      providerName: opts.provider.name,
      baseDir: opts.baseDir,
    });
    const output = vscode.window.createOutputChannel(opts.displayName);
    const statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
    );
    context.subscriptions.push(output, statusBar);

    const commands = commandInfoOf(opts.provider);

    const bridge = new ChatViewBridge(
      () => (controller as SessionController).getState(),
      {
        send: (text) =>
          void handlers.send(text).then((r) => {
            // The webview empties the composer as it posts `send`; a hook
            // refusal sends nothing, so give the text back to be fixed.
            if (!r.ok && r.code === "URL_HOOK") {
              bridge.pushTookBack([{ text, attachments: [] }]);
            }
          }),
        removeAttachment: (i) => controller?.removeAttachment(i),
        takeBack: () => {
          const r = controller?.takeBack();
          if (!r) return;
          // `takeBack()` has already emitted a `state` with the queue
          // empty; the webview fills the composer from `tookBack` alone,
          // so this arriving second does not matter.
          bridge.pushTookBack(r.entries);
          if (r.droppedAttachments > 0) {
            void vscode.window.showWarningMessage(
              `${r.droppedAttachments} attachment(s) left out: total size limit.`,
            );
          }
        },
        removeQueued: (i) => controller?.removeQueued(i),
        command: (name) => void handlers[name](),
        customCommand: (name, args, text) =>
          void handlers.customCommand(name, args, text),
        attachUris: (uris) => void handlers.attachUris(uris),
        pasted: (id, text) => bridge.pushPasteResult(id, handlers.pasted(text)),
      },
    );

    let warnedTimeout = false;
    let warnedIdle = false;
    function settings() {
      const cfg = vscode.workspace.getConfiguration(opts.id);
      const fallbackMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const { timeoutMs, invalid } = parseTimeoutSec(
        cfg.get<unknown>("timeoutSec"),
        fallbackMs,
      );
      if (invalid && !warnedTimeout) {
        warnedTimeout = true;
        void vscode.window.showWarningMessage(
          `${opts.displayName}: "${opts.id}.timeoutSec" must be a positive number; using ${fallbackMs / 1000} s.`,
        );
      }
      // Unset means the provider's own default, then 24 h.
      const idleFallbackMs =
        opts.provider.idle?.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
      const idle = parseIdleTimeoutMin(
        cfg.get<unknown>("idleTimeoutMinutes"),
        idleFallbackMs,
      );
      if (idle.invalid && !warnedIdle) {
        warnedIdle = true;
        void vscode.window.showWarningMessage(
          `${opts.displayName}: "${opts.id}.idleTimeoutMinutes" must be a non-negative number (0 disables); using ${idleFallbackMs / 60_000} minutes.`,
        );
      }
      return {
        headless: cfg.get<boolean>("headless", opts.headless ?? true),
        timeoutMs,
        idle: { timeoutMs: idle.timeoutMs },
      };
    }

    function progress(message: string): void {
      output.appendLine(message);
      statusBar.text = `$(sync~spin) ${message}`;
      bridge.pushProgress(message);
    }

    controller = new SessionController({
      openSession: (onIdleExpired) =>
        ChatSession.open({
          provider: opts.provider,
          authStore,
          ...settings(),
          onProgress: progress,
          onIdleExpired,
        }),
      expandUrls: (text) =>
        resolveUrlHooks(text, opts.provider.urlHooks ?? [], {
          timeoutMs: settings().timeoutMs,
        }),
      hints: {
        BLOCKED: `Set the "${opts.id}.headless" setting to false and try again.`,
        BROWSER_UNAVAILABLE: `Run "${opts.displayName}: Install Browser" and send again.`,
      },
      onChange: (state) => {
        bridge.pushState(state);
        if (
          state.status === "busy" ||
          state.status === "opening" ||
          state.status === "reopening"
        )
          statusBar.show();
        else statusBar.hide();
      },
    });

    const cliPath =
      opts.playwrightCliPath ??
      join(context.extensionPath, "node_modules", "playwright", "cli.js");
    const handlers: CommandHandlers = createCommands({
      displayName: opts.displayName,
      controller,
      ui: createVscodeUi(vscode, opts.id),
      runLogin,
      installBrowser,
      loginOptions: () => ({ provider: opts.provider, authStore }),
      installOptions: () => {
        if (!existsSync(cliPath)) {
          throw new Error(
            `playwright is not bundled with this extension (looked for ${cliPath}).`,
          );
        }
        return { cliPath };
      },
      clearAuth: () => authStore.clear(),
      commands,
    });

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        `${opts.id}.chat`,
        new ChatViewProvider(
          context.extensionUri,
          opts.displayName,
          bridge,
          uiConfig,
          commands,
        ),
      ),
    );
    for (const name of COMMAND_NAMES) {
      context.subscriptions.push(
        vscode.commands.registerCommand(
          `${opts.id}.${name}`,
          (arg?: unknown) =>
            name === "sendFile" ? handlers.sendFile(arg) : handlers[name](),
        ),
      );
    }
    return { controller, handlers };
  }

  async function deactivate(): Promise<void> {
    await controller?.close();
  }

  return { activate, deactivate };
}
