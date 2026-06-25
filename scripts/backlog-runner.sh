#!/usr/bin/env bash
#
# backlog-runner.sh — conservative autonomous backlog executor.
#
# One invocation = one task. Picks the next open task from BACKLOG.md, works on
# it in an isolated branch using `pi -p` (non-interactive agent), verifies the
# result, and (only if verification passes) opens a PR for human review.
#
# It NEVER merges and NEVER pushes to the base branch. The PR is the review gate.
#
# Schedule it with cron/launchd to drain the backlog one task per run.
#
# Config (env overrides):
#   BACKLOG_FILE   backlog path            (default: BACKLOG.md)
#   BASE_BRANCH    branch to fork/PR into  (default: main)
#   BACKLOG_MODEL  pi model                (default: anthropic/claude-opus-4-6)
#   VERIFY_CMD     verification gate       (default: npm run test:run && npm run typecheck)
#   DRY_RUN        1 = run agent + verify, but skip push/PR and keep the branch
#
set -euo pipefail

BACKLOG_FILE="${BACKLOG_FILE:-BACKLOG.md}"
BASE_BRANCH="${BASE_BRANCH:-main}"
BACKLOG_MODEL="${BACKLOG_MODEL:-anthropic/claude-opus-4-6}"
VERIFY_CMD="${VERIFY_CMD:-npm run test:run && npm run typecheck}"
DRY_RUN="${DRY_RUN:-}"

log() { printf '\033[36m[backlog-runner]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[backlog-runner] %s\033[0m\n' "$*" >&2; exit 1; }

# --- 0. Preconditions ------------------------------------------------------
command -v pi >/dev/null || die "pi not found on PATH"
command -v gh >/dev/null || die "gh not found on PATH"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git repo"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Single-flight lock: a task can take minutes; never let two runs overlap.
LOCK_DIR="${TMPDIR:-/tmp}/backlog-runner-$(printf '%s' "$REPO_ROOT" | cksum | cut -d' ' -f1).lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "another run holds the lock ($LOCK_DIR); exiting"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

[ -n "$DRY_RUN" ] && log "DRY RUN: will skip push + PR and keep the branch"

[ -f "$BACKLOG_FILE" ] || die "no $BACKLOG_FILE in $REPO_ROOT"
[ -z "$(git status --porcelain)" ] || die "working tree is dirty; commit or stash first"

START_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git rev-parse --verify --quiet "$BASE_BRANCH" >/dev/null || die "base branch '$BASE_BRANCH' not found locally"

# --- 1. Pick the next open task whose branch isn't already in flight -------
task=""
branch=""
while IFS= read -r line; do
  text="${line#- \[ \] }"
  [ -n "$text" ] || continue
  slug="$(printf '%s' "$text" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' \
            | sed -E 's/^-+|-+$//g' | cut -c1-48 | sed -E 's/-+$//')"
  cand="auto/${slug}"
  # Skip if a branch for this task already exists locally or on origin (in flight / done).
  if git show-ref --verify --quiet "refs/heads/$cand" \
     || git ls-remote --exit-code --heads origin "$cand" >/dev/null 2>&1; then
    log "skip (branch exists): $cand"
    continue
  fi
  task="$text"; branch="$cand"; break
done < <(grep '^- \[ \] ' "$BACKLOG_FILE" || true)

[ -n "$task" ] || { log "no actionable tasks in $BACKLOG_FILE"; exit 0; }
log "task: $task"
log "branch: $branch"

# --- 2. Isolated branch from the local base --------------------------------
git checkout -B "$branch" "$BASE_BRANCH" --quiet

# Always return to where we started, even on failure.
cleanup_to_base() {
  git checkout --quiet "$START_BRANCH" 2>/dev/null || git checkout --quiet "$BASE_BRANCH" 2>/dev/null || true
  git branch -D "$branch" --quiet 2>/dev/null || true
}

# --- 3. Let the agent do the work (files only, no git) ---------------------
read -r -d '' PROMPT <<EOF || true
You are an autonomous coding agent working in the repository at $REPO_ROOT.
Complete EXACTLY this one backlog task and nothing else:

TASK: $task

Rules:
- Implement only what the task requires. Do NOT refactor or "improve" unrelated code.
- Keep the change minimal and focused; touch the fewest files possible.
- Ensure the project still builds and its tests pass.
- Do NOT run any git commands, do NOT commit, push, or create branches.
- Do NOT edit $BACKLOG_FILE; the runner manages backlog state.
When done, briefly summarize what you changed.
EOF

log "running pi ($BACKLOG_MODEL)…"
if ! pi -p --model "$BACKLOG_MODEL" "$PROMPT"; then
  log "pi exited non-zero; abandoning task"
  cleanup_to_base
  exit 1
fi

# --- 4. Did the agent actually change anything? ----------------------------
if [ -z "$(git status --porcelain)" ]; then
  log "agent produced no changes; leaving task open, no PR"
  cleanup_to_base
  exit 0
fi

# --- 5. Verification gate --------------------------------------------------
log "verifying: $VERIFY_CMD"
if ! bash -c "$VERIFY_CMD"; then
  log "VERIFICATION FAILED — discarding branch, no PR (task stays open)"
  git checkout -- . 2>/dev/null || true
  git clean -fd >/dev/null 2>&1 || true
  cleanup_to_base
  exit 1
fi
log "verification passed"

# --- 6. Mark done, commit (push + PR unless dry run) ------------------------
# Flip the checkbox for THIS task so the PR carries the backlog update.
tmp="$(mktemp)"
awk -v t="- [ ] $task" -v d="- [x] $task" \
  '!done && $0==t {print d; done=1; next} {print}' "$BACKLOG_FILE" > "$tmp" && mv "$tmp" "$BACKLOG_FILE"

git add -A
git commit --quiet -m "auto: $task" \
  -m "Completed by backlog-runner (model: $BACKLOG_MODEL). Verified with: $VERIFY_CMD"

if [ -n "$DRY_RUN" ]; then
  log "DRY RUN complete — no push, no PR. Branch '$branch' left for inspection:"
  git --no-pager show --stat HEAD
  echo >&2
  log "inspect:  git diff $BASE_BRANCH...$branch"
  log "discard:  git checkout $START_BRANCH && git branch -D $branch"
  exit 0
fi

git push --quiet -u origin "$branch"

pr_url="$(gh pr create \
  --base "$BASE_BRANCH" \
  --head "$branch" \
  --title "auto: $task" \
  --body "$(cat <<EOF
Automated backlog task.

**Task:** $task
**Model:** \`$BACKLOG_MODEL\`
**Verification:** \`$VERIFY_CMD\` (passed)

Generated by \`scripts/backlog-runner.sh\`. Review before merging.
EOF
)")"

log "PR opened: $pr_url"
git checkout --quiet "$START_BRANCH" 2>/dev/null || git checkout --quiet "$BASE_BRANCH"
log "done"
