#!/usr/bin/env bash
# Adds the three thin caller workflows (ai-review, issue-triage, release-notes)
# to every non-fork, non-archived repo in the organization.
# Idempotent: existing workflows are kept. Creates one PR per repo.
#
# Usage:   bash rollout.sh
# Needs:   gh CLI authenticated with write access to the org.
# Options: ORG=other-org bash rollout.sh
set -euo pipefail

ORG="${ORG:-agent-guardrails}"
CENTRAL_REPO=".github"
BRANCH="chore/ai-workflows"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v gh >/dev/null || { echo "gh CLI is required (brew install gh)"; exit 1; }
gh auth status >/dev/null

repos=$(gh repo list "$ORG" --limit 200 --json name,isArchived,isFork \
  --jq '.[] | select(.isArchived == false and .isFork == false and .name != ".github") | .name')

for repo in $repos; do
  echo "== $ORG/$repo"
  default_branch=$(gh repo view "$ORG/$repo" --json defaultBranchRef -q .defaultBranchRef.name)

  missing=()
  for wf in ai-review issue-triage release-notes; do
    if ! gh api "repos/$ORG/$repo/contents/.github/workflows/$wf.yml" >/dev/null 2>&1; then
      missing+=(".github/workflows/$wf.yml")
    fi
  done
  # Org-wide agent rules: only when the repo has no AGENTS.md of its own.
  if ! gh api "repos/$ORG/$repo/contents/AGENTS.md" >/dev/null 2>&1; then
    missing+=("AGENTS.md")
  fi
  if [ "${#missing[@]}" -eq 0 ]; then
    echo "   all workflows + AGENTS.md present, skipping"
    continue
  fi

  # Branch off the default branch (reuse an existing rollout branch if present).
  sha=$(gh api "repos/$ORG/$repo/git/ref/heads/$default_branch" -q .object.sha)
  gh api -X POST "repos/$ORG/$repo/git/refs" \
    -f "ref=refs/heads/$BRANCH" -f "sha=$sha" >/dev/null 2>&1 || true

  for target in "${missing[@]}"; do
    name="$(basename "$target")"
    if [ "$name" = "AGENTS.md" ]; then
      src="$SCRIPT_DIR/AGENTS.md"
    else
      src="$SCRIPT_DIR/workflow-templates/$name"
    fi
    content=$(base64 < "$src" | tr -d '\n')
    gh api -X PUT "repos/$ORG/$repo/contents/$target" \
      -f "message=chore: add $name (agent-guardrails/.github)" \
      -f "content=$content" \
      -f "branch=$BRANCH" >/dev/null
  done

  gh pr create --repo "$ORG/$repo" --head "$BRANCH" --base "$default_branch" \
    --title "Add AI workflows and org-wide AGENTS.md" \
    --body "Thin callers for the reusable workflows in [$ORG/$CENTRAL_REPO](https://github.com/$ORG/$CENTRAL_REPO), plus the org-wide agent rules file.

Requires the org secret \`AI_API_KEY\` (setup: see the central repo README)." \
    >/dev/null 2>&1 && echo "   PR created for: ${missing[*]}" \
    || echo "   files pushed; PR may already exist — check $ORG/$repo"
done

echo "Done."
