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
  -e CHATWOOT_INBOX_ID="$CHATWOOT_INBOX_ID" \
  -e BAILEYS_ADMIN_TOKEN="$BAILEYS_ADMIN_TOKEN" \
  rails bundle exec rails runner '
account_id = ENV.fetch("CHATWOOT_ACCOUNT_ID").to_i
account = Account.find(account_id)
account_user = account.account_users.find_by!(role: :administrator)
access_token = account_user.user.access_token || AccessToken.create!(owner: account_user.user)
webhook_url = "http://baileys:3001/webhooks/chatwoot?token=#{ENV.fetch("BAILEYS_ADMIN_TOKEN")}"

requested_inbox_id = ENV.fetch("CHATWOOT_INBOX_ID", "").to_i
inbox = account.inboxes.where(channel_type: "Channel::Api").find_by(name: "WhatsApp Volt Conect")
inbox ||= account.inboxes.where(channel_type: "Channel::Api").find_by(id: requested_inbox_id) if requested_inbox_id.positive?

unless inbox
  channel = Channel::Api.create!(account: account)
  inbox = Inbox.create!(account: account, channel: channel, name: "WhatsApp Volt Conect")
end

missing_member_ids = account.users.ids - inbox.members.ids
inbox.add_members(missing_member_ids) if missing_member_ids.any?

legacy_webhooks = Webhook.where(account_id: account_id).where("LOWER(url) LIKE ?", "%wppconnect%")
legacy_count = legacy_webhooks.count
legacy_webhooks.destroy_all

webhook = Webhook.find_or_initialize_by(account_id: account_id, url: webhook_url)
webhook.subscriptions = ["message_created"]
webhook.save!

puts "#{legacy_count} webhook(s) antigo(s) do WPPConnect removido(s)." if legacy_count.positive?
puts "Webhook do Chatwoot configurado automaticamente."
puts "Caixa API #{inbox.name} configurada com ID #{inbox.id}."
puts "CHATWOOT_TOKEN=#{access_token.token}"
puts "CHATWOOT_INBOX=#{inbox.id}"
')

new_chatwoot_token=$(printf '%s\n' "$configure_output" | sed -n 's/^CHATWOOT_TOKEN=//p' | tail -n 1)
new_chatwoot_inbox_id=$(printf '%s\n' "$configure_output" | sed -n 's/^CHATWOOT_INBOX=//p' | tail -n 1)
if [ -z "$new_chatwoot_token" ]; then
  echo "Não foi possível obter um token válido do Chatwoot." >&2
  exit 1
fi
if [ -z "$new_chatwoot_inbox_id" ]; then
  echo "Não foi possível criar ou localizar a caixa API do Chatwoot." >&2
  exit 1
fi

env_file_tmp="${PROJECT_DIR}/.env.baileys.tmp"
awk -v token="$new_chatwoot_token" -v inbox_id="$new_chatwoot_inbox_id" '
  BEGIN { token_replaced = 0; inbox_replaced = 0 }
  /^CHATWOOT_API_TOKEN=/ {
    print "CHATWOOT_API_TOKEN=" token
    token_replaced = 1
    next
  }
  /^CHATWOOT_INBOX_ID=/ {
    print "CHATWOOT_INBOX_ID=" inbox_id
    inbox_replaced = 1
    next
  }
  { print }
  END {
    if (!token_replaced) print "CHATWOOT_API_TOKEN=" token
    if (!inbox_replaced) print "CHATWOOT_INBOX_ID=" inbox_id
  }
' .env > "$env_file_tmp"
mv "$env_file_tmp" .env
chmod 600 .env
CHATWOOT_API_TOKEN="$new_chatwoot_token"
CHATWOOT_INBOX_ID="$new_chatwoot_inbox_id"
export CHATWOOT_API_TOKEN CHATWOOT_INBOX_ID

printf '%s\n' "$configure_output" | sed '/^CHATWOOT_TOKEN=/d; /^CHATWOOT_INBOX=/d'

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

gateway_status=$(./scripts/baileys-status.sh)
if printf '%s' "$gateway_status" | grep -q '"status":"connected"'; then
  echo
  echo "Gateway Baileys instalado e WhatsApp conectado."
  printf '%s\n' "$gateway_status"
else
  echo
  echo "Gateway Baileys instalado. Escaneie o QR Code abaixo:"
  echo
  ./scripts/baileys-qr.sh
fi
