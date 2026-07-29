function isOutgoingMessage(message) {
  return message?.message_type === 'outgoing' || Number(message?.message_type) === 1;
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
