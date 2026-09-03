#!/usr/bin/env sh
set -eu
umask 077

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
STATE_DIR="${PROJECT_DIR}/.whatsapp-instances"
REGISTRY="${STATE_DIR}/instances.tsv"
OVERRIDE="${STATE_DIR}/compose.yml"
MAX_TOTAL=20

usage() {
  cat <<'EOF'
Uso:
  ./scripts/whatsapp-instance.sh add <identificador> "<nome>" [email-do-vendedor]
  ./scripts/whatsapp-instance.sh list
  ./scripts/whatsapp-instance.sh status [identificador]
  ./scripts/whatsapp-instance.sh qr <identificador>
  ./scripts/whatsapp-instance.sh start <identificador>
  ./scripts/whatsapp-instance.sh stop <identificador>
  ./scripts/whatsapp-instance.sh refresh

O número principal existente usa o identificador "principal" apenas para status/QR.
Exemplo: ./scripts/whatsapp-instance.sh add vendas2 "Vendas 2" vendedor@empresa.com.br
EOF
}

read_env() {
  sed -n "s/^${1}=//p" "${PROJECT_DIR}/.env" | tail -n 1 | sed 's/^"//;s/"$//'
}

service_for() {
  if [ "$1" = principal ]; then printf '%s' baileys; else printf 'baileys-%s' "$1"; fi
}

compose_stack() {
  if [ -s "$OVERRIDE" ]; then
    docker compose -f "${PROJECT_DIR}/docker-compose.yml" -f "$OVERRIDE" "$@"
  else
    docker compose -f "${PROJECT_DIR}/docker-compose.yml" "$@"
  fi
}

validate_slug() {
  case "$1" in
    ''|principal|*[!a-z0-9-]*|-*|*-) echo "Identificador inválido. Use letras minúsculas, números e hífen." >&2; exit 1 ;;
  esac
  if [ "${#1}" -gt 32 ]; then
    echo "Identificador longo demais (máximo: 32 caracteres)." >&2
    exit 1
  fi
}

generate_compose() {
  mkdir -p "$STATE_DIR"
  {
    echo 'services:'
    if [ -s "$REGISTRY" ]; then
      while IFS="$(printf '\t')" read -r slug display_name inbox_id; do
        [ -n "$slug" ] || continue
        cat <<EOF
  baileys-${slug}:
    image: voltconnect-chat-baileys:local
    depends_on:
      rails:
        condition: service_healthy
    env_file:
      - ${PROJECT_DIR}/.env
      - ${STATE_DIR}/${slug}.env
    environment:
      PORT: 3001
      CHATWOOT_URL: http://rails:3000
      BAILEYS_AUTH_DIR: /data/auth
      BAILEYS_STATE_FILE: /data/state.json
      CHATWOOT_POLL_INTERVAL_MS: 15000
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - baileys-${slug}-data:/data
    networks:
      - app
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3001/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 10
      start_period: 20s
    restart: unless-stopped
EOF
      done < "$REGISTRY"
    fi
    echo 'volumes:'
    if [ -s "$REGISTRY" ]; then
      while IFS="$(printf '\t')" read -r slug display_name inbox_id; do
        [ -n "$slug" ] || continue
        echo "  baileys-${slug}-data:"
      done < "$REGISTRY"
    fi
  } > "${OVERRIDE}.tmp"
  mv "${OVERRIDE}.tmp" "$OVERRIDE"
  chmod 600 "$OVERRIDE"
}

require_instance() {
  slug=$1
  if [ "$slug" = principal ]; then return; fi
  if ! [ -s "$REGISTRY" ] || ! awk -F '\t' -v wanted="$slug" '$1 == wanted { found=1 } END { exit !found }' "$REGISTRY"; then
    echo "Número '${slug}' não cadastrado." >&2
    exit 1
  fi
}

inside_get() {
  service=$1
  endpoint=$2
  compose_stack exec -T "$service" node --input-type=module -e \
    'const r=await fetch(`http://127.0.0.1:3001/'"$endpoint"'?token=${encodeURIComponent(process.env.BAILEYS_ADMIN_TOKEN)}`); const body=await r.text(); if(!r.ok){console.error(body);process.exit(1)} process.stdout.write(body)'
}

command=${1:-}
case "$command" in
  add)
    slug=${2:-}
    display_name=${3:-}
    agent_email=${4:-}
    validate_slug "$slug"
    if [ -z "$display_name" ]; then usage >&2; exit 1; fi
    case "$display_name" in *"$(printf '\t')"*|*"
