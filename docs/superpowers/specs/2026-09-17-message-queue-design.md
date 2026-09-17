# Message queue while a turn is in flight — design

Milestone 9, issue #46. Brainstormed 2026-09-17 (replaces the backlog note
recorded in issue #40).

## Goal

Today `Enter` while a turn is in flight is dropped: `ChatModel.submit()`
returns `false` and the view leaves the textarea untouched. The user has to
wait for the reply before typing the next message. Claude Code instead queues
the message, lists it above the input box, and sends it as the next turn;
`Up` from the first line of the input takes the queue back into the box for
editing. This milestone brings the same behaviour to the interactive TUI.

Reference: https://code.claude.com/docs/en/interactive-mode, section "Queue
messages while Claude works" (read 2026-09-17).

## Decisions

- **Queue instead of reject.** `Enter` while the status is `busy`,
  `resetting` or `dead` appends the typed text to a queue. The input box is
  cleared as for a normal send.
- **One entry per turn.** When a turn ends and the model is `idle`, the
  oldest queued entry is sent as the next turn. The remaining entries wait
  for that turn to end. The web chat services have no tool-call boundary
  inside a turn, so Claude Code's "pass it in within the same turn" has no
  analogue here.
- **Expansion at send time.** The queue holds the typed text verbatim.
  `@` mentions are expanded when the entry is dequeued, exactly as a typed
  message is expanded on `Enter`. Take-back therefore returns what the user
  typed, and a file edited while the entry waited is read in its final form.
- **Mention failure on a queued entry.** When expansion of a dequeued entry
  raises `MentionError`, the error is shown in the history (as today) and the
  entry is put back at the front of the queue. Draining stops there and
  resumes at the next turn end or reset, so the same failure is never retried
  in a loop. The user fixes it with take-back.
- **Survives `dead` and reopen.** The queue is kept while the model is
  `dead`; nothing is sent. A successful Ctrl+R reopen returns the model to
  `idle` and draining resumes with the oldest entry. The entries were typed
  with the earlier conversation in mind, but the user chose an automatic
  resume over a manual one; take-back is available at any time to review the
  queue first.
- **`Esc` is untouched.** It keeps closing the mention popup and stays
  reserved for a future interrupt. The queue is emptied by taking it back and
  clearing the input box.
- **Take-back.** `Up` while the cursor is on the first line of the input box
  and the queue is not empty removes every entry from the queue and inserts
  them into the input box, one per line, ahead of any text already typed. The
  cursor ends up after the inserted text. `Enter` then queues (or sends, when idle) the
  whole box as one entry, as in Claude Code; clearing the box drops it. `Up`
  on any other line, or with an empty queue, reaches the textarea as usual.
  While the mention popup is open `Up` keeps moving the popup selection.
- **Out of scope.** One-shot mode. Interrupting the service mid-response.
  `!` shell mode (#38) is not implemented; how shell commands queue is
  decided when that item is picked up. Core, runtime and provider are
  unchanged: the queue is TUI policy and lives in `@chatbridge/cli`.

## ChatModel (`packages/cli/src/tui/chat-model.ts`)

State: `readonly queue: string[]`, the trimmed texts in arrival order.

`submit(text)`:

- Blank input still returns `false` without any change.
- `idle`: starts the turn as today.
- Any other status: pushes the text, calls `onChange()`, returns `true`.
  The `true` tells the view the text was taken and the box may be cleared.

`takeBack(): string[]`: empties the queue and returns the entries in order;
calls `onChange()` when it removed anything.

Draining: a private `drain()` runs whenever the model becomes `idle` at the
end of a turn (reply received, `ResponseTimeoutError`) and after a successful
reset. When the queue is not empty it shifts the oldest entry and starts a
turn with it. The turn itself is the same code path as a typed submit; only
the `MentionError` branch differs for a dequeued entry: the text goes back to
the front of the queue and `drain()` is not called again from that turn end.
The model becomes `idle` in the same tick as `drain()` claims the next turn,
so the view never observes a spurious idle frame with a queue waiting.

Stale sends: a turn started by `drain()` carries the generation counter like
any other, so a reset mid-turn drops its outcome as today. The reset then
drains from the new session.

## ChatView (`packages/cli/src/tui/chat-view.ts`)

Layout, top to bottom, becomes: header / banner-or-history / **queue list** /
input box / mention popup / status line.

- The queue list is a column box between the body and the input box, hidden
  when the queue is empty. Each entry is one row: a muted `▹ ` prefix and the
  entry's first line, `wrapMode: "none"`. At most 5 rows are shown; when the
  queue is longer the fifth row is replaced by `… +N more`. The list never
  grows the input box away from the bottom: it has `flexShrink: 0` and the
  5-row cap keeps it bounded.
- `onSubmit` no longer checks the status: blank input is ignored, everything
  else clears the box and calls `submit()`. The existing refill on `false`
  (a mention problem on a typed message) stays.
- `handleKey` gains one case before the popup handling: `up` with the popup
  hidden, a non-empty queue, and the cursor on the first line (no `\n`
  before `cursorOffset` in `plainText`) is prevented, the queue is taken
  back, and `entries.join("\n")` plus a trailing `\n` (only when the box was
  not empty) replaces the box content (the typed text follows the entries) with the
  cursor after the inserted entries.
  `fitInput()` runs afterwards.
- The status line while `busy` appends `· N queued` when the queue is not
  empty. The idle guide gains `Up take back` only while the queue is not
  empty (it can be non-empty when idle only for the duration of a mention
  failure, and in `dead`, whose guide also gains it).

`update()` redraws the queue list from `model.queue` on every change; the
list is small enough to rebuild rather than diff.

## Tests

`chat-model.test.ts`:

- `Enter` while busy queues instead of rejecting; `submit` resolves `true`.
- Turn end sends the oldest entry only; the second waits for the next end.
- `takeBack` returns the entries in order and empties the queue.
- A dequeued entry with a `MentionError` is shown as an error, returns to the
  front, and is not retried until the next turn ends.
- `dead` keeps the queue and sends nothing; a successful reset drains it.
- A reset mid-turn drops the stale outcome and the new session receives the
  next queued entry.

`chat-view.test.ts` (runs the real renderer as today):

- Queued entries appear above the input box; the sixth entry becomes
  `… +N more`.
- `Up` on the first line takes the queue back into the box ahead of typed
  text; `Up` on the second line does not.
- The busy status shows the queued count.

## Documentation

`docs/ROADMAP.md`: the backlog entry becomes milestone 9 with a pointer to
this spec. `README.md` interactive-mode key list gains the queue and take-back
behaviour.
