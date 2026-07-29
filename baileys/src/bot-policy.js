function isOutgoingMessage(message) {
  return message?.message_type === 'outgoing' || Number(message?.message_type) === 1;
}

function isHumanSender(message) {
  const senderType = String(message?.sender?.type || '').toLowerCase();
  return senderType === 'user';
}

export function hasHumanAgentMessage(messages) {
  return (Array.isArray(messages) ? messages : []).some((message) => {
    const attributes = message?.content_attributes || {};
    return (
      isOutgoingMessage(message) &&
      message?.private !== true &&
      isHumanSender(message) &&
      attributes.baileys_bot !== true &&
      attributes.baileys_history_import !== true
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
