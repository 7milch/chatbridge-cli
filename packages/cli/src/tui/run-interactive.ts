import {
  ChatSession,
  type ChatSessionOptions,
  closeWithTimeout,
  runLogin,
} from "@chatbridge/core";
import {
  type CliRenderer,
  type KeyEvent,
  createCliRenderer,
} from "@opentui/core";
import { FileIndex } from "../mentions/file-index.js";
import type { ShellConfig } from "../shell/shell-config.js";
import { resolveBanner } from "./banner.js";
import {
  ChatModel,
  type ChatModelOptions,
  type ChatSessionLike,
} from "./chat-model.js";
import { ChatView } from "./chat-view.js";
import { type SpinnerOptions, resolveSpinner } from "./spinner.js";

export interface InteractiveOptions extends ChatSessionOptions {
  /** Shown in the header, e.g. the CLI name. */
  title: string;
  /** Shown in the default startup banner. */
  version?: string;
  /** Vendor startup banner; replaces the default when set. */
  banner?: string[];
  /** Vendor busy spinner; unset fields keep the default. */
  spinner?: SpinnerOptions;
  /** Resolved `!` shell mode settings. Default: DEFAULT_SHELL_CONFIG. */
  shell?: ShellConfig;
  /** Test-only: replaces createCliRenderer. */
  createRenderer?: () => Promise<CliRenderer>;
  /** Test-only: replaces the working-directory index. */
  index?: FileIndex;
  /** Test-only: replaces ChatSession.open. */
  createSession?: () => Promise<ChatSessionLike>;
  /** Test-only: replaces runLogin. */
  login?: ChatModelOptions["login"];
}

const CLOSE_TIMEOUT_MS = 5_000;
const CLOSING_STATUS = "Closing browser...";

/** KeyHandler's `on` is typed through a generic EventEmitter that does not
 * type-check under our config; this is the shape we rely on at runtime. */
interface KeypressSource {
  on(event: "keypress", handler: (key: KeyEvent) => void): unknown;
}

/** CliRenderer is an EventEmitter and emits "destroy" from finalizeDestroy;
 * that typing is not visible through the exported type. */
interface DestroySource {
  on(event: "destroy", handler: () => void): unknown;
}

/**
 * Resolves when the user asks to quit: Ctrl+C, or the renderer being
 * destroyed from outside — OpenTUI installs its own SIGINT/SIGTERM/SIGHUP
 * handlers that destroy the renderer without exiting the process, so
 * without this the caller's promise would stay pending and the browser
 * would keep the process alive. While a shell command is running, Ctrl+C
 * stops the command instead of quitting. A fatal model error does not
 * quit (the model goes `dead` and Ctrl+R can recover); the resolved value
 * is the model's `fatal` at quit time so a quit from `dead` reports the
 * error.
 */
export function waitForQuit(
  renderer: CliRenderer,
  model: ChatModel,
): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    (renderer.keyInput as unknown as KeypressSource).on("keypress", (key) => {
      if (!key.ctrl || key.name !== "c") return;
      // A login holds a browser window the user is waiting in; Ctrl+C
      // there cancels it rather than tearing the whole TUI down.
      if (model.status === "logging-in") {
        model.cancelLogin();
        return;
      }
      if (model.status === "running") {
        model.stopShell();
        return;
      }
      resolve(model.fatal);
    });
    (renderer as unknown as DestroySource).on("destroy", () =>
      resolve(model.fatal),
    );
  });
}

/** Waits for an in-flight reset to settle, capped at CLOSE_TIMEOUT_MS.
 * True when there was nothing to wait for or it settled in time; false when
 * it did not, in which case the caller must not assume which session is
 * current and hard-exits instead. */
