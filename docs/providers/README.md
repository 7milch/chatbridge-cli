# Writing a Provider

For people who implement `Provider` from `@chatbridge/provider` for one web chat service and ship it as a CLI, a VSCode extension, or both. The framework owns the browser and the auth state; the provider owns URLs, selectors and completion detection.

- [contract.md](contract.md) — the seven required members, when each is called, what each must guarantee.
- [define-provider.md](define-provider.md) — `defineProvider` validation, `createCli` and `createExtension` wiring, the VSCode manifest a vendor must carry.
- [auth-and-browser.md](auth-and-browser.md) — auth state on disk, the headful login flow, headless and headful sessions, the bot-protection stance.
- [extension-points/](extension-points/README.md) — the optional members: commands, URL hooks, streaming, conversation, detectBlock, open / browser / idle.
- [recipes/](recipes/README.md) — copy-ready examples, one per extension point.

The `@chatbridge/provider` package also ships two skills for coding agents, `creating-provider-repo` and `upgrading-provider-repo`; they are procedures, this guide is the reference.
