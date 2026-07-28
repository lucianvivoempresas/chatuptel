#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  echo "Erro: arquivo .env não encontrado em ${PROJECT_DIR}." >&2
  exit 1
fi

read_env() {
  sed -n "s/^${1}=//p" .env | tail -n 1 | sed 's/^"//;s/"$//'
}

BAILEYS_ADMIN_TOKEN=$(read_env BAILEYS_ADMIN_TOKEN)
if [ -z "$BAILEYS_ADMIN_TOKEN" ]; then
  BAILEYS_ADMIN_TOKEN=$(openssl rand -hex 32)
  printf '\nBAILEYS_ADMIN_TOKEN=%s\n' "$BAILEYS_ADMIN_TOKEN" >> .env
  chmod 600 .env
  echo "Token seguro do Baileys criado no .env."
fi

CHATWOOT_ACCOUNT_ID=$(read_env CHATWOOT_ACCOUNT_ID)
CHATWOOT_INBOX_ID=$(read_env CHATWOOT_INBOX_ID)
CHATWOOT_API_TOKEN=$(read_env CHATWOOT_API_TOKEN)

for variable_name in CHATWOOT_ACCOUNT_ID CHATWOOT_INBOX_ID CHATWOOT_API_TOKEN; do
  eval "variable_value=\${$variable_name:-}"
  if [ -z "$variable_value" ]; then
    echo "Erro: preencha ${variable_name} no .env antes de continuar." >&2
    exit 1
  fi
done

export BAILEYS_ADMIN_TOKEN CHATWOOT_ACCOUNT_ID CHATWOOT_INBOX_ID CHATWOOT_API_TOKEN

chmod +x scripts/*.sh deploy/*.sh
docker compose config --quiet
docker compose up -d --build --remove-orphans baileys

attempt=0
until curl --fail --silent http://127.0.0.1:3001/health >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then
    echo "O gateway não iniciou. Últimos logs:" >&2
    docker compose logs --tail=100 baileys >&2
    exit 1
  fi
  sleep 2
done

python3 - <<'PY'
import json
import os
import urllib.request

account_id = os.environ["CHATWOOT_ACCOUNT_ID"]
api_token = os.environ["CHATWOOT_API_TOKEN"]
baileys_token = os.environ["BAILEYS_ADMIN_TOKEN"]
base_url = f"http://127.0.0.1:3100/api/v1/accounts/{account_id}/webhooks"
webhook_url = (
    "http://baileys:3001/webhooks/chatwoot?token=" + baileys_token
)

def request(url, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "api_access_token": api_token,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.loads(response.read() or b"{}")

existing = request(base_url)
items = existing.get("payload", existing) if isinstance(existing, dict) else existing
old_webhooks = [
    item for item in items
    if "wppconnect" in (item.get("url") or "").lower()
]
for item in old_webhooks:
    request(f"{base_url}/{item['id']}", method="DELETE")
if old_webhooks:
    print(f"{len(old_webhooks)} webhook(s) antigo(s) do WPPConnect removido(s).")

if not any(item.get("url") == webhook_url for item in items):
    request(
        base_url,
        method="POST",
        payload={"url": webhook_url, "subscriptions": ["message_created"]},
    )
    print("Webhook do Chatwoot criado automaticamente.")
else:
    print("Webhook do Chatwoot já estava configurado.")
PY

echo
echo "Gateway Baileys instalado. Escaneie o QR Code abaixo:"
echo
./scripts/baileys-qr.sh
