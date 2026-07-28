#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"
ADMIN_TOKEN=$(sed -n 's/^BAILEYS_ADMIN_TOKEN=//p' .env | tail -n 1 | tr -d '\r')
ADMIN_TOKEN=$(printf '%s' "$ADMIN_TOKEN" | sed 's/^["'"'"']//;s/["'"'"']$//')

curl -fsS \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  http://127.0.0.1:3001/history/status
printf '\n'
