import {
  ChatBridgeError,
  DEFAULT_IDLE_TIMEOUT_MS,
  type IdleOptions,
  type Provider,
} from "@chatbridge/core";
import type { CliConfig } from "./config.js";

export type { IdleOptions };

/** Built-in layer: a day of inactivity before the browser is closed. */
export const DEFAULT_IDLE_OPTIONS: IdleOptions = {
  timeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
};

export interface ResolveIdleOptionsInput {
  provider: Pick<Provider, "idle">;
  config: Pick<CliConfig, "idle">;
  env: Record<string, string | undefined>;
}

/** built-in → provider.idle → config.idle → env. Config and env are in
 * minutes; the result is in ms. 0 disables the idle close. */
export function resolveIdleOptions(
  input: ResolveIdleOptionsInput,
): IdleOptions {
  const out = { ...DEFAULT_IDLE_OPTIONS };
  const p = input.provider.idle;
  if (p?.timeoutMs !== undefined) out.timeoutMs = p.timeoutMs;
  const c = input.config.idle;
  if (c?.timeoutMin !== undefined) out.timeoutMs = c.timeoutMin * 60_000;
  // Trimmed first: Number(" ") is 0, so a blank value would disable the
  // idle close instead of meaning "not set".
  const raw = input.env.CHATBRIDGE_IDLE_TIMEOUT?.trim();
  if (raw !== undefined && raw !== "") {
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || minutes < 0) {
      throw new ChatBridgeError(
        "INVALID_ARGUMENT",
        `CHATBRIDGE_IDLE_TIMEOUT must be a non-negative number of minutes (0 disables), got ${JSON.stringify(raw)}`,
      );
    }
    out.timeoutMs = minutes * 60_000;
  }
  return out;
}
