#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
BACKUP_DIR="${PROJECT_DIR}/backups"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$BACKUP_DIR"
cd "$PROJECT_DIR"

docker compose exec -T postgres pg_dump -U chatwoot -d chatwoot \
  | gzip > "${BACKUP_DIR}/chatwoot-${TIMESTAMP}.sql.gz"

docker compose run --rm --no-deps \
  -v "${BACKUP_DIR}:/backup" \
  baileys tar -czf "/backup/baileys-${TIMESTAMP}.tar.gz" -C /data .

echo "Backups criados em: ${BACKUP_DIR}"
echo "O backup do Baileys contém a sessão do WhatsApp. Proteja-o e copie-o para armazenamento externo criptografado."
