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

# Identidade da instalação. Os arquivos são fornecidos pelo volume
# /app/public/brand-assets definido no docker-compose.yml.
brand_settings = {
  "INSTALLATION_NAME" => "Uptel Conecta",
  "BRAND_NAME" => "Uptel Conecta",
  "BRAND_URL" => "https://www.voltconect.com.br",
  "WIDGET_BRAND_URL" => "https://www.voltconect.com.br",
  "LOGO" => "/brand-assets/logo.svg",
  "LOGO_DARK" => "/brand-assets/logo_dark.svg",
  "LOGO_THUMBNAIL" => "/brand-assets/logo_thumbnail.svg",
  "DISPLAY_MANIFEST" => false
}
brand_settings.each do |name, value|
  setting = InstallationConfig.find_or_initialize_by(name: name)
  setting.value = value
  setting.save!
end
account.update!(name: "Uptel Conecta") unless account.name == "Uptel Conecta"

# Contas criadas antes da carga das configurações da instalação podem ficar
# com todas as funcionalidades ocultas no painel. Reaplica somente os recursos
# que a própria instalação marca como habilitados por padrão.
feature_config = InstallationConfig.find_by(name: "ACCOUNT_LEVEL_FEATURE_DEFAULTS")
default_features =
  if feature_config&.value.is_a?(Array)
    feature_config.value.filter_map do |feature|
      name = feature["name"] || feature[:name]
      enabled = feature["enabled"].nil? ? feature[:enabled] : feature["enabled"]
      name if enabled
    end
  else
    Featurable::FEATURE_LIST.select { |feature| feature["enabled"] }.pluck("name")
  end
account.enable_features!(*default_features)

bot_user = User.find_or_initialize_by(email: "assistente-chat@voltconect.com.br")
bot_user.name = "Assistente Uptel Conecta"
if bot_user.new_record?
  password = "Aa1!#{SecureRandom.hex(28)}"
  bot_user.password = password
  bot_user.password_confirmation = password
end
bot_user.skip_confirmation!
bot_user.skip_confirmation_notification!
bot_user.save!
bot_membership = AccountUser.find_or_initialize_by(account: account, user: bot_user)
bot_membership.role = :agent
bot_membership.availability = :offline
bot_membership.auto_offline = true
bot_membership.save!
bot_access_token = bot_user.access_token || AccessToken.create!(owner: bot_user)

administrator = account.account_users
  .where(role: AccountUser.roles[:administrator])
  .includes(:user)
  .first
raise "A conta não possui um administrador" unless administrator

admin_access_token = administrator.user.access_token ||
  AccessToken.create!(owner: administrator.user)
webhook_url = "http://baileys:3001/webhooks/chatwoot?token=#{ENV.fetch("BAILEYS_ADMIN_TOKEN")}"

requested_inbox_id = ENV.fetch("CHATWOOT_INBOX_ID", "").to_i
inbox = account.inboxes.where(channel_type: "Channel::Api").find_by(name: "WhatsApp Uptel Conecta")
inbox ||= account.inboxes.where(channel_type: "Channel::Api").find_by(name: "WhatsApp Volt Conect")
inbox ||= account.inboxes.where(channel_type: "Channel::Api").find_by(id: requested_inbox_id) if requested_inbox_id.positive?

unless inbox
  channel = Channel::Api.create!(account: account)
  inbox = Inbox.create!(account: account, channel: channel, name: "WhatsApp Uptel Conecta")
end
inbox.update!(name: "WhatsApp Uptel Conecta") unless inbox.name == "WhatsApp Uptel Conecta"

missing_member_ids = account.users.ids - inbox.members.ids
inbox.add_members(missing_member_ids) if missing_member_ids.any?

legacy_webhooks = Webhook.where(account_id: account_id).where("LOWER(url) LIKE ?", "%wppconnect%")
legacy_count = legacy_webhooks.count
legacy_webhooks.destroy_all

webhook = Webhook.find_or_initialize_by(account_id: account_id, url: webhook_url)
webhook.subscriptions = ["message_created"]
webhook.save!

