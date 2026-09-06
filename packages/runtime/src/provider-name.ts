const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Provider names become auth-state file names, so they must be plain,
 * lowercase, and free of path separators. Rejected, never rewritten. */
export function validateProviderName(name: string): void {
  if (!PROVIDER_NAME.test(name)) {
    throw new RangeError(
      `Invalid provider name ${JSON.stringify(name)}: must match ${PROVIDER_NAME}`,
    );
  }
}
