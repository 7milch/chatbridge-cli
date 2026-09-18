import { isAbsolute, join, normalize, sep } from "node:path";

/** Vendor-facing UI customisation, passed as `createExtension({ ui })`. */
export interface ExtensionUiOptions {
  /** Shown centred in the empty history until the first message; plain
   * text, `\n` allowed. */
  welcome?: string;
  /** Image path relative to the extension root (png/svg); shown above
   * `welcome`, same lifetime. Must ship inside the .vsix. */
  banner?: string;
  /** One line under the composer, always visible. Plain text. */
  footer?: string;
  /** CSS colour strings for the Send button. */
  sendButton?: { background?: string; foreground?: string };
}

/** Host-side resolved form: `bannerPath` is absolute and already validated.
 * `ChatViewProvider` turns it into a `bannerUri` per webview. */
export interface ResolvedUiConfig {
  welcome?: string;
  bannerPath?: string;
  footer?: string;
  sendButton?: { background?: string; foreground?: string };
}

/** Validates the vendor's UI options at activation time so a missing banner
 * fails loudly instead of silently rendering nothing. Pure: the caller
 * supplies the file-existence check. */
export function resolveUiConfig(
  ui: ExtensionUiOptions | undefined,
  extensionRoot: string,
  exists: (path: string) => boolean,
): ResolvedUiConfig | undefined {
  if (!ui) return undefined;
  const config: ResolvedUiConfig = {};
  if (ui.welcome !== undefined) config.welcome = ui.welcome;
  if (ui.footer !== undefined) config.footer = ui.footer;
  if (ui.sendButton !== undefined) config.sendButton = ui.sendButton;
  if (ui.banner !== undefined) {
    const relative = normalize(ui.banner);
    if (
      isAbsolute(ui.banner) ||
      relative === ".." ||
      relative.startsWith(`..${sep}`)
    ) {
      throw new Error(
        `${ui.banner}: banner path must be relative to the extension root`,
      );
    }
    const absolute = join(extensionRoot, relative);
    if (!exists(absolute)) {
      throw new Error(
        `${ui.banner}: banner image not found (looked for ${absolute})`,
      );
    }
    config.bannerPath = absolute;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}