puts "#{legacy_count} webhook(s) antigo(s) do WPPConnect removido(s)." if legacy_count.positive?
puts "Identidade visual Uptel Conecta aplicada."
puts "#{default_features.length} funcionalidades padrão da conta habilitadas."
puts "Webhook do Chatwoot configurado automaticamente."
puts "Caixa API #{inbox.name} configurada com ID #{inbox.id}."
puts "CHATWOOT_TOKEN=#{admin_access_token.token}"
puts "CHATWOOT_BOT_TOKEN=#{bot_access_token.token}"
puts "CHATWOOT_INBOX=#{inbox.id}"
puts "CHATWOOT_BOT_USER=#{bot_user.id}"
')

new_chatwoot_token=$(printf '%s\n' "$configure_output" | sed -n 's/^CHATWOOT_TOKEN=//p' | tail -n 1)
new_chatwoot_bot_token=$(printf '%s\n' "$configure_output" | sed -n 's/^CHATWOOT_BOT_TOKEN=//p' | tail -n 1)
new_chatwoot_inbox_id=$(printf '%s\n' "$configure_output" | sed -n 's/^CHATWOOT_INBOX=//p' | tail -n 1)
new_chatwoot_bot_user_id=$(printf '%s\n' "$configure_output" | sed -n 's/^CHATWOOT_BOT_USER=//p' | tail -n 1)
if [ -z "$new_chatwoot_token" ] || [ -z "$new_chatwoot_bot_token" ]; then
  echo "Não foi possível obter um token válido do Chatwoot." >&2
  exit 1
fi
if [ -z "$new_chatwoot_inbox_id" ]; then
  echo "Não foi possível criar ou localizar a caixa API do Chatwoot." >&2
  exit 1
fi
if [ -z "$new_chatwoot_bot_user_id" ]; then
  echo "Não foi possível criar a identidade técnica do Assistente." >&2
  exit 1
fi

env_file_tmp="${PROJECT_DIR}/.env.baileys.tmp"
awk -v token="$new_chatwoot_token" -v bot_token="$new_chatwoot_bot_token" -v inbox_id="$new_chatwoot_inbox_id" -v bot_user_id="$new_chatwoot_bot_user_id" '
  BEGIN { token_replaced = 0; bot_token_replaced = 0; inbox_replaced = 0; bot_user_replaced = 0 }
  /^CHATWOOT_API_TOKEN=/ {
    print "CHATWOOT_API_TOKEN=" token
    token_replaced = 1
    next
  }
  /^CHATWOOT_BOT_API_TOKEN=/ {
    print "CHATWOOT_BOT_API_TOKEN=" bot_token
    bot_token_replaced = 1
    next
  }
  /^CHATWOOT_INBOX_ID=/ {
    print "CHATWOOT_INBOX_ID=" inbox_id
    inbox_replaced = 1
    next
  }
  /^CHATWOOT_BOT_USER_ID=/ {
    print "CHATWOOT_BOT_USER_ID=" bot_user_id
    bot_user_replaced = 1
    next
  }
  { print }
  END {
    if (!token_replaced) print "CHATWOOT_API_TOKEN=" token
    if (!bot_token_replaced) print "CHATWOOT_BOT_API_TOKEN=" bot_token
    if (!inbox_replaced) print "CHATWOOT_INBOX_ID=" inbox_id
    if (!bot_user_replaced) print "CHATWOOT_BOT_USER_ID=" bot_user_id
  }
' .env > "$env_file_tmp"
mv "$env_file_tmp" .env
chmod 600 .env
CHATWOOT_API_TOKEN="$new_chatwoot_token"
CHATWOOT_BOT_API_TOKEN="$new_chatwoot_bot_token"
CHATWOOT_INBOX_ID="$new_chatwoot_inbox_id"
CHATWOOT_BOT_USER_ID="$new_chatwoot_bot_user_id"
export CHATWOOT_API_TOKEN CHATWOOT_BOT_API_TOKEN CHATWOOT_INBOX_ID CHATWOOT_BOT_USER_ID

printf '%s\n' "$configure_output" | sed '/^CHATWOOT_TOKEN=/d; /^CHATWOOT_BOT_TOKEN=/d; /^CHATWOOT_INBOX=/d; /^CHATWOOT_BOT_USER=/d'

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
