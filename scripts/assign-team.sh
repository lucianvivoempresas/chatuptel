#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  echo "Erro: arquivo .env não encontrado em ${PROJECT_DIR}." >&2
  exit 1
fi

if [ "$#" -ne 2 ]; then
  echo "Uso: sh ./scripts/assign-team.sh \"email@empresa.com\" \"vendas|energia|pos-venda\"" >&2
  exit 1
fi

AGENT_EMAIL=$1
TEAM_NAME=$2
CHATWOOT_ACCOUNT_ID=$(sed -n 's/^CHATWOOT_ACCOUNT_ID=//p' .env | tail -n 1 | sed 's/^"//;s/"$//')

if [ -z "$CHATWOOT_ACCOUNT_ID" ]; then
  echo "Erro: CHATWOOT_ACCOUNT_ID precisa estar no .env." >&2
  exit 1
fi

export AGENT_EMAIL TEAM_NAME CHATWOOT_ACCOUNT_ID

docker compose exec -T \
  -e AGENT_EMAIL="$AGENT_EMAIL" \
  -e TEAM_NAME="$TEAM_NAME" \
  -e CHATWOOT_ACCOUNT_ID="$CHATWOOT_ACCOUNT_ID" \
  rails bundle exec rails runner '
account = Account.find(ENV.fetch("CHATWOOT_ACCOUNT_ID").to_i)
email = ENV.fetch("AGENT_EMAIL").strip.downcase
team_name = ENV.fetch("TEAM_NAME").strip.downcase
user = account.users.find_by!(email: email)
team = account.teams.find_by!(name: team_name)

team.add_members([user.id]) unless team.members.exists?(user.id)

puts "Agente adicionado à equipe."
puts "AGENTE=#{user.name} (#{user.email})"
puts "EQUIPE=#{team.name}"
'
