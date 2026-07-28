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
  if (
    state.chats[jid]?.conversationId &&
    Number(state.chats[jid].inboxId) === config.chatwootInboxId
  ) {
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
            additional_attributes: { whatsapp_jid: jid, provider: 'baileys' },
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
        additional_attributes: { whatsapp_jid: jid, provider: 'baileys' },
      }),
    },
  );

  state.chats[jid] = {
    contactId,
    sourceId,
    conversationId: conversation.id,
    inboxId: config.chatwootInboxId,
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
}

function findJid(payload) {
  const conversationId = Number(payload.conversation?.id || payload.conversation_id);
  const mapped = Object.entries(state.chats).find(
    ([, chat]) => Number(chat.conversationId) === conversationId,
  );
  if (mapped) return mapped[0];

  const explicitJid =
    payload.conversation?.additional_attributes?.whatsapp_jid ||
    payload.meta?.sender?.additional_attributes?.whatsapp_jid;
  if (explicitJid) return explicitJid;

  const phone = payload.meta?.sender?.phone_number?.replace(/\D/g, '');
  return phone ? `${phone}@s.whatsapp.net` : null;
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
    await socket.sendMessage(jid, { image: buffer, caption });
  } else if (declaredType === 'video' || mimeType.startsWith('video/')) {
    await socket.sendMessage(jid, { video: buffer, caption });
  } else if (declaredType === 'audio' || mimeType.startsWith('audio/')) {
    await socket.sendMessage(jid, { audio: buffer, mimetype: mimeType, ptt: false });
  } else {
    await socket.sendMessage(jid, {
      document: buffer,
      mimetype: mimeType || 'application/octet-stream',
      fileName: attachment.file_name || 'arquivo',
      caption,
    });
  }
}

async function handleChatwootWebhook(payload) {
  const payloadInboxId = Number(
    payload.inbox?.id || payload.conversation?.inbox_id || payload.inbox_id || 0,
  );
  if (
    payload.event !== 'message_created' ||
    payload.message_type !== 'outgoing' ||
    payload.private === true ||
    (payloadInboxId > 0 && payloadInboxId !== config.chatwootInboxId)
  ) {
    return { ignored: true };
  }
  if (connectionStatus !== 'connected' || !socket) {
    throw new Error('WhatsApp desconectado');
  }

  const jid = findJid(payload);
  if (!jid) throw new Error('Não foi possível identificar o destinatário');

  const attachments = payload.attachments || [];
  if (attachments.length) {
    for (const [index, attachment] of attachments.entries()) {
      await sendAttachment(jid, attachment, index === 0 ? payload.content || '' : '');
    }
  } else if (payload.content) {
    await socket.sendMessage(jid, { text: payload.content });
  }
  logger.info({ jid, messageId: payload.id }, 'Resposta enviada ao WhatsApp');
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
