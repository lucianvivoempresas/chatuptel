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
CHATWOOT_BOT_USER_ID=$(read_env CHATWOOT_BOT_USER_ID)

if [ -z "$CHATWOOT_ACCOUNT_ID" ] || [ -z "$CHATWOOT_INBOX_ID" ]; then
  echo "Erro: CHATWOOT_ACCOUNT_ID e CHATWOOT_INBOX_ID precisam estar no .env." >&2
  exit 1
fi

docker compose exec -T \
  -e CHATWOOT_ACCOUNT_ID="$CHATWOOT_ACCOUNT_ID" \
  -e CHATWOOT_INBOX_ID="$CHATWOOT_INBOX_ID" \
  -e CHATWOOT_BOT_USER_ID="${CHATWOOT_BOT_USER_ID:-0}" \
  rails bundle exec rails runner '
account = Account.find(ENV.fetch("CHATWOOT_ACCOUNT_ID").to_i)
inbox = account.inboxes.find(ENV.fetch("CHATWOOT_INBOX_ID").to_i)
bot_user_id = ENV.fetch("CHATWOOT_BOT_USER_ID", "0").to_i

ActiveRecord::Base.transaction do
  inbox.update!(
    enable_auto_assignment: true,
    lock_to_single_conversation: true
  )

  missing_member_ids = account.users.ids - inbox.members.ids
  inbox.add_members(missing_member_ids) if missing_member_ids.any?

  human_memberships = account.account_users.joins(:user)
    .where.not(users: { email: "assistente-chat@voltconect.com.br" })
  human_memberships = human_memberships.where.not(user_id: bot_user_id) if bot_user_id.positive?
  human_memberships.find_each do |membership|
    membership.update!(availability: :online, auto_offline: false)
  end
end

puts "Equipe configurada para a caixa: #{inbox.name}"
puts "Distribuição automática: #{inbox.enable_auto_assignment ? "ATIVA" : "INATIVA"}"
puts "Uma conversa ativa por contato: #{inbox.lock_to_single_conversation ? "ATIVA" : "INATIVA"}"
puts
puts "USUÁRIOS:"
account.account_users.includes(:user).order(:role, :id).each do |membership|
  in_inbox = inbox.members.exists?(membership.user_id) ? "sim" : "não"
  puts "- #{membership.user.name} | #{membership.user.email} | #{membership.role} | caixa=#{in_inbox}"
end
'

cat <<'TEXT'

Regras de operação:
1. Agentes humanos permanecem Online e não são desligados automaticamente.
2. O Chatwoot distribuirá novas conversas entre os agentes humanos.
3. O agente atribuído aparece como responsável pela conversa.
4. Antes de responder uma conversa de outro agente, faça a transferência no painel.

Observação: a Community Edition não bloqueia tecnicamente a resposta de outro
membro que tenha acesso à mesma caixa. A atribuição define o responsável e
evita conflito operacional, mas administradores ainda conseguem intervir.
TEXT
