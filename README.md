# chatbridge-cli

A reusable OSS framework for using web-based chat AI services from the command line, without touching the browser UI.

Service-specific behaviour (URLs, DOM selectors, login flows, response detection) is isolated behind a Provider / Adapter interface, so the same core can drive multiple web chat AI services.

## Status

Milestones 1 (one-shot), 2 (hardening + publishability), and 3a (interactive TUI) are implemented. The first npm release is still pending. Streaming display (milestone 3b) is not built yet.

## Planned features

- Interactive TUI, in the style of Claude Code (non-streaming; streaming display is planned)
- Non-interactive one-shot execution (`-p "..."`) writing to stdout
- Playwright-based browser automation runtime
- Browser session and authentication-state management (save / restore / clear)
- A Provider API for plugging in service-specific implementations

## Concept

```
CLI ─┬─ Interactive Mode (TUI)
     └─ One-shot Mode (stdout)
              │
            Core
              │
         Provider API
              │
       Playwright Layer
              │
         Web Chat AI
```

The core and providers do not depend on the TUI, so both execution modes share the same code paths.

## Quick start (against the bundled dummy chat)

```bash
bun install
./packages/runtime/node_modules/.bin/playwright install chromium
bun run examples/dummy-chat/serve.ts &          # dummy service on :8735
bun packages/cli/src/bin.ts auth login \
  --provider ./examples/dummy-chat/provider.ts  # click "Log in" in the opened browser
bun packages/cli/src/bin.ts -p "hello" \
  --provider ./examples/dummy-chat/provider.ts  # → Echo: hello
bun packages/cli/src/bin.ts \
  --provider ./examples/dummy-chat/provider.ts  # interactive chat
```

## Install (npm)

```bash
npm install -g @chatbridge/cli      # CLI (Node >= 20 or Bun)
npm install @chatbridge/provider     # to write a provider
```

These commands apply from v0.1.0 onwards, once that release is published.

Providers are loaded with `--provider <npm-package|./path>` or from
`~/.config/chatbridge/config.json`:

```json
{
  "defaultProvider": "@your-scope/your-provider",
  "shell": { "leadIn": "Please check the execution result.", "autoSend": true },
  "open": { "timeoutSec": 180, "retries": 2 }
}
```

A globally installed CLI resolves an npm-package `defaultProvider` only if
that provider is installed globally as well.

`shell` is optional and configures `!` shell mode in the interactive TUI
(see below): `leadIn` is the first line of the message sent with a
command's output, `autoSend: false` holds the output back until your next
message. Both override the defaults a derived CLI ships.

`open` is optional and tunes the "Opening browser..." phase: `timeoutSec`
is the per-step timeout for navigating to the chat page, checking the
login and starting a new chat (default 120, or what the provider
declares), `retries` how many times the whole phase is re-run after a
launch or navigation failure, closing the browser in between (default 0).
Failures that opening again would not fix (auth expired, blocked by the
service, Chromium missing) are never retried. `CHATBRIDGE_OPEN_TIMEOUT`
(seconds) and `CHATBRIDGE_OPEN_RETRIES` override the file for one run. A
provider sets its own defaults with `open: { timeoutMs, retries }`.

Interactive mode reads `config.json` even when the CLI ships its own
provider (the `shell` section still applies), so a file that is not valid
JSON stops it at startup with exit 1. A derived CLI ignores
`defaultProvider` entirely; `auth` never reads the file; one-shot mode
(`-p`) reads it for the `shell`-independent `open` section, so a broken
file stops it at startup too.

A derived CLI passes its own identity to `createCli`:

```ts
createCli({
  name: "acme-ai",
  version: "2.4.0",            // shown by --version and in the startup banner
  banner: {
    lines: ["Acme internal assistant", "Conversations are not stored."],
    colors: ["#ff5f87", "#ffaf00"],
    mode: "gradient",
    direction: "horizontal", // gradient only: vertical (default), horizontal, diagonal
  }, // or plain string[]
  spinner: {                   // optional; unset fields keep the default
    frames: ["⠋", "⠙", "⠹", "⠸"],          // same display width each
    intervalMs: 80,
    label: ["Thinking…", "Pondering…"],     // one is picked per turn
    frameColor: 4,                          // ANSI index or "#rrggbb"
    labelColor: "#8a8a8a",
  },
  shell: { leadIn: "Here is the output of a command I ran:" }, // optional: default lead-in for ! shell mode
  provider,
});
```

