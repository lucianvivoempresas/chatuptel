const CONTACT_FIELDS = [
  ['produto_interesse', 'Produto'],
  ['razao_social', 'Empresa'],
  ['cidade_uf', 'Cidade/UF'],
  ['quantidade_linhas', 'Quantidade de linhas'],
  ['valor_conta_energia', 'Conta de energia'],
  ['media_consumo_energia_kwh', 'Média de consumo'],
];

const CONVERSATION_FIELDS = [
  ['status_lead', 'Etapa'],
  ['proxima_acao', 'Próxima ação'],
  ['resumo_atendimento', 'Resumo persistente'],
  ['status_simulacao_energia', 'Situação da simulação'],
  ['economia_mensal_energia', 'Economia mensal'],
  ['economia_anual_energia', 'Economia anual'],
  ['validade_simulacao_energia', 'Validade da simulação'],
  ['resumo_simulacao_energia', 'Resumo da simulação'],
];

function compact(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function fieldLines(source, definitions) {
  return definitions
    .map(([key, label]) => {
      const value = compact(source?.[key], 900);
      return value ? `${label}: ${value}` : null;
    })
    .filter(Boolean);
}

function messageList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.payload)) return payload.payload;
  if (Array.isArray(payload?.data?.payload)) return payload.data.payload;
  return [];
}

export function compactTranscript(payload, { maxMessages = 6, maxMessageChars = 800 } = {}) {
  return messageList(payload)
    .filter(message => !message.private && compact(message.content, 1))
    .slice(-maxMessages)
    .map(message => {
      const incoming = Number(message.message_type) === 0 || message.message_type === 'incoming';
      const sender = compact(message.sender?.name, 80);
      const direction = incoming ? 'Cliente' : `Atendente${sender ? ` (${sender})` : ''}`;
      return `${direction}: ${compact(message.content, maxMessageChars)}`;
    })
    .join('\n');
}

export function economicConversationContext(conversation, messages, options = {}) {
  const contact = conversation?.meta?.sender || conversation?.contact || {};
  const contactAttributes = contact.custom_attributes || {};
  const conversationAttributes = conversation?.custom_attributes || {};
  const memory = [
    `Contato: ${compact(contact.name || 'não informado', 120)}`,
    `Telefone: ${compact(contact.phone_number || 'não informado', 80)}`,
    ...fieldLines(contactAttributes, CONTACT_FIELDS),
    ...fieldLines(conversationAttributes, CONVERSATION_FIELDS),
  ];
  return [
    'MEMÓRIA ESTRUTURADA:',
    ...memory,
    '',
    'ÚLTIMAS MENSAGENS:',
    compactTranscript(messages, options) || 'Nenhuma mensagem textual disponível.',
  ].join('\n');
}

export function estimateTokenEnvelope(text) {
  return Math.ceil(String(text || '').length / 4);
}
