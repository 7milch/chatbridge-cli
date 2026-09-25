# Recipes

Copy-ready code for the extension points. Each recipe targets the bundled dummy chat or an `example.com` host; copy it into your provider repository and change the host, never the other way round. The three dummy-chat recipes are the code of `examples/dummy-chat/provider.ts`, explained.

- [commands/dummy-title-shout.md](commands/dummy-title-shout.md) — one `show` command and one `send` command.
- [url-hooks/jira-datacenter.md](url-hooks/jira-datacenter.md) — a Jira Data Center issue with its comments, over REST API v2 with a personal access token.
- [streaming/dummy-response-text.md](streaming/dummy-response-text.md) — `responseText` that stays `undefined` until the new turn's bubble exists.
- [conversation/dummy-url-conversation.md](conversation/dummy-url-conversation.md) — `urlConversation` keyed on the `/chat/c/<id>` path.
