# chatbridge-cli

A reusable OSS framework for using web-based chat AI services from the command line, without touching the browser UI.

Service-specific behaviour (URLs, DOM selectors, login flows, response detection) is isolated behind a Provider / Adapter interface, so the same core can drive multiple web chat AI services.

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

Choose a provider with `--provider <npm-package|./path>` or set `defaultProvider` in the config file; see [Configuration](docs/users/configuration.md).

## Documentation

- [Using the CLI, the terminal chat and the VSCode extension](docs/users/README.md)
- [Writing a Provider](docs/providers/README.md)
- [Contributing](docs/contributing/README.md)
- [Roadmap](docs/ROADMAP.md)

## License

MIT — see [LICENSE](LICENSE). `@chatbridge/cli` ships five tree-sitter
grammars under `packages/cli/assets/`, each with its own MIT licence file.
