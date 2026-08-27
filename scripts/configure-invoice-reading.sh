#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE="$PROJECT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Erro: arquivo .env não encontrado em $PROJECT_DIR." >&2
  exit 1
fi

set_env() {
  key=$1
  value=$2
  temporary=$(mktemp "${ENV_FILE}.XXXXXX")
  awk -v key="$key" -v value="$value" '
    BEGIN { updated = 0 }
    $0 ~ ("^" key "=") {
      if (!updated) print key "=" value
      updated = 1
      next
    }
    { print }
    END { if (!updated) print key "=" value }
  ' "$ENV_FILE" > "$temporary"
  chmod --reference="$ENV_FILE" "$temporary" 2>/dev/null || chmod 600 "$temporary"
  mv "$temporary" "$ENV_FILE"
}

printf 'Cole a(s) chave(s) Gemini, separadas por vírgula (não serão exibidas): '
trap 'stty echo 2>/dev/null || true' EXIT INT TERM
stty -echo
IFS= read -r GEMINI_KEYS
stty echo
trap - EXIT INT TERM
printf '\n'

if [ -z "$GEMINI_KEYS" ]; then
  echo 'Nenhuma chave informada; configuração cancelada.' >&2
  exit 1
fi

set_env GEMINI_API_KEYS "$GEMINI_KEYS"
set_env GEMINI_INVOICE_MODEL "gemini-2.5-flash"
set_env ENERGY_INVOICE_MAX_BYTES "15728640"
chmod 600 "$ENV_FILE" 2>/dev/null || true

echo 'Chaves salvas no .env sem exibição no terminal.'
echo 'Recriando o gateway e configurando os campos do Chatwoot...'
cd "$PROJECT_DIR"
docker compose up -d --build baileys
./scripts/configure-qualification.sh
./scripts/baileys-status.sh
