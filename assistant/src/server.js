import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PORT = Number.parseInt(process.env.PORT || '3002', 10);
const CHATWOOT_URL = (process.env.CHATWOOT_URL || 'http://rails:3000').replace(/\/$/, '');
const ZYLOO_BASE_URL = (process.env.ZYLOO_BASE_URL || 'https://api.zyloo.io/v1').replace(/\/$/, '');
const ZYLOO_MODEL = process.env.ZYLOO_MODEL || 'zyloo/gpt-4.1';
const ZYLOO_API_KEY = process.env.ZYLOO_API_KEY || '';
const ZYLOO_MAX_TOKENS = Number.parseInt(process.env.ZYLOO_MAX_TOKENS || '700', 10);
const RATE_LIMIT = Number.parseInt(process.env.ASSISTANT_RATE_LIMIT_PER_MINUTE || '20', 10);
const MAX_BODY_BYTES = 32 * 1024;
const MAX_MESSAGES = 16;
const requestCounters = new Map();
let modelCache = { expiresAt: 0, model: null };
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function extractJsonObject(content) {
  if (typeof content !== 'string') return null;
  const withoutFence = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function normalizeText(value, maxLength = 4000) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function messageList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.payload)) return payload.payload;
  if (Array.isArray(payload?.data?.payload)) return payload.data.payload;
  return [];
}

export function renderTranscript(payload) {
  return messageList(payload)
    .filter(message => !message.private && normalizeText(message.content, 1))
    .slice(-MAX_MESSAGES)
    .map(message => {
      const direction = Number(message.message_type) === 0 || message.message_type === 'incoming'
        ? 'Cliente'
        : `Atendente${message.sender?.name ? ` (${normalizeText(message.sender.name, 80)})` : ''}`;
      return `${direction}: ${normalizeText(message.content, 1800)}`;
    })
    .join('\n');
}

function sendJson(response, status, body) {
  response.writeHead(status, jsonHeaders);
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Payload muito grande'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('JSON inválido'), { status: 400 });
  }
}

function chatwootAuthHeaders(request) {
  const allowed = ['access-token', 'token-type', 'client', 'expiry', 'uid'];
  return Object.fromEntries(
    allowed
      .map(name => [name, normalizeText(request.headers[name], 2048)])
      .filter(([, value]) => value)
  );
}

