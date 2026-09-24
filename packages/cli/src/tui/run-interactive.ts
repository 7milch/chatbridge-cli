import {
  ChatSession,
  type ChatSessionOptions,
  closeWithTimeout,
  commandInfoOf,
  runLogin,
} from "@chatbridge/core";
import {
  type CliRenderer,
  type KeyEvent,
  createCliRenderer,
} from "@opentui/core";
import { FileIndex } from "../mentions/file-index.js";
import type { ShellConfig } from "../shell/shell-config.js";
import type { BannerOptions } from "./banner-options.js";
import { resolveBanner } from "./banner.js";
import {
  ChatModel,
  type ChatModelOptions,
  type ChatSessionLike,
} from "./chat-model.js";
import { ChatView } from "./chat-view.js";
import { copyToClipboard, spawnClipboardProcess } from "./clipboard.js";
import { expandInput } from "./expand-input.js";
import { registerBundledGrammars } from "./grammars.js";
import { type SpinnerOptions, resolveSpinner } from "./spinner.js";

export interface InteractiveOptions extends ChatSessionOptions {
  /** Shown in the header, e.g. the CLI name. */
  title: string;
  /** Shown in the default startup banner. */
  version?: string;
  /** Vendor startup banner; replaces the default when set. */
  banner?: string[] | BannerOptions;
  /** Vendor busy spinner; unset fields keep the default. */
  spinner?: SpinnerOptions;
  /** Resolved `!` shell mode settings. Default: DEFAULT_SHELL_CONFIG. */
  shell?: ShellConfig;
  /** Test-only: replaces createCliRenderer. */
  createRenderer?: () => Promise<CliRenderer>;
  /** Test-only: replaces the working-directory index. */
  index?: FileIndex;
  /** Test-only: replaces ChatSession.open. */
  createSession?: ChatModelOptions["openSession"];
  /** Test-only: replaces runLogin. */
  login?: ChatModelOptions["login"];
  /** Test-only: replaces the system clipboard `/copy` writes to. */
  copy?: ChatModelOptions["copy"];
}

/**
 * The renderer options the TUI runs under. `autoFocus: false` is what keeps
 * the text cursor in the chat input: with it on, OpenTUI's left-mousedown
 * handler focuses the first focusable ancestor of whatever was clicked, so
 * a click on the history would take focus off the textarea and typing would
 * stop reaching it. Wheel scrolling and mouse selection do not go through
 * the focus path, so they are unaffected. Exported so the view's tests can
 * build their renderer the same way; they would otherwise prove nothing.
 */
export const RENDERER_OPTIONS = {
  exitOnCtrlC: false,
  autoFocus: false,
} as const;

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

/** Waits for an in-flight reset — or for an idle close still saving the
 * auth state — to settle, capped at CLOSE_TIMEOUT_MS. True when there was
 * nothing to wait for or it settled in time; false when it did not, in
 * which case the caller must not assume which session is current and
 * hard-exits instead. */
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
  // Before any Markdown body exists: the first CodeRenderable creates the
  // tree-sitter client, which reads the registered grammars once.
  registerBundledGrammars();
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
    opts.createRenderer ?? (() => createCliRenderer({ ...RENDERER_OPTIONS }))
  )();
  let view: ChatView | undefined;
  let model: ChatModel | undefined;
  try {
    const commands = commandInfoOf(opts.provider);
    // One function, shared: the renderer's OSC 52 escape is the last resort
    // of the platform command, and it needs the renderer that exists here.
    const copy =
      opts.copy ??
      ((text: string) =>
        copyToClipboard(text, {
          env: process.env,
          platform: process.platform,
          process: spawnClipboardProcess,
          osc52: (t) => renderer.copyToClipboardOSC52(t),
        }));
    model = new ChatModel({
      openSession:
        opts.createSession ??
        ((report, onIdleExpired, conversation) =>
          // Opening messages paint the live status row; everything the
          // session reports later (from close(), including the idle one)
          // keeps going to the buffering onProgress above. Each session
          // gets its own expiry callback, so the model can tell a stale
          // session's expiry from the current one's. `conversation` is the
          // handle the model remembers, so a reopen lands back in the same
          // chat; undefined starts a new one.
          ChatSession.open({
            ...sessionOpts,
            onOpenProgress: report,
            onIdleExpired,
            conversation,
          })),
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
      copy,
      shell: opts.shell,
      commands,
      expand: (text) =>
        expandInput(text, {
          cwd: process.cwd(),
          hooks: opts.provider.urlHooks ?? [],
          timeoutMs: opts.timeoutMs,
        }),
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
      commands,
      // The same function the model got: `/copy` and a mouse selection reach
      // the clipboard the same way.
      copy,
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
    // The idle close may still be saving the rotated auth state; the model
    // no longer holds that session, only the promise of its close.
    const idleSettled = await settleReset(model?.idleClosing);
    // The model may still hold no session: the open above failed.
    const open = model?.session;
    // The session the model holds now is closed on its own account: an idle
    // close that never settled belongs to a session the model let go of, and
    // short-circuiting on it would leave this browser running and its auth
    // state unsaved. The hard exit below still covers either failure.
    const sessionClosed =
      settled &&
      (open === undefined || (await closeWithTimeout(open, CLOSE_TIMEOUT_MS)));
    const closed = sessionClosed && idleSettled;
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
