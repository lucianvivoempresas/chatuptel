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

configure_output=$(docker compose exec -T \
  -e CHATWOOT_ACCOUNT_ID="$CHATWOOT_ACCOUNT_ID" \
  -e BAILEYS_ADMIN_TOKEN="$BAILEYS_ADMIN_TOKEN" \
  rails bundle exec rails runner '
account_id = ENV.fetch("CHATWOOT_ACCOUNT_ID").to_i
account_user = AccountUser.find_by!(account_id: account_id, role: :administrator)
access_token = account_user.user.access_token || AccessToken.create!(owner: account_user.user)
webhook_url = "http://baileys:3001/webhooks/chatwoot?token=#{ENV.fetch("BAILEYS_ADMIN_TOKEN")}"

legacy_webhooks = Webhook.where(account_id: account_id).where("LOWER(url) LIKE ?", "%wppconnect%")
legacy_count = legacy_webhooks.count
legacy_webhooks.destroy_all

webhook = Webhook.find_or_initialize_by(account_id: account_id, url: webhook_url)
webhook.subscriptions = ["message_created"]
webhook.save!

puts "#{legacy_count} webhook(s) antigo(s) do WPPConnect removido(s)." if legacy_count.positive?
puts "Webhook do Chatwoot configurado automaticamente."
puts "CHATWOOT_TOKEN=#{access_token.token}"
')

new_chatwoot_token=$(printf '%s\n' "$configure_output" | sed -n 's/^CHATWOOT_TOKEN=//p' | tail -n 1)
if [ -z "$new_chatwoot_token" ]; then
  echo "Não foi possível obter um token válido do Chatwoot." >&2
  exit 1
fi

env_file_tmp="${PROJECT_DIR}/.env.baileys.tmp"
awk -v token="$new_chatwoot_token" '
  BEGIN { replaced = 0 }
  /^CHATWOOT_API_TOKEN=/ {
    print "CHATWOOT_API_TOKEN=" token
    replaced = 1
    next
  }
  { print }
  END {
    if (!replaced) print "CHATWOOT_API_TOKEN=" token
  }
' .env > "$env_file_tmp"
mv "$env_file_tmp" .env
chmod 600 .env

printf '%s\n' "$configure_output" | sed '/^CHATWOOT_TOKEN=/d'

docker compose up -d --force-recreate baileys

attempt=0
until curl --fail --silent http://127.0.0.1:3001/health >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then
    echo "O gateway não reiniciou após atualizar o token. Últimos logs:" >&2
    docker compose logs --tail=100 baileys >&2
    exit 1
  fi
  sleep 2
done

echo
echo "Gateway Baileys instalado. Escaneie o QR Code abaixo:"
echo
./scripts/baileys-qr.sh
