#!/usr/bin/env sh
set -eu
umask 077

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
BACKUP_DIR="${BACKUP_DIR:-${PROJECT_DIR}/backups}"
OPERATIONS_ENV="${OPERATIONS_ENV:-/etc/voltconnect-chat/operations.env}"
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/root/.config/voltconnect/backup.pass}"

if [ -f "$OPERATIONS_ENV" ]; then
  # Arquivo criado pelo instalador, legível somente pelo root.
  # shellcheck disable=SC1090
  . "$OPERATIONS_ENV"
fi

LOCAL_RETENTION_DAYS="${BACKUP_LOCAL_RETENTION_DAYS:-7}"
REMOTE_RETENTION_DAYS="${BACKUP_REMOTE_RETENTION_DAYS:-30}"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$BACKUP_DIR"
STAGE_DIR=$(mktemp -d "${BACKUP_DIR}/.stage.XXXXXX")
case "$STAGE_DIR" in
  "${BACKUP_DIR}"/.stage.*) ;;
  *) echo "ERRO: diretório temporário fora da pasta de backup." >&2; exit 1 ;;
esac
cleanup() {
  rm -rf -- "$STAGE_DIR"
}
trap cleanup EXIT HUP INT TERM

if [ ! -s "$PASSPHRASE_FILE" ]; then
  echo "ERRO: senha de backup ausente em $PASSPHRASE_FILE" >&2
  echo "Execute: sudo ./deploy/install-operations.sh" >&2
  exit 1
fi

cd "$PROJECT_DIR"
docker compose exec -T postgres pg_dump -U chatwoot -d chatwoot \
  | gzip -9 > "${STAGE_DIR}/postgres.sql.gz"
docker compose exec -T baileys tar -czf - -C /data . \
  > "${STAGE_DIR}/baileys-data.tar.gz"
docker compose exec -T rails tar -czf - -C /app/storage . \
  > "${STAGE_DIR}/chatwoot-storage.tar.gz"

cp docker-compose.yml "${STAGE_DIR}/docker-compose.yml"
git rev-parse HEAD > "${STAGE_DIR}/git-commit.txt" 2>/dev/null || true
ARCHIVE="${BACKUP_DIR}/voltconnect-chat-${TIMESTAMP}.tar.gz.enc"

tar -czf - -C "$STAGE_DIR" . \
  | openssl enc -aes-256-cbc -pbkdf2 -salt \
      -pass "file:${PASSPHRASE_FILE}" \
      -out "$ARCHIVE"
sha256sum "$ARCHIVE" > "${ARCHIVE}.sha256"

find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'voltconnect-chat-*.tar.gz.enc' -o -name 'voltconnect-chat-*.tar.gz.enc.sha256' \) \
  -mtime "+${LOCAL_RETENTION_DAYS}" -delete

EXTERNAL_OK=false
if [ -n "${BACKUP_EXTERNAL_DIR:-}" ]; then
  mkdir -p "$BACKUP_EXTERNAL_DIR"
  cp "$ARCHIVE" "${ARCHIVE}.sha256" "$BACKUP_EXTERNAL_DIR/"
  EXTERNAL_OK=true
fi

if [ -n "${BACKUP_REMOTE:-}" ]; then
  if ! command -v rclone >/dev/null 2>&1; then
    echo "ERRO: BACKUP_REMOTE configurado, mas rclone não está instalado." >&2
    exit 1
  fi
  rclone copy "$ARCHIVE" "${BACKUP_REMOTE%/}/"
  rclone copy "${ARCHIVE}.sha256" "${BACKUP_REMOTE%/}/"
  rclone delete "${BACKUP_REMOTE%/}/" \
    --min-age "${REMOTE_RETENTION_DAYS}d" \
    --include 'voltconnect-chat-*.tar.gz.enc*'
  EXTERNAL_OK=true
fi

if [ "$EXTERNAL_OK" != true ]; then
  echo "AVISO: backup criptografado criado apenas localmente; configure destino externo." >&2
fi

echo "Backup concluído: $ARCHIVE"
