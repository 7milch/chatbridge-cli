/** What the bounded close needs from a session; lets tests inject a fake. */
export interface ClosableSession {
  close(): Promise<void>;
}

export interface KillableSession extends ClosableSession {
  kill(): Promise<void>;
}

/** Playwright close can hang on a wedged browser; never block exit on it.
 * Returns true when the session closed within `ms`. Close errors are
 * swallowed: teardown must not mask the result the caller is returning. */
export async function closeWithTimeout(
  session: ClosableSession,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      session.close().then(
        () => true,
        () => true,
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Closes the session, and kills it when the close has not finished within
 * `ms`: the reset path exists for a wedged browser, so a close that hangs is
 * the expected case, not an error. Never throws. */
export async function closeOrKill(
  session: KillableSession,
  ms: number,
): Promise<void> {
  const closed = await closeWithTimeout(session, ms);
  if (!closed) await session.kill().catch(() => {});
}
