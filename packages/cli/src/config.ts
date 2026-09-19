import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ChatBridgeError } from "@chatbridge/core";
import type { ShellConfig } from "./shell/shell-config.js";

export interface CliConfig {
  /** Provider spec used when --provider is absent. Relative paths are
   * already resolved against the config file's directory. */
  defaultProvider?: string;
  /** `!` shell mode overrides; each key is optional and wins over the
   * vendor default from createCli. */
  shell?: Partial<ShellConfig>;
  /** Opening-phase overrides; each key is optional and wins over the
   * provider's `open` defaults. Seconds, like --timeout. */
  open?: { timeoutSec?: number; retries?: number };
}

export interface ConfigLocation {
  /** Directory name under the base dir, e.g. "chatbridge". */
  configDir: string;
  /** Base directory; defaults to ~/.config. Overridable for tests. */
  baseDir?: string;
}

export interface LoadConfigOptions {
  /** The CLI ships a pinned provider: "defaultProvider" is documented as
   * ignored, so it is neither validated nor returned. */
  providerPinned?: boolean;
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

/** Reads <base>/<configDir>/config.json. Missing file → {}. A file that
 * exists must be valid JSON with the documented shapes; every mode that
 * reads it fails the same way on a broken file. */
export async function loadConfig(
  loc: ConfigLocation,
  opts: LoadConfigOptions = {},
): Promise<CliConfig> {
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
  const { defaultProvider, shell, open } = doc as Record<string, unknown>;
  const cfg: CliConfig = {};
  if (defaultProvider !== undefined && !opts.providerPinned) {
    if (typeof defaultProvider !== "string") {
      throw invalid(file, '"defaultProvider" must be a string');
    }
    const isRelative =
      defaultProvider.startsWith("./") || defaultProvider.startsWith("../");
    cfg.defaultProvider = isRelative
      ? resolve(dirname(file), defaultProvider)
      : defaultProvider;
  }
  if (shell !== undefined) {
    if (typeof shell !== "object" || shell === null || Array.isArray(shell)) {
      throw invalid(file, '"shell" must be an object');
    }
    const { leadIn, autoSend } = shell as Record<string, unknown>;
    const out: Partial<ShellConfig> = {};
    if (leadIn !== undefined) {
      if (typeof leadIn !== "string") {
        throw invalid(file, '"shell.leadIn" must be a string');
      }
      out.leadIn = leadIn;
    }
    if (autoSend !== undefined) {
      if (typeof autoSend !== "boolean") {
        throw invalid(file, '"shell.autoSend" must be a boolean');
      }
      out.autoSend = autoSend;
    }
    cfg.shell = out;
  }
  if (open !== undefined) {
    if (typeof open !== "object" || open === null || Array.isArray(open)) {
      throw invalid(file, '"open" must be an object');
    }
    const { timeoutSec, retries } = open as Record<string, unknown>;
    const out: NonNullable<CliConfig["open"]> = {};
    if (timeoutSec !== undefined) {
      if (typeof timeoutSec !== "number" || !(timeoutSec > 0)) {
        throw invalid(file, '"open.timeoutSec" must be a positive number');
      }
      out.timeoutSec = timeoutSec;
    }
    if (retries !== undefined) {
      if (!Number.isInteger(retries) || (retries as number) < 0) {
        throw invalid(file, '"open.retries" must be a non-negative integer');
      }
      out.retries = retries as number;
    }
    cfg.open = out;
  }
  return cfg;
}
