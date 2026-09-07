#!/bin/sh

set -eu

base=${1:-}
if [ -z "$base" ]; then
  printf '%s\n' "usage: scripts/check-dco.sh <base>" >&2
  exit 2
fi
git rev-parse --verify "$base^{commit}" >/dev/null

status=0
commits=$(git rev-list --reverse "$base..HEAD")
if [ -z "$commits" ]; then
  printf '%s\n' "PASS DCO: no commits to check"
  exit 0
fi

for commit in $commits; do
  if git show -s --format=%B "$commit" | git interpret-trailers --parse | grep -Eq '^Signed-off-by: .+ <[^>[:space:]]+>$'; then
    printf 'PASS DCO: %s\n' "$commit"
  else
    printf 'FAIL DCO: %s is missing a valid Signed-off-by trailer\n' "$commit"
    status=1
  fi
done
exit "$status"
