# `commands`

Optional `ProviderCommand[]` a provider adds to the interactive UIs (TUI,
VSCode). The contract is `ProviderCommand` in `@chatbridge/provider`; the
shared table and parsing live in `@chatbridge/core`
(`slash-commands.ts`).

## What the framework does with it

A user types `/name [args]`. Core parses the line, and if `name` is one of
the provider's commands, calls `command.run(page, args)` on the chat page,
under the same guard as `send`: nothing else runs on the page at the same
time.

- `args` is the rest of the line after the command word, trimmed. `""`
  when there is none. It may contain newlines.
- The result decides what the UI does next:
  - `{ kind: "show", text }` prints `text` in the history. The turn ends
    there.
  - `{ kind: "send", prompt }` sends `prompt` as an ordinary turn. The
    history keeps the `/name ...` line the user typed; the service only
    ever sees `prompt`.
- `run` executes under the per-turn timeout, with the same timeout
  diagnosis as a turn (see [contract.md](../contract.md#timeouts-and-errors)
  and [contract.md](../contract.md#2-a-turn)).
- `/help` lists the provider's commands after the built-ins
  (`login`, `logout`, `new`, `reopen`, `copy`, `help`), in the order they
  are declared.

## Constraints

- `name` must match `/^[a-z]+$/`: lower-case letters only. `defineProvider`
  rejects anything else, a duplicate name, or a name that collides with a
  built-in.
- Commands only run in the interactive UIs (TUI, VSCode). One-shot `-p`
  mode has no commands.
- When the session cannot run commands (a state that predates the
  session's `runCommand`), the TUI shows `/<name> is not available in this
  session.` instead of calling it. See
  [../users/interactive-mode.md](../users/interactive-mode.md#slash-commands)
  for the user-facing behaviour.
- A `/name` nobody defines (built-in or provider) shows
  `Unknown command: /<name>. Type /help.` in the UI. (Core's `ChatSession.runCommand`
  also has its own internal guard, `Unknown provider command "/<name>".`, for a UI that
  passes a name the session's provider does not carry; a well-behaved UI never reaches it.)
- While the chat page is busy, a typed command is queued like an ordinary
  message and runs when its turn comes.

## Minimal template

```ts
commands: [
  {
    name: "model",
    description: "Show or switch the model picker",
    async run(page, args) {
      if (args === "") return { kind: "show", text: await page.locator("#model").innerText() };
      await page.selectOption("#model", args);
      return { kind: "show", text: `model: ${args}` };
    },
  },
],
```

## Recipe

- [commands/dummy-title-shout.md](../recipes/commands/dummy-title-shout.md)
  — one `show` command and one `send` command, from the bundled dummy
  provider.
