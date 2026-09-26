# Recipe: `/title` and `/shout`

## What it does

Two provider commands from the bundled dummy provider: `/title` shows the
chat page's title, `/shout` sends its arguments in upper case as a turn.

## The code

`examples/dummy-chat/provider.ts`:

```ts
    commands: [
      {
        name: "title",
        description: "Show the chat page title",
        async run(page) {
          return { kind: "show", text: await page.title() };
        },
      },
      {
        name: "shout",
        description: "Send the arguments in upper case",
        async run(_page, args) {
          return { kind: "send", prompt: args.toUpperCase() };
        },
      },
    ],
```

## Register it

The array above is passed straight to `defineProvider`:

```ts
export default defineProvider({
  // ...page methods
  commands,
});
```

In the example it is inline, as part of the object literal shown above.

## Use it

```
/title
```

prints the page's `<title>` in the history.

```
/shout hello
```

the service receives `HELLO`; the history keeps the typed line,
`/shout hello`.

## Verify

```sh
bun run examples/dummy-chat/serve.ts &
bun packages/cli/src/bin.ts --provider ./examples/dummy-chat/provider.ts
```

Type `/help`: `title` and `shout` appear after the built-ins, with their
descriptions.
