import { ResponseTimeoutError } from "./errors.js";

/** Runs one browser step; a Playwright TimeoutError becomes a framework
 * ResponseTimeoutError that names the step and keeps the original as cause. */
export async function runStep<T>(
  name: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ResponseTimeoutError(
        `Timed out during ${name} after ${timeoutMs} ms.`,
        { cause: err },
      );
    }
    throw err;
  }
}
