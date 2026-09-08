#!/usr/bin/env bash
# Fails unless every publishable package.json has version == $1.
set -euo pipefail
expected="$1"
status=0
for dir in packages/provider packages/runtime packages/core packages/cli; do
  actual=$(node -p "require('./$dir/package.json').version")
  if [ "$actual" != "$expected" ]; then
    echo "$dir: version $actual != $expected" >&2
    status=1
  fi
done

if [ -f bun.lock ]; then
  for dir in packages/provider packages/runtime packages/core packages/cli; do
    locked=$(node -e '
      const fs = require("fs");
      const lock = fs.readFileSync("bun.lock", "utf8");
      const key = process.argv[1];
      const keyIdx = lock.indexOf(`"${key}": {`);
      if (keyIdx === -1) {
        process.exit(0);
      }
      const versionMatch = lock.slice(keyIdx).match(/"version":\s*"([^"]+)"/);
      if (versionMatch) {
        process.stdout.write(versionMatch[1]);
      }
    ' "$dir")
    if [ -n "$locked" ] && [ "$locked" != "$expected" ]; then
      echo "bun.lock: $dir version $locked != $expected (stale lock? run: rm bun.lock && bun install)" >&2
      status=1
    fi
  done
fi

exit $status
