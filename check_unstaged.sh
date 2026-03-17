#!/usr/bin/env bash
set -euo pipefail

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: There are unstaged changes after build."
  echo "Please run 'make build' and commit the changes."
  git status --porcelain
  git diff
  exit 1
fi
echo "No unstaged changes detected."
