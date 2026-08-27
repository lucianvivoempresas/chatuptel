import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import express from 'express';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import {
  hasHumanAgentMessage,
  hasPersistentHumanMarker,
  humanAgentIdFromMessage,
  isOutgoingMessage,
  markHumanManaged,
  suppressQualificationBot,
} from './bot-policy.js';
import { agentNameFromPayload, formatAgentMessage } from './message-format.js';
import { simulateEnergyDiscount } from './energy-simulation.js';
import { extractEnergyInvoice, parseGeminiApiKeys } from './energy-invoice.js';
import {
  MENU_TEXT,
  PRODUCT_OPTIONS,
  formatCnpj,
  formatCurrency,
  isEnergyFinalize,
  isMenuRequest,
  normalizeText,
  parsePositiveInteger,
  parseProduct,
} from './qualification.js';

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
};

const positiveNumber = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

const config = {
  port: Number(process.env.PORT || 3001),
  authDir: process.env.BAILEYS_AUTH_DIR || '/data/auth',
  stateFile: process.env.BAILEYS_STATE_FILE || '/data/state.json',
  adminToken: required('BAILEYS_ADMIN_TOKEN'),
  chatwootUrl: (process.env.CHATWOOT_URL || 'http://rails:3000').replace(/\/$/, ''),
  chatwootAccountId: required('CHATWOOT_ACCOUNT_ID'),
  chatwootInboxId: Number(required('CHATWOOT_INBOX_ID')),
  chatwootApiToken: required('CHATWOOT_API_TOKEN'),
  chatwootBotApiToken: String(
    process.env.CHATWOOT_BOT_API_TOKEN || process.env.CHATWOOT_API_TOKEN || '',
  ).trim(),
  chatwootBotUserId: Math.max(0, Number(process.env.CHATWOOT_BOT_USER_ID || 0)),
  defaultCountryCode: (process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '55').replace(/\D/g, ''),
  prefixAgentName: !['false', '0', 'no'].includes(
    String(process.env.WHATSAPP_PREFIX_AGENT_NAME || 'true').toLowerCase(),
  ),
  botEnabled: !['false', '0', 'no'].includes(
    String(process.env.WHATSAPP_BOT_ENABLED || 'true').toLowerCase(),
  ),
  energiaCrmUrl: String(process.env.ENERGIA_CRM_URL || '').trim().replace(/\/+$/, ''),
  energiaCrmIntegrationToken: String(
    process.env.ENERGIA_CRM_INTEGRATION_TOKEN || '',
  ).trim(),
  geminiApiKeys: parseGeminiApiKeys(
    process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '',
  ),
  geminiModel: String(process.env.GEMINI_INVOICE_MODEL || 'gemini-2.5-flash').trim(),
  energyInvoiceMaxBytes: Math.max(1024 * 1024, positiveNumber(
    process.env.ENERGY_INVOICE_MAX_BYTES,
    15 * 1024 * 1024,
  )),
  auditDir: process.env.BAILEYS_AUDIT_DIR || '/data/audit',
  auditRetentionDays: Math.max(1, Number(process.env.BAILEYS_AUDIT_RETENTION_DAYS || 90)),
  globalPerMinute: Math.max(1, Number(process.env.WHATSAPP_GLOBAL_PER_MINUTE || 60)),
  recipientPerMinute: Math.max(1, Number(process.env.WHATSAPP_RECIPIENT_PER_MINUTE || 10)),
  agentDailyLimit: Math.max(1, Number(process.env.WHATSAPP_AGENT_DAILY_LIMIT || 500)),
  historySyncDays: Math.max(
    0,
    Math.min(30, Number(process.env.WHATSAPP_HISTORY_SYNC_DAYS || 0)),
  ),
};

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baileysLogger = logger.child({ module: 'baileys' });
const app = express();
app.use(express.json({ limit: '10mb' }));

let socket;
let currentQr = null;
let connectionStatus = 'starting';
let reconnectTimer;
let state = {
  chats: {},
  crmOutbox: {},
  outboundQueue: {},
  outboundDelivered: {},
  sendLimits: {},
  historyImported: {},
  historyStats: {},
  botPolicyVersion: 2,
};
let stateSaveQueue = Promise.resolve();
let auditWriteQueue = Promise.resolve();
let crmFlushRunning = false;
let outboundFlushRunning = false;
let historyImportQueue = Promise.resolve();
const processedMessages = new Set();
const registeredJids = new Map();
const sentMessages = new Map();
const teamIds = new Map();
const historyContacts = new Map();
const historyLidToPn = new Map();

class ChatwootRequestError extends Error {
  constructor(status, body) {
    super(`Chatwoot ${status}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

async function loadState() {
  try {
    state = JSON.parse(await fs.readFile(config.stateFile, 'utf8'));
    state.chats ||= {};
    state.crmOutbox ||= {};
    state.outboundQueue ||= {};
    state.outboundDelivered ||= {};
    state.sendLimits ||= {};
    state.historyImported ||= {};
    state.historyStats ||= {};
    if (Number(state.botPolicyVersion || 0) < 2) {
      for (const chat of Object.values(state.chats)) {
        delete chat.humanParticipationChecked;
      }
      state.botPolicyVersion = 2;
      await saveState();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await saveState();
  }
}

async function saveState() {
  const write = async () => {
    await fs.mkdir(path.dirname(config.stateFile), { recursive: true });
    const temporary = `${config.stateFile}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state, null, 2));
    await fs.rename(temporary, config.stateFile);
  };
  stateSaveQueue = stateSaveQueue.then(write, write);
  return stateSaveQueue;
}

function auditHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

async function auditEvent(event, fields = {}) {
  const timestamp = new Date().toISOString();
  const day = timestamp.slice(0, 10);
  const entry = {
    timestamp,
    event,
    ...fields,
  };
  const write = async () => {
    await fs.mkdir(config.auditDir, { recursive: true });
    await fs.appendFile(
      path.join(config.auditDir, `messages-${day}.jsonl`),
      `${JSON.stringify(entry)}\n`,
      { mode: 0o600 },
    );
  };
  auditWriteQueue = auditWriteQueue.then(write, write);
  return auditWriteQueue;
}

async function cleanOldAuditFiles() {
  try {
    const entries = await fs.readdir(config.auditDir, { withFileTypes: true });
    const cutoff = Date.now() - config.auditRetentionDays * 24 * 60 * 60 * 1000;
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^messages-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
        .map(async (entry) => {
          const file = path.join(config.auditDir, entry.name);
          const stat = await fs.stat(file);
          if (stat.mtimeMs < cutoff) await fs.unlink(file);
        }),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn({ error: error.message }, 'Falha ao limpar auditoria');
  }
}

