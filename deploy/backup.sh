#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
BACKUP_DIR="${PROJECT_DIR}/backups"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$BACKUP_DIR"
cd "$PROJECT_DIR"

docker compose exec -T postgres pg_dump -U chatwoot -d chatwoot \
  | gzip > "${BACKUP_DIR}/chatwoot-${TIMESTAMP}.sql.gz"

echo "Backup criado: ${BACKUP_DIR}/chatwoot-${TIMESTAMP}.sql.gz"
echo "Copie-o para armazenamento externo criptografado."
