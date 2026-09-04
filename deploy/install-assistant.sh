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

if [ -z "$(read_env OPENAI_API_KEY)" ] && [ -z "$(read_env ZYLOO_API_KEY)" ]; then
  echo "Aviso: nenhuma chave de IA foi configurada no .env." >&2
  echo "O painel e a aba Números serão instalados; sugestões por IA ficarão indisponíveis." >&2
fi

chmod 600 .env
docker compose config --quiet
docker compose up -d --build assistant

attempt=0
until curl --fail --silent http://127.0.0.1:3002/health >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "O Assistente Uptel não iniciou. Últimos logs:" >&2
    docker compose logs --tail=100 assistant >&2
    exit 1
  fi
  sleep 2
done

asset_version=$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)
docker compose exec -T -e UPTEL_ASSISTANT_ASSET_VERSION="$asset_version" rails bundle exec rails runner '
marker_start = "<!-- uptel-assistant:start -->"
marker_end = "<!-- uptel-assistant:end -->"
asset_version = ENV.fetch("UPTEL_ASSISTANT_ASSET_VERSION")
snippet = <<~HTML.strip
  #{marker_start}
  <script defer src="/uptel-assistant/embed.js?v=#{asset_version}"></script>
  #{marker_end}
HTML
setting = InstallationConfig.find_or_initialize_by(name: "DASHBOARD_SCRIPTS")
current = setting.value.to_s.gsub(/#{Regexp.escape(marker_start)}.*?#{Regexp.escape(marker_end)}/m, "").strip
setting.value = [current, snippet].reject(&:empty?).join("\n")
setting.save!
setting.reload
raise "O registro do painel não foi persistido" unless setting.value.to_s.include?(marker_start)
puts "Painel do Assistente Uptel ativado no Chatwoot (versão #{asset_version})."
'

if [ "$(id -u)" -eq 0 ]; then
  NGINX_SITE=${NGINX_SITE:-/etc/nginx/sites-available/chat.voltconect.com.br.conf}
  case "$NGINX_SITE" in
    /etc/nginx/sites-available/*|/etc/nginx/sites-enabled/*) ;;
    *)
      echo "Erro: NGINX_SITE deve estar dentro de /etc/nginx/sites-available ou sites-enabled." >&2
      exit 1
      ;;
  esac

  if [ ! -f "$NGINX_SITE" ]; then
    echo "Aviso: configuração Nginx não encontrada em ${NGINX_SITE}." >&2
    echo "Copie deploy/nginx/chat.voltconect.com.br.conf para o Nginx e recarregue-o." >&2
    exit 1
  fi

  mkdir -p /etc/nginx/snippets
  cp deploy/nginx/uptel-assistant.conf /etc/nginx/snippets/uptel-assistant.conf

  if ! grep -qE 'uptel-assistant\.conf|location[[:space:]]+\^~[[:space:]]+/uptel-assistant/' "$NGINX_SITE"; then
    backup="${NGINX_SITE}.uptel-assistant.$(date +%Y%m%d%H%M%S).bak"
    cp "$NGINX_SITE" "$backup"
    temp_file=$(mktemp)
    awk '
      !inserted && /^[[:space:]]*location \/ \{/ {
        print "    include /etc/nginx/snippets/uptel-assistant.conf;"
        print ""
        inserted=1
      }
      { print }
      END { if (!inserted) exit 42 }
    ' "$NGINX_SITE" > "$temp_file" || {
      rm -f "$temp_file"
      echo "Erro: não encontrei o bloco location / no Nginx." >&2
      exit 1
    }
    cp "$temp_file" "$NGINX_SITE"
    rm -f "$temp_file"
  fi

  nginx -t
  systemctl reload nginx
else
  echo "Aviso: execute este instalador com sudo para configurar o Nginx automaticamente." >&2
  echo "O serviço foi iniciado, mas /uptel-assistant ainda precisa ser publicado." >&2
fi

echo "Assistente Uptel instalado. Atualize o Chatwoot com Ctrl+F5 e abra uma conversa."
