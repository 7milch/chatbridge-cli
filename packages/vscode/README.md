# @chatbridge/vscode

VSCode extension factory for [chatbridge](https://github.com/7milch/chatbridge-cli).
It turns a chatbridge Provider into a sidebar chat view: a webview talks to a
`vscode`-free `SessionController` that owns the conversation history, the
pending attachments and the underlying `ChatSession` lifecycle. A provider
package wires it up and ships its own extension.