async function settleReset(
  pending: Promise<void> | undefined,
): Promise<boolean> {
  if (pending === undefined) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // A rejecting reset still counts as settled; it must never escape from
      // the caller's `finally`.
      pending.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The stderr line before the hard exit. `settled` false means the race in
 * `settleReset` timed out; which promise it was decides the wording — a
 * quit typed at startup waits for the eager first open, not for a reopen. */
export function teardownExitMessage(
  settled: boolean,
  waitedForReset: boolean,
): string {
  if (settled) return "browser did not close within 5 s; exiting\n";
  return waitedForReset
    ? "browser reopen did not finish within 5 s; exiting\n"
    : "browser did not finish opening within 5 s; exiting\n";
}

/** Runs the TUI until the user quits, then restores the terminal. The
 * session is opened by the model once the UI is up, so an opening failure
 * is an error entry rather than a crash. Resolves with the model's
 * unrecovered fatal error, if any, for the caller to report. */
export async function runInteractive(
  opts: InteractiveOptions,
): Promise<{ fatal?: unknown }> {
  // Progress messages go to stderr, which would land on top of the live TUI.
  // Forward them directly only until the renderer takes over the terminal;
  // after that a reopen's "Opening browser..." is reported by the status row.
  // Messages are buffered rather than dropped, so what `close()` reports at
  // teardown ("Could not save auth state: ...") still reaches the user; the
  // buffer is flushed once the terminal has been restored. A mid-session
  // reset's messages are flushed then too, which is acceptable.
  let uiUp = false;
  const buffered: string[] = [];
  const onProgress = (message: string) => {
    if (uiUp) buffered.push(message);
    else opts.onProgress?.(message);
  };
  const sessionOpts: InteractiveOptions = { ...opts, onProgress };
  const index = opts.index ?? (await FileIndex.build({ cwd: process.cwd() }));
  const renderer = await (
    opts.createRenderer ?? (() => createCliRenderer({ exitOnCtrlC: false }))
  )();
  let view: ChatView | undefined;
  let model: ChatModel | undefined;
  try {
    model = new ChatModel({
      openSession: opts.createSession ?? (() => ChatSession.open(sessionOpts)),
      login:
        opts.login ??
        (({ signal, onProgress: report }) =>
          runLogin({
            provider: opts.provider,
            authStore: opts.authStore,
            signal,
            onProgress: report,
          })),
      clearAuth: () => opts.authStore.clear(),
      shell: opts.shell,
    });
    view = new ChatView(renderer, model, {
      title: opts.title,
      providerName: opts.provider.name,
      timeoutMs: opts.timeoutMs,
      headless: opts.headless,
      banner: resolveBanner({
        name: opts.title,
        version: opts.version,
        providerName: opts.provider.name,
        banner: opts.banner,
      }),
      spinner: resolveSpinner(opts.spinner),
      index,
    });
    const quit = waitForQuit(renderer, model);
    uiUp = true;
    renderer.start();
    const fatal = await quit;
    return fatal === undefined ? {} : { fatal };
  } finally {
    // Neither a shell command nor a login browser may outlive the TUI.
    model?.stopShell();
    model?.cancelLogin();
    view?.setStatus(CLOSING_STATUS);
    // The cancelled login kills its browser asynchronously; let it finish so
    // the process does not exit with a Playwright connection open. Under the
    // same cap as the rest of teardown, and a timeout just falls through: the
    // cancel already killed the browser, so there is nothing left to own.
    await settleReset(model?.pendingLogin);
    // A reset in flight has already closed the old session and is about to
    // assign a new one; closing model.session now would leak that new browser
    // and its Playwright connection would keep the process alive. The same
    // goes for the initial open, which a quit typed at startup can outrun.
    // Wait for whichever is in flight, under the same cap.
    const pendingReset = model?.pendingReset;
    const settled = await settleReset(pendingReset ?? model?.ready);
    // The model may still hold no session: the open above failed.
    const open = model?.session;
    const closed =
      settled &&
      (open === undefined || (await closeWithTimeout(open, CLOSE_TIMEOUT_MS)));
    view?.destroy();
    renderer.destroy();
    // The terminal is ours again: anything the teardown reported can be
    // printed now.
    uiUp = false;
    for (const message of buffered) opts.onProgress?.(message);
    buffered.length = 0;
    if (!closed) {
      // The Playwright connection would keep the event loop alive forever;
      // the terminal is restored by now, so exiting hard is safe here.
      process.stderr.write(
        teardownExitMessage(settled, pendingReset !== undefined),
      );
      process.exit(1);
    }
  }
}
