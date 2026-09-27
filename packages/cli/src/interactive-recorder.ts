import {
  SAVE_FAILED_MESSAGE,
  SessionRecorder,
  type SessionRecorderOptions,
} from "@chatbridge/core";

/** The recorder of an interactive run and the `onNotifier` that routes its
 * save failure to the status line. The recorder is built before the TUI
 * exists, so the notice goes through a function the TUI fills in later;
 * until then a failure has nowhere to show and is dropped. */
export function interactiveRecorder(
  opts: Omit<SessionRecorderOptions, "onSaveFailed">,
): {
  recorder: SessionRecorder;
  onNotifier: (notify: (text: string) => void) => void;
} {
  let notifySaveFailed: () => void = () => {};
  const recorder = new SessionRecorder({
    ...opts,
    onSaveFailed: () => notifySaveFailed(),
  });
  return {
    recorder,
    onNotifier: (notify) => {
      notifySaveFailed = () => notify(SAVE_FAILED_MESSAGE);
    },
  };
}
