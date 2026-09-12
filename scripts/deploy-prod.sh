#!/usr/bin/env bash
# deploy-prod.sh — the production deploy, with every hard-won rule enforced
# instead of remembered.
#
# WHY THIS EXISTS. The procedure worked and was still dangerous, because it
# lived as prose in DEPLOY-RUNBOOK.md §9 and a memory file while the actual
# deploy was a hand-assembled rsync + compose chain. Every guard below is a
# production incident that already happened:
#
#   · --exclude ".env*"      2026-09-03: a full-tree rsync carrying a stale
#                            local .env.prod wiped the host's operator-
#                            appended vars and darked the research clock.
#                            The host file is RUNTIME TRUTH.
#   · one service at a time  2026-08-22: a combined build OOM-killed dockerd
#                            itself (2.5 GB RSS on a 3.8 GB box) and took
#                            production down. Never two builds at once.
#   · set -o pipefail        a `build | tail` pipe masks the build's exit
#                            code, so a failed build reported success.
#   · COPYFILE_DISABLE=1     AppleDouble ._* files from macOS rsync fail the
#     + --exclude "._*"      next lint inside the image build.
#   · --exclude ".claude"    2026-09-05: four stale agent worktrees were found
#                            living in /opt/potion/app on production — one of
#                            them carrying a developer .env with provider API
#                            keys and a 61 MB PGlite data directory. rsync
#                            ships the TREE, and .claude is gitignored, so the
#                            committed-tree gate never saw them. The agent
#                            working directory is not part of the app and has
#                            no business on the host.
#   · committed-tree gate    the working tree carries several sessions' WIP
#                            at once; shipping it deploys code nobody
#                            reviewed. Migrations + server + workers must
#                            travel as the SET a commit defines.
#
# SAFETY POSTURE. Dry run is the DEFAULT and touches nothing remote — it
# prints the plan and runs every local preflight. Deploying requires --go,
# typed by a person who means it. This script never reads, writes, prints
# or transports a secret: .env* is excluded on the way out, and the host's
# copy is the only one that matters.
#
# Usage:
#   bash scripts/deploy-prod.sh                 # dry run: plan + preflight
#   bash scripts/deploy-prod.sh --go            # deploy (asks to confirm)
#   bash scripts/deploy-prod.sh --go --yes      # deploy, no prompt (CI)
#   bash scripts/deploy-prod.sh --rollback      # restore last images, ~15s
set -u
set -o pipefail   # a piped build must not report success when it failed

HOST="${POTION_DEPLOY_HOST:-root@178.105.98.174}"
APP_DIR="${POTION_DEPLOY_DIR:-/opt/potion/app}"
COMPOSE="docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod"
# Build order matters only in that it is SEQUENTIAL; server first so the
# dashboard's rebuild lands against an already-updated API.
SERVICES=("server" "dashboard")

GO=0; YES=0; ROLLBACK=0
for arg in "$@"; do
  case "$arg" in
    --go) GO=1 ;;
    --yes) YES=1 ;;
    --rollback) ROLLBACK=1 ;;
    -h|--help) sed -n '1,40p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)"; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
