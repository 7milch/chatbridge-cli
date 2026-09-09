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
{ "defaultProvider": "@your-scope/your-provider" }
```

A globally installed CLI resolves an npm-package `defaultProvider` only if
that provider is installed globally as well.

Exit codes: 1 invalid argument or config, 2 not logged in, 3 auth expired,
4 response timeout, 5 provider could not be loaded, 6 blocked by the
service (a bot challenge or an IdP refusing the automated browser; try
`--headful`). A timeout that coincides with a lost login is reported as 3
or 6 rather than 4. Set `CHATBRIDGE_DEBUG=1` to print the underlying error.

## Interactive mode

Run the CLI with no `-p` to open a chat in the terminal. The browser stays
open for the whole conversation, so follow-up messages continue the same
chat.

- **Enter** sends. **Shift+Enter** (or **Ctrl+J**) inserts a newline;
  Shift+Enter needs a terminal that speaks the kitty keyboard protocol
  (iTerm2, kitty, WezTerm, Ghostty), Ctrl+J works everywhere. **Ctrl+C**
  quits.
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
- While a reply is pending the status line shows an activity indicator
  with the elapsed time against the `--timeout` budget, e.g.
  `○●○ Thinking…  12s / 120s`.
- A response timeout is shown in the history and you can keep chatting.
  If the timeout turns out to be a lost login or a block, the chat closes
  with exit code 3 or 6; any other failure closes it with exit code 1.
- Interactive mode needs **Bun >= 1.3 or Node >= 26.4** (the TUI library's
  requirement). One-shot mode and `auth` keep working on Node >= 20.
- A terminal is required; in pipes and scripts use `-p`.

## Authentication

The framework never stores usernames or passwords. You log in yourself in a headful browser, and the resulting browser authentication state is saved and reused on subsequent runs.

## Scope: cooperative services only

This project exists to drive company-internal and similarly cooperative
web chat services. Services that deploy bot protection (Cloudflare
challenges, browser fingerprinting at the identity provider) may block
Playwright, especially headless; `--headful` sometimes helps, and that is
as far as this project goes. A provider can recognise such a page with the
optional `detectBlock` method (see `@chatbridge/provider`) so the CLI exits
6 and suggests `--headful` instead of reporting an expired login. Evading
bot protection — stealth plugins,
user-agent spoofing, attaching to a personal browser profile — is out of
scope and will not be added. Public services are used here only as spike
targets to validate the Provider contract (see `docs/spike-notes/`).

## License

MIT — see [LICENSE](LICENSE).
