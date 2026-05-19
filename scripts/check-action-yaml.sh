#!/usr/bin/env bash
# GitHub Actions evaluates ${{ }} expressions inside action.yaml at
# action-load time, including inside `description` strings. A literal
# expression there fails the load for every consumer with
# "Unrecognized named-value: 'github'". Reject any such literal.
set -euo pipefail

target="${1:-action.yaml}"

if grep -Fn '${{' "$target"; then
  echo >&2
  echo "ERROR: $target contains a \${{ }} expression." >&2
  echo "GitHub Actions evaluates these at action-load time and will fail to load the action." >&2
  echo "Rewrite the affected description string in plain prose." >&2
  exit 1
fi

echo "$target has no \${{ }} literals."
