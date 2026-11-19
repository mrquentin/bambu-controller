#!/usr/bin/env bash
# Apply the repository security policies (idempotent — safe to re-run).
#
#   scripts/apply-repo-policies.sh [owner/repo]
#
# Requires the GitHub CLI authenticated as a repository admin.
set -euo pipefail

REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
ACTIONS_APP_ID=15368 # the "GitHub Actions" app (GITHUB_TOKEN)

echo "Applying policies to $REPO"

# --- merge strategy & features ------------------------------------------------
# Squash-merge only: the PR title (validated as a Conventional Commit) becomes
# the single commit on main that semantic-release reads.
gh api -X PATCH "repos/$REPO" --silent --input - <<'JSON'
{
  "allow_squash_merge": true,
  "allow_merge_commit": false,
  "allow_rebase_merge": false,
  "squash_merge_commit_title": "PR_TITLE",
  "squash_merge_commit_message": "PR_BODY",
  "delete_branch_on_merge": true,
  "allow_auto_merge": true,
  "allow_update_branch": true,
  "has_wiki": false,
  "has_projects": false
}
JSON
echo "  ✓ squash-only merges, auto-delete branches"

# --- vulnerability management ---------------------------------------------------
gh api -X PUT "repos/$REPO/vulnerability-alerts" --silent
gh api -X PUT "repos/$REPO/automated-security-fixes" --silent
gh api -X PUT "repos/$REPO/private-vulnerability-reporting" --silent
echo "  ✓ Dependabot alerts + security updates, private vulnerability reporting"

# Secret scanning + push protection (free for public repositories).
gh api -X PATCH "repos/$REPO" --silent --input - <<'JSON' || echo "  ! secret scanning not available for this repository/plan"
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
JSON
echo "  ✓ secret scanning + push protection"

# --- GitHub Actions ----------------------------------------------------------------
# Read-only GITHUB_TOKEN by default (workflows request more per job), workflows
# can't approve PRs, only GitHub-owned / verified-creator actions plus the
# PR-title linter, and actions must be pinned to a full commit SHA.
gh api -X PUT "repos/$REPO/actions/permissions/workflow" --silent --input - <<'JSON'
{ "default_workflow_permissions": "read", "can_approve_pull_request_reviews": false }
JSON
gh api -X PUT "repos/$REPO/actions/permissions" --silent --input - <<'JSON'
{ "enabled": true, "allowed_actions": "selected", "sha_pinning_required": true }
JSON
gh api -X PUT "repos/$REPO/actions/permissions/selected-actions" --silent --input - <<'JSON'
{
  "github_owned_allowed": true,
  "verified_allowed": true,
  "patterns_allowed": ["amannn/action-semantic-pull-request@*"]
}
JSON
echo "  ✓ Actions: read-only token, allow-listed + SHA-pinned actions"

# --- rulesets ----------------------------------------------------------------------
upsert_ruleset() {
  local name="$1" body="$2" id
  id=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$name\") | .id" || true)
  if [ -n "$id" ]; then
    gh api -X PUT "repos/$REPO/rulesets/$id" --silent --input - <<<"$body"
  else
    gh api -X POST "repos/$REPO/rulesets" --silent --input - <<<"$body"
  fi
  echo "  ✓ ruleset: $name"
}

# main: changes only through pull requests with all checks green, linear
# history, no force-push / deletion, no CodeQL alerts of high severity.
upsert_ruleset "main" "$(cat <<JSON
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "test", "integration_id": $ACTIONS_APP_ID },
          { "context": "secrets", "integration_id": $ACTIONS_APP_ID },
          { "context": "image", "integration_id": $ACTIONS_APP_ID },
          { "context": "dependency-review", "integration_id": $ACTIONS_APP_ID },
          { "context": "conventional-title", "integration_id": $ACTIONS_APP_ID },
          { "context": "analyze", "integration_id": $ACTIONS_APP_ID }
        ]
      }
    },
    {
      "type": "code_scanning",
      "parameters": {
        "code_scanning_tools": [
          { "tool": "CodeQL", "security_alerts_threshold": "high_or_higher", "alerts_threshold": "errors" }
        ]
      }
    }
  ]
}
JSON
)"

# Release tags (v*): a published version can never be moved or deleted.
# (Restricting *creation* to the release pipeline needs the GitHub Actions app
# as a bypass actor, which GitHub only allows for organization-owned repos.)
upsert_ruleset "release-tags" "$(cat <<JSON
{
  "name": "release-tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "update" },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
JSON
)"

echo "Done."
