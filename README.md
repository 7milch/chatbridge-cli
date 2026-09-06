# chatbridge-cli

A reusable OSS framework for using web-based chat AI services from the command line, without touching the browser UI.

Service-specific behaviour (URLs, DOM selectors, login flows, response detection) is isolated behind a Provider / Adapter interface, so the same core can drive multiple web chat AI services.

## Status

Milestone 1 (one-shot vertical slice) and milestone 2 (hardening + publishability) implemented. Packages are published to npm; interactive TUI is not built yet.

## Planned features

- Interactive TUI, in the style of Claude Code
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
```

## Install (npm)

```bash
npm install -g chatbridge            # CLI (Node >= 20 or Bun)
npm install @chatbridge/provider     # to write a provider
```

Providers are loaded with `--provider <npm-package|./path>` or from
`~/.config/chatbridge/config.json`:

```json
{ "defaultProvider": "@your-scope/your-provider" }
```

Exit codes: 1 invalid argument or config, 2 not logged in, 3 auth expired,
4 response timeout, 5 provider could not be loaded. Set `CHATBRIDGE_DEBUG=1`
to print the underlying error.

## Authentication

The framework never stores usernames or passwords. You log in yourself in a headful browser, and the resulting browser authentication state is saved and reused on subsequent runs.

## License

MIT — see [LICENSE](LICENSE).