async function chatwootRequest(endpoint, options = {}) {
  const { apiToken = config.chatwootApiToken, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers || {});
  headers.set('api_access_token', apiToken);
  if (requestOptions.body && !(requestOptions.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(`${config.chatwootUrl}${endpoint}`, {
    ...requestOptions,
    headers,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new ChatwootRequestError(response.status, body);
  }
  return body ? JSON.parse(body) : {};
}

function phoneFromJid(jid) {
  const number = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  return number ? `+${number}` : null;
}

function phoneJidFromValue(value) {
  if (!value) return null;
  const normalized = String(value).trim();
  if (normalized.endsWith('@s.whatsapp.net')) return normalized;
  if (normalized.includes('@')) return null;
  let number = normalized.replace(/^whatsapp:/i, '').replace(/\D/g, '');
  if (number.startsWith('0') && number.length >= 11) number = number.replace(/^0+/, '');
  if ([10, 11].includes(number.length) && config.defaultCountryCode) {
    number = `${config.defaultCountryCode}${number}`;
  }
  return number ? `${number}@s.whatsapp.net` : null;
}

function contactFromResponse(response) {
  const payload = response?.payload;
  if (Array.isArray(payload)) return payload[0] || null;
  return payload || response || null;
}

async function searchContact(query, identifier, phoneNumber) {
  if (!query) return null;
  const response = await chatwootRequest(
    `/api/v1/accounts/${config.chatwootAccountId}/contacts/search?q=${encodeURIComponent(query)}`,
  );
  const contacts = Array.isArray(response.payload) ? response.payload : [];
  return (
    contacts.find((contact) => contact.identifier === identifier) ||
    contacts.find((contact) => contact.phone_number === phoneNumber) ||
    null
  );
}

async function findExistingContact(identifier, phoneNumber) {
  return (
    (await searchContact(identifier, identifier, phoneNumber)) ||
    (await searchContact(phoneNumber, identifier, phoneNumber))
  );
}

async function ensureWhatsAppLeadOrigin(contact) {
  if (contact.custom_attributes?.origem_lead) return contact;

  try {
    const updated = await chatwootRequest(
      `/api/v1/accounts/${config.chatwootAccountId}/contacts/${contact.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          custom_attributes: { origem_lead: 'WhatsApp' },
        }),
      },
    );
    return contactFromResponse(updated) || contact;
  } catch (error) {
    logger.warn(
      { contactId: contact.id, error: error.message },
      'Não foi possível registrar a origem do lead',
    );
    return contact;
  }
}

async function ensureContactInbox(contact, preferredSourceId) {
  let contactInbox = contact.contact_inboxes?.find(
    (item) => Number(item.inbox?.id) === config.chatwootInboxId,
  );
  if (contactInbox) return contactInbox;

  try {
    contactInbox = await chatwootRequest(
      `/api/v1/accounts/${config.chatwootAccountId}/contacts/${contact.id}/contact_inboxes`,
      {
        method: 'POST',
        body: JSON.stringify({
          inbox_id: config.chatwootInboxId,
          source_id: preferredSourceId,
        }),
      },
    );
    return contactInbox;
  } catch (error) {
    if (!(error instanceof ChatwootRequestError) || error.status !== 422) throw error;
    const refreshed = contactFromResponse(
      await chatwootRequest(
        `/api/v1/accounts/${config.chatwootAccountId}/contacts/${contact.id}`,
      ),
    );
    contactInbox = refreshed?.contact_inboxes?.find(
      (item) => Number(item.inbox?.id) === config.chatwootInboxId,
    );
    if (!contactInbox) throw error;
    return contactInbox;
  }
}

async function ensureConversation(jid, pushName, phoneJid = jid, options = {}) {
  const historical = options.historical === true;
  const outboundJid = phoneJidFromValue(phoneJid);
  const matchingChats = outboundJid
    ? Object.entries(state.chats).filter(
        ([, chat]) =>
          Number(chat.inboxId) === config.chatwootInboxId &&
          phoneJidFromValue(chat.outboundJid || chat.sourceId) === outboundJid,
      )
    : [];
  const humanManagedAlias = matchingChats.find(([, chat]) => chat.humanManaged === true);
  if (state.chats[jid]?.conversationId && humanManagedAlias) {
    markHumanManaged(state.chats[jid], humanManagedAlias[1].humanManagedAt);
    state.chats[jid].conversationId = humanManagedAlias[1].conversationId;
    state.chats[jid].outboundJid = outboundJid;
    await saveState();
  } else if (!state.chats[jid]?.conversationId && matchingChats.length) {
    const [matchingKey, chat] = humanManagedAlias || matchingChats[0];
    state.chats[jid] = chat;
    if (matchingKey !== jid) delete state.chats[matchingKey];
    await saveState();
  }
  if (
    state.chats[jid]?.conversationId &&
    Number(state.chats[jid].inboxId) === config.chatwootInboxId
  ) {
    if (outboundJid && state.chats[jid].outboundJid !== outboundJid) {
      state.chats[jid].outboundJid = outboundJid;
      await saveState();
    }
    return state.chats[jid];
  }

  const phoneNumber = phoneFromJid(phoneJid);
  const identifier = `whatsapp:${phoneNumber?.replace(/\D/g, '') || jid}`;
  let contact = await findExistingContact(identifier, phoneNumber);

  if (!contact) {
    try {
      const contactResponse = await chatwootRequest(
        `/api/v1/accounts/${config.chatwootAccountId}/contacts`,
        {
          method: 'POST',
          body: JSON.stringify({
            inbox_id: config.chatwootInboxId,
            name: pushName || phoneNumber || jid,
            phone_number: phoneNumber,
            identifier,
            custom_attributes: {
              origem_lead: 'WhatsApp',
            },
            additional_attributes: {
              whatsapp_jid: jid,
              whatsapp_phone_jid: outboundJid,
              provider: 'baileys',
            },
          }),
        },
      );
      contact = contactFromResponse(contactResponse);
    } catch (error) {
      if (!(error instanceof ChatwootRequestError) || error.status !== 422) throw error;
      contact = await findExistingContact(identifier, phoneNumber);
      if (!contact) throw error;
    }
  }
  if (!historical) contact = await ensureWhatsAppLeadOrigin(contact);

  const contactId = contact.id;
  const contactInbox = await ensureContactInbox(contact, identifier);
  const sourceId = contactInbox.source_id;

  const conversation = await chatwootRequest(
    `/api/v1/accounts/${config.chatwootAccountId}/conversations`,
    {
      method: 'POST',
      body: JSON.stringify({
        source_id: sourceId,
        inbox_id: config.chatwootInboxId,
        contact_id: contactId,
        status: historical ? 'resolved' : 'open',
        custom_attributes: historical ? {} : { status_lead: 'Novo' },
        additional_attributes: {
          whatsapp_jid: jid,
          whatsapp_phone_jid: outboundJid,
          provider: 'baileys',
          history_imported: historical,
        },
      }),
    },
  );

  if (!historical) {
    try {
      await chatwootRequest(
        `/api/v1/accounts/${config.chatwootAccountId}/conversations/${conversation.id}/labels`,
        {
          method: 'POST',
          body: JSON.stringify({ labels: ['novo-lead'] }),
        },
      );
    } catch (error) {
      logger.warn(
        { conversationId: conversation.id, error: error.message },
        'Não foi possível aplicar a etiqueta novo-lead',
      );
    }
  }

  state.chats[jid] = {
    contactId,
    sourceId,
    conversationId: conversation.id,
    inboxId: config.chatwootInboxId,
    outboundJid,
  };
  await saveState();
  return state.chats[jid];
}

function extractText(message) {
  const content = normalizeMessageContent(message.message) || {};
  const type = getContentType(content);
  if (!type) return '';
  const value = content[type];

  return (
    value?.text ||
    value?.caption ||
    value?.conversation ||
    content.conversation ||
    (type === 'locationMessage'
      ? `Localização: https://maps.google.com/?q=${value.degreesLatitude},${value.degreesLongitude}`
      : '') ||
    (type === 'contactMessage' ? `Contato: ${value.displayName || ''}\n${value.vcard || ''}` : '') ||
    `[Mensagem do WhatsApp: ${type}]`
  );
}

function mediaInfo(message) {
  const content = normalizeMessageContent(message.message) || {};
  const type = getContentType(content);
  const value = type ? content[type] : null;
  const supported = {
    imageMessage: ['image', 'jpg'],
    videoMessage: ['video', 'mp4'],
    audioMessage: ['audio', value?.ptt ? 'ogg' : 'mp3'],
    documentMessage: ['file', value?.fileName?.split('.').pop() || 'bin'],
    stickerMessage: ['image', 'webp'],
  };
  if (!supported[type]) return null;
  return {
    type,
    extension: supported[type][1],
    mimeType: value?.mimetype || 'application/octet-stream',
    filename: value?.fileName || `whatsapp-${message.key.id}.${supported[type][1]}`,
  };
}

async function createIncomingMessage(conversationId, message, text, options = {}) {
  const messageType = options.messageType || 'incoming';
  const contentAttributes = {
    whatsapp_message_id: message.key.id,
    ...(options.contentAttributes || {}),
  };
  const externalCreatedAt = options.externalCreatedAt || null;
  const media = mediaInfo(message);
  if (!media) {
    return chatwootRequest(
      `/api/v1/accounts/${config.chatwootAccountId}/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          content: text,
          message_type: messageType,
          private: false,
          content_type: 'text',
          content_attributes: contentAttributes,
          external_created_at: externalCreatedAt,
          source_id: message.key.id,
        }),
      },
    );
  }

  const buffer = await downloadMediaMessage(
    message,
    'buffer',
    {},
    { logger: baileysLogger, reuploadRequest: socket.updateMediaMessage },
  );
  const form = new FormData();
  form.append('content', text || media.filename);
  form.append('message_type', messageType);
  form.append('private', 'false');
  form.append('content_attributes', JSON.stringify(contentAttributes));
  form.append('source_id', message.key.id);
  if (externalCreatedAt) form.append('external_created_at', externalCreatedAt);
  form.append('attachments[]', new Blob([buffer], { type: media.mimeType }), media.filename);
  return chatwootRequest(
    `/api/v1/accounts/${config.chatwootAccountId}/conversations/${conversationId}/messages`,
    { method: 'POST', body: form },
  );
}

async function createBotMessage(conversationId, content) {
  return chatwootRequest(
    `/api/v1/accounts/${config.chatwootAccountId}/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      apiToken: config.chatwootBotApiToken,
      body: JSON.stringify({
        content,
        message_type: 'outgoing',
        private: false,
        content_type: 'text',
        content_attributes: {
          baileys_bot: true,
          bot_name: 'Assistente Uptel Conecta',
        },
      }),
    },
  );
}

async function sendBotMessage(chat, jid, text) {
  const content = `*Assistente Uptel Conecta:*\n${text}`;
  await sendWhatsAppMessage(jid, { text: content });
  await auditEvent('outbound_bot_sent', {
    conversationId: chat.conversationId,
    jid,
    contentLength: content.length,
    contentSha256: auditHash(content),
  });
  try {
    await createBotMessage(chat.conversationId, content);
  } catch (error) {
    logger.warn(
      { conversationId: chat.conversationId, error: error.message },
      'Mensagem do bot enviada ao WhatsApp, mas não registrada no Chatwoot',
    );
  }
}

async function updateContactAttributes(contactId, attributes) {
  await chatwootRequest(
    `/api/v1/accounts/${config.chatwootAccountId}/contacts/${contactId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ custom_attributes: attributes }),
    },
  );
}

async function updateContactName(contactId, name) {
  await chatwootRequest(
    `/api/v1/accounts/${config.chatwootAccountId}/contacts/${contactId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    },
  );
}

async function mergeConversationAttributes(conversationId, attributes) {
  const conversation = await chatwootRequest(
    `/api/v1/accounts/${config.chatwootAccountId}/conversations/${conversationId}`,
  );
  await chatwootRequest(
    `/api/v1/accounts/${config.chatwootAccountId}/conversations/${conversationId}/custom_attributes`,
    {
      method: 'POST',
      body: JSON.stringify({
        custom_attributes: {
          ...(conversation.custom_attributes || {}),
          ...attributes,
        },
      }),
    },
  );
}

async function mergeConversationLabels(conversationId, newLabels) {
  const response = await chatwootRequest(
    `/api/v1/accounts/${config.chatwootAccountId}/conversations/${conversationId}/labels`,
  );
  const currentLabels = Array.isArray(response)
    ? response
    : Array.isArray(response.payload)
      ? response.payload
      : [];
  const labels = [...new Set([...currentLabels, ...newLabels])];
  await chatwootRequest(
    `/api/v1/accounts/${config.chatwootAccountId}/conversations/${conversationId}/labels`,
    {
      method: 'POST',
      body: JSON.stringify({ labels }),
    },
  );
}

async function teamIdByName(teamName) {
  if (teamIds.has(teamName)) return teamIds.get(teamName);
  const response = await chatwootRequest(
    `/api/v1/accounts/${config.chatwootAccountId}/teams`,
  );
  const teams = Array.isArray(response) ? response : response.payload || [];
  const team = teams.find(
    (item) => normalizeText(item.name) === normalizeText(teamName),
  );
  if (!team) return null;
  teamIds.set(teamName, team.id);
  return team.id;
}

async function assignConversationTeam(conversationId, teamName) {
  const teamId = await teamIdByName(teamName);
  if (!teamId) {
    logger.warn({ conversationId, teamName }, 'Equipe não encontrada no Chatwoot');
    return;
  }
  await chatwootRequest(
    `/api/v1/accounts/${config.chatwootAccountId}/conversations/${conversationId}/assignments`,
    {
      method: 'POST',
      body: JSON.stringify({ team_id: teamId }),
    },
  );
}

async function assignConversationAgent(conversationId, agentId) {
  await chatwootRequest(
    `/api/v1/accounts/${config.chatwootAccountId}/conversations/${conversationId}/assignments`,
    {
      method: 'POST',
      body: JSON.stringify({ assignee_id: agentId }),
    },
  );
}

function newBotState() {
  return {
    stage: 'product',
    answers: {},
    handoff: false,
    completed: false,
  };
}

async function energyInvoiceMedia(message) {
  const media = mediaInfo(message);
  if (!media) return null;
  const mimeType = String(media.mimeType || '').toLowerCase().split(';')[0];
  if (!['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(mimeType)) {
    return { unsupported: true, ...media, mimeType };
  }
  const buffer = await downloadMediaMessage(
    message,
    'buffer',
    {},
    { logger: baileysLogger, reuploadRequest: socket.updateMediaMessage },
  );
  if (buffer.length > config.energyInvoiceMaxBytes) {
    return { tooLarge: true, ...media, mimeType, size: buffer.length };
  }
  return { ...media, mimeType, buffer, size: buffer.length };
}

async function conversationHasHumanAgentMessage(conversationId) {
  const response = await chatwootRequest(
    `/api/v1/accounts/${config.chatwootAccountId}/conversations/${conversationId}/messages`,
  );
  const messages = Array.isArray(response) ? response : response.payload || [];
  return hasHumanAgentMessage(messages, config.chatwootBotUserId);
}

async function conversationHasPersistentHumanMarker(conversationId) {
  const response = await chatwootRequest(
    `/api/v1/accounts/${config.chatwootAccountId}/conversations/${conversationId}`,
  );
  const conversation = response?.payload || response;
  return hasPersistentHumanMarker(conversation, config.chatwootBotUserId);
}

async function disableBotForHumanConversation(chat) {
  markHumanManaged(chat);
  await saveState();
  logger.info(
    { conversationId: chat.conversationId },
    'Chatbot desativado: conversa jÃ¡ possui participaÃ§Ã£o de agente',
  );
}

async function humanAlreadyParticipated(chat) {
  if (suppressQualificationBot(chat)) return true;

  try {
    if (
      (await conversationHasPersistentHumanMarker(chat.conversationId)) ||
      (await conversationHasHumanAgentMessage(chat.conversationId))
    ) {
      await disableBotForHumanConversation(chat);
      return true;
    }
  } catch (error) {
    logger.warn(
      { conversationId: chat.conversationId, error: error.message },
      'NÃ£o foi possÃ­vel verificar se um agente jÃ¡ participou da conversa',
    );
  }
  return false;
}

function qualificationSummary(answers) {
  return [
    answers.contactName && `Contato: ${answers.contactName}`,
    answers.companyName && `Empresa: ${answers.companyName}`,
    answers.productName && `Produto: ${answers.productName}`,
    answers.cnpj && `CNPJ: ${answers.cnpj}`,
    answers.city && `Cidade/UF: ${answers.city}`,
    answers.lines && `Linhas: ${answers.lines}`,
    answers.energyValue && `Conta de energia: ${answers.energyValue}`,
    answers.energySimulationSummary && `Simulação: ${answers.energySimulationSummary}`,
    answers.need && `Necessidade: ${answers.need}`,
  ]
    .filter(Boolean)
    .join(' | ');
}

function formatBrl(value) {
  return Number(value || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function formatPercent(value) {
  return `${Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

function energyReviewLabel(reason) {
  const labels = {
    tarifa_social_ou_nis: 'NIS/Tarifa Social',
    fatura_ilegivel: 'fatura ilegível',
    uf_fora_da_tabela: 'UF fora da tabela automática',
    consumo_nao_identificado: 'consumo não identificado',
    consumo_abaixo_de_300_kwh: 'consumo abaixo de 300 kWh',
    valor_da_fatura_nao_identificado: 'valor da fatura não identificado',
  };
  return labels[reason] || reason;
}

function energySimulationSummary(simulation) {
  return simulation.groups.map(group => {
    const discount = group.baseDiscountRate === null
      ? 'avaliação do atendente'
      : `${formatPercent(group.baseDiscountRate)} base`;
    return `${group.state}: ${group.groupAverageKwh.toLocaleString('pt-BR')} kWh, ${discount}, economia mensal ${formatBrl(group.monthlySavings)}`;
  }).join(' / ');
}

function energySimulationCustomerMessage(simulation, units) {
  const sections = simulation.groups.map(group => {
    const lines = [
      `*${group.state}* — média agrupada: *${group.groupAverageKwh.toLocaleString('pt-BR')} kWh/mês*`,
    ];
    if (group.baseDiscountRate !== null) {
      lines.push(`Desconto da tabela: *${formatPercent(group.baseDiscountRate)}*`);
      for (const unit of group.units) {
        const label = unit.id ? `Unidade ${unit.id}` : 'Unidade';
        lines.push(
          `${label}: desconto final *${formatPercent(unit.finalDiscountRate)}*, `
          + `economia estimada de *${formatBrl(unit.monthlySavings)} por mês*`,
        );
      }
      lines.push(`Economia anual estimada neste estado: *${formatBrl(group.annualSavings)}*`);
    }
    if (group.reviewReasons.length) {
      lines.push(`Validação do atendente: ${group.reviewReasons.map(energyReviewLabel).join(', ')}.`);
    }
    return lines.join('\n');
  });
  const holderTypes = new Set(units.map(unit => unit.holderType));
  const documents = [];
  if (holderTypes.has('company')) {
    documents.push('Para unidade em nome de empresa: Contrato Social, RG e CPF do gestor, e-mail e telefone.');
  }
  if (holderTypes.has('person')) {
    documents.push('Para unidade em nome de pessoa: RG e CPF do titular, e-mail e telefone.');
  }
  const validity = simulation.validity;
  const hasAutomaticSavings = simulation.groups.some(group => group.baseDiscountRate !== null);
  return [
    'Concluí a leitura das suas faturas e preparei a simulação:',
    ...sections,
    hasAutomaticSavings
      ? `*Economia automática estimada:* ${formatBrl(simulation.monthlySavings)} por mês e ${formatBrl(simulation.annualSavings)} por ano.`
      : 'A economia será calculada pelo atendente após validar as unidades fora da regra automática.',
    `*Validade:* ${validity.startsAt.split('-').reverse().join('/')} até ${validity.endsAt.split('-').reverse().join('/')}.`,
    simulation.status === 'operator_review'
      ? 'A simulação ficará sujeita à validação do nosso atendente antes da proposta.'
      : 'Agora um atendente validará a proposta e continuará a contratação.',
    ...documents,
  ].filter(Boolean).join('\n\n');
}

function energySimulationAttributes(simulation) {
  return {
    status_simulacao_energia: simulation.status === 'eligible'
      ? 'Elegível'
      : 'Avaliação do atendente',
    economia_mensal_energia: simulation.monthlySavings,
    economia_anual_energia: simulation.annualSavings,
    validade_simulacao_energia: simulation.validity.endsAt,
    resumo_simulacao_energia: energySimulationSummary(simulation).slice(0, 2000),
  };
}

function energiaCrmConfigured() {
  return Boolean(
    config.energiaCrmUrl &&
      config.energiaCrmIntegrationToken.length >= 32,
  );
}

function buildEnergiaCrmPayload(chat) {
  const answers = chat.bot.answers;
  const phone = phoneFromJid(chat.outboundJid || '');
  return {
    version: 1,
    eventId: `chatwoot:${config.chatwootAccountId}:conversation:${chat.conversationId}`,
    chatwoot: {
      accountId: Number(config.chatwootAccountId),
      contactId: Number(chat.contactId),
      conversationId: Number(chat.conversationId),
    },
    contact: {
      name: answers.contactName,
      company: answers.companyName,
      phone,
      document: String(answers.cnpj || '').replace(/\D/g, ''),
      city: answers.city,
    },
    lead: {
      product: answers.productName,
      monthlyBill: answers.energyValue,
      energySimulation: answers.energySimulation || null,
      estimatedMonthlySavings: answers.energySimulation?.monthlySavings ?? null,
      estimatedAnnualSavings: answers.energySimulation?.annualSavings ?? null,
      simulationStatus: answers.energySimulation?.status ?? null,
      simulationValidUntil: answers.energySimulation?.validity?.endsAt ?? null,
      summary: qualificationSummary(answers),
    },
  };
}

async function enqueueEnergiaCrmSync(chat) {
  if (chat.bot.answers.productKey !== 'energy') return;
  const payload = buildEnergiaCrmPayload(chat);
  state.crmOutbox[payload.eventId] = {
    payload,
    attempts: 0,
    nextAttemptAt: Date.now(),
    createdAt: new Date().toISOString(),
  };
  chat.crmSync = {
    status: energiaCrmConfigured() ? 'pending' : 'not_configured',
    eventId: payload.eventId,
    updatedAt: new Date().toISOString(),
  };
  await saveState();
  if (energiaCrmConfigured()) void flushEnergiaCrmOutbox();
}

async function sendEnergiaCrmLead(payload) {
  const response = await fetch(
    `${config.energiaCrmUrl}/api/integrations/chatwoot/leads`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.energiaCrmIntegrationToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`EnergiaVolt ${response.status}: ${body.slice(0, 300)}`);
  }
  return body ? JSON.parse(body) : {};
}

async function flushEnergiaCrmOutbox() {
  if (crmFlushRunning || !energiaCrmConfigured()) return;
  crmFlushRunning = true;
  try {
    const dueEntries = Object.entries(state.crmOutbox)
      .filter(([, job]) => Number(job.nextAttemptAt || 0) <= Date.now())
      .slice(0, 20);
    for (const [eventId, job] of dueEntries) {
      try {
        const result = await sendEnergiaCrmLead(job.payload);
        const chat = Object.values(state.chats).find(
          (item) =>
            Number(item.conversationId) ===
            Number(job.payload.chatwoot.conversationId),
        );
        if (chat) {
          chat.crmSync = {
            status: 'synced',
            eventId,
            clienteId: result.clienteId || null,
            oportunidadeId: result.oportunidadeId || null,
            updatedAt: new Date().toISOString(),
          };
        }
        delete state.crmOutbox[eventId];
        await saveState();
        logger.info(
          {
            conversationId: job.payload.chatwoot.conversationId,
            oportunidadeId: result.oportunidadeId,
          },
          'Lead sincronizado com o EnergiaVolt',
        );
      } catch (error) {
        job.attempts = Number(job.attempts || 0) + 1;
        const delayMs = Math.min(60 * 60 * 1000, 15000 * 2 ** (job.attempts - 1));
        job.nextAttemptAt = Date.now() + delayMs;
        job.lastError = String(error.message || error).slice(0, 500);
        job.updatedAt = new Date().toISOString();
        await saveState();
        logger.warn(
          {
            conversationId: job.payload.chatwoot.conversationId,
            attempts: job.attempts,
            delayMs,
            error: job.lastError,
          },
          'EnergiaVolt indisponível; sincronização será repetida',
        );
      }
    }
  } finally {
    crmFlushRunning = false;
  }
}

async function finishQualification(chat, jid, options = {}) {
  const bot = chat.bot;
  const product = PRODUCT_OPTIONS[bot.answers.productKey];
  const contactAttributes = {
    produto_interesse: product.name,
    cnpj: bot.answers.cnpj,
    razao_social: bot.answers.companyName,
    cidade_uf: bot.answers.city,
    origem_lead: 'WhatsApp',
  };
  if (bot.answers.lines) contactAttributes.quantidade_linhas = bot.answers.lines;
  if (bot.answers.energyValue) {
    contactAttributes.valor_conta_energia = bot.answers.energyValue;
  }
  if (bot.answers.energySimulation) {
    contactAttributes.media_consumo_energia_kwh = bot.answers.energySimulation.groups.reduce(
      (sum, group) => sum + Number(group.groupAverageKwh || 0),
      0,
    );
  }

  const summary = qualificationSummary(bot.answers);
  await updateContactAttributes(chat.contactId, contactAttributes);
  await mergeConversationAttributes(chat.conversationId, {
    status_lead: 'Em qualificação',
    proxima_acao: `Atendimento pela equipe ${product.team}`,
    resumo_atendimento: summary,
    ...(bot.answers.energySimulation
      ? energySimulationAttributes(bot.answers.energySimulation)
      : {}),
  });
  await mergeConversationLabels(chat.conversationId, ['novo-lead', product.label]);
  await assignConversationTeam(chat.conversationId, product.team);

  bot.stage = 'completed';
  bot.completed = true;
  bot.handoff = true;
  bot.completedAt = new Date().toISOString();
  await saveState();
  await enqueueEnergiaCrmSync(chat);
  await sendBotMessage(
    chat,
    jid,
    options.customerMessage
      || `Obrigado! Já registrei seus dados e encaminhei seu atendimento para nossa equipe de *${product.name}*.\n\nUm consultor continuará a conversa por aqui.`,
  );
  logger.info(
    { conversationId: chat.conversationId, product: product.name, team: product.team },
    'Lead qualificado e encaminhado',
  );
}

async function handoffToHuman(chat, jid, message) {
  chat.bot.handoff = true;
  chat.bot.stage = 'handoff';
  chat.bot.completedAt = new Date().toISOString();
  await mergeConversationAttributes(chat.conversationId, {
    status_lead: 'Em qualificação',
    proxima_acao: 'Atendimento humano solicitado',
  });
  await assignConversationTeam(chat.conversationId, 'vendas');
  await saveState();
  await sendBotMessage(
    chat,
    jid,
    message
      || 'Certo! Encaminhei sua conversa para um de nossos atendentes. Assim que possível, alguém continuará o atendimento por aqui.',
  );
}

function upsertEnergyUnit(bot, invoice) {
  bot.answers.energyUnits ||= [];
  const normalized = {
    id: invoice.unitId,
    state: invoice.state,
    holderType: invoice.holderType,
    consumptionMonths: invoice.consumptionMonths,
    consumptions: invoice.consumptions,
    billTotal: invoice.billTotal,
    publicLighting: invoice.publicLighting,
    pisRate: invoice.pisRate,
    cofinsRate: invoice.cofinsRate,
    hasNis: invoice.hasNis,
    lowIncome: invoice.lowIncome,
    readable: invoice.readable,
    confidence: invoice.confidence,
    warnings: invoice.warnings,
  };
  const fingerprint = unit => unit.id
    ? `${unit.state}:${unit.id}`
    : `${unit.state}:${unit.billTotal}:${unit.consumptions?.[0] || ''}`;
  const existing = bot.answers.energyUnits.findIndex(
    unit => fingerprint(unit) === fingerprint(normalized),
  );
  if (existing >= 0) bot.answers.energyUnits[existing] = normalized;
  else bot.answers.energyUnits.push(normalized);
  return normalized;
}

async function analyzeEnergyInvoice(chat, jid, incomingMedia) {
  const bot = chat.bot;
  if (!incomingMedia) {
    await sendBotMessage(
      chat,
      jid,
      'Envie uma fatura em *PDF ou imagem*. Se já enviou todas as unidades, digite *CALCULAR*.',
    );
    return;
  }
  if (incomingMedia.unsupported) {
    await sendBotMessage(chat, jid, 'Use um arquivo PDF ou uma imagem JPG, PNG ou WEBP da fatura.');
    return;
  }
  if (incomingMedia.tooLarge) {
    await sendBotMessage(chat, jid, 'O arquivo está muito grande. Envie uma versão com até 15 MB.');
    return;
  }

  let invoice;
  try {
    invoice = await extractEnergyInvoice({
      buffer: incomingMedia.buffer,
      mimeType: incomingMedia.mimeType,
      apiKeys: config.geminiApiKeys,
      model: config.geminiModel,
    });
  } catch (error) {
    logger.warn(
      { conversationId: chat.conversationId, status: error.status, error: error.message },
      'Falha na leitura automática da fatura',
    );
    await handoffToHuman(
      chat,
      jid,
      'Não consegui concluir a leitura automática agora. Encaminhei a fatura para um atendente analisar sem você precisar reenviá-la.',
    );
    return;
  }

  if (!invoice.readable) {
    bot.energyReadAttempts = Number(bot.energyReadAttempts || 0) + 1;
    await saveState();
    if (bot.energyReadAttempts >= 2) {
      await handoffToHuman(
        chat,
        jid,
        'Ainda não consegui ler todos os dados com segurança. A fatura já está no atendimento e será analisada por uma pessoa.',
      );
      return;
    }
    await sendBotMessage(
      chat,
      jid,
      'A fatura ficou ilegível ou faltaram dados essenciais. Envie outra foto mais nítida, mostrando a página inteira, ou o PDF original.',
    );
    return;
  }

  bot.energyReadAttempts = 0;
  const unit = upsertEnergyUnit(bot, invoice);
  bot.stage = 'energy_more';
  await saveState();
  const average = unit.consumptions.reduce((sum, value) => sum + value, 0) / unit.consumptions.length;
  await sendBotMessage(
    chat,
    jid,
    `Fatura lida com segurança: *${unit.state}*, média de *${average.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} kWh/mês* e total de *${formatBrl(unit.billTotal)}*.\n\nEnvie a fatura de outra unidade ou digite *CALCULAR* para receber a simulação.`,
  );
}

async function completeEnergySimulation(chat, jid) {
  const units = chat.bot.answers.energyUnits || [];
  if (!units.length) {
    await sendBotMessage(chat, jid, 'Primeiro envie ao menos uma fatura em PDF ou imagem.');
    return;
  }
  const simulation = simulateEnergyDiscount({ units, simulatedAt: new Date() });
  const billTotal = units.reduce((sum, unit) => sum + Number(unit.billTotal || 0), 0);
  chat.bot.answers.energyValue = formatBrl(billTotal);
  chat.bot.answers.energySimulation = simulation;
  chat.bot.answers.energySimulationSummary = energySimulationSummary(simulation);
  await saveState();
  await finishQualification(chat, jid, {
    customerMessage: energySimulationCustomerMessage(simulation, units),
  });
}

async function processQualificationBot(chat, jid, text, incomingMedia = null) {
  if (!config.botEnabled) return;
  if (await humanAlreadyParticipated(chat)) return;

  if (!chat.bot || isMenuRequest(text)) {
    chat.bot = newBotState();
    await saveState();
    const directProduct = parseProduct(text);
    if (!directProduct) {
      await sendBotMessage(chat, jid, MENU_TEXT);
      return;
    }
  }

  const bot = chat.bot;
  if (bot.handoff) return;
  if (parseProduct(text) === 'handoff') {
    await handoffToHuman(chat, jid);
    return;
  }

  if (bot.stage === 'product') {
    const productKey = parseProduct(text);
    if (productKey === 'handoff') {
      await handoffToHuman(chat, jid);
      return;
    }
    if (!productKey) {
      await sendBotMessage(chat, jid, MENU_TEXT);
      return;
    }
    const product = PRODUCT_OPTIONS[productKey];
    bot.answers.productKey = productKey;
    bot.answers.productName = product.name;
    bot.stage = 'name';
    await saveState();
    await sendBotMessage(
      chat,
      jid,
      `Ótimo, vamos falar sobre *${product.name}*.\n\nPrimeiro, qual é o seu *nome*?`,
    );
    return;
  }

  if (bot.stage === 'name') {
    const contactName = String(text || '').trim();
    if (contactName.length < 2 || /\d{5,}/.test(contactName)) {
      await sendBotMessage(chat, jid, 'Por favor, informe seu nome.');
      return;
    }
    bot.answers.contactName = contactName.slice(0, 100);
    bot.stage = 'cnpj';
    await saveState();
    await updateContactName(chat.contactId, bot.answers.contactName);
    await sendBotMessage(
      chat,
      jid,
      'Informe o CNPJ da empresa (14 números). Se não tiver CNPJ, responda *não tenho*.',
    );
    return;
  }

  if (bot.stage === 'cnpj') {
    const cnpj = formatCnpj(text);
    if (!cnpj) {
      await sendBotMessage(
        chat,
        jid,
        'Não consegui identificar o CNPJ. Digite os 14 números ou responda *não tenho*.',
      );
      return;
    }
    bot.answers.cnpj = cnpj;
    bot.stage = 'company';
    await saveState();
    await updateContactAttributes(chat.contactId, {
      cnpj,
      produto_interesse: bot.answers.productName,
      origem_lead: 'WhatsApp',
    });
    await sendBotMessage(
      chat,
      jid,
      'Qual é o *nome ou razão social da empresa*?',
    );
    return;
  }

  if (bot.stage === 'company') {
    const companyName = String(text || '').trim();
    if (companyName.length < 2) {
      await sendBotMessage(chat, jid, 'Informe o nome ou a razão social da empresa.');
      return;
    }
    bot.answers.companyName = companyName.slice(0, 150);
    bot.stage = 'city';
    await saveState();
    await updateContactAttributes(chat.contactId, {
      razao_social: bot.answers.companyName,
    });
    await sendBotMessage(chat, jid, 'Qual é a sua *cidade e UF*? Exemplo: Salvador/BA');
    return;
  }

  if (bot.stage === 'city') {
    if (String(text || '').trim().length < 3) {
      await sendBotMessage(chat, jid, 'Informe a cidade e o estado. Exemplo: Salvador/BA');
      return;
    }
    bot.answers.city = String(text).trim().slice(0, 100);
    const product = PRODUCT_OPTIONS[bot.answers.productKey];
    bot.stage = product.nextStage === 'energy_invoice' && !config.geminiApiKeys.length
      ? 'energy_value'
      : product.nextStage;
    await saveState();
    await updateContactAttributes(chat.contactId, {
      cidade_uf: bot.answers.city,
    });
    if (bot.stage === 'lines') {
      await sendBotMessage(chat, jid, 'Quantas linhas móveis sua empresa precisa?');
    } else if (bot.stage === 'energy_invoice') {
      await sendBotMessage(
        chat,
        jid,
        'Envie sua *fatura de energia em PDF ou imagem*. Vou ler os últimos consumos, calcular o desconto e a economia anual.\n\nVocê pode enviar várias unidades, uma por vez. Ao enviar, você autoriza a análise automatizada da fatura exclusivamente para esta simulação. Não envie RG, CPF ou outros documentos pessoais nesta etapa.',
      );
    } else if (bot.stage === 'energy_value') {
      await sendBotMessage(
        chat,
        jid,
        'Qual é o valor médio mensal da sua conta de energia? Exemplo: R$ 1.500,00',
      );
    } else {
      await sendBotMessage(
        chat,
        jid,
        'Descreva brevemente o que você precisa para que o consultor já receba seu atendimento completo.',
      );
    }
    return;
  }

  if (bot.stage === 'lines') {
    const lines = parsePositiveInteger(text);
    if (!lines) {
      await sendBotMessage(chat, jid, 'Informe uma quantidade válida de linhas. Exemplo: 10');
      return;
    }
    bot.answers.lines = lines;
    await finishQualification(chat, jid);
    return;
  }

  if (bot.stage === 'energy_invoice' || bot.stage === 'energy_more') {
    if (isEnergyFinalize(text)) {
      await completeEnergySimulation(chat, jid);
      return;
    }
    await analyzeEnergyInvoice(chat, jid, incomingMedia);
    return;
  }

  // Compatibilidade com qualificações iniciadas antes da leitura automática.
  if (bot.stage === 'energy_value') {
    const energyValue = formatCurrency(text);
    if (!energyValue) {
      await sendBotMessage(chat, jid, 'Informe um valor válido. Exemplo: R$ 1.500,00');
      return;
    }
    bot.answers.energyValue = energyValue;
    await finishQualification(chat, jid);
    return;
  }

  if (bot.stage === 'need') {
    if (String(text || '').trim().length < 3) {
      await sendBotMessage(chat, jid, 'Conte em poucas palavras o que você precisa.');
      return;
    }
    bot.answers.need = String(text).trim().slice(0, 500);
    await finishQualification(chat, jid);
  }
}

async function handleIncoming(message) {
  const jid = message.key.remoteJid;
  if (
    !jid ||
    message.key.fromMe ||
    jid.endsWith('@g.us') ||
    jid === 'status@broadcast' ||
    processedMessages.has(message.key.id)
  ) {
    return;
  }

  processedMessages.add(message.key.id);
  if (processedMessages.size > 2000) {
    processedMessages.delete(processedMessages.values().next().value);
  }

  const phoneJid =
    message.key.remoteJidAlt?.endsWith('@s.whatsapp.net') ? message.key.remoteJidAlt : jid;
  let chat = await ensureConversation(jid, message.pushName, phoneJid);
  try {
    await createIncomingMessage(chat.conversationId, message, extractText(message));
  } catch (error) {
    if (!(error instanceof ChatwootRequestError) || error.status !== 404) throw error;
    delete state.chats[jid];
    await saveState();
    chat = await ensureConversation(jid, message.pushName, phoneJid);
    await createIncomingMessage(chat.conversationId, message, extractText(message));
  }
  state.historyImported[`${phoneJid}:${message.key.id}`] = messageTimestampSeconds(message);
  await saveState();
  const text = extractText(message);
  logger.info({ jid, conversationId: chat.conversationId }, 'Mensagem recebida no Chatwoot');
  await auditEvent('inbound_received', {
    conversationId: chat.conversationId,
    whatsappMessageId: message.key.id,
    jid: chat.outboundJid || phoneJid,
    contentLength: text.length,
    contentSha256: auditHash(text),
    hasMedia: Boolean(message.message && !text),
  });
  const energyStage = ['energy_invoice', 'energy_more'].includes(chat.bot?.stage);
  let incomingMedia = null;
  if (energyStage && mediaInfo(message)) {
    try {
      incomingMedia = await energyInvoiceMedia(message);
    } catch (error) {
      logger.warn(
        { conversationId: chat.conversationId, error: error.message },
        'Não foi possível baixar a fatura para análise',
      );
    }
  }
  await processQualificationBot(
    chat,
    chat.outboundJid || phoneJid,
    text,
    incomingMedia,
  );
}

function messageTimestampSeconds(message) {
  const value = Number(message?.messageTimestamp || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function importHistoricalMessage(message, contactsByJid) {
  const jid = message.key?.remoteJid;
  const messageId = message.key?.id;
  if (
    !jid ||
    !messageId ||
    jid.endsWith('@g.us') ||
    jid === 'status@broadcast' ||
    jid.endsWith('@newsletter')
  ) {
    return 'skipped';
  }

  const timestamp = messageTimestampSeconds(message);
  const cutoff = Date.now() / 1000 - config.historySyncDays * 24 * 60 * 60;
  if (!timestamp || timestamp < cutoff) return 'skipped';

  const mappedPn = historyLidToPn.get(jid);
  const phoneJid =
    message.key.remoteJidAlt?.endsWith('@s.whatsapp.net')
      ? message.key.remoteJidAlt
      : phoneJidFromValue(mappedPn) || jid;
  const dedupeKey = `${phoneJid}:${messageId}`;
  if (state.historyImported[dedupeKey]) return 'duplicate';
  const contact = contactsByJid.get(jid) || contactsByJid.get(phoneJid) || {};
  const pushName = contact.name || contact.notify || message.pushName || phoneFromJid(phoneJid);
  const chat = await ensureConversation(jid, pushName, phoneJid, { historical: true });
  const text = extractText(message);
  const options = {
    messageType: message.key.fromMe ? 'outgoing' : 'incoming',
    externalCreatedAt: new Date(timestamp * 1000).toISOString(),
    contentAttributes: {
      baileys_history_import: true,
      whatsapp_original_timestamp: timestamp,
      original_direction: message.key.fromMe ? 'outgoing' : 'incoming',
    },
  };

  try {
    await createIncomingMessage(chat.conversationId, message, text, options);
  } catch (error) {
    if (!mediaInfo(message)) throw error;
    await chatwootRequest(
      `/api/v1/accounts/${config.chatwootAccountId}/conversations/${chat.conversationId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          content: text || '[Mídia antiga indisponível para download]',
          message_type: options.messageType,
          private: false,
          content_type: 'text',
          content_attributes: {
            ...options.contentAttributes,
            whatsapp_message_id: messageId,
            media_download_failed: true,
          },
          external_created_at: options.externalCreatedAt,
          source_id: messageId,
        }),
      },
    );
  }

  state.historyImported[dedupeKey] = timestamp;
  await auditEvent('history_message_imported', {
    conversationId: chat.conversationId,
    whatsappMessageId: messageId,
    jid: phoneJid,
    direction: options.messageType,
    originalTimestamp: timestamp,
    contentLength: text.length,
    contentSha256: auditHash(text),
  });
  return 'imported';
}

async function importHistoryChunk({
  contacts = [],
  messages = [],
  lidPnMappings = [],
  progress,
  syncType,
  isLatest,
}) {
  if (config.historySyncDays <= 0) return;
  for (const mapping of lidPnMappings) {
    if (mapping.lid && mapping.pn) historyLidToPn.set(mapping.lid, mapping.pn);
  }
  for (const contact of contacts) {
    if (contact.id) historyContacts.set(contact.id, contact);
    if (contact.lid) historyContacts.set(contact.lid, contact);
  }

  state.historyStats.startedAt ||= new Date().toISOString();
  state.historyStats.received = Number(state.historyStats.received || 0) + messages.length;
  const sorted = [...messages].sort(
    (left, right) => messageTimestampSeconds(left) - messageTimestampSeconds(right),
  );
  let processedInChunk = 0;
  for (const message of sorted) {
    try {
      const result = await importHistoricalMessage(message, historyContacts);
      state.historyStats[result] = Number(state.historyStats[result] || 0) + 1;
    } catch (error) {
      state.historyStats.failed = Number(state.historyStats.failed || 0) + 1;
      state.historyStats.lastError = String(error.message || error).slice(0, 500);
      logger.error(
        { err: error, messageId: message.key?.id },
        'Falha ao importar mensagem histórica',
      );
    }
    processedInChunk += 1;
    if (processedInChunk % 25 === 0) await saveState();
  }
  state.historyStats.progress = progress ?? state.historyStats.progress ?? null;
  state.historyStats.syncType = syncType ?? state.historyStats.syncType ?? null;
  state.historyStats.isLatest = Boolean(isLatest);
  state.historyStats.updatedAt = new Date().toISOString();
  await saveState();
  logger.info(
    {
      received: messages.length,
      imported: state.historyStats.imported || 0,
      failed: state.historyStats.failed || 0,
      progress,
      isLatest,
    },
    'Lote de histórico processado',
  );
}

function phoneJidFromPayload(payload) {
  const candidates = [
    payload.conversation?.additional_attributes?.whatsapp_phone_jid,
    payload.conversation?.meta?.sender?.phone_number,
    payload.meta?.sender?.phone_number,
    payload.sender?.phone_number,
    payload.conversation?.contact_inbox?.source_id,
    payload.contact_inbox?.source_id,
  ];
  for (const candidate of candidates) {
    const jid = phoneJidFromValue(candidate);
    if (jid) return jid;
  }
  return null;
}

async function findJid(payload) {
  const conversationId = Number(payload.conversation?.id || payload.conversation_id);
  const mapped = Object.entries(state.chats).find(
    ([, chat]) => Number(chat.conversationId) === conversationId,
  );
  if (mapped) {
    const storedPhoneJid =
      phoneJidFromValue(mapped[1].outboundJid) ||
      phoneJidFromValue(mapped[1].sourceId);
    if (storedPhoneJid) return storedPhoneJid;
  }

  const payloadPhoneJid = phoneJidFromPayload(payload);
  if (payloadPhoneJid) return payloadPhoneJid;

  const explicitJid =
    payload.conversation?.additional_attributes?.whatsapp_phone_jid ||
    payload.conversation?.additional_attributes?.whatsapp_jid ||
    payload.meta?.sender?.additional_attributes?.whatsapp_jid;
  const explicitPhoneJid = phoneJidFromValue(explicitJid);
  if (explicitPhoneJid) return explicitPhoneJid;

  if (conversationId) {
    const conversation = await chatwootRequest(
      `/api/v1/accounts/${config.chatwootAccountId}/conversations/${conversationId}`,
    );
    const conversationPhoneJid = phoneJidFromPayload({ conversation });
    if (conversationPhoneJid) {
      if (mapped) {
        mapped[1].outboundJid = conversationPhoneJid;
        await saveState();
      }
      return conversationPhoneJid;
    }
  }

  return null;
}

async function sendAttachment(jid, attachment, caption) {
  const url = attachment.data_url || attachment.file_url;
  if (!url) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Falha ao baixar anexo do Chatwoot: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const declaredType = attachment.file_type || '';
  const mimeType = declaredType.includes('/')
    ? declaredType
    : response.headers.get('content-type') || '';

  if (declaredType === 'image' || mimeType.startsWith('image/')) {
    await sendWhatsAppMessage(jid, { image: buffer, caption });
  } else if (declaredType === 'video' || mimeType.startsWith('video/')) {
    await sendWhatsAppMessage(jid, { video: buffer, caption });
  } else if (declaredType === 'audio' || mimeType.startsWith('audio/')) {
    if (caption) await sendWhatsAppMessage(jid, { text: caption });
    await sendWhatsAppMessage(jid, { audio: buffer, mimetype: mimeType, ptt: false });
  } else {
    await sendWhatsAppMessage(jid, {
      document: buffer,
      mimetype: mimeType || 'application/octet-stream',
      fileName: attachment.file_name || 'arquivo',
      caption,
    });
  }
}

function rememberSentMessage(message) {
  if (!message?.key?.id) return;
  sentMessages.set(message.key.id, message);
  if (sentMessages.size > 2000) {
    sentMessages.delete(sentMessages.keys().next().value);
  }
}

async function validateWhatsAppJid(jid) {
  const normalizedJid = phoneJidFromValue(jid);
  if (!normalizedJid) throw new Error(`Número de WhatsApp inválido: ${jid}`);

  const cached = registeredJids.get(normalizedJid);
  if (cached && cached.expiresAt > Date.now()) return cached.jid;

  const [result] = (await socket.onWhatsApp(normalizedJid)) || [];
  if (!result?.exists) {
    throw new Error(`O número ${normalizedJid.split('@')[0]} não possui WhatsApp`);
  }

  const registeredJid = phoneJidFromValue(result.jid) || normalizedJid;
  registeredJids.set(normalizedJid, {
    jid: registeredJid,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  return registeredJid;
}

function isRetryableWhatsAppError(error) {
  const message = String(error?.message || '').toLowerCase();
  const statusCode = Number(error?.output?.statusCode || error?.statusCode || 0);
  return (
    [500, 503].includes(statusCode) ||
    message.includes('service-unavailable') ||
    message.includes('internal server error') ||
    message.includes('connection')
  );
}

async function sendWhatsAppMessage(jid, content) {
  const registeredJid = await validateWhatsAppJid(jid);
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const message = await socket.sendMessage(registeredJid, content);
      rememberSentMessage(message);
      if (message?.key?.id) {
        state.historyImported[`${registeredJid}:${message.key.id}`] = Math.floor(Date.now() / 1000);
      }
      return message;
    } catch (error) {
      lastError = error;
      if (!isRetryableWhatsAppError(error) || attempt === 3) throw error;
      const delayMs = attempt * 1500;
      logger.warn(
        { jid: registeredJid, attempt, delayMs, error: error.message },
        'Envio temporariamente indisponível; tentando novamente',
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

const globalSendTimes = [];
const recipientSendTimes = new Map();

function localDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function rateLimitDelay(job) {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;
  while (globalSendTimes.length && globalSendTimes[0] <= oneMinuteAgo) {
    globalSendTimes.shift();
  }
  const recipientTimes = recipientSendTimes.get(job.jid) || [];
  while (recipientTimes.length && recipientTimes[0] <= oneMinuteAgo) {
    recipientTimes.shift();
  }
  recipientSendTimes.set(job.jid, recipientTimes);

  const day = localDay();
  if (state.sendLimits.day !== day) state.sendLimits = { day, agents: {} };
  state.sendLimits.agents ||= {};
  const agentKey = String(job.agentId || job.agentName || 'unknown');
  const dailyTotal = Number(state.sendLimits.agents[agentKey] || 0);

  if (dailyTotal >= config.agentDailyLimit) return 15 * 60_000;
  if (globalSendTimes.length >= config.globalPerMinute) {
    return Math.max(1000, globalSendTimes[0] + 60_000 - now);
  }
  if (recipientTimes.length >= config.recipientPerMinute) {
    return Math.max(1000, recipientTimes[0] + 60_000 - now);
  }
  return 0;
}

function recordRateUsage(job) {
  const now = Date.now();
  globalSendTimes.push(now);
  const recipientTimes = recipientSendTimes.get(job.jid) || [];
  recipientTimes.push(now);
  recipientSendTimes.set(job.jid, recipientTimes);
  const agentKey = String(job.agentId || job.agentName || 'unknown');
  state.sendLimits.agents[agentKey] = Number(state.sendLimits.agents[agentKey] || 0) + 1;
}

async function deliverOutboundJob(job) {
  const attachments = job.attachments || [];
  if (attachments.length) {
    for (const [index, attachment] of attachments.entries()) {
      const caption = index === 0 ? job.formattedContent : '';
      if (
        index === 0 &&
        !caption &&
        job.agentName &&
        config.prefixAgentName &&
        (attachment.file_type === 'audio' || attachment.content_type?.startsWith('audio/'))
      ) {
        await sendWhatsAppMessage(job.jid, { text: `*${job.agentName}:*` });
      }
      await sendAttachment(job.jid, attachment, caption);
    }
  } else if (job.formattedContent) {
    await sendWhatsAppMessage(job.jid, { text: job.formattedContent });
  }
}

async function flushOutboundQueue() {
  if (outboundFlushRunning || connectionStatus !== 'connected' || !socket) return;
  outboundFlushRunning = true;
  try {
    const jobs = Object.values(state.outboundQueue || {})
      .filter((job) => Number(job.nextAttemptAt || 0) <= Date.now())
      .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
    const job = jobs[0];
    if (!job) return;

    const delay = rateLimitDelay(job);
    if (delay > 0) {
      job.nextAttemptAt = Date.now() + delay;
      job.lastError = 'Aguardando limite seguro de envio';
      await auditEvent('outbound_rate_limited', {
        chatwootMessageId: job.messageId,
        conversationId: job.conversationId,
        jid: job.jid,
        agentId: job.agentId,
        delayMs: delay,
      });
      await saveState();
      return;
    }

    try {
      await deliverOutboundJob(job);
      recordRateUsage(job);
      delete state.outboundQueue[job.key];
      state.outboundDelivered[job.key] = Date.now();
      const deliveredKeys = Object.keys(state.outboundDelivered);
      for (const oldKey of deliveredKeys.slice(0, Math.max(0, deliveredKeys.length - 2000))) {
        delete state.outboundDelivered[oldKey];
      }
      await auditEvent('outbound_human_sent', {
        chatwootMessageId: job.messageId,
        conversationId: job.conversationId,
        jid: job.jid,
        agentId: job.agentId,
        agentName: job.agentName,
        contentLength: job.formattedContent.length,
        contentSha256: auditHash(job.formattedContent),
        attachmentCount: job.attachments.length,
      });
      logger.info(
        { jid: job.jid, messageId: job.messageId, agentName: job.agentName },
        'Resposta enviada ao WhatsApp',
      );
      await saveState();
    } catch (error) {
      job.attempts = Number(job.attempts || 0) + 1;
      job.lastError = String(error.message || error).slice(0, 500);
      job.nextAttemptAt =
        Date.now() + Math.min(60 * 60_000, Math.max(5_000, 5_000 * 2 ** job.attempts));
      await auditEvent('outbound_send_failed', {
        chatwootMessageId: job.messageId,
        conversationId: job.conversationId,
        jid: job.jid,
        agentId: job.agentId,
        attempts: job.attempts,
        error: job.lastError,
      });
      await saveState();
      logger.error({ err: error, messageId: job.messageId }, 'Resposta mantida na fila para retry');
    }
  } finally {
    outboundFlushRunning = false;
  }
}

async function handleChatwootWebhook(payload) {
  const payloadInboxId = Number(
    payload.inbox?.id || payload.conversation?.inbox_id || payload.inbox_id || 0,
  );
  if (
    payload.event !== 'message_created' ||
    !isOutgoingMessage(payload) ||
    payload.private === true ||
    payload.content_attributes?.baileys_bot === true ||
    payload.content_attributes?.baileys_history_import === true ||
    (payloadInboxId > 0 && payloadInboxId !== config.chatwootInboxId)
  ) {
    return { ignored: true };
  }
  const jid = await findJid(payload);
  if (!jid) throw new Error('Não foi possível identificar o destinatário');

  const conversationId = Number(payload.conversation?.id || payload.conversation_id);
  const agentId = humanAgentIdFromMessage(payload, config.chatwootBotUserId);
  const agentName = agentNameFromPayload(payload);
  const normalizedJid = phoneJidFromValue(jid);
  const relatedEntries = Object.entries(state.chats).filter(
    ([, chat]) =>
      Number(chat.conversationId) === conversationId ||
      (normalizedJid &&
        phoneJidFromValue(chat.outboundJid || chat.sourceId) === normalizedJid),
  );
  if (relatedEntries.length) {
    for (const [, chat] of relatedEntries) {
      chat.conversationId = conversationId;
      chat.inboxId = config.chatwootInboxId;
      if (normalizedJid) chat.outboundJid = normalizedJid;
      markHumanManaged(chat);
    }
  } else {
    const mappedChat = {
      conversationId,
      inboxId: config.chatwootInboxId,
      outboundJid: normalizedJid,
    };
    markHumanManaged(mappedChat);
    state.chats[normalizedJid || jid] = mappedChat;
  }
  await saveState();
  logger.info(
    {
      conversationId,
      jid: normalizedJid || jid,
      aliasesBlocked: Math.max(1, relatedEntries.length),
    },
    'Chatbot desativado pela participaÃ§Ã£o de agente',
  );

  if (agentId) {
    const ownershipResults = await Promise.allSettled([
      assignConversationAgent(conversationId, agentId),
      mergeConversationAttributes(conversationId, {
        atendimento_humano_ativo: true,
        agente_responsavel_id: agentId,
        agente_responsavel_nome: agentName || `Agente ${agentId}`,
      }),
    ]);
    const ownershipErrors = ownershipResults
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason?.message || String(result.reason));
    if (ownershipErrors.length) {
      logger.warn(
        { conversationId, agentId, errors: ownershipErrors },
        'Mensagem serÃ¡ enviada, mas a atribuiÃ§Ã£o automÃ¡tica ficou incompleta',
      );
    } else {
      logger.info(
        { conversationId, agentId, agentName },
        'Conversa atribuÃ­da automaticamente ao agente que iniciou ou respondeu',
      );
    }
  }

  const formattedContent = formatAgentMessage(
    payload.content,
    payload,
    config.prefixAgentName,
  );
  const attachments = payload.attachments || [];
  const key = String(payload.id || `${conversationId}-${auditHash(formattedContent).slice(0, 16)}`);
  if (state.outboundDelivered[key]) return { sent: true, duplicate: true };
  if (state.outboundQueue[key]) return { queued: true, duplicate: true };

  state.outboundQueue[key] = {
    key,
    messageId: payload.id || null,
    conversationId,
    jid,
    agentId: payload.sender?.id || payload.user?.id || null,
    agentName,
    formattedContent,
    attachments,
    attempts: 0,
    createdAt: Date.now(),
    nextAttemptAt: Date.now(),
    lastError: null,
  };
  await saveState();
  void flushOutboundQueue();
  return { queued: true, connected: connectionStatus === 'connected' };
}

function authorized(request) {
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  return bearer === config.adminToken || request.query.token === config.adminToken;
}

app.get('/health', (_request, response) => {
  response.status(200).json({ ok: true, status: connectionStatus });
});

app.get('/status', (request, response) => {
  if (!authorized(request)) return response.status(401).json({ error: 'Não autorizado' });
  return response.json({
    status: connectionStatus,
    connectedNumber: socket?.user?.id || null,
    qrAvailable: Boolean(currentQr),
    pendingOutbound: Object.keys(state.outboundQueue || {}).length,
    pendingCrmSync: Object.keys(state.crmOutbox || {}).length,
  });
});

app.get('/operations/status', (request, response) => {
  if (!authorized(request)) return response.status(401).json({ error: 'NÃ£o autorizado' });
  const outbound = Object.values(state.outboundQueue || {});
  return response.json({
    connection: connectionStatus,
    connectedNumber: socket?.user?.id || null,
    pendingOutbound: outbound.length,
    failedOutbound: outbound.filter((job) => Number(job.attempts || 0) > 0).length,
    oldestOutboundAt: outbound.length
      ? new Date(Math.min(...outbound.map((job) => Number(job.createdAt)))).toISOString()
      : null,
    pendingCrmSync: Object.keys(state.crmOutbox || {}).length,
    rateLimits: {
      globalPerMinute: config.globalPerMinute,
      recipientPerMinute: config.recipientPerMinute,
      agentDailyLimit: config.agentDailyLimit,
    },
    auditRetentionDays: config.auditRetentionDays,
    history: {
      enabled: config.historySyncDays > 0,
      days: config.historySyncDays,
      ...state.historyStats,
    },
    invoiceReading: {
      configured: config.geminiApiKeys.length > 0,
      keyCount: config.geminiApiKeys.length,
      model: config.geminiModel,
      maxBytes: config.energyInvoiceMaxBytes,
    },
  });
});

app.get('/history/status', (request, response) => {
  if (!authorized(request)) return response.status(401).json({ error: 'Não autorizado' });
  return response.json({
    enabled: config.historySyncDays > 0,
    days: config.historySyncDays,
    importedIds: Object.keys(state.historyImported || {}).length,
    ...state.historyStats,
  });
});

app.get('/crm-sync/status', (request, response) => {
  if (!authorized(request)) return response.status(401).json({ error: 'Não autorizado' });
  const jobs = Object.values(state.crmOutbox || {});
  return response.json({
    configured: energiaCrmConfigured(),
    pending: jobs.length,
    jobs: jobs.slice(0, 20).map((job) => ({
      conversationId: job.payload?.chatwoot?.conversationId,
      attempts: Number(job.attempts || 0),
      nextAttemptAt: job.nextAttemptAt
        ? new Date(job.nextAttemptAt).toISOString()
        : null,
      lastError: job.lastError || null,
    })),
  });
});

app.post('/crm-sync/retry', async (request, response) => {
  if (!authorized(request)) return response.status(401).json({ error: 'Não autorizado' });
  for (const job of Object.values(state.crmOutbox || {})) {
    job.nextAttemptAt = Date.now();
  }
  await saveState();
  void flushEnergiaCrmOutbox();
  return response.json({ accepted: true, pending: Object.keys(state.crmOutbox).length });
});

app.post('/energy/simulate', (request, response) => {
  if (!authorized(request)) return response.status(401).json({ error: 'Não autorizado' });
  try {
    return response.json(simulateEnergyDiscount(request.body));
  } catch (error) {
    return response.status(422).json({ error: error.message });
  }
});

app.get('/qr.png', async (request, response, next) => {
  try {
    if (!authorized(request)) return response.status(401).json({ error: 'Não autorizado' });
    if (!currentQr) return response.status(409).json({ error: 'QR Code indisponível' });
    const png = await QRCode.toBuffer(currentQr, { width: 600, margin: 2 });
    response.type('png').send(png);
  } catch (error) {
    next(error);
  }
});

app.get('/qr.ansi', (request, response) => {
  if (!authorized(request)) return response.status(401).send('Não autorizado\n');
  if (!currentQr) return response.status(409).send('QR Code indisponível. Verifique o status.\n');
  qrcodeTerminal.generate(currentQr, { small: true }, (qr) => response.type('text').send(qr));
});

app.post('/webhooks/chatwoot', async (request, response, next) => {
  try {
    if (!authorized(request)) return response.status(401).json({ error: 'Não autorizado' });
    return response.json(await handleChatwootWebhook(request.body));
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  logger.error({ err: error }, 'Erro na API do gateway');
  response.status(500).json({ error: error.message });
});

async function startWhatsApp() {
  clearTimeout(reconnectTimer);
  connectionStatus = 'connecting';
  const { state: authState, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  socket = makeWASocket({
    version,
    auth: authState,
    logger: baileysLogger,
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false,
    syncFullHistory: config.historySyncDays > 0,
    shouldSyncHistoryMessage: () => config.historySyncDays > 0,
    generateHighQualityLinkPreview: false,
    getMessage: async (key) => sentMessages.get(key.id)?.message,
  });

  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('messaging-history.set', (history) => {
    historyImportQueue = historyImportQueue
      .then(() => importHistoryChunk(history))
      .catch((error) => logger.error({ err: error }, 'Falha ao processar lote de histórico'));
  });
  socket.ev.on('messaging-history.status', (historyStatus) => {
    state.historyStats.status = historyStatus.status;
    state.historyStats.explicitCompletion = historyStatus.explicit;
    state.historyStats.statusUpdatedAt = new Date().toISOString();
    void saveState();
  });
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const message of messages) {
      try {
        await handleIncoming(message);
      } catch (error) {
        logger.error({ err: error, messageId: message.key.id }, 'Falha ao importar mensagem');
      }
    }
  });

  socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQr = qr;
      connectionStatus = 'qr';
      logger.info('QR Code disponível. Execute ./scripts/baileys-qr.sh');
    }
    if (connection === 'open') {
      currentQr = null;
      connectionStatus = 'connected';
      void auditEvent('connection_open', { connectedNumber: socket.user?.id || null });
      void flushOutboundQueue();
      logger.info({ user: socket.user }, 'WhatsApp conectado');
    }
    if (connection === 'close') {
      currentQr = null;
      const statusCode = new Boom(lastDisconnect?.error).output.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      connectionStatus = loggedOut ? 'logged_out' : 'reconnecting';
      void auditEvent('connection_closed', { statusCode, loggedOut });
      logger.warn({ statusCode, loggedOut }, 'Conexão com WhatsApp encerrada');
      if (!loggedOut) reconnectTimer = setTimeout(startWhatsApp, 5000);
    }
  });
}

await loadState();
await cleanOldAuditFiles();
app.listen(config.port, '0.0.0.0', () => {
  logger.info({ port: config.port }, 'Gateway Baileys iniciado');
});
const crmSyncTimer = setInterval(() => {
  void flushEnergiaCrmOutbox();
}, 30000);
crmSyncTimer.unref();
const outboundTimer = setInterval(() => {
  void flushOutboundQueue();
}, 2000);
outboundTimer.unref();
if (Object.keys(state.crmOutbox).length > 0) {
  if (energiaCrmConfigured()) {
    void flushEnergiaCrmOutbox();
  } else {
    logger.warn(
      { pending: Object.keys(state.crmOutbox).length },
      'Há leads de Energia pendentes, mas a integração com o CRM não está configurada',
    );
  }
}
startWhatsApp().catch((error) => {
  connectionStatus = 'error';
  logger.fatal({ err: error }, 'Não foi possível iniciar o Baileys');
});
