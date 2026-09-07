import { ChatSession, type ChatSessionOptions } from "@chatbridge/core";
import { type KeyEvent, createCliRenderer } from "@opentui/core";
import { ChatModel } from "./chat-model.js";
import { ChatView } from "./chat-view.js";

export interface InteractiveOptions extends ChatSessionOptions {
  /** Shown in the header, e.g. the CLI name. */
  title: string;
}

const CLOSE_TIMEOUT_MS = 5_000;

/** KeyHandler's `on` is typed through a generic EventEmitter that does not
 * type-check under our config; this is the shape we rely on at runtime. */
interface KeypressSource {
  on(event: "keypress", handler: (key: KeyEvent) => void): unknown;
}

/** Opens a ChatSession (errors propagate before any UI exists), runs the
 * TUI until Ctrl+C or a fatal error, then restores the terminal.
 * Resolves with the fatal error, if any, for the caller to report. */
export async function runInteractive(
  opts: InteractiveOptions,
): Promise<{ fatal?: unknown }> {
  const session = await ChatSession.open(opts);
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  let view: ChatView | undefined;
  try {
    const fatal = await new Promise<unknown>((resolve) => {
      const model = new ChatModel(session);
      view = new ChatView(renderer, model, {
        title: opts.title,
        providerName: opts.provider.name,
      });
      model.onChange = () => {
        view?.update();
        if (model.fatal !== undefined) resolve(model.fatal);
      };
      (renderer.keyInput as unknown as KeypressSource).on("keypress", (key) => {
        if (key.ctrl && key.name === "c") resolve(undefined);
      });
      renderer.start();
    });
    return fatal === undefined ? {} : { fatal };
  } finally {
    await closeWithTimeout(session, CLOSE_TIMEOUT_MS);
    view?.destroy();
    renderer.destroy();
  }
}

/** Playwright close can hang on a wedged browser; never block exit on it. */
async function closeWithTimeout(
  session: ChatSession,
  ms: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([session.close(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
