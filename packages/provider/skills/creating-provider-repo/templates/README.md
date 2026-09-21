# chatbridge-&lt;vendor&gt;

A chatbridge provider for &lt;Vendor&gt;: it drives the browser-only &lt;Vendor&gt; web
chat from a CLI named `<vendor>`, on the published `@chatbridge/*` packages.

## Install

```sh
bun install
bun run build
bun link            # puts `<vendor>` on PATH
<vendor> --version
```

## Use

```sh
<vendor> auth login             # a headful browser opens; log in by hand
<vendor> -p "Reply with the single word: ping"   # one-shot, prints to stdout
<vendor>                        # interactive mode (needs Bun >= 1.3 or Node >= 26.4)
<vendor> auth status
<vendor> auth logout            # deletes the saved auth state
```

The CLI never stores a username or a password. `auth login` saves the browser
context's storage state (cookies, localStorage, IndexedDB) under the config
directory; `auth logout` deletes it. Never commit it or paste it anywhere.

## Develop

```sh
bun run check       # lint + build + tests; must pass before every commit
```

`src/selectors.ts` holds every URL and selector, each citing a section of
`docs/dom-notes.md`. Change a selector only after observing the real DOM and
recording the observation there.

## Real-service E2E

`src/provider.e2e.test.ts` talks to the real service, so it is skipped unless
you opt in and a saved auth state exists:

```sh
<vendor> auth login
<VENDOR>_E2E=1 bun test src/provider.e2e.test.ts
```

## Following framework releases

After bumping `@chatbridge/*`, refresh the bundled skills and follow
`upgrading-provider-repo`:

```sh
rm -rf .claude/skills/creating-provider-repo .claude/skills/upgrading-provider-repo
cp -R node_modules/@chatbridge/provider/skills/. .claude/skills/
```
