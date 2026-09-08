#!/usr/bin/env bash
# Packs the four publishable packages into $1 (default: ./packs) in
# dependency order and sanity-checks each tarball.
set -euo pipefail
mkdir -p "${1:-packs}"
out=$(cd "${1:-packs}" && pwd)
for dir in packages/provider packages/runtime packages/core packages/cli; do
  (cd "$dir" && bun pm pack --destination "$out" --quiet)
done
for tgz in "$out"/*.tgz; do
  # Capture first: piping into `grep -q` can kill the producer with SIGPIPE,
  # which under `set -o pipefail` turns a real finding into a silent pass.
  listing=$(tar -tzf "$tgz")
  case "$listing" in
    *package/dist/index.js*) ;;
    *) echo "$tgz: missing dist/index.js" >&2; exit 1 ;;
  esac
  case "$listing" in
    *package/LICENSE*) ;;
    *) echo "$tgz: missing LICENSE" >&2; exit 1 ;;
  esac
  manifest=$(tar -xOf "$tgz" package/package.json)
  case "$manifest" in
    *workspace:*) echo "$tgz: unresolved workspace: dependency" >&2; exit 1 ;;
  esac
  echo "$manifest" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const manifest = JSON.parse(input);
      const version = manifest.version;
      const deps = Object.assign({}, manifest.dependencies, manifest.peerDependencies);
      for (const [name, spec] of Object.entries(deps)) {
        if (name.startsWith("@chatbridge/") && spec !== version) {
          console.error(`${process.argv[1]}: depends on ${name}@${spec} but the release is ${version} (stale bun.lock? run rm bun.lock && bun install)`);
          process.exit(1);
        }
      }
    });
  ' "$tgz"
done
ls -1 "$out"
