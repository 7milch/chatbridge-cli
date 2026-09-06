import {
  AuthStore,
  type AuthStoreOptions,
  validateProviderName,
} from "@chatbridge/runtime";
import { InvalidProviderError } from "./errors.js";

/** Builds an AuthStore, translating an unusable provider name into the
 * framework error the CLI maps to exit code 5. */
export function createAuthStore(opts: AuthStoreOptions): AuthStore {
  try {
    validateProviderName(opts.providerName);
  } catch (err) {
    throw new InvalidProviderError(
      `Provider name ${JSON.stringify(opts.providerName)} cannot be used as a file name: use lowercase letters, digits, ".", "_" or "-" (1-64 chars, starting with a letter or digit).`,
      { cause: err },
    );
  }
  return new AuthStore(opts);
}
