import { spawn as nodeSpawn } from "node:child_process";

export interface ChildLike {
  stdout: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  } | null;
  stderr: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  } | null;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export type SpawnFn = (
  command: string,
  args: string[],
  opts: { env: Record<string, string | undefined> },
) => ChildLike;

export interface InstallBrowserOptions {
  /** Absolute path of `playwright/cli.js` inside the extension's node_modules. */
  cliPath: string;
  /**
   * The Node binary to run it with; the extension host's process.execPath
   * (Electron) works with ELECTRON_RUN_AS_NODE=1.
   */
  execPath?: string;
  env?: Record<string, string | undefined>;
  spawn?: SpawnFn;
  /** One call per progress line (download names, progress bars). */
  onProgress?: (line: string) => void;
}

/**
 * Playwright redraws its progress bar with `\r`; treat every `\r` or `\n`
 * as a line break and drop blanks.
 */
export function splitProgressLines(chunk: string): string[] {
  return chunk
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** Runs `playwright install chromium` and resolves when it exits 0. */
export function installBrowser(opts: InstallBrowserOptions): Promise<void> {
  const spawn: SpawnFn = opts.spawn ?? ((c, a, o) => nodeSpawn(c, a, o));
  const child = spawn(
    opts.execPath ?? process.execPath,
    [opts.cliPath, "install", "chromium"],
    {
      env: { ...(opts.env ?? process.env), ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  let lastStderr = "";
  return new Promise((resolve, reject) => {
    child.stdout?.on("data", (chunk) => {
      for (const line of splitProgressLines(String(chunk)))
        opts.onProgress?.(line);
    });
    child.stderr?.on("data", (chunk) => {
      const lines = splitProgressLines(String(chunk));
      if (lines.length > 0) lastStderr = lines[lines.length - 1];
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `playwright install chromium exited with ${code ?? "signal"}${lastStderr ? `: ${lastStderr}` : ""}`,
          ),
        );
      }
    });
  });
}