`--version` (`-V`) prints `name vX.Y.Z`.

Exit codes: 1 invalid argument or config, 2 not logged in, 3 auth expired,
4 response timeout, 5 provider could not be loaded, 6 blocked by the
service (a bot challenge or an IdP refusing the automated browser; try
`--headful`), 7 Chromium is not installed (the message says
`Run: npx playwright install chromium`), 130 `auth login` cancelled with
Ctrl-C. A timeout that coincides with a lost login is reported as 3 or 6
rather than 4. Set `CHATBRIDGE_DEBUG=1` to print the underlying error.

## Interactive mode

Run the CLI with no `-p` to open a chat in the terminal. The browser stays
open for the whole conversation, so follow-up messages continue the same
chat.

- **Enter** sends. **Shift+Enter** (or **Ctrl+J**) inserts a newline;
  Shift+Enter needs a terminal that speaks the kitty keyboard protocol
  (iTerm2, kitty, WezTerm, Ghostty), Ctrl+J works everywhere. **Ctrl+R**
  reopens the browser. **Ctrl+C** quits (while a `!` command runs it stops
  the command instead).
- **Ctrl+R** closes the browser (killing it after 5 s if it will not close),
  opens a fresh one with the saved auth state, and starts a new chat. The
  transcript stays on screen with a `── reopened ──` line; the service does
  not remember the earlier turns, so re-send what you need. Use it when a
  response hangs. If a fatal error happens mid-conversation the status row
  shows `Ctrl+R reopen · Ctrl+C quit`; quitting then exits with that error.
- **Enter while a reply is pending** queues the message instead of dropping
  it. Queued messages are listed above the input box and sent one per turn,
  oldest first, once the current reply arrives (also after a Ctrl+R reopen).
  **Up** from the first line of the input takes the whole queue back into the
  box, one message per line, ahead of anything you have typed; Enter then
  queues the box again as one message, and clearing it drops them. A message
  typed while a `!` command runs is queued the same way and goes out once the
  command's turn ends; a `!` command is not — it needs an idle session, so
  Enter leaves it in the box. **Up** is not a take-back in shell mode: leave
  the mode with **Esc** first.
- The screen is a header (CLI name, provider, headless/headful, timeout
  budget), the conversation with `user` / `assistant` / `error` labels, and
  a `>` input between two rules that grows to five rows as you add
  newlines. Until the first message the history shows a startup banner
  (the CLI name and version by default; a derived CLI can pass its own
  `banner` lines to `createCli`; plain lines are dim, while an object form
  `{ lines, colors, mode }` colours rows (`per-line`), cells diagonally
  (`per-char`) or a `gradient` between hex stops running down (`vertical`,
  default), across (`horizontal`) or diagonally (`diagonal`) over the
  centred banner grid — the object form
  needs `@chatbridge/cli` >= 0.8.2). While a turn is in flight the status
  row shows a spinner and the elapsed time against the budget; `spinner` on
  `createCli` replaces its frames, interval, label (a list of labels picks
  one at random per turn) and the colours of frame and label (`"#rrggbb"` or an ANSI palette index).
- Type **`@`** to attach a file from the directory you started `chatbridge`
  in. A popup lists fuzzy matches (`.gitignore`d files, `.git`, and
  `node_modules` are left out); **↑/↓** select, **Tab** or **Enter** insert
  `@path `, **Esc** closes. A path you type by hand still attaches even
  when the popup does not list it (a `.gitignore`d file, for example).
  On send, each mentioned file is appended to
  the prompt as a fenced code block under a `### path` heading, and the
  history shows `📎 path (size)` for each one. Limits: 200 KB per file,
  1 MB per message, text files only, paths inside the working directory.
  Problems are shown as an error and nothing is sent; fix the message and
  press Enter again. One-shot mode (`-p`) sends the prompt verbatim.
- Type **`/`** at the start of the input to see the commands: the built-ins
  and any the provider adds, each with its description. **↑/↓** select,
  **Tab** completes the word to `/name ` so you can type arguments, and
  **Enter** completes too — unless what you typed is already the whole
  command, in which case it runs. **Esc** closes the popup; accepting an
  entry never runs it. `/` has no special meaning in shell mode.
