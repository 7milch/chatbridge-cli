import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ChatSession,
  type Provider,
  createAuthStore,
  runLogin,
} from "@chatbridge/core";
import * as vscode from "vscode";
import { ChatViewBridge } from "./chat-view-bridge.js";
import { ChatViewProvider } from "./chat-view-provider.js";
import { type CommandHandlers, createCommands } from "./commands.js";
import { installBrowser } from "./install-browser.js";
import { COMMAND_NAMES, missingContributions } from "./manifest.js";
import { SessionController } from "./session-controller.js";
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
  /** Path of `playwright/cli.js`; defaults to
   * `<extension>/node_modules/playwright/cli.js`. */
  playwrightCliPath?: string;
}

/** What `activate` returns: the E2E drives the controller directly. */
export interface ExtensionApi {
  controller: SessionController;
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

    const bridge = new ChatViewBridge(
      () => (controller as SessionController).getState(),
      {
        send: (text) => void handlers.send(text),
        removeAttachment: (i) => controller?.removeAttachment(i),
        command: (name) => void handlers[name](),
      },
    );

    function settings() {
      const cfg = vscode.workspace.getConfiguration(opts.id);
      return {
        headless: cfg.get<boolean>("headless", opts.headless ?? true),
        timeoutMs:
          cfg.get<number>(
            "timeoutSec",
            (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000,
          ) * 1000,
      };
    }

    function progress(message: string): void {
      output.appendLine(message);
      statusBar.text = `$(sync~spin) ${message}`;
      bridge.pushProgress(message);
    }

    controller = new SessionController({
      openSession: () =>
        ChatSession.open({
          provider: opts.provider,
          authStore,
          ...settings(),
          onProgress: progress,
        }),
      onChange: (state) => {
        bridge.pushState(state);
        if (state.status === "busy" || state.status === "opening")
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
    });

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        `${opts.id}.chat`,
        new ChatViewProvider(context.extensionUri, opts.displayName, bridge),
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
    return { controller };
  }

  async function deactivate(): Promise<void> {
    await controller?.close();
  }

  return { activate, deactivate };
}
