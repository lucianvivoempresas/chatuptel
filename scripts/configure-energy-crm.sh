#!/usr/bin/env sh
set -eu

CHAT_PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
CRM_PROJECT_DIR=${1:-}

if [ -z "$CRM_PROJECT_DIR" ]; then
  echo "Uso: ./scripts/configure-energy-crm.sh /caminho/do/crm-server" >&2
  exit 1
fi

CRM_PROJECT_DIR=$(CDPATH='' cd -- "$CRM_PROJECT_DIR" && pwd)
CHAT_ENV="$CHAT_PROJECT_DIR/.env"
CRM_ENV="$CRM_PROJECT_DIR/.env"

if [ ! -f "$CHAT_ENV" ]; then
  echo "Arquivo não encontrado: $CHAT_ENV" >&2
  exit 1
fi
if [ ! -f "$CRM_PROJECT_DIR/server.js" ]; then
  echo "O diretório informado não parece ser o crm-server: $CRM_PROJECT_DIR" >&2
  exit 1
fi
if [ ! -f "$CRM_ENV" ]; then
  touch "$CRM_ENV"
  chmod 600 "$CRM_ENV"
fi

set_env() {
  file=$1
  key=$2
  value=$3
  temporary=$(mktemp "${file}.XXXXXX")
  awk -v key="$key" -v value="$value" '
    BEGIN { updated = 0 }
    $0 ~ ("^" key "=") {
      if (!updated) print key "=" value
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) print key "=" value
    }
  ' "$file" > "$temporary"
  chmod --reference="$file" "$temporary" 2>/dev/null || chmod 600 "$temporary"
  mv "$temporary" "$file"
}

TOKEN=$(sed -n 's/^CHATWOOT_INTEGRATION_TOKEN=//p' "$CRM_ENV" | tail -n 1)
TOKEN=$(printf '%s' "$TOKEN" | sed 's/^"//;s/"$//')
if [ "${#TOKEN}" -lt 32 ]; then
  TOKEN=$(openssl rand -hex 32)
fi

set_env "$CRM_ENV" CHATWOOT_INTEGRATION_TOKEN "$TOKEN"
set_env "$CRM_ENV" CHATWOOT_PUBLIC_URL "https://chat.voltconect.com.br"
set_env "$CHAT_ENV" ENERGIA_CRM_URL "http://host.docker.internal:3000"
set_env "$CHAT_ENV" ENERGIA_CRM_INTEGRATION_TOKEN "$TOKEN"

echo "Integração configurada nos dois arquivos .env."
echo "O segredo não foi exibido no terminal."
echo
echo "Reinicie o CRM:"
echo "  cd $CRM_PROJECT_DIR && pm2 reload crm-server --update-env"
echo
echo "Recrie o gateway:"
echo "  cd $CHAT_PROJECT_DIR && docker compose up -d --build baileys"