async function chatwootRequest(endpoint, authHeaders) {
  const response = await fetch(`${CHATWOOT_URL}${endpoint}`, {
    headers: { Accept: 'application/json', ...authHeaders },
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!response.ok) {
    const error = new Error(response.status === 401 ? 'Sessão do Chatwoot inválida' : 'Não foi possível consultar a conversa');
    error.status = response.status === 401 ? 401 : 502;
    throw error;
  }
  return body;
}

function checkRateLimit(identity) {
  const now = Date.now();
  const current = requestCounters.get(identity);
  if (!current || now - current.startedAt >= 60000) {
    requestCounters.set(identity, { startedAt: now, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > RATE_LIMIT) {
    throw Object.assign(new Error('Limite temporário do assistente atingido'), { status: 429 });
  }
}

async function loadConversation(request, body) {
  const accountId = Number.parseInt(body.accountId, 10);
  const conversationId = Number.parseInt(body.conversationId, 10);
  if (!Number.isInteger(accountId) || accountId <= 0 || !Number.isInteger(conversationId) || conversationId <= 0) {
    throw Object.assign(new Error('Conversa inválida'), { status: 400 });
  }

  const authHeaders = chatwootAuthHeaders(request);
  if (!authHeaders['access-token'] || !authHeaders.client || !authHeaders.uid) {
    throw Object.assign(new Error('Entre novamente no Chatwoot'), { status: 401 });
  }

  checkRateLimit(`${authHeaders.uid}:${accountId}`);
  const [conversation, messages] = await Promise.all([
    chatwootRequest(`/api/v1/accounts/${accountId}/conversations/${conversationId}`, authHeaders),
    chatwootRequest(`/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, authHeaders),
  ]);
  return { conversation, messages };
}

function conversationContext(conversation, messages) {
  const contact = conversation?.meta?.sender || conversation?.contact || {};
  const contactAttributes = contact.custom_attributes || {};
  const conversationAttributes = conversation?.custom_attributes || {};
  return [
    `Contato: ${normalizeText(contact.name || 'não informado', 120)}`,
    `Telefone: ${normalizeText(contact.phone_number || 'não informado', 80)}`,
    `Atributos do contato: ${normalizeText(JSON.stringify(contactAttributes), 1800)}`,
    `Atributos da conversa: ${normalizeText(JSON.stringify(conversationAttributes), 1800)}`,
    'Mensagens recentes:',
    renderTranscript(messages) || 'Nenhuma mensagem textual disponível.',
  ].join('\n');
}

async function askZyloo(messages) {
  if (!ZYLOO_API_KEY) throw Object.assign(new Error('A chave Zyloo ainda não foi configurada'), { status: 503 });
  const model = await resolveZylooModel();
  const payloadBody = buildZylooPayload(messages, model);
  const response = await fetch(`${ZYLOO_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ZYLOO_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payloadBody),
    signal: AbortSignal.timeout(45000),
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
  if (!response.ok) {
    const providerMessage = normalizeText(payload?.error?.message || payload?.message, 300);
    console.error(JSON.stringify({
      level: 'error',
      provider: 'zyloo',
      status: response.status,
      message: providerMessage || 'Resposta de erro sem detalhes',
    }));
    const errorMessage = response.status === 400
      ? `A Zyloo recusou a solicitação${providerMessage ? `: ${providerMessage}` : ''}`
      : response.status === 402
        ? 'Créditos Zyloo insuficientes. Recarregue a carteira da Zyloo para continuar.'
        : `Zyloo indisponível (HTTP ${response.status})`;
    const error = new Error(errorMessage);
    error.status = [402, 429].includes(response.status) ? response.status : 502;
    throw error;
  }
  return normalizeText(payload?.choices?.[0]?.message?.content, 8000);
}

export function chooseZylooModel(configuredModel, availableModels = []) {
  const configured = normalizeText(configuredModel, 160);
  const available = new Set(availableModels.map(model => normalizeText(model, 160)).filter(Boolean));
  if (available.has(configured)) return configured;

  const withoutFreeSuffix = configured.replace(/-free$/i, '');
  if (available.has(withoutFreeSuffix)) return withoutFreeSuffix;

  const preferred = ['zyloo/gpt-4.1', 'zyloo/gpt-5.6-terra', 'zyloo/gpt-4o'];
  const replacement = preferred.find(model => available.has(model));
  if (replacement) return replacement;

  // Mantém a migração conhecida mesmo se o catálogo estiver temporariamente
  // indisponível. O antigo gpt-4.1-free foi substituído por gpt-4.1.
  if (/^zyloo\/gpt-4\.1-free$/i.test(configured)) return 'zyloo/gpt-4.1';
  return configured || 'zyloo/gpt-4.1';
}

async function resolveZylooModel() {
  const now = Date.now();
  if (modelCache.model && modelCache.expiresAt > now) return modelCache.model;

  let availableModels = [];
  try {
    const response = await fetch(`${ZYLOO_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${ZYLOO_API_KEY}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) {
      const payload = await response.json();
      availableModels = Array.isArray(payload?.data) ? payload.data.map(model => model?.id) : [];
    }
  } catch (error) {
    console.warn(JSON.stringify({ level: 'warn', provider: 'zyloo', message: 'Catálogo de modelos temporariamente indisponível' }));
  }

  const model = chooseZylooModel(ZYLOO_MODEL, availableModels);
  modelCache = { model, expiresAt: now + (15 * 60 * 1000) };
  if (model !== ZYLOO_MODEL) {
    console.warn(JSON.stringify({ level: 'warn', provider: 'zyloo', configuredModel: ZYLOO_MODEL, selectedModel: model, message: 'Modelo configurado substituído por um modelo disponível' }));
  }
  return model;
}

export function buildZylooPayload(messages, model = ZYLOO_MODEL) {
  return { model, messages, max_tokens: ZYLOO_MAX_TOKENS };
}

async function createSuggestion(context) {
  const system = `Você é o Assistente Uptel, um copiloto interno para atendentes humanos da Uptel Conecta.
Responda sempre em português do Brasil. Não invente dados, preços, cobertura ou promessas.
Produza uma sugestão profissional, curta e natural. Nunca envie nada ao cliente e nunca afirme que executou ações.
Retorne somente JSON válido com as chaves suggested_reply, summary, interest, company e next_action.`;
  const content = await askZyloo([
    { role: 'system', content: system },
    { role: 'user', content: `Analise este atendimento e prepare a próxima resposta:\n\n${context}` },
  ]);
  const parsed = extractJsonObject(content);
  if (!parsed) {
    return {
      suggestedReply: content,
      summary: 'Resumo não estruturado pelo modelo.',
      interest: 'Não identificado',
      company: 'Não informada',
      nextAction: 'Revisar a resposta sugerida',
    };
  }
  return {
    suggestedReply: normalizeText(parsed.suggested_reply, 4000),
    summary: normalizeText(parsed.summary, 1500),
    interest: normalizeText(parsed.interest || 'Não identificado', 120),
    company: normalizeText(parsed.company || 'Não informada', 160),
    nextAction: normalizeText(parsed.next_action || 'Revisar com o cliente', 300),
  };
}

async function createChatAnswer(context, prompt) {
  return askZyloo([
    {
      role: 'system',
      content: 'Você é o Assistente Uptel, copiloto interno de um atendente. Responda em português do Brasil, seja objetivo, não invente informações e não afirme que enviou mensagens ou executou ações.',
    },
    { role: 'user', content: `Contexto do atendimento:\n${context}\n\nPergunta interna do atendente: ${normalizeText(prompt, 2000)}` },
  ]);
}

async function servePublic(response, filename, contentType) {
  const content = await readFile(path.join(publicDir, filename));
  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(content);
}

export async function handleRequest(request, response) {
  const url = new URL(request.url, 'http://localhost');
  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, { status: 'ok', zylooConfigured: Boolean(ZYLOO_API_KEY) });
    }
    if (request.method === 'GET' && url.pathname === '/uptel-assistant/embed.js') {
      return servePublic(response, 'embed.js', 'application/javascript; charset=utf-8');
    }
    if (request.method === 'GET' && url.pathname === '/uptel-assistant/api/status') {
      return sendJson(response, 200, { status: 'ok', configured: Boolean(ZYLOO_API_KEY) });
    }
    if (request.method === 'POST' && url.pathname === '/uptel-assistant/api/suggest') {
      const body = await readJsonBody(request);
      const { conversation, messages } = await loadConversation(request, body);
      return sendJson(response, 200, await createSuggestion(conversationContext(conversation, messages)));
    }
    if (request.method === 'POST' && url.pathname === '/uptel-assistant/api/chat') {
      const body = await readJsonBody(request);
      if (!normalizeText(body.prompt, 1)) throw Object.assign(new Error('Digite uma pergunta'), { status: 400 });
      const { conversation, messages } = await loadConversation(request, body);
      const answer = await createChatAnswer(conversationContext(conversation, messages), body.prompt);
      return sendJson(response, 200, { answer });
    }
    return sendJson(response, 404, { error: 'Recurso não encontrado' });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) console.error(JSON.stringify({ level: 'error', status, message: error.message }));
    return sendJson(response, status, { error: status === 500 ? 'Falha interna do assistente' : error.message });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer(handleRequest).listen(PORT, '0.0.0.0', () => {
    console.log(JSON.stringify({ level: 'info', port: PORT, message: 'Assistente Uptel iniciado' }));
  });
}
