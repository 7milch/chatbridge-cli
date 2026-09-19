import {
  ChatModel,
  type ChatModelOptions,
  type ChatSessionLike,
} from "./chat-model.js";

/** A model over `session`; a second open goes to `opts.openSession` (a
 * reopen), and `gate` delays the first open for tests that need to race it. */
export async function modelWith(
  session: ChatSessionLike,
  opts: Partial<ChatModelOptions> = {},
  gate?: Promise<void>,
): Promise<ChatModel> {
  const reopen = opts.openSession;
  let opened = false;
  const model = new ChatModel({
    login: async () => {},
    clearAuth: async () => {},
    ...opts,
    openSession: async (report) => {
      if (!opened) {
        opened = true;
        if (gate) await gate;
        return session;
      }
      if (!reopen) throw new Error("not expected");
      return reopen(report);
    },
  });
  // A gated first open leaves the model `opening`, which is the point of
  // the tests that pass one.
  if (!gate) await model.ready;
  return model;
}
