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

CHATWOOT_ACCOUNT_ID=$(read_env CHATWOOT_ACCOUNT_ID)
CHATWOOT_INBOX_ID=$(read_env CHATWOOT_INBOX_ID)

if [ -z "$CHATWOOT_ACCOUNT_ID" ] || [ -z "$CHATWOOT_INBOX_ID" ]; then
  echo "Erro: CHATWOOT_ACCOUNT_ID e CHATWOOT_INBOX_ID precisam estar no .env." >&2
  exit 1
fi

configure_output=$(docker compose exec -T \
  -e CHATWOOT_ACCOUNT_ID="$CHATWOOT_ACCOUNT_ID" \
  -e CHATWOOT_INBOX_ID="$CHATWOOT_INBOX_ID" \
  rails bundle exec rails runner '
account = Account.find(ENV.fetch("CHATWOOT_ACCOUNT_ID").to_i)
inbox = account.inboxes.find(ENV.fetch("CHATWOOT_INBOX_ID").to_i)
email = "assistente-chat@voltconect.com.br"

ActiveRecord::Base.transaction do
  user = User.find_or_initialize_by(email: email)
  user.name = "Assistente Uptel Conecta"
  if user.new_record?
    password = SecureRandom.hex(32)
    user.password = password
    user.password_confirmation = password
  end
  user.skip_confirmation!
  user.skip_confirmation_notification!
  user.save!

  membership = AccountUser.find_or_initialize_by(account: account, user: user)
  membership.role = :agent
  membership.availability = :offline
  membership.auto_offline = true
  membership.save!

  inbox.add_members([user.id]) unless inbox.members.exists?(user.id)
  token = user.access_token || AccessToken.create!(owner: user)

  puts "BOT_USER_ID=#{user.id}"
  puts "BOT_TOKEN=#{token.token}"
end
')

bot_user_id=$(printf '%s\n' "$configure_output" | sed -n 's/^BOT_USER_ID=//p' | tail -n 1)
bot_token=$(printf '%s\n' "$configure_output" | sed -n 's/^BOT_TOKEN=//p' | tail -n 1)

if [ -z "$bot_user_id" ] || [ -z "$bot_token" ]; then
  echo "Erro: não foi possível criar a identidade técnica do Assistente." >&2
  exit 1
fi

env_file_tmp=$(mktemp "${PROJECT_DIR}/.env.bot.XXXXXX")
trap 'rm -f "$env_file_tmp"' EXIT INT TERM
awk -v token="$bot_token" -v bot_user_id="$bot_user_id" '
  BEGIN { token_replaced = 0; user_replaced = 0 }
  /^CHATWOOT_API_TOKEN=/ {
    print "CHATWOOT_API_TOKEN=" token
    token_replaced = 1
    next
  }
  /^CHATWOOT_BOT_USER_ID=/ {
    print "CHATWOOT_BOT_USER_ID=" bot_user_id
    user_replaced = 1
    next
  }
  { print }
  END {
    if (!token_replaced) print "CHATWOOT_API_TOKEN=" token
    if (!user_replaced) print "CHATWOOT_BOT_USER_ID=" bot_user_id
  }
' .env > "$env_file_tmp"
mv "$env_file_tmp" .env
trap - EXIT INT TERM
chmod 600 .env

docker compose up -d --build --force-recreate baileys

echo "Identidade técnica do Assistente configurada."
echo "NOME=Assistente Uptel Conecta"
echo "USUARIO_ID=${bot_user_id}"
echo "O token foi salvo com segurança no .env e não foi exibido."
