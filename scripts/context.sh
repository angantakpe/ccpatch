#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || git rev-parse --short HEAD)"
upstream="$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || true)"
origin_url="$(git remote get-url origin 2>/dev/null || true)"

echo "repo: $(basename "$repo_root")"
echo "root: $repo_root"
echo "branch: $branch"
echo "status:"
git status --short --branch
echo "upstream: ${upstream:-none}"
echo "origin: ${origin_url:-none}"
echo "last_commit: $(git log -1 --pretty='%h %s' 2>/dev/null || true)"
echo "top_level_paths:"
git ls-files --cached --others --exclude-standard | awk -F/ 'NF == 1 { print $1 } NF > 1 { print $1 "/" }' | sort -u | head -n 25

if command -v gh >/dev/null 2>&1; then
  echo "gh_repo:"
  gh repo view --json nameWithOwner,url,defaultBranchRef 2>/dev/null || echo "gh_repo: unavailable"
  echo "gh_pr:"
  gh pr view --json number,title,state,url,headRefName,baseRefName 2>/dev/null || echo "gh_pr: none for current branch"
else
  echo "gh: not installed"
fi
