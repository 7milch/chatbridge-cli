import { ChatSession, type ChatSessionOptions } from "@chatbridge/core";
import {
  type CliRenderer,
  type KeyEvent,
  createCliRenderer,
} from "@opentui/core";
import { ChatModel } from "./chat-model.js";
import { ChatView } from "./chat-view.js";

export interface InteractiveOptions extends ChatSessionOptions {
  /** Shown in the header, e.g. the CLI name. */
  title: string;
  /** Test-only: replaces createCliRenderer. */
  createRenderer?: () => Promise<CliRenderer>;
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

/** What the bounded close needs from a session; lets tests inject a fake. */
export interface ClosableSession {
  close(): Promise<void>;
}

/**
 * Resolves when the user asks to quit: Ctrl+C, a fatal model error (the
 * error is the resolved value), or the renderer being destroyed from
 * outside — OpenTUI installs its own SIGINT/SIGTERM/SIGHUP handlers that
 * destroy the renderer without exiting the process, so without this the
 * caller's promise would stay pending and the browser would keep the
 * process alive.
 *
 * Must be called after the ChatView is built: it chains onto the view's
 * `onChange` handler rather than replacing it.
 */
export function waitForQuit(
  renderer: CliRenderer,
  model: ChatModel,
): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    const notify = model.onChange;
    model.onChange = () => {
      notify();
      if (model.fatal !== undefined) resolve(model.fatal);
    };
    (renderer.keyInput as unknown as KeypressSource).on("keypress", (key) => {
      if (key.ctrl && key.name === "c") resolve(undefined);
    });
    (renderer as unknown as DestroySource).on("destroy", () =>
      resolve(undefined),
    );
  });
}

/** Opens a ChatSession (errors propagate before any UI exists), runs the
 * TUI until Ctrl+C or a fatal error, then restores the terminal.
 * Resolves with the fatal error, if any, for the caller to report. */
export async function runInteractive(
  opts: InteractiveOptions,
): Promise<{ fatal?: unknown }> {
  const session = await ChatSession.open(opts);
  let renderer: CliRenderer;
  try {
    renderer = await (
      opts.createRenderer ?? (() => createCliRenderer({ exitOnCtrlC: false }))
    )();
  } catch (err) {
    // The session is already open; nothing else would ever close it.
    await closeWithTimeout(session, CLOSE_TIMEOUT_MS);
    throw err;
  }
  let view: ChatView | undefined;
  try {
    const model = new ChatModel(session);
    view = new ChatView(renderer, model, {
      title: opts.title,
      providerName: opts.provider.name,
      timeoutMs: opts.timeoutMs,
    });
    const quit = waitForQuit(renderer, model);
    renderer.start();
    const fatal = await quit;
    return fatal === undefined ? {} : { fatal };
  } finally {
    view?.setStatus(CLOSING_STATUS);
    const closed = await closeWithTimeout(session, CLOSE_TIMEOUT_MS);
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