"*) echo "O nome não pode conter tabulação ou quebra de linha." >&2; exit 1 ;; esac
    cd "$PROJECT_DIR"
    [ -s .env ] || { echo "Arquivo .env ausente." >&2; exit 1; }
    mkdir -p "$STATE_DIR"
    touch "$REGISTRY"
    chmod 600 "$REGISTRY"
    if awk -F '\t' -v wanted="$slug" '$1 == wanted { found=1 } END { exit !found }' "$REGISTRY"; then
      echo "O identificador '${slug}' já existe." >&2
      exit 1
    fi
    extra_count=$(awk 'NF { count++ } END { print count+0 }' "$REGISTRY")
    if [ "$extra_count" -ge $((MAX_TOTAL - 1)) ]; then
      echo "Limite de ${MAX_TOTAL} números atingido (principal + adicionais)." >&2
      exit 1
    fi
    account_id=$(read_env CHATWOOT_ACCOUNT_ID)
    api_token=$(read_env CHATWOOT_API_TOKEN)
    bot_token=$(read_env CHATWOOT_BOT_API_TOKEN)
    bot_user_id=$(read_env CHATWOOT_BOT_USER_ID)
    [ -n "$account_id" ] && [ -n "$api_token" ] || { echo "CHATWOOT_ACCOUNT_ID/API_TOKEN ausentes." >&2; exit 1; }
    admin_token=$(openssl rand -hex 32)
    service="baileys-${slug}"
    webhook_url="http://${service}:3001/webhooks/chatwoot?token=${admin_token}"
    result=$(docker compose exec -T \
      -e INSTANCE_DISPLAY_NAME="$display_name" \
      -e INSTANCE_WEBHOOK_URL="$webhook_url" \
      -e INSTANCE_AGENT_EMAIL="$agent_email" \
      -e CHATWOOT_ACCOUNT_ID="$account_id" \
      rails bundle exec rails runner '
account = Account.find(ENV.fetch("CHATWOOT_ACCOUNT_ID").to_i)
name = "WhatsApp #{ENV.fetch("INSTANCE_DISPLAY_NAME")}"
raise "Já existe uma caixa chamada #{name}" if account.inboxes.exists?(name: name)
agent_email = ENV.fetch("INSTANCE_AGENT_EMAIL", "").strip.downcase
agent = nil
unless agent_email.empty?
  agent = account.users.find_by("LOWER(email) = ?", agent_email)
  raise "Vendedor #{agent_email} não encontrado nesta conta" unless agent
end
inbox = ActiveRecord::Base.transaction do
  channel = Channel::Api.create!(account: account)
  created = Inbox.create!(account: account, channel: channel, name: name)
  created.update!(lock_to_single_conversation: true)
  created.channel.update!(webhook_url: ENV.fetch("INSTANCE_WEBHOOK_URL"))
  member_ids = account.account_users
    .where(role: AccountUser.roles[:administrator])
    .pluck(:user_id)
  bot = account.users.find_by(email: "assistente-chat@voltconect.com.br")
  member_ids << bot.id if bot
  member_ids << agent.id if agent
  created.add_members(member_ids.uniq)
  created
end
puts "INBOX_ID=#{inbox.id}"
' )
    inbox_id=$(printf '%s\n' "$result" | sed -n 's/^INBOX_ID=//p' | tail -n 1)
    [ -n "$inbox_id" ] || { echo "Não foi possível criar a caixa no Chatwoot." >&2; exit 1; }
    cat > "${STATE_DIR}/${slug}.env" <<EOF
BAILEYS_ADMIN_TOKEN=${admin_token}
CHATWOOT_ACCOUNT_ID=${account_id}
CHATWOOT_INBOX_ID=${inbox_id}
CHATWOOT_API_TOKEN=${api_token}
CHATWOOT_BOT_API_TOKEN=${bot_token}
CHATWOOT_BOT_USER_ID=${bot_user_id:-0}
EOF
    chmod 600 "${STATE_DIR}/${slug}.env"
    printf '%s\t%s\t%s\n' "$slug" "$display_name" "$inbox_id" >> "$REGISTRY"
    generate_compose
    docker compose build baileys
    compose_stack config --quiet
    compose_stack up -d "$service"
    echo "Número '${display_name}' criado na caixa ${inbox_id}."
    if [ -n "$agent_email" ]; then
      echo "Acesso concedido aos administradores e a ${agent_email}."
    else
      echo "Acesso concedido somente aos administradores; informe um e-mail no cadastro para vincular um vendedor."
    fi
    total_count=$((extra_count + 2))
    if [ "$total_count" -gt 3 ]; then
      echo "AVISO: ${total_count} gateways ativos podem exceder os recursos de um VPS com 1 vCPU/4 GB." >&2
    fi
    echo "Escaneie o QR Code com: ./scripts/whatsapp-instance.sh qr ${slug}"
    ;;
  list)
    echo "principal$(printf '\t')Número principal$(printf '\t')inbox $(read_env CHATWOOT_INBOX_ID)"
    [ ! -s "$REGISTRY" ] || cat "$REGISTRY"
    ;;
  status)
    slug=${2:-}
    if [ -n "$slug" ]; then
      require_instance "$slug"
      inside_get "$(service_for "$slug")" status
      printf '\n'
    else
      "$0" list | while IFS="$(printf '\t')" read -r item_slug item_name item_inbox; do
        printf '%s: ' "$item_slug"
        if inside_get "$(service_for "$item_slug")" status 2>/dev/null; then printf '\n'; else echo 'indisponível'; fi
      done
    fi
    ;;
  qr)
    slug=${2:-}
    [ -n "$slug" ] || { usage >&2; exit 1; }
    require_instance "$slug"
    inside_get "$(service_for "$slug")" qr.ansi
    ;;
  start|stop)
    slug=${2:-}
    [ -n "$slug" ] || { usage >&2; exit 1; }
    require_instance "$slug"
    compose_stack "$command" "$(service_for "$slug")"
    ;;
  refresh)
    cd "$PROJECT_DIR"
    docker compose build baileys
    services=baileys
    if [ -s "$REGISTRY" ]; then
      while IFS="$(printf '\t')" read -r slug display_name inbox_id; do
        [ -n "$slug" ] || continue
        services="${services} baileys-${slug}"
      done < "$REGISTRY"
    fi
    # A separação por palavras é segura porque os identificadores não aceitam espaços.
    # shellcheck disable=SC2086
    compose_stack up -d --force-recreate $services
    ;;
  *) usage; [ -n "$command" ] && exit 1 || exit 0 ;;
esac
