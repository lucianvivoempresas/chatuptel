export function isOutgoingMessage(message) {
  return message?.message_type === 'outgoing' || Number(message?.message_type) === 1;
}

export function isExternalWhatsAppOutgoing(message, gatewayMessageIds = new Set()) {
  const messageId = message?.key?.id;
  if (message?.key?.fromMe !== true || !messageId) return false;
  return !gatewayMessageIds.has(messageId);
}

function isHumanSender(message) {
  const senderType = String(message?.sender?.type || '').toLowerCase();
  return senderType === 'user';
}

export function isBotAuthoredMessage(message, botUserId = 0) {
  const attributes = message?.content_attributes || {};
  const senderType = String(message?.sender?.type || '').toLowerCase();
  const senderName = String(message?.sender?.name || '').trim().toLowerCase();
  const senderId = Number(message?.sender?.id || message?.user?.id || 0);
  return (
    attributes.baileys_bot === true ||
    attributes.bot_name === 'Assistente Uptel Conecta' ||
    senderType === 'agentbot' ||
    senderName === 'assistente uptel conecta' ||
    (Number(botUserId) > 0 && senderId === Number(botUserId))
  );
}

export function hasHumanAgentMessage(messages, botUserId = 0) {
  return (Array.isArray(messages) ? messages : []).some((message) => {
    return (
      isOutgoingMessage(message) &&
      message?.private !== true &&
      isHumanSender(message) &&
      !isBotAuthoredMessage(message, botUserId) &&
      message?.content_attributes?.baileys_history_import !== true
    );
  });
}

export function humanAgentIdFromMessage(message, botUserId = 0) {
  if (
    !isOutgoingMessage(message) ||
    message?.private === true ||
    !isHumanSender(message) ||
    isBotAuthoredMessage(message, botUserId) ||
    message?.content_attributes?.baileys_history_import === true
  ) {
    return null;
  }
  const senderId = Number(message?.sender?.id || 0);
  return senderId > 0 ? senderId : null;
}

export function assignedHumanAgentId(conversation, botUserId = 0) {
  const assignee =
    conversation?.meta?.assignee ||
    conversation?.assignee ||
    conversation?.assigned_agent;
  const assigneeId = Number(
    assignee?.id ||
      conversation?.assignee_id ||
      conversation?.meta?.assignee_id ||
      0,
  );
  if (assigneeId <= 0 || assigneeId === Number(botUserId || 0)) return null;
  const assigneeType = String(assignee?.type || 'user').toLowerCase();
  return assigneeType === 'user' ? assigneeId : null;
}

export function hasPersistentHumanMarker(conversation, botUserId = 0) {
  const attributes = conversation?.custom_attributes || {};
  return (
    attributes.atendimento_humano_ativo === true ||
    String(attributes.atendimento_humano_ativo || '').toLowerCase() === 'true' ||
    assignedHumanAgentId(conversation, botUserId) !== null
  );
}

export function suppressQualificationBot(chat) {
  return chat?.humanManaged === true || chat?.bot?.handoff === true;
}

export function markHumanManaged(chat, timestamp = new Date().toISOString()) {
  chat.humanManaged = true;
  chat.humanManagedAt ||= timestamp;
  if (chat.bot) {
    chat.bot.handoff = true;
    chat.bot.stage = 'human';
    chat.bot.handoffAt ||= timestamp;
  }
  return chat;
}
