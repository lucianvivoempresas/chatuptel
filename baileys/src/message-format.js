const WHATSAPP_FORMATTING_CHARACTERS = /[*_~`]/g;

export function agentNameFromPayload(payload) {
  const sender =
    payload?.sender ||
    payload?.message?.sender ||
    payload?.conversation?.meta?.assignee;
  const name = sender?.name || sender?.available_name || sender?.display_name;
  if (!name) return null;

  const normalized = String(name)
    .replace(WHATSAPP_FORMATTING_CHARACTERS, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || null;
}

export function formatAgentMessage(content, payload, enabled = true) {
  const message = String(content || '').trim();
  if (!message || !enabled) return message;

  const agentName = agentNameFromPayload(payload);
  if (!agentName) return message;

  const header = `*${agentName}:*`;
  if (message.startsWith(header)) return message;
  return `${header}\n${message}`;
}
