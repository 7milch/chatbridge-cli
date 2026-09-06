import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ChatBridgeError } from "@chatbridge/core";

export interface CliConfig {
  /** Provider spec used when --provider is absent. Relative paths are
   * already resolved against the config file's directory. */
  defaultProvider?: string;
}

export interface ConfigLocation {
  /** Directory name under the base dir, e.g. "chatbridge". */
  configDir: string;
  /** Base directory; defaults to ~/.config. Overridable for tests. */
  baseDir?: string;
}

export function configPath(loc: ConfigLocation): string {
  const base = loc.baseDir ?? join(homedir(), ".config");
  return join(base, loc.configDir, "config.json");
}

function invalid(file: string, why: string, cause?: unknown): ChatBridgeError {
  return new ChatBridgeError(
    "INVALID_CONFIG",
    `Invalid config ${file}: ${why}`,
    {
      cause,
    },
  );
}

/** Reads <base>/<configDir>/config.json. Missing file → {}. */
export async function loadConfig(loc: ConfigLocation): Promise<CliConfig> {
  const file = configPath(loc);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return {};
    throw invalid(file, "could not read the file", err);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw invalid(file, "not valid JSON", err);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw invalid(file, "top level must be a JSON object");
  }
  const { defaultProvider } = doc as Record<string, unknown>;
  const cfg: CliConfig = {};
  if (defaultProvider !== undefined) {
    if (typeof defaultProvider !== "string") {
      throw invalid(file, '"defaultProvider" must be a string');
    }
    const isRelative =
      defaultProvider.startsWith("./") || defaultProvider.startsWith("../");
    cfg.defaultProvider = isRelative
      ? resolve(dirname(file), defaultProvider)
      : defaultProvider;
  }
  return cfg;
}
