#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

if grep -q '^WHATSAPP_HISTORY_SYNC_DAYS=' .env; then
  sed -i 's/^WHATSAPP_HISTORY_SYNC_DAYS=.*/WHATSAPP_HISTORY_SYNC_DAYS=0/' .env
else
  printf '\nWHATSAPP_HISTORY_SYNC_DAYS=0\n' >> .env
fi

docker compose up -d --force-recreate baileys
echo "Modo de importação encerrado. As mensagens já importadas permanecem no Chatwoot."
