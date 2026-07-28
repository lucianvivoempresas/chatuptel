#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  echo "Arquivo .env não encontrado." >&2
  exit 1
fi

ADMIN_TOKEN=$(sed -n 's/^BAILEYS_ADMIN_TOKEN=//p' .env | tail -n 1)
ADMIN_TOKEN=$(printf '%s' "$ADMIN_TOKEN" | sed 's/^"//;s/"$//')
if [ -z "$ADMIN_TOKEN" ]; then
  echo "BAILEYS_ADMIN_TOKEN não definido no .env." >&2
  exit 1
fi

curl --fail --silent --show-error \
  "http://127.0.0.1:3001/qr.ansi?token=${ADMIN_TOKEN}"
