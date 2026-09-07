# Publishing

Packages: `@chatbridge/provider`, `@chatbridge/runtime`, `@chatbridge/core`,
`@chatbridge/cli`. Versions move in lockstep.

## One-time setup (npm side, done by a maintainer)

1. Confirm the `@chatbridge` scope: sign in to npmjs.com and create the
   organization `chatbridge` (Add Organization → free). If the name is taken,
   follow "Scope fallback" below before anything else.
2. Trusted Publishing: for each of the four packages, open
   Package → Settings → Trusted Publisher and register
   - Provider: GitHub Actions
   - Repository: `7milch/chatbridge-cli`
   - Workflow file: `publish.yml`
   Packages that do not exist yet cannot be configured; the very first
   publish of each package therefore happens once by hand. Run
   `bun run build` first — the pack script does not build:
   `bun run build && scripts/pack-all.sh packs && for t in packs/chatbridge-provider-* packs/chatbridge-runtime-* packs/chatbridge-core-* packs/chatbridge-cli-*; do npm publish "$t" --access public; done`
   (in dependency order, with a granular access token). After that,
   register the trusted publisher and use the workflow.

## Cutting a release

1. On `main`, bump `version` in the four `package.json` files to the same
   value. Commit: `chore: release vX.Y.Z`.
2. `git tag vX.Y.Z && git push origin main vX.Y.Z`.
3. The `Publish` workflow runs `bun run check`, verifies the tag matches
   every package version, packs with `bun pm pack` (rewrites `workspace:*`),
   and runs `npm publish --provenance` in dependency order.

## Scope fallback

If `@chatbridge` is unavailable, rename in one commit:

| From | To |
|---|---|
| `@chatbridge/provider` | `@chatbridge-cli/provider` |
| `@chatbridge/runtime` | `@chatbridge-cli/runtime` |
| `@chatbridge/core` | `@chatbridge-cli/core` |
| `@chatbridge/cli` | `@chatbridge-cli/cli` |

Checklist: every `package.json` (`name`, `dependencies`, `devDependencies`,
`peerDependencies`), all `import` specifiers under `packages/` and
`examples/`, `README.md`, `CLAUDE.md`, `docs/ROADMAP.md`, this file,
`.github/workflows/*.yml` (tarball name prefixes), `scripts/pack-all.sh`,
`scripts/check-versions.sh`, and `createCli({ name })` in
`packages/cli/src/bin.ts`. Verify with `bun install && bun run check`.
