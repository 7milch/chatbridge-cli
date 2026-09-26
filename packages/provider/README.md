# @chatbridge/provider

The provider contract for [chatbridge](https://github.com/7milch/chatbridge-cli): the interface service-specific browser behaviour implements.

```bash
npm install @chatbridge/provider
```

## Documentation

- [Writing a Provider](https://github.com/7milch/chatbridge-cli/blob/main/docs/providers/README.md)
- [The Provider contract](https://github.com/7milch/chatbridge-cli/blob/main/docs/providers/contract.md): the required members, when each is called, what each must guarantee
- [Extension points](https://github.com/7milch/chatbridge-cli/blob/main/docs/providers/extension-points/README.md): commands, URL hooks, streaming, conversation, `detectBlock`, open / browser / idle

## Skills for coding agents

`@chatbridge/provider` ships two skills for coding agents (Claude Code,
Codex, …) that build and maintain a vendor repository: `creating-provider-repo`
scaffolds a new vendor-specific provider repository from a template, and
`upgrading-provider-repo` walks an existing vendor repository through bumping
`@chatbridge/*` and adopting new framework features. They live under
`node_modules/@chatbridge/provider/skills/`, so a vendor repository always has
the skills that match its installed framework version, and refreshes its copy
with one command, run after every bump:

```sh
rm -rf .claude/skills/creating-provider-repo .claude/skills/upgrading-provider-repo
cp -R node_modules/@chatbridge/provider/skills/. .claude/skills/
```

In a brand-new vendor repository there is nothing to refresh yet:
`bun add @chatbridge/provider`, then
`mkdir -p .claude/skills && cp -R node_modules/@chatbridge/provider/skills/. .claude/skills/`,
then ask the agent. The template `.mcp.json` loads the DOM probe from that
directory.

What to tell your coding agent:

- New vendor: "Use the creating-provider-repo skill for `<service URL>`."
- Existing vendor: "Bump `@chatbridge/*` to the latest and follow the
  upgrading-provider-repo skill."
- For one feature: "… and adopt Markdown replies."
