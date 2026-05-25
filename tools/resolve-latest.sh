#!/usr/bin/env bash
# src/cli/resolve-latest.sh
#
# Resolve the latest version of an npm package, with caching.

PACKAGE=$1
if [[ -z "$PACKAGE" ]]; then
  echo "Error: PACKAGE name required" >&2
  exit 1
fi

CACHE_DIR="storage/tmp"
mkdir -p "$CACHE_DIR"
CACHE_FILE="$CACHE_DIR/latest_version_${PACKAGE//\//@}.txt"

# TTL: 1 hour (3600 seconds)
TTL=3600

if [[ -f "$CACHE_FILE" ]]; then
  MOD_TIME=$(stat -c %Y "$CACHE_FILE")
  NOW=$(date +%s)
  DIFF=$(( NOW - MOD_TIME ))
  if [[ $DIFF -lt $TTL ]]; then
    cat "$CACHE_FILE"
    exit 0
  fi
fi

# Fetch from npm
VERSION=$(npm view "$PACKAGE" version 2>/dev/null)
if [[ -z "$VERSION" ]]; then
  # If offline or package not found, fallback to existing cache if available
  if [[ -f "$CACHE_FILE" ]]; then
    cat "$CACHE_FILE"
    exit 0
  fi
  echo "Error: Could not resolve latest version for $PACKAGE" >&2
  exit 1
fi

echo "$VERSION" > "$CACHE_FILE"
echo "$VERSION"
