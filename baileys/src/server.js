import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import express from 'express';
import { Boom } from '@hapi/boom';
import makeWASocket, {
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
import { agentNameFromPayload, formatAgentMessage } from './message-format.js';
import {
  MENU_TEXT,
  PRODUCT_OPTIONS,
  formatCnpj,
  formatCurrency,
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

const config = {
  port: Number(process.env.PORT || 3001),
  authDir: process.env.BAILEYS_AUTH_DIR || '/data/auth',
  stateFile: process.env.BAILEYS_STATE_FILE || '/data/state.json',
  adminToken: required('BAILEYS_ADMIN_TOKEN'),
  chatwootUrl: (process.env.CHATWOOT_URL || 'http://rails:3000').replace(/\/$/, ''),
  chatwootAccountId: required('CHATWOOT_ACCOUNT_ID'),
  chatwootInboxId: Number(required('CHATWOOT_INBOX_ID')),
  chatwootApiToken: required('CHATWOOT_API_TOKEN'),
  defaultCountryCode: (process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '55').replace(/\D/g, ''),
  prefixAgentName: !['false', '0', 'no'].includes(
    String(process.env.WHATSAPP_PREFIX_AGENT_NAME || 'true').toLowerCase(),
  ),
  botEnabled: !['false', '0', 'no'].includes(
    String(process.env.WHATSAPP_BOT_ENABLED || 'true').toLowerCase(),
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
let state = { chats: {} };
const processedMessages = new Set();
const registeredJids = new Map();
const sentMessages = new Map();
const teamIds = new Map();

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
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await saveState();
  }
}

async function saveState() {
  await fs.mkdir(path.dirname(config.stateFile), { recursive: true });
  const temporary = `${config.stateFile}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2));
  await fs.rename(temporary, config.stateFile);
}

async function chatwootRequest(endpoint, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('api_access_token', config.chatwootApiToken);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(`${config.chatwootUrl}${endpoint}`, {
    ...options,
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

async function ensureConversation(jid, pushName, phoneJid = jid) {
  const outboundJid = phoneJidFromValue(phoneJid);
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
  contact = await ensureWhatsAppLeadOrigin(contact);

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
        status: 'open',
        custom_attributes: {
          status_lead: 'Novo',
        },
        additional_attributes: {
          whatsapp_jid: jid,
          whatsapp_phone_jid: outboundJid,
          provider: 'baileys',
        },
      }),
    },
  );

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

async function createIncomingMessage(conversationId, message, text) {
  const media = mediaInfo(message);
  if (!media) {
    return chatwootRequest(
      `/api/v1/accounts/${config.chatwootAccountId}/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          content: text,
          message_type: 'incoming',
          private: false,
          content_type: 'text',
          content_attributes: { whatsapp_message_id: message.key.id },
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
  form.append('message_type', 'incoming');
  form.append('private', 'false');
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

function newBotState() {
  return {
    stage: 'product',
    answers: {},
    handoff: false,
    completed: false,
  };
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
    answers.need && `Necessidade: ${answers.need}`,
  ]
    .filter(Boolean)
    .join(' | ');
}

async function finishQualification(chat, jid) {
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

  const summary = qualificationSummary(bot.answers);
  await updateContactAttributes(chat.contactId, contactAttributes);
  await mergeConversationAttributes(chat.conversationId, {
    status_lead: 'Em qualificação',
    proxima_acao: `Atendimento pela equipe ${product.team}`,
    resumo_atendimento: summary,
  });
  await mergeConversationLabels(chat.conversationId, ['novo-lead', product.label]);
  await assignConversationTeam(chat.conversationId, product.team);

  bot.stage = 'completed';
  bot.completed = true;
  bot.handoff = true;
  bot.completedAt = new Date().toISOString();
  await saveState();
  await sendBotMessage(
    chat,
    jid,
    `Obrigado! Já registrei seus dados e encaminhei seu atendimento para nossa equipe de *${product.name}*.\n\nUm consultor continuará a conversa por aqui.`,
  );
  logger.info(
    { conversationId: chat.conversationId, product: product.name, team: product.team },
    'Lead qualificado e encaminhado',
  );
}

async function handoffToHuman(chat, jid) {
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
    'Certo! Encaminhei sua conversa para um de nossos atendentes. Assim que possível, alguém continuará o atendimento por aqui.',
  );
}

async function processQualificationBot(chat, jid, text) {
  if (!config.botEnabled) return;

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
    bot.stage = product.nextStage;
    await saveState();
    await updateContactAttributes(chat.contactId, {
      cidade_uf: bot.answers.city,
    });
    if (bot.stage === 'lines') {
      await sendBotMessage(chat, jid, 'Quantas linhas móveis sua empresa precisa?');
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
  logger.info({ jid, conversationId: chat.conversationId }, 'Mensagem recebida no Chatwoot');
  await processQualificationBot(chat, chat.outboundJid || phoneJid, extractText(message));
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

async function handleChatwootWebhook(payload) {
  const payloadInboxId = Number(
    payload.inbox?.id || payload.conversation?.inbox_id || payload.inbox_id || 0,
  );
  if (
    payload.event !== 'message_created' ||
    payload.message_type !== 'outgoing' ||
    payload.private === true ||
    payload.content_attributes?.baileys_bot === true ||
    (payloadInboxId > 0 && payloadInboxId !== config.chatwootInboxId)
  ) {
    return { ignored: true };
  }
  if (connectionStatus !== 'connected' || !socket) {
    throw new Error('WhatsApp desconectado');
  }

  const jid = await findJid(payload);
  if (!jid) throw new Error('Não foi possível identificar o destinatário');

  const conversationId = Number(payload.conversation?.id || payload.conversation_id);
  const mappedChat = Object.values(state.chats).find(
    (chat) => Number(chat.conversationId) === conversationId,
  );
  if (mappedChat?.bot && !mappedChat.bot.handoff) {
    mappedChat.bot.handoff = true;
    mappedChat.bot.stage = 'human';
    mappedChat.bot.handoffAt = new Date().toISOString();
    await saveState();
  }

  const agentName = agentNameFromPayload(payload);
  const formattedContent = formatAgentMessage(
    payload.content,
    payload,
    config.prefixAgentName,
  );
  const attachments = payload.attachments || [];
  if (attachments.length) {
    for (const [index, attachment] of attachments.entries()) {
      const caption = index === 0 ? formattedContent : '';
      if (
        index === 0 &&
        !caption &&
        agentName &&
        config.prefixAgentName &&
        (attachment.file_type === 'audio' || attachment.content_type?.startsWith('audio/'))
      ) {
        await sendWhatsAppMessage(jid, { text: `*${agentName}:*` });
      }
      await sendAttachment(jid, attachment, caption);
    }
  } else if (formattedContent) {
    await sendWhatsAppMessage(jid, { text: formattedContent });
  }
  logger.info({ jid, messageId: payload.id, agentName }, 'Resposta enviada ao WhatsApp');
  return { sent: true };
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
  });
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
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async (key) => sentMessages.get(key.id)?.message,
  });

  socket.ev.on('creds.update', saveCreds);
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
      logger.info({ user: socket.user }, 'WhatsApp conectado');
    }
    if (connection === 'close') {
      currentQr = null;
      const statusCode = new Boom(lastDisconnect?.error).output.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      connectionStatus = loggedOut ? 'logged_out' : 'reconnecting';
      logger.warn({ statusCode, loggedOut }, 'Conexão com WhatsApp encerrada');
      if (!loggedOut) reconnectTimer = setTimeout(startWhatsApp, 5000);
    }
  });
}

await loadState();
app.listen(config.port, '0.0.0.0', () => {
  logger.info({ port: config.port }, 'Gateway Baileys iniciado');
});
startWhatsApp().catch((error) => {
  connectionStatus = 'error';
  logger.fatal({ err: error }, 'Não foi possível iniciar o Baileys');
});
