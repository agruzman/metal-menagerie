#!/usr/bin/env bash
# =============================================================================
#  deploy.sh — put the shop on the internet for $0.
#
#     bash deploy.sh
#
#  What it does (each step is skipped if already done):
#    1. Pushes this folder to a GitHub repository        (code hosting, free)
#    2. Creates a Turso database and prints its two keys (database, free)
#    3. Opens Render's one-click deploy page              (server, free)
#    4. Wires up the keep-alive so the site never sleeps
#
#  The only things it cannot do for you are the sign-ins: GitHub, Turso and
#  Render each open a browser tab where you click "Authorize". Three clicks.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

REPO_NAME="${1:-metal-menagerie}"

bold()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note()  { printf '    %s\n' "$*"; }
fail()  { printf '\n\033[31m%s\033[0m\n' "$*"; exit 1; }

# ----------------------------------------------------------------- 0. tools
command -v git  >/dev/null || fail "git is missing. Run:  xcode-select --install   and try again."
command -v brew >/dev/null || fail "Homebrew is missing. Install it from https://brew.sh and try again."

if ! command -v gh >/dev/null; then
  bold "Installing the GitHub command-line tool"
  brew install gh
fi
if ! command -v turso >/dev/null; then
  bold "Installing the Turso command-line tool"
  # Turso's own installer drops one binary into ~/.turso — no Homebrew tap
  # juggling (the brew formula pulls in a second tap that must be trusted).
  if curl -sSfL https://get.tur.so/install.sh | bash; then
    export PATH="$HOME/.turso:$PATH"
  fi
  if ! command -v turso >/dev/null; then
    brew tap libsql/sqld >/dev/null 2>&1 || true
    brew trust libsql/sqld >/dev/null 2>&1 || true
    brew install tursodatabase/tap/turso
  fi
fi

# -------------------------------------------------------------- 1. GitHub
if ! gh auth status >/dev/null 2>&1; then
  bold "Sign in to GitHub"
  note "gh will show a one-time code and WAIT for you to press Enter."
  note "Press Enter, paste the code into the browser tab that opens, click Authorize."
  note "(If it asks 'Authenticate Git with your GitHub credentials?', answer Y.)"
  gh auth login --web --git-protocol https --scopes repo,workflow
elif ! { gh auth status 2>&1 || true; } | grep workflow >/dev/null; then
  # Pushing .github/workflows needs the "workflow" scope.
  bold "GitHub needs one more permission (workflow) — click Authorize again"
  gh auth refresh -h github.com -s repo,workflow
fi
GH_USER="$(gh api user -q .login)"
REPO_URL="https://github.com/$GH_USER/$REPO_NAME"

bold "Pushing the code to $REPO_URL"
[ -d .git ] || git init -q -b main
# The push is ~1 MB (the photos). Above Git's default 1 MB buffer it switches
# to chunked uploads, which some office proxies reject with HTTP 400.
git config http.postBuffer 157286400
# Git needs a name on the commit; use the GitHub one if none is configured.
git config user.email >/dev/null || git config user.email "$GH_USER@users.noreply.github.com"
git config user.name  >/dev/null || git config user.name  "$GH_USER"
git add -A
if git diff --cached --quiet && git rev-parse HEAD >/dev/null 2>&1; then
  note "nothing new to commit"
else
  git commit -q -m "Metal Menagerie shop"
fi
BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo main)"
if gh repo view "$GH_USER/$REPO_NAME" >/dev/null 2>&1; then
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "$REPO_URL.git"
  git push -q -u origin "$BRANCH"
else
  # Public so that the keep-alive workflow gets unlimited free minutes.
  # The repository contains no secrets — those live in .env and on Render.
  gh repo create "$REPO_NAME" --public --source=. --remote=origin --push \
     --description "Handmade metal statues — online shop" >/dev/null
fi
note "done"

# ---------------------------------------------------------------- 2. Turso
if ! turso auth whoami >/dev/null 2>&1; then
  bold "Sign in to Turso (a browser tab opens — click Authorize)"
  turso auth login || turso auth signup
fi

bold "Creating the database on Turso"
# Oregon, to sit next to the Render service in the same region.
turso group create default --location aws-us-west-2 >/dev/null 2>&1 || true
turso db show "$REPO_NAME" >/dev/null 2>&1 || turso db create "$REPO_NAME" >/dev/null
TURSO_URL="$(turso db show "$REPO_NAME" --url)"
TURSO_TOKEN="$(turso db tokens create "$REPO_NAME")"
note "done"

# ------------------------------------------------------------- 3. Render
# (openssl rather than an endless /dev/urandom pipe: under `set -o pipefail`
#  the latter dies of SIGPIPE and would abort the script right here.)
ADMIN_PASSWORD="$(openssl rand -base64 48 | LC_ALL=C tr -dc 'a-zA-Z0-9' | cut -c1-16)"
DEPLOY_URL="https://render.com/deploy?repo=$REPO_URL"

cat <<EOF

======================================================================
  A Render tab is opening. Sign in with GitHub, then paste these three
  values into the boxes Render shows, and press "Deploy Blueprint".
======================================================================

  ADMIN_PASSWORD      $ADMIN_PASSWORD      (your admin login — keep it)
  TURSO_DATABASE_URL  $TURSO_URL
  TURSO_AUTH_TOKEN    $TURSO_TOKEN

  (If the tab did not open: $DEPLOY_URL )

EOF
open "$DEPLOY_URL" 2>/dev/null || true

# ---------------------------------------------------- 4. keep-alive hookup
bold "Last step: the shop's address"
note "When Render finishes (2-3 minutes) it shows an address like"
note "https://metal-menagerie.onrender.com — paste it here."
printf '    Address: '
read -r APP_URL
APP_URL="$(printf '%s' "$APP_URL" | tr -d '[:space:]')"
APP_URL="${APP_URL%/}"
case "$APP_URL" in
  http://*|https://*|'') ;;
  *) APP_URL="https://$APP_URL" ;;
esac
if [ -n "$APP_URL" ]; then
  gh variable set APP_URL --body "$APP_URL" --repo "$GH_USER/$REPO_NAME"
  gh workflow run keepalive.yml --repo "$GH_USER/$REPO_NAME" >/dev/null 2>&1 || true
  note "keep-alive enabled: GitHub pings $APP_URL/healthz every 5 minutes"
fi

cat <<EOF

======================================================================
  Done.
    Shop    ${APP_URL:-https://<your-service>.onrender.com}
    Admin   ${APP_URL:-https://<your-service>.onrender.com}/admin
    Code    $REPO_URL

  Admin password: $ADMIN_PASSWORD   (also stored on Render → Environment)
======================================================================
EOF
