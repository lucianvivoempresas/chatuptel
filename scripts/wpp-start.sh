#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  echo "Arquivo .env não encontrado. Copie .env.example e preencha os valores." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

required_vars="WPP_SESSION WPP_SECRET_KEY CHATWOOT_ACCOUNT_ID CHATWOOT_INBOX_ID CHATWOOT_API_TOKEN"
for variable_name in $required_vars; do
  eval "variable_value=\${$variable_name:-}"
  if [ -z "$variable_value" ]; then
    echo "Variável obrigatória ausente no .env: $variable_name" >&2
    exit 1
  fi
done

token_response=$(curl --fail --silent --show-error \
  --request POST \
  "http://127.0.0.1:21465/api/${WPP_SESSION}/${WPP_SECRET_KEY}/generate-token")

WPP_TOKEN=$(TOKEN_RESPONSE="$token_response" python3 -c \
  'import json, os; print(json.loads(os.environ["TOKEN_RESPONSE"])["token"])')
export WPP_TOKEN

request_body=$(python3 -c '
import json, os
print(json.dumps({
  "waitQrCode": True,
  "chatWoot": {
    "baseURL": "http://rails:3000/",
    "token": os.environ["CHATWOOT_API_TOKEN"],
    "account_id": int(os.environ["CHATWOOT_ACCOUNT_ID"]),
    "inbox_id": int(os.environ["CHATWOOT_INBOX_ID"]),
    "mobile_name": os.environ.get("WPP_DEVICE_NAME", "Volt Conect Atendimento"),
    "mobile_number": "5500000000000",
    "chatwoot": {"sendQrCode": True, "sendStatus": True}
  }
}))
')

curl --fail --silent --show-error \
  --request POST \
  "http://127.0.0.1:21465/api/${WPP_SESSION}/start-session" \
  --header "Authorization: Bearer ${WPP_TOKEN}" \
  --header "Content-Type: application/json" \
  --data "$request_body"

printf '\n'
echo "Sessão iniciada. Se o QR Code não apareceu no retorno, execute:"
echo "./scripts/wpp-status.sh"
echo
echo "Use esta URL interna no webhook message_created do Chatwoot:"
echo "http://wppconnect:21465/api/${WPP_SESSION}:${WPP_TOKEN}/chatwoot"
