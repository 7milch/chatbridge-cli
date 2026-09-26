# Extension points

Optional members of `Provider`. Each page says what the framework does with the member, the constraints it must respect, a minimal template, and where its recipe is.

- [commands.md](commands.md) — `commands`: `/name` commands in the interactive UIs.
- [url-hooks.md](url-hooks.md) — `urlHooks`: a URL typed in a message becomes an attachment.
- [streaming.md](streaming.md) — `streaming`: show the reply while it is being written.
- [conversation.md](conversation.md) — `conversation`: return to the same chat after the browser was closed.
- [detect-block.md](detect-block.md) — `detectBlock`: tell a bot challenge from an expired login.
- [open-browser-idle.md](open-browser-idle.md) — `open`, `browser`, `idle`: defaults for the opening phase, reduced motion, and the idle close.
