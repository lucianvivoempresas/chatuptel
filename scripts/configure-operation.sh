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

printf 'Ativar horário padrão (segunda a sexta 08h-18h e sábado 08h-13h)? [s/N]: '
IFS= read -r working_hours_answer
case "$working_hours_answer" in
  s|S|sim|SIM|Sim) ENABLE_WORKING_HOURS=true ;;
  *) ENABLE_WORKING_HOURS=false ;;
esac

docker compose exec -T \
  -e CHATWOOT_ACCOUNT_ID="$CHATWOOT_ACCOUNT_ID" \
  -e CHATWOOT_INBOX_ID="$CHATWOOT_INBOX_ID" \
  -e ENABLE_WORKING_HOURS="$ENABLE_WORKING_HOURS" \
  rails bundle exec rails runner '
account = Account.find(ENV.fetch("CHATWOOT_ACCOUNT_ID").to_i)
inbox = account.inboxes.find(ENV.fetch("CHATWOOT_INBOX_ID").to_i)

teams = {
  "vendas" => "Novos clientes, propostas e negociações comerciais.",
  "energia" => "Atendimentos de energia por assinatura e análise de faturas.",
  "pos-venda" => "Implantação, suporte, acompanhamento e solicitações de clientes."
}

labels = {
  "novo-lead" => ["#2563EB", "Novo contato aguardando qualificação.", true],
  "vivo-movel" => ["#7C3AED", "Planos móveis e portabilidade.", true],
  "internet-empresarial" => ["#0891B2", "Internet e conectividade empresarial.", true],
  "energia" => ["#00A86B", "Energia por assinatura.", true],
  "aparelhos" => ["#EA580C", "Aparelhos e equipamentos.", true],
  "pos-venda" => ["#475569", "Atendimento após a contratação.", true],
  "documentacao-pendente" => ["#D97706", "Aguardando documentos do cliente.", false],
  "proposta-enviada" => ["#0D9488", "Proposta comercial enviada.", false],
  "cliente" => ["#16A34A", "Cliente ativo.", false],
  "urgente" => ["#DC2626", "Atendimento com prioridade.", true]
}

canned_responses = {
  "saudacao" => "Olá! Tudo bem? Como posso ajudar?",
  "aguarde" => "Estou verificando essas informações. Aguarde só um momento, por favor.",
  "cnpj" => "Para continuar, poderia informar o CNPJ da empresa?",
  "cidade" => "Qual é a cidade e o estado onde o serviço será utilizado?",
  "linhas" => "Quantas linhas móveis sua empresa precisa atualmente?",
  "fatura-energia" => "Para analisar sua economia, envie uma foto ou PDF da sua conta de energia mais recente.",
  "documentos" => "Para dar continuidade, preciso dos documentos combinados. Você pode enviá-los por aqui.",
  "proposta" => "Sua proposta foi preparada e enviada. Se desejar, posso explicar cada condição.",
  "transferir" => "Vou encaminhar seu atendimento ao setor responsável. Só um momento, por favor.",
  "encerrar" => "Seu atendimento foi concluído. Caso precise de algo mais, é só nos chamar!"
}

ActiveRecord::Base.transaction do
  teams.each do |name, description|
    team = account.teams.find_or_initialize_by(name: name)
    team.description = description
    team.allow_auto_assign = true
    team.save!
  end

  labels.each do |title, attributes|
    color, description, show_on_sidebar = attributes
    label = account.labels.find_or_initialize_by(title: title)
    label.color = color
    label.description = description
    label.show_on_sidebar = show_on_sidebar
    label.save!
  end

  canned_responses.each do |short_code, content|
    response = account.canned_responses.find_or_initialize_by(short_code: short_code)
    response.content = content
    response.save!
  end

  enable_hours = ENV.fetch("ENABLE_WORKING_HOURS") == "true"
  inbox.update!(
    timezone: "America/Sao_Paulo",
    working_hours_enabled: enable_hours,
    out_of_office_message: "Olá! Nosso atendimento está fechado no momento. Recebemos sua mensagem e responderemos no próximo horário útil."
  )

  if enable_hours
    schedule = {
      0 => { closed_all_day: true },
      1 => { open_hour: 8, open_minutes: 0, close_hour: 18, close_minutes: 0 },
      2 => { open_hour: 8, open_minutes: 0, close_hour: 18, close_minutes: 0 },
      3 => { open_hour: 8, open_minutes: 0, close_hour: 18, close_minutes: 0 },
      4 => { open_hour: 8, open_minutes: 0, close_hour: 18, close_minutes: 0 },
      5 => { open_hour: 8, open_minutes: 0, close_hour: 18, close_minutes: 0 },
      6 => { open_hour: 8, open_minutes: 0, close_hour: 13, close_minutes: 0 }
    }

    schedule.each do |day, attributes|
      working_hour = inbox.working_hours.find_or_initialize_by(day_of_week: day)
      working_hour.assign_attributes(
        {
          closed_all_day: false,
          open_all_day: false,
          open_hour: nil,
          open_minutes: nil,
          close_hour: nil,
          close_minutes: nil
        }.merge(attributes)
      )
      working_hour.save!
    end
  end
end

puts "Configuração operacional concluída."
puts "Equipes: #{account.teams.order(:name).pluck(:name).join(", ")}"
puts "Etiquetas criadas/atualizadas: #{labels.length}"
puts "Respostas prontas criadas/atualizadas: #{canned_responses.length}"
puts "Horário de atendimento: #{inbox.working_hours_enabled ? "ATIVO" : "INATIVO"}"
puts "Fuso horário: #{inbox.timezone}"
'

cat <<'TEXT'

Como usar:
- Digite / no campo de resposta para abrir as respostas prontas.
- Aplique etiquetas na lateral da conversa.
- Transfira a conversa para vendas, energia ou pos-venda conforme o assunto.
- Use o script assign-team.sh para adicionar cada agente às equipes corretas.
TEXT
