#!/usr/bin/env sh
set -eu
umask 077

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

echo "Esta operação exigirá um novo QR Code do WhatsApp."
echo "Antes de continuar, remova no celular o dispositivo antigo do Uptel Conecta."
printf 'Digite IMPORTAR para criar backup e preparar 30 dias de histórico: '
IFS= read -r CONFIRMATION
[ "$CONFIRMATION" = IMPORTAR ] || { echo "Operação cancelada."; exit 1; }

./deploy/backup.sh

if grep -q '^WHATSAPP_HISTORY_SYNC_DAYS=' .env; then
  sed -i 's/^WHATSAPP_HISTORY_SYNC_DAYS=.*/WHATSAPP_HISTORY_SYNC_DAYS=30/' .env
else
  printf '\nWHATSAPP_HISTORY_SYNC_DAYS=30\n' >> .env
fi

BAILEYS_CONTAINER=$(docker compose ps -a -q baileys)
if [ -z "$BAILEYS_CONTAINER" ]; then
  echo "Contêiner Baileys não encontrado." >&2
  exit 1
fi

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
RESTART_REQUIRED=true
cleanup() {
  if [ "$RESTART_REQUIRED" = true ]; then
    docker compose up -d baileys >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM

docker compose stop -t 20 baileys >/dev/null
docker run --rm --volumes-from "${BAILEYS_CONTAINER}" redis:7-alpine sh -c \
  "if [ -d /data/auth ]; then mv /data/auth /data/auth-before-history-${TIMESTAMP}; fi; mkdir -p /data/auth"
docker compose up -d --build baileys
RESTART_REQUIRED=false

echo
echo "Importação preparada. Aguarde o QR ficar disponível e execute:"
echo "  ./scripts/baileys-qr.sh"
echo
echo "Depois acompanhe com:"
echo "  ./scripts/history-status.sh"