ok()   { printf 'OK    %s\n' "$*"; }
bad()  { printf 'BLOCK %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

cd "$(dirname "$0")/.." || exit 2
REPO=$(pwd)

# ---------------------------------------------------------------- rollback
if [ "$ROLLBACK" = 1 ]; then
  say "Rolling back to the images already on the host (no build, ~15s)."
  say "Host: $HOST  Dir: $APP_DIR"
  [ "$YES" = 1 ] || { printf 'Type ROLLBACK to continue: '; read -r c; [ "$c" = "ROLLBACK" ] || { say "aborted"; exit 1; }; }
  # shellcheck disable=SC2029
  ssh "$HOST" "cd $APP_DIR && $COMPOSE up -d --no-build" || exit 1
  say "Done. Check: curl -fsS https://api.withpotion.com/readyz"
  exit 0
fi

# --------------------------------------------------------------- preflight
step "Preflight (runs in dry run too — these are the rules that bit us)"
FAIL=0

if git rev-parse --git-dir >/dev/null 2>&1; then
  DIRTY=$(git status --porcelain | grep -vE '^\?\?' | wc -l | tr -d ' ')
  HEAD_SHA=$(git rev-parse --short HEAD)
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  if [ "$DIRTY" != "0" ]; then
    bad "$DIRTY tracked file(s) modified but not committed."
    say "      A deploy ships the TREE, so this would ship code no commit"
    say "      describes — and this repo regularly holds several sessions'"
    say "      work at once. Commit or stash first, then re-run."
    git status --short | grep -vE '^\?\?' | head -12 | sed 's/^/      /'
    FAIL=1
  else
    ok "working tree clean — deploying $BRANCH @ $HEAD_SHA"
  fi
  # rsync ships the TREE, not the index: an untracked file that is not
  # gitignored travels to production while no commit describes it. Same
  # failure as a dirty tree, and easier to miss — the first version of this
  # script skipped these and would have shipped two scratch files.
  UNTRACKED=$(git status --porcelain | grep -E '^\?\?' | sed 's/^?? //')
  if [ -n "$UNTRACKED" ]; then
    bad "untracked file(s) present — rsync would ship these unreviewed:"
    printf '%s\n' "$UNTRACKED" | head -12 | sed 's/^/      /'
    say "      Commit them, delete them, or add them to .gitignore."
    FAIL=1
  else
    ok "no untracked files — the commit describes everything that ships"
  fi
  UNPUSHED=$(git log --oneline @{u}..HEAD 2>/dev/null | wc -l | tr -d ' ')
  if [ "${UNPUSHED:-0}" != "0" ]; then
    say "NOTE  $UNPUSHED commit(s) not pushed to the upstream branch."
    say "      Not fatal — the host is fed by rsync, not by git pull — but"
    say "      an unpushed deploy is one laptop failure from unreproducible."
  fi

  # DEPLOY TRACKS MAIN (2026-09-12). Production ships commits that are ON
  # main, never commits main has not seen.
  #
  # It used to be the other way round: work landed on deploy/** and main
  # caught up in batches, so the two were never briefly identical. That is not
  # just untidy — CI reads .github/workflows/ci.yml from the BASE, so a PR
  # into deploy was gated by whatever workflow deploy happened to have. #18
  # got a two-job gate while main had three, because the third job existed
  # only on main. Every PR was tested against whichever half its base held.
  #
  # So the direction is fixed here, where it is checkable: HEAD must be
  # contained in origin/main. `deploy/**` becomes a RECORD of what production
  # is running — a pointer fast-forwarded to a main commit — rather than a
  # place work accumulates.
  git fetch -q origin main 2>/dev/null || say "NOTE  could not fetch origin/main — checking against the local ref."
  if git rev-parse --verify -q origin/main >/dev/null; then
    if git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
      ok "HEAD is on main — $(git rev-list --count HEAD..origin/main) commit(s) behind origin/main"
    elif [ "${POTION_DEPLOY_OFF_MAIN:-}" = "1" ]; then
      say "NOTE  HEAD is NOT on origin/main, and POTION_DEPLOY_OFF_MAIN=1 allowed it."
      say "      Deliberate hotfix. Get it onto main straight after, or the next"
      say "      deploy from main silently reverts it — which is exactly how"
      say "      27 files came to exist only on the production filesystem."
    else
      bad "HEAD is not contained in origin/main — deploy tracks main."
      say "      $(git rev-list --count origin/main..HEAD) commit(s) here are not on main."
      say "      Land them on main first (PR), then fast-forward this branch to"
      say "      main and re-run. Production must never hold code the trunk has"
      say "      not accepted: that is how work ends up existing only on a"
      say "      server, recoverable from nowhere."
      say "      Deliberate hotfix? POTION_DEPLOY_OFF_MAIN=1, and land it after."
      FAIL=1
    fi
  fi
else
  bad "not a git repository — refusing to deploy an unidentifiable tree"
  FAIL=1
fi

# Migrations are the irreversible half. Name any that this deploy carries
# so the operator takes a dump first (runbook §8) rather than discovering
# them in the boot log.
if [ -d packages/db/drizzle ]; then
  NEW_MIGRATIONS=$(git log --name-only --pretty=format: -20 -- packages/db/drizzle 2>/dev/null | grep -E '\.sql$' | sort -u | tail -5)
  if [ -n "$NEW_MIGRATIONS" ]; then
    say "NOTE  recent migrations in history (they apply ONCE on boot):"
    printf '%s\n' "$NEW_MIGRATIONS" | sed 's/^/      /'
    say "      Take a dump before --go if any are new to this host (§8)."
  fi
fi

if [ ! -f deploy/docker-compose.prod.yml ]; then bad "deploy/docker-compose.prod.yml missing"; FAIL=1; else ok "compose file present"; fi

if [ "$FAIL" != 0 ]; then say ""; say "Preflight failed. Nothing was sent."; exit 1; fi

# ------------------------------------------------------------------- plan
step "Plan"
say "Host     : $HOST"
say "Directory: $APP_DIR"
say "Source   : $REPO"
say "Services : ${SERVICES[*]}  (built ONE AT A TIME — combined builds have"
say "           OOM-killed dockerd on this box and taken production down)"
say "Excluded : .env*  node_modules  .next  dist  .git  .claude  .pglite  ._*  *.log"
say "           .env* is excluded ALWAYS: the host copy is runtime truth."

RSYNC_ARGS=(
  -az --delete
  --exclude ".env*"          # runtime truth lives on the host — never overwrite
  --exclude "._*"            # AppleDouble files break the image lint
  --exclude ".git"
  --exclude ".claude"        # agent worktrees/settings — never part of the app
  --exclude "node_modules"
  --exclude ".next"
  --exclude "dist"
  --exclude ".pglite"
  --exclude ".tranche/*.log"
  --exclude "*.log"
)

if [ "$GO" != 1 ]; then
  step "DRY RUN — nothing was sent"
  say "Would run:"
  say "  COPYFILE_DISABLE=1 rsync ${RSYNC_ARGS[*]} ./ $HOST:$APP_DIR/"
  for s in "${SERVICES[@]}"; do say "  ssh $HOST 'cd $APP_DIR && $COMPOSE build $s'"; done
  say "  ssh $HOST 'cd $APP_DIR && $COMPOSE up -d'"
  say "  curl -fsS https://api.withpotion.com/readyz"
  say ""
  say "Re-run with --go to deploy. --rollback restores the previous images."
  exit 0
fi

# --------------------------------------------------------------- execute
step "Deploying for real"
if [ "$YES" != 1 ]; then
  printf 'Type DEPLOY to continue: '; read -r c
  [ "$c" = "DEPLOY" ] || { say "aborted"; exit 1; }
fi

step "1/4 rsync (excluding .env* — host secrets are runtime truth)"
COPYFILE_DISABLE=1 rsync "${RSYNC_ARGS[@]}" ./ "$HOST:$APP_DIR/" || { bad "rsync failed"; exit 1; }
ok "files synced"

step "2/4 build, one service at a time"
for s in "${SERVICES[@]}"; do
  say "-- building $s"
  # No pipe here on purpose: piping to tail masks the exit code, which is
  # how a failed build once reported success.
  # shellcheck disable=SC2029
  ssh "$HOST" "cd $APP_DIR && set -o pipefail && $COMPOSE build $s" || { bad "$s build failed — production still runs the OLD images"; exit 1; }
  ok "$s built"
done

step "3/4 up"
# shellcheck disable=SC2029
ssh "$HOST" "cd $APP_DIR && $COMPOSE up -d" || { bad "compose up failed"; say "Recover with: bash scripts/deploy-prod.sh --rollback"; exit 1; }
ok "containers up"

step "4/4 verify"
sleep 5
READY=$(curl -fsS -m 20 https://api.withpotion.com/readyz 2>/dev/null)
if [ -n "$READY" ]; then
  ok "readyz answered"
  printf '%s\n' "$READY" | head -20
else
  bad "readyz did not answer cleanly — INVESTIGATE NOW"
  say "      Fast recovery: bash scripts/deploy-prod.sh --rollback"
  exit 1
fi

say ""
say "Deployed. Smoke the serving path next:"
say "  POTION_API_KEY=... bash scripts/smoke-prod.sh"
