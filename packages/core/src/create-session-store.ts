import { validateProviderName } from "@chatbridge/runtime";
import { InvalidProviderError } from "./errors.js";
import { SessionStore, type SessionStoreOptions } from "./session-store.js";

/** Builds a SessionStore, translating an unusable provider name into the
 * framework error the CLI maps to exit code 5. */
export function createSessionStore(opts: SessionStoreOptions): SessionStore {
  try {
    validateProviderName(opts.providerName);
  } catch (err) {
    throw new InvalidProviderError(
      `Provider name ${JSON.stringify(opts.providerName)} cannot be used as a file name: use lowercase letters, digits, ".", "_" or "-" (1-64 chars, starting with a letter or digit).`,
      { cause: err },
    );
  }
  return new SessionStore(opts);
}
