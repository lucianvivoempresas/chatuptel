#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

printf 'E-mail que receberá o teste SMTP: '
IFS= read -r RECIPIENT
case "$RECIPIENT" in
  *@*.*) ;;
  *) echo "E-mail inválido." >&2; exit 1 ;;
esac

docker compose exec -T \
  -e TEST_SMTP_TO="$RECIPIENT" \
  rails bundle exec rails runner '
required = %w[SMTP_ADDRESS SMTP_USERNAME SMTP_PASSWORD MAILER_SENDER_EMAIL]
missing = required.select { |key| ENV[key].to_s.strip.empty? }
abort("SMTP ainda não configurado: #{missing.join(", ")}") if missing.any?
ApplicationMailer.mail(
  to: ENV.fetch("TEST_SMTP_TO"),
  subject: "Teste SMTP - Uptel Conecta",
  body: "Configuração SMTP validada com sucesso."
).deliver_now
puts "Mensagem de teste enviada."
'
