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
  awk -v key="$key" '
    $0 ~ ("^" key "=") {
      next
    }
    { print }
  ' "$ENV_FILE" > "$temporary"
  printf '%s=%s\n' "$key" "$value" >> "$temporary"
  chmod --reference="$ENV_FILE" "$temporary" 2>/dev/null || chmod 600 "$temporary"
  mv "$temporary" "$ENV_FILE"
}

printf 'Cole a chave da API OpenAI (não será exibida): '
trap 'stty echo 2>/dev/null || true' EXIT INT TERM
stty -echo
IFS= read -r OPENAI_KEY
stty echo
trap - EXIT INT TERM
printf '\n'

if [ -z "$OPENAI_KEY" ]; then
  echo 'Nenhuma chave informada; configuração cancelada.' >&2
  exit 1
fi

case "$OPENAI_KEY" in
  sk-*) ;;
  *)
    echo 'A chave informada não possui o prefixo esperado sk-. Configuração cancelada.' >&2
    exit 1
    ;;
esac

set_env OPENAI_API_KEY "$OPENAI_KEY"
set_env OPENAI_INVOICE_MODEL "gpt-4.1-mini"
set_env OPENAI_INVOICE_MAX_OUTPUT_TOKENS "800"
chmod 600 "$ENV_FILE" 2>/dev/null || true
unset OPENAI_KEY

echo 'Chave salva no .env sem exibição no terminal.'
echo 'Recriando apenas o gateway Baileys...'
cd "$PROJECT_DIR"
docker compose up -d --build baileys
./scripts/baileys-status.sh
