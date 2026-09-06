#!/usr/bin/env bash
# Packs the four publishable packages into $1 (default: ./packs) in
# dependency order and sanity-checks each tarball.
set -euo pipefail
out=$(cd "$(dirname "${1:-packs}")" && pwd)/$(basename "${1:-packs}")
mkdir -p "$out"
for dir in packages/provider packages/runtime packages/core packages/cli; do
  (cd "$dir" && bun pm pack --destination "$out" --quiet)
done
for tgz in "$out"/*.tgz; do
  tar -tzf "$tgz" | grep -q 'package/dist/index.js' || { echo "$tgz: missing dist/index.js" >&2; exit 1; }
  tar -tzf "$tgz" | grep -q 'package/LICENSE' || { echo "$tgz: missing LICENSE" >&2; exit 1; }
  if tar -xOf "$tgz" package/package.json | grep -q 'workspace:'; then
    echo "$tgz: unresolved workspace: dependency" >&2; exit 1
  fi
done
ls -1 "$out"
