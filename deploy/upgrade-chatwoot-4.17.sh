#!/usr/bin/env sh
set -eu
umask 077

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  echo "ERRO: arquivo .env não encontrado em ${PROJECT_DIR}." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERRO: Docker não encontrado." >&2
  exit 1
fi

if command -v flock >/dev/null 2>&1; then
  exec 9>/var/lock/voltconnect-chat-upgrade.lock
  if ! flock -n 9; then
    echo "ERRO: outra atualização do Chatwoot está em andamento." >&2
    exit 1
  fi
fi

read_env() {
  sed -n "s/^${1}=//p" .env | tail -n 1 | sed 's/^"//;s/"$//'
}

write_env() {
  env_key=$1
  env_value=$2
  env_tmp=$(mktemp "${PROJECT_DIR}/.env.upgrade.XXXXXX")
  awk -v key="$env_key" -v value="$env_value" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 {
      print key "=" value
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) print key "=" value }
  ' .env > "$env_tmp"
  mv "$env_tmp" .env
  chmod 600 .env
}

wait_for_rails() {
  attempt=0
  while [ "$attempt" -lt 48 ]; do
    rails_container=$(docker compose ps -q rails 2>/dev/null || true)
    if [ -n "$rails_container" ]; then
      health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$rails_container" 2>/dev/null || true)
      if [ "$health" = "healthy" ]; then
        return 0
      fi
    fi
    attempt=$((attempt + 1))
    sleep 5
  done
  return 1
}

BACKUP_TIMER_WAS_ACTIVE=false
UPGRADE_FINISHED=false
SERVICES_PAUSED=false
BACKUP_ARCHIVE=''

cleanup() {
  exit_code=$?
  if [ "$BACKUP_TIMER_WAS_ACTIVE" = true ]; then
    systemctl start voltconnect-backup.timer >/dev/null 2>&1 || true
  fi
  if [ "$UPGRADE_FINISHED" != true ] && [ "$SERVICES_PAUSED" = true ]; then
    echo "Atualização interrompida. Tentando manter os serviços disponíveis na última etapa aplicada." >&2
    docker compose up -d rails sidekiq baileys >/dev/null 2>&1 || true
    if [ -n "$BACKUP_ARCHIVE" ]; then
      echo "Backup anterior à atualização: ${BACKUP_ARCHIVE}" >&2
    fi
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet voltconnect-backup.service 2>/dev/null; then
    echo "ERRO: há um backup em execução. Aguarde a conclusão e tente novamente." >&2
    exit 1
  fi
  if systemctl is-active --quiet voltconnect-backup.timer 2>/dev/null; then
    BACKUP_TIMER_WAS_ACTIVE=true
    systemctl stop voltconnect-backup.timer
  fi
fi

docker compose config --quiet

available_kb=$(df -Pk "$PROJECT_DIR" | awk 'NR == 2 { print $4 }')
if [ -z "$available_kb" ] || [ "$available_kb" -lt 4194304 ]; then
  echo "ERRO: são necessários pelo menos 4 GB livres para baixar imagens e migrar com segurança." >&2
  exit 1
fi

current_image=$(read_env CHATWOOT_IMAGE)
case "$current_image" in
  chatwoot/chatwoot:v4.9.2-ce|'') targets='v4.12.1-ce v4.16.2-ce v4.17.0-ce' ;;
  chatwoot/chatwoot:v4.12.1-ce) targets='v4.16.2-ce v4.17.0-ce' ;;
  chatwoot/chatwoot:v4.16.2-ce) targets='v4.17.0-ce' ;;
  chatwoot/chatwoot:v4.17.0-ce)
    echo "Chatwoot já está configurado na versão v4.17.0-ce."
    UPGRADE_FINISHED=true
    exit 0
    ;;
  *)
    echo "ERRO: versão de origem não homologada: ${current_image:-não informada}." >&2
    echo "Este atualizador aceita 4.9.2, 4.12.1 ou 4.16.2 Community." >&2
    exit 1
    ;;
esac

echo "Criando backup criptografado antes da atualização..."
backup_output=$(./deploy/backup.sh)
printf '%s\n' "$backup_output"
BACKUP_ARCHIVE=$(printf '%s\n' "$backup_output" | sed -n 's/^Backup concluído: //p' | tail -n 1)
if [ -z "$BACKUP_ARCHIVE" ] || [ ! -s "$BACKUP_ARCHIVE" ] || [ ! -s "${BACKUP_ARCHIVE}.sha256" ]; then
  echo "ERRO: o backup ou seu checksum não foi criado corretamente." >&2
  exit 1
fi
(cd "$(dirname "$BACKUP_ARCHIVE")" && sha256sum -c "$(basename "${BACKUP_ARCHIVE}.sha256")")

echo "Pausando atendimento durante as migrações..."
docker compose stop -t 30 baileys sidekiq rails
SERVICES_PAUSED=true

for version in $targets; do
  target_image="chatwoot/chatwoot:${version}"
  echo
  echo "Preparando ${target_image}..."

  CHATWOOT_IMAGE="$target_image" docker compose pull rails sidekiq
  write_env CHATWOOT_IMAGE "$target_image"

  docker compose run --rm rails bundle exec rails db:chatwoot_prepare
  docker compose up -d --force-recreate rails sidekiq

  if ! wait_for_rails; then
    echo "ERRO: Rails não ficou saudável após instalar ${version}." >&2
    docker compose logs --tail=200 rails sidekiq >&2 || true
    exit 1
  fi

  docker compose exec -T rails bundle exec rails runner '
    raise "Nenhuma conta encontrada" unless Account.exists?
    raise "Nenhuma caixa encontrada" unless Inbox.exists?
    puts "Banco e aplicação validados: contas=#{Account.count}, caixas=#{Inbox.count}"
  '
  echo "Etapa ${version} validada."

  if [ "$version" != "v4.17.0-ce" ]; then
    docker compose stop -t 30 sidekiq rails
  fi
done

echo "Reativando o gateway Baileys..."
docker compose up -d --build --force-recreate baileys

attempt=0
until curl --fail --silent http://127.0.0.1:3001/health >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "ERRO: Baileys não ficou saudável após a atualização." >&2
    docker compose logs --tail=200 baileys >&2 || true
    exit 1
  fi
  sleep 2
done

gateway_status=$(./scripts/baileys-status.sh)
printf '%s\n' "$gateway_status"
if ! printf '%s' "$gateway_status" | grep -q '"status":"connected"'; then
  echo "ERRO: Chatwoot foi atualizado, mas o WhatsApp não está conectado." >&2
  exit 1
fi

docker compose ps
UPGRADE_FINISHED=true
echo
echo "Atualização concluída com segurança para chatwoot/chatwoot:v4.17.0-ce."
echo "Backup de recuperação: ${BACKUP_ARCHIVE}"
