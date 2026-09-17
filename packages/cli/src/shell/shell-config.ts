/** Settings for `!` shell mode in the interactive TUI. Resolved from three
 * layers: built-in default → vendor default via createCli({ shell }) → the
 * user's config.json. */
export interface ShellConfig {
  /** First line of the prompt sent after a command finishes. */
  leadIn: string;
  /** false: hold results and attach them to the next message instead. */
  autoSend: boolean;
}

export const DEFAULT_SHELL_CONFIG: ShellConfig = {
  leadIn: "Please check the execution result.",
  autoSend: true,
};

/** Starts from the built-in default; each later layer overrides the earlier
 * ones key by key. Undefined layers and undefined keys are ignored. */
export function resolveShellConfig(
  ...layers: (Partial<ShellConfig> | undefined)[]
): ShellConfig {
  const out: ShellConfig = { ...DEFAULT_SHELL_CONFIG };
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.leadIn !== undefined) out.leadIn = layer.leadIn;
    if (layer.autoSend !== undefined) out.autoSend = layer.autoSend;
  }
  return out;
}
