import { ChatSession, type ChatSessionOptions } from "@chatbridge/core";
import {
  type CliRenderer,
  type KeyEvent,
  createCliRenderer,
} from "@opentui/core";
import { FileIndex } from "../mentions/file-index.js";
import { resolveBanner } from "./banner.js";
import { ChatModel } from "./chat-model.js";
import { ChatView } from "./chat-view.js";
import { closeWithTimeout } from "./close-session.js";

export interface InteractiveOptions extends ChatSessionOptions {
  /** Shown in the header, e.g. the CLI name. */
  title: string;
  /** Shown in the default startup banner. */
  version?: string;
  /** Vendor startup banner; replaces the default when set. */
  banner?: string[];
  /** Test-only: replaces createCliRenderer. */
  createRenderer?: () => Promise<CliRenderer>;
  /** Test-only: replaces the working-directory index. */
  index?: FileIndex;
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
 * would keep the process alive. A fatal model error does not quit (the
 * model goes `dead` and Ctrl+R can recover); the resolved value is the
 * model's `fatal` at quit time so a quit from `dead` reports the error.
 */
export function waitForQuit(
  renderer: CliRenderer,
  model: ChatModel,
): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    (renderer.keyInput as unknown as KeypressSource).on("keypress", (key) => {
      if (key.ctrl && key.name === "c") resolve(model.fatal);
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
      pending.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Opens a ChatSession (errors propagate before any UI exists), runs the
 * TUI until the user quits, then restores the terminal. Resolves with the
 * model's unrecovered fatal error, if any, for the caller to report. */
export async function runInteractive(
  opts: InteractiveOptions,
): Promise<{ fatal?: unknown }> {
  // Progress messages go to stderr, which would land on top of the live TUI.
  // Forward them only until the renderer takes over the terminal; after that
  // a reopen's "Opening browser..." is reported by the status row instead.
  let uiUp = false;
  const onProgress = (message: string) => {
    if (!uiUp) opts.onProgress?.(message);
  };
  const sessionOpts: InteractiveOptions = { ...opts, onProgress };
  const session = await ChatSession.open(sessionOpts);
  let index: FileIndex;
  let renderer: CliRenderer;
  try {
    index = opts.index ?? (await FileIndex.build({ cwd: process.cwd() }));
    renderer = await (
      opts.createRenderer ?? (() => createCliRenderer({ exitOnCtrlC: false }))
    )();
  } catch (err) {
    // The session is already open; nothing else would ever close it.
    await closeWithTimeout(session, CLOSE_TIMEOUT_MS);
    throw err;
  }
  let view: ChatView | undefined;
  let model: ChatModel | undefined;
  try {
    model = new ChatModel(session, {
      openSession: () => ChatSession.open(sessionOpts),
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
      index,
    });
    const quit = waitForQuit(renderer, model);
    uiUp = true;
    renderer.start();
    const fatal = await quit;
    return fatal === undefined ? {} : { fatal };
  } finally {
    view?.setStatus(CLOSING_STATUS);
    // A reset in flight has already closed the old session and is about to
    // assign a new one; closing model.session now would leak that new browser
    // and its Playwright connection would keep the process alive. Wait for the
    // reset to settle first, under the same cap.
    const settled = await settleReset(model?.pendingReset);
    // After a reset the original `session` is already closed; close whichever
    // one the model holds now.
    const closed =
      settled &&
      (await closeWithTimeout(model?.session ?? session, CLOSE_TIMEOUT_MS));
    view?.destroy();
    renderer.destroy();
    if (!closed) {
      // The Playwright connection would keep the event loop alive forever;
      // the terminal is restored by now, so exiting hard is safe here.
      process.stderr.write("browser did not close within 5 s; exiting\n");
      process.exit(1);
    }
  }
}
