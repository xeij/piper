#!/usr/bin/env bash
# Ship the working tree to an Ubuntu VM and (re)start it. Safe to re-run:
# the first run provisions the box, later runs just deploy new code.
#
#   deploy/deploy.sh <ssh-host>        e.g. deploy/deploy.sh piper
#
# Production env vars live in .env.production (gitignored) and are copied to
# the VM as .env. PUBLIC_BASE_URL in it decides the HTTPS hostname.
set -euo pipefail

HOST=${1:?usage: deploy/deploy.sh <ssh-host>}
cd "$(dirname "$0")/.."
[ -f .env.production ] || { echo "missing .env.production" >&2; exit 1; }

# Compile here: tsc needs more memory than a 1 GB VM has, and the output is plain JS.
npm run build --silent
ssh "$HOST" 'command -v rsync >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq rsync; }'
rsync -az --delete --exclude node_modules --exclude .git --exclude '.env*' ./ "$HOST:piper/"
scp -q .env.production "$HOST:piper/.env"
ssh "$HOST" 'chmod 600 piper/.env && bash piper/deploy/remote.sh'