- Type **`!`** in an empty input to run a shell command (pasting text that
  starts with `!` works too). The prompt turns into `! `; **Enter** runs
  the command in the directory you started `chatbridge` in, with your own
  user and environment and no sandbox. Its output streams into the history
  under a `shell` label; the status row shows `Running…  12s · Ctrl+C
  stop`, plus `· N queued` when messages are waiting. When the command
  finishes, the output is sent to the service as a fenced block under
  `### $ <command>` after a lead-in line (default `Please check the
  execution result.`, configurable in `config.json` and by a derived
  CLI), so the assistant reacts to it in the same turn. A non-zero
  exit code is appended as `exit code: N`; a stopped command is marked
  `interrupted`, and one killed from outside (or crashed) is marked
  `killed by <SIGNAL>` (for example `killed by SIGKILL`). Output is capped at 200 KB:
  past that the command is killed and only the tail is kept, with a
  `truncated` note. Enter returns the input to message mode, so you can
  comment on the output right away; type `!` again for another command.
  **Esc**, **Backspace**, or **Ctrl+U** on an empty shell input leave the
  mode without running anything. `@` has no special meaning in shell mode.
  Each command starts fresh in the start directory (`cd` does not carry
  over).
- With `"shell": { "autoSend": false }` in `config.json` the output is held
  instead of sent: the entry shows `📎 held, sent with your next message`,
  the status row counts the held results, and they are appended to the next
  message you send. If that send fails (a timeout, a reopened browser) they
  stay held for the next try. Held results are dropped when you quit.
- While a reply is pending the status line shows an activity indicator
  with the elapsed time against the `--timeout` budget, e.g.
  `○●○ Thinking…  12s / 120s`.
- A response timeout is shown in the history and you can keep chatting.
  If the timeout turns out to be a lost login or a block, the chat closes
  with exit code 3 or 6; any other failure closes it with exit code 1.
- Interactive mode needs **Bun >= 1.3 or Node >= 26.4** (the TUI library's
  requirement). One-shot mode and `auth` keep working on Node >= 20.
- A terminal is required; in pipes and scripts use `-p`.

A provider can add its own commands (`/model`, `/summarize …`); `/help` lists
them after the built-ins. Arguments are the rest of the line. A provider can
also register URL hooks: a URL in your message that a hook recognises is
fetched by the provider and attached like an `@file` mention (the history
shows the hook's label; only the service sees the content). Neither is
available in one-shot mode.

## VSCode extension

`@chatbridge/vscode` ships the same chat as a sidebar view. A vendor
repository packages it with its Provider, in the style of `createCli`:

```ts
import { createExtension } from "@chatbridge/vscode";
import provider from "./provider.js";
export const { activate, deactivate } = createExtension({
  id: "company-ai", displayName: "Company AI", provider, configDir: "company-ai",
});
```

The manifest declares the view `<id>.chat`, the commands `<id>.login`,
`logout`, `newChat`, `installBrowser`, `sendSelection`, `sendFile`, `focus`,
and the settings `<id>.headless` / `<id>.timeoutSec`.

Pass `ui` to brand the view: `welcome` text and a `banner` image above the
empty history, a `footer` line under the composer, `sendButton` colours and
a `userMessage` border colour.

`examples/vscode-dummy-chat` is the template (esbuild CJS bundle, `vscode`
and `playwright` external, webview assets copied next to the bundle). The
browser runs inside the extension host and opens lazily on the first
message. Use the CLI's `configDir` so one `auth login` serves both. When
Chromium is missing the extension offers to install it. Right-click a
selection or a file to attach it to the next message in the CLI's
`### path` fenced format.

To build a distributable `.vsix`, keep only `playwright` under
`dependencies` (the `@chatbridge/*` packages are inlined by esbuild), run
the esbuild bundle, then `rm -rf node_modules && npm install --omit=dev`
and `npx @vscode/vsce package` — npm rather than bun, because vsce walks
npm's `node_modules` layout to collect dependencies. The result (about
4 MB) ships `node_modules/playwright`, which the Install Browser button
needs; Chromium itself is downloaded by that button, never packaged. The
example's own `package` script uses `--no-dependencies` and is only a CI
smoke test. Full steps: `packages/vscode/README.md`.

## Long-running sessions

An open interactive session keeps a real browser running. That is not free:
a headless Chromium on macOS rasterises in software and Playwright disables
background throttling, so a chat page that keeps animating can hold a core
busy for as long as the session stays open.

