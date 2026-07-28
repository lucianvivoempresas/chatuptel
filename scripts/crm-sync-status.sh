#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

ADMIN_TOKEN=$(sed -n 's/^BAILEYS_ADMIN_TOKEN=//p' .env | tail -n 1)
ADMIN_TOKEN=$(printf '%s' "$ADMIN_TOKEN" | sed 's/^"//;s/"$//')

curl --fail --silent --show-error \
  "http://127.0.0.1:3001/crm-sync/status?token=${ADMIN_TOKEN}"
printf '\n'
