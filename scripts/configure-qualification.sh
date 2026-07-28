#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  echo "Erro: arquivo .env não encontrado em ${PROJECT_DIR}." >&2
  exit 1
fi

CHATWOOT_ACCOUNT_ID=$(sed -n 's/^CHATWOOT_ACCOUNT_ID=//p' .env | tail -n 1 | sed 's/^"//;s/"$//')

if [ -z "$CHATWOOT_ACCOUNT_ID" ]; then
  echo "Erro: CHATWOOT_ACCOUNT_ID precisa estar no .env." >&2
  exit 1
fi

docker compose exec -T \
  -e CHATWOOT_ACCOUNT_ID="$CHATWOOT_ACCOUNT_ID" \
  rails bundle exec rails runner '
account = Account.find(ENV.fetch("CHATWOOT_ACCOUNT_ID").to_i)

definitions = [
  {
    attribute_model: "contact_attribute",
    attribute_key: "cnpj",
    attribute_display_name: "CNPJ",
    attribute_display_type: "text",
    attribute_description: "CNPJ do cliente, preferencialmente no formato 00.000.000/0000-00."
  },
  {
    attribute_model: "contact_attribute",
    attribute_key: "razao_social",
    attribute_display_name: "Razão social",
    attribute_display_type: "text",
    attribute_description: "Razão social ou nome empresarial."
  },
  {
    attribute_model: "contact_attribute",
    attribute_key: "cidade_uf",
    attribute_display_name: "Cidade / UF",
    attribute_display_type: "text",
    attribute_description: "Cidade e estado onde o cliente utilizará o serviço."
  },
  {
    attribute_model: "contact_attribute",
    attribute_key: "produto_interesse",
    attribute_display_name: "Produto de interesse",
    attribute_display_type: "list",
    attribute_values: ["Vivo Móvel", "Internet Empresarial", "Energia", "Aparelhos", "Pós-venda", "Outro"],
    attribute_description: "Principal produto ou assunto procurado pelo cliente."
  },
  {
    attribute_model: "contact_attribute",
    attribute_key: "quantidade_linhas",
    attribute_display_name: "Quantidade de linhas",
    attribute_display_type: "number",
    attribute_description: "Quantidade de linhas móveis solicitadas."
  },
  {
    attribute_model: "contact_attribute",
    attribute_key: "valor_conta_energia",
    attribute_display_name: "Valor da conta de energia",
    attribute_display_type: "currency",
    attribute_description: "Valor aproximado da fatura mensal de energia."
  },
  {
    attribute_model: "contact_attribute",
    attribute_key: "origem_lead",
    attribute_display_name: "Origem do lead",
    attribute_display_type: "list",
    attribute_values: ["WhatsApp", "Site", "Indicação", "Campanha", "Cliente ativo", "Outro"],
    attribute_description: "Canal que originou o primeiro contato."
  },
  {
    attribute_model: "contact_attribute",
    attribute_key: "vendedor_responsavel",
    attribute_display_name: "Vendedor responsável",
    attribute_display_type: "text",
    attribute_description: "Vendedor comercial responsável pelo relacionamento."
  },
  {
    attribute_model: "conversation_attribute",
    attribute_key: "status_lead",
    attribute_display_name: "Status do lead",
    attribute_display_type: "list",
    attribute_values: ["Novo", "Em qualificação", "Proposta enviada", "Em negociação", "Ganho", "Perdido", "Pós-venda"],
    attribute_description: "Etapa comercial atual desta negociação."
  },
  {
    attribute_model: "conversation_attribute",
    attribute_key: "proxima_acao",
    attribute_display_name: "Próxima ação",
    attribute_display_type: "text",
    attribute_description: "Próxima atividade combinada com o cliente."
  },
  {
    attribute_model: "conversation_attribute",
    attribute_key: "data_follow_up",
    attribute_display_name: "Data do follow-up",
    attribute_display_type: "date",
    attribute_description: "Data planejada para o próximo contato."
  },
  {
    attribute_model: "conversation_attribute",
    attribute_key: "valor_proposta",
    attribute_display_name: "Valor da proposta",
    attribute_display_type: "currency",
    attribute_description: "Valor principal da proposta comercial."
  },
  {
    attribute_model: "conversation_attribute",
    attribute_key: "motivo_perda",
    attribute_display_name: "Motivo da perda",
    attribute_display_type: "list",
    attribute_values: ["Preço", "Sem retorno", "Concorrente", "Sem viabilidade", "Documentação", "Desistência", "Outro"],
    attribute_description: "Motivo informado quando a oportunidade for perdida."
  },
  {
    attribute_model: "conversation_attribute",
    attribute_key: "resumo_atendimento",
    attribute_display_name: "Resumo do atendimento",
    attribute_display_type: "text",
    attribute_description: "Resumo objetivo da necessidade e do que foi combinado."
  }
]

ActiveRecord::Base.transaction do
  definitions.each do |attributes|
    definition = account.custom_attribute_definitions.find_or_initialize_by(
      attribute_model: attributes.fetch(:attribute_model),
      attribute_key: attributes.fetch(:attribute_key)
    )
    definition.assign_attributes(attributes)
    definition.attribute_values = [] unless attributes[:attribute_display_type] == "list"
    definition.save!
  end
end

contact_count = definitions.count { |item| item[:attribute_model] == "contact_attribute" }
conversation_count = definitions.count { |item| item[:attribute_model] == "conversation_attribute" }

puts "Campos de qualificação configurados."
puts "Campos do contato: #{contact_count}"
puts "Campos da conversa: #{conversation_count}"
puts "Total: #{definitions.length}"
'

cat <<'TEXT'

Atualize o Chatwoot com Ctrl+F5. Os campos aparecerão na lateral direita da
conversa, separados entre dados do contato e atributos da conversa.
TEXT