Two things keep that in check:

- Every browser context asks for `prefers-reduced-motion: reduce`, so pages
  that honour the preference stop animating while you are not typing. A
  provider that needs the animations can opt out with
  `browser: { reducedMotion: "no-preference" }`.
- A session that has seen no turn for 24 hours closes its browser (saving
  the auth state first). The UI says so, and your next prompt reopens it —
  as a new chat, since the service-side conversation is not restored.

Change or disable the idle close, longest-winning-last:

- `config.json`: `{ "idle": { "timeoutMin": 120 } }` — `0` disables it.
- Environment: `CHATBRIDGE_IDLE_TIMEOUT=120` (minutes, `0` disables).
- VSCode: the `<id>.idleTimeoutMinutes` setting.

One-shot mode (`-p`) is unaffected: it closes the browser when the reply
arrives.

## Authentication

The framework never stores usernames or passwords. You log in yourself in a headful browser, and the resulting browser authentication state is saved and reused on subsequent runs.

## Scope: cooperative services only

This project exists to drive company-internal and similarly cooperative
web chat services. Services that deploy bot protection (Cloudflare
challenges, browser fingerprinting at the identity provider) may block
Playwright, especially headless; `--headful` sometimes helps, and that is
as far as this project goes. A provider can recognise such a page with the
optional `detectBlock` method (see `@chatbridge/provider`) so the CLI exits
6 and suggests `--headful` instead of reporting an expired login. A provider
that is slow to open, or flaky enough to be worth a second try, can also ship
its own defaults through the optional `open` field
(`{ timeoutMs?, retries? }`), which the `open` block in `config.json` and
then the `CHATBRIDGE_OPEN_*` environment variables override in turn. Evading
bot protection — stealth plugins,
user-agent spoofing, attaching to a personal browser profile — is out of
scope and will not be added. Public services are used here only as spike
targets to validate the Provider contract (see `docs/spike-notes/`).

## Provider extension points

Besides the required page methods, a provider may ship:

```ts
import { defineProvider } from "@chatbridge/provider";

export default defineProvider({
  // ...name, chatUrl and the five page methods...
  commands: [
    {
      name: "model",
      description: "Show the selected model",
      async run(page) {
        return { kind: "show", text: await page.locator("#model").innerText() };
      },
    },
    {
      name: "summarize",
      description: "Summarize the given text",
      async run(_page, args) {
        return { kind: "send", prompt: `Summarize in three bullets:\n\n${args}` };
      },
    },
  ],
  urlHooks: [
    {
      match: /^https:\/\/wiki\.example\.com\//,
      async resolve(url) {
        // Your code: a script, an API call, a PAT from the environment.
        // The framework never fetches and never sees a credential.
        const { title, body } = await fetchWikiPage(url);
        return { label: `Wiki: ${title}`, content: body };
      },
    },
  ],
});
```

`defineProvider` rejects command names that are not lower-case letters, that
collide with a built-in (`login`, `logout`, `new`, `reopen`, `help`), or that
repeat. A `show` result is printed; a `send` result is sent as an ordinary
turn while the history keeps the `/command` line you typed. A URL hook runs
under the session timeout and its result is subject to the same size limits
as `@file` attachments. URLs are detected in the text as typed, and the
punctuation prose puts after a link (`.,;:!?'"]>`) is trimmed off before
`match` sees it; a `)` is trimmed only when it does not close a `(` from
inside the URL, so `https://wiki.example.com/Foo_(bar)` arrives intact.

A provider may also set two defaults for the framework's browser handling:

```ts
export default defineProvider({
  // ...
  // Emulated prefers-reduced-motion for every context (default "reduce").
  browser: { reducedMotion: "no-preference" },
  // Idle lifetime of an interactive session (default 24 h; 0 disables).
  idle: { timeoutMs: 2 * 60 * 60 * 1000 },
});
```

`reducedMotion` defaults to `"reduce"` because an idle animating page is
rasterised on the CPU for as long as the session is open; opt out only when
the service misbehaves without its animations — and prefer completion
detection that keys on DOM state rather than on a running animation, which
never needs the opt-out. The user's `idle` config key, the
`CHATBRIDGE_IDLE_TIMEOUT` environment variable and the VSCode setting
override `idle.timeoutMs`.

## License

MIT — see [LICENSE](LICENSE).
