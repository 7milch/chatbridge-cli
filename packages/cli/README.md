# @chatbridge/cli

The CLI for [chatbridge](https://github.com/7milch/chatbridge-cli): drive browser-only web chat AI services from the command line, one-shot (`-p`) or as an interactive terminal chat.

```bash
npm install -g @chatbridge/cli
```

## Documentation

- [CLI reference](https://github.com/7milch/chatbridge-cli/blob/main/docs/users/cli.md): commands, flags, provider resolution, exit codes
- [Configuration](https://github.com/7milch/chatbridge-cli/blob/main/docs/users/configuration.md): `config.json`, environment variables, precedence
- [Interactive mode](https://github.com/7milch/chatbridge-cli/blob/main/docs/users/interactive-mode.md): slash commands, `@file` mentions, `!` shell mode, keys, copying
- [Shipping your own CLI with `createCli`](https://github.com/7milch/chatbridge-cli/blob/main/docs/providers/define-provider.md)

## Bundled grammars

Fenced code in a Markdown reply is highlighted with tree-sitter. OpenTUI
bundles JavaScript, TypeScript, Markdown and Zig; this package adds Python,
Ruby, JSON, Bash and Go under `assets/<lang>/`, each with the grammar's MIT
`LICENSE` and a `highlights.scm` whose header names the source repository and
tag. Grammars load lazily the first time a reply names one.
