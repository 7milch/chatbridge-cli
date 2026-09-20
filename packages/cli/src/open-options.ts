import {
  ChatBridgeError,
  type OpenOptions,
  type Provider,
} from "@chatbridge/core";
import type { CliConfig } from "./config.js";

export type { OpenOptions };

/** Built-in layer: the opening steps ran under --timeout's 120 s default
 * before 0.8.3, so this keeps them there. */
export const DEFAULT_OPEN_OPTIONS: OpenOptions = {
  timeoutMs: 120_000,
  retries: 0,
};

export interface ResolveOpenOptionsInput {
  provider: Pick<Provider, "open">;
  config: Pick<CliConfig, "open">;
  env: Record<string, string | undefined>;
}

function envNumber(
  env: Record<string, string | undefined>,
  name: string,
  check: (n: number) => boolean,
  expected: string,
): number | undefined {
  // Trimmed first: Number(" ") is 0, so a blank value would pass for a
  // variable whose range allows 0 instead of meaning "not set".
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !check(n)) {
    throw new ChatBridgeError(
      "INVALID_ARGUMENT",
      `${name} must be ${expected}, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/** built-in → provider.open → config.open → env, each layer overriding only
 * the keys it sets. Config and env are in seconds; the result is in ms. */
export function resolveOpenOptions(
  input: ResolveOpenOptionsInput,
): OpenOptions {
  const out = { ...DEFAULT_OPEN_OPTIONS };
  const p = input.provider.open;
  if (p?.timeoutMs !== undefined) out.timeoutMs = p.timeoutMs;
  if (p?.retries !== undefined) out.retries = p.retries;
  const c = input.config.open;
  if (c?.timeoutSec !== undefined) out.timeoutMs = c.timeoutSec * 1000;
  if (c?.retries !== undefined) out.retries = c.retries;
  const envTimeout = envNumber(
    input.env,
    "CHATBRIDGE_OPEN_TIMEOUT",
    (n) => n > 0,
    "a positive number of seconds",
  );
  if (envTimeout !== undefined) out.timeoutMs = envTimeout * 1000;
  const envRetries = envNumber(
    input.env,
    "CHATBRIDGE_OPEN_RETRIES",
    (n) => Number.isInteger(n) && n >= 0,
    "a non-negative integer",
  );
  if (envRetries !== undefined) out.retries = envRetries;
  return out;
}
