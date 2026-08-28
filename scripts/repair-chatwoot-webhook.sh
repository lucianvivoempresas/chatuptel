#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  echo "Erro: arquivo .env não encontrado em ${PROJECT_DIR}." >&2
  exit 1
fi

echo "Garantindo que Rails, Sidekiq e Baileys estejam ativos..."
docker compose up -d rails sidekiq baileys

echo "Recriando o webhook interno Chatwoot -> Baileys..."
docker compose exec -T rails bundle exec rails runner '
require "net/http"
require "json"

account_id = ENV.fetch("CHATWOOT_ACCOUNT_ID").to_i
token = ENV.fetch("BAILEYS_ADMIN_TOKEN")
url = "http://baileys:3001/webhooks/chatwoot?token=#{token}"

scope = Webhook.where(account_id: account_id)
  .where("url LIKE ?", "http://baileys:3001/webhooks/chatwoot%")
removed = scope.where.not(url: url).count
scope.where.not(url: url).destroy_all

webhook = Webhook.find_or_initialize_by(account_id: account_id, url: url)
webhook.subscriptions = ["message_created"]
webhook.save!

uri = URI(url)
request = Net::HTTP::Post.new(uri)
request["Content-Type"] = "application/json"
request.body = { event: "uptel_webhook_healthcheck" }.to_json
response = Net::HTTP.start(uri.host, uri.port, open_timeout: 5, read_timeout: 10) do |http|
  http.request(request)
end
raise "Gateway respondeu HTTP #{response.code}" unless response.code.to_i == 200

puts "WEBHOOK_OK id=#{webhook.id} subscriptions=#{webhook.subscriptions.join(",")} antigos_removidos=#{removed}"
'

echo "Verificando serviços..."
docker compose ps rails sidekiq baileys
echo "Webhook reparado e comunicação interna validada."
