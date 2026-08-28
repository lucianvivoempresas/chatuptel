#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

if [ "$#" -lt 1 ]; then
  echo "Uso: $0 TELEFONE [TELEFONE...]" >&2
  echo "Exemplo: $0 5571999999999 5573999999999" >&2
  exit 1
fi

ADMIN_TOKEN=$(sed -n 's/^BAILEYS_ADMIN_TOKEN=//p' .env | tail -n 1)
ADMIN_TOKEN=$(printf '%s' "$ADMIN_TOKEN" | sed 's/^"//;s/"$//')

for raw_phone in "$@"; do
  phone=$(printf '%s' "$raw_phone" | tr -cd '0-9')
  if [ -z "$phone" ]; then
    echo "Telefone inválido: $raw_phone" >&2
    exit 1
  fi
  curl --fail --silent --show-error \
    -X POST \
    -H 'Content-Type: application/json' \
    --data "{\"phones\":[\"${phone}\"]}" \
    "http://127.0.0.1:3001/admin/test-chats/reset?token=${ADMIN_TOKEN}"
  printf '\n'
done

echo "Estado do assistente reiniciado somente para os telefones de teste informados."
