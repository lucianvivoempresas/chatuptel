#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  echo "Erro: arquivo .env não encontrado em ${PROJECT_DIR}." >&2
  exit 1
fi

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "Uso: sh ./scripts/create-agent.sh \"Nome\" \"email@empresa.com\" [agent|administrator]" >&2
  exit 1
fi

AGENT_NAME=$1
AGENT_EMAIL=$2
AGENT_ROLE=${3:-agent}

if [ "$AGENT_ROLE" != "agent" ] && [ "$AGENT_ROLE" != "administrator" ]; then
  echo "Erro: o papel deve ser agent ou administrator." >&2
  exit 1
fi
CHATWOOT_ACCOUNT_ID=$(sed -n 's/^CHATWOOT_ACCOUNT_ID=//p' .env | tail -n 1 | sed 's/^"//;s/"$//')
CHATWOOT_INBOX_ID=$(sed -n 's/^CHATWOOT_INBOX_ID=//p' .env | tail -n 1 | sed 's/^"//;s/"$//')

if [ -z "$CHATWOOT_ACCOUNT_ID" ] || [ -z "$CHATWOOT_INBOX_ID" ]; then
  echo "Erro: CHATWOOT_ACCOUNT_ID e CHATWOOT_INBOX_ID precisam estar no .env." >&2
  exit 1
fi

printf 'Digite a senha temporária do agente: '
stty -echo
trap 'stty echo' EXIT INT TERM
IFS= read -r AGENT_PASSWORD
stty echo
trap - EXIT INT TERM
printf '\n'

printf 'Confirme a senha temporária: '
stty -echo
trap 'stty echo' EXIT INT TERM
IFS= read -r AGENT_PASSWORD_CONFIRMATION
stty echo
trap - EXIT INT TERM
printf '\n'

if [ "$AGENT_PASSWORD" != "$AGENT_PASSWORD_CONFIRMATION" ]; then
  echo "Erro: as senhas não coincidem." >&2
  exit 1
fi

if [ -z "$AGENT_PASSWORD" ]; then
  echo "Erro: a senha não pode ficar vazia." >&2
  exit 1
fi

export AGENT_NAME AGENT_EMAIL AGENT_PASSWORD AGENT_ROLE CHATWOOT_ACCOUNT_ID CHATWOOT_INBOX_ID

docker compose exec -T \
  -e AGENT_NAME="$AGENT_NAME" \
  -e AGENT_EMAIL="$AGENT_EMAIL" \
  -e AGENT_PASSWORD="$AGENT_PASSWORD" \
  -e AGENT_ROLE="$AGENT_ROLE" \
  -e CHATWOOT_ACCOUNT_ID="$CHATWOOT_ACCOUNT_ID" \
  -e CHATWOOT_INBOX_ID="$CHATWOOT_INBOX_ID" \
  rails bundle exec rails runner '
account = Account.find(ENV.fetch("CHATWOOT_ACCOUNT_ID").to_i)
inbox = account.inboxes.find(ENV.fetch("CHATWOOT_INBOX_ID").to_i)
email = ENV.fetch("AGENT_EMAIL").strip.downcase

ActiveRecord::Base.transaction do
  user = User.find_or_initialize_by(email: email)
  user.name = ENV.fetch("AGENT_NAME").strip
  user.password = ENV.fetch("AGENT_PASSWORD")
  user.password_confirmation = ENV.fetch("AGENT_PASSWORD")
  user.skip_confirmation!
  user.skip_confirmation_notification!
  user.save!

  membership = AccountUser.find_or_initialize_by(account: account, user: user)
  membership.role = ENV.fetch("AGENT_ROLE", "agent")
  membership.availability = :online
  membership.auto_offline = false
  membership.save!

  inbox.add_members([user.id]) unless inbox.members.exists?(user.id)

  puts "Agente criado e confirmado."
  puts "NOME=#{user.name}"
  puts "EMAIL=#{user.email}"
  puts "PAPEL=#{membership.role}"
  puts "DISPONIBILIDADE=#{membership.availability}"
  puts "DESLIGAMENTO_AUTOMATICO=#{membership.auto_offline ? "ativo" : "inativo"}"
  puts "CAIXA=#{inbox.name}"
end
'

unset AGENT_PASSWORD AGENT_PASSWORD_CONFIRMATION

echo "O agente já pode entrar em https://chat.voltconect.com.br/app/login"
