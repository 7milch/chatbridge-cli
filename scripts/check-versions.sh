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
exit $status
