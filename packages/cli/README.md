# @chatbridge/cli

The CLI for [chatbridge](https://github.com/7milch/chatbridge-cli): drive browser-only web chat AI services from the command line.

## Modes

- `chatbridge -p "<prompt>"` — one-shot, response on stdout. Node >= 20 or Bun.
- `chatbridge` — interactive chat in the terminal. Bun >= 1.3 or Node >= 26.4.
- `chatbridge auth login|logout|status` — manage the saved browser auth state.
