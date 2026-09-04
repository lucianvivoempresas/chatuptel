import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildZylooPayload,
  buildOpenAiPayload,
  catalogPriceFallback,
  chooseZylooModel,
  extractJsonObject,
  needsCatalogPriceFallback,
  normalizeText,
  parseWhatsAppRegistry,
  renderTranscript,
} from '../src/server.js';

test('parseWhatsAppRegistry accepts only safe unique gateway descriptors', () => {
  const rows = [
    'vendas2\tVendas 2\t7',
    '../invasor\tInválido\t8',
    'suporte\tSuporte\t9',
    'sem-id\tSem caixa\t0',
  ].join('\n');
  assert.deepEqual(parseWhatsAppRegistry(rows), [
    { slug: 'vendas2', name: 'Vendas 2', inboxId: 7, service: 'baileys-vendas2', configuredMode: 'active' },
    { slug: 'suporte', name: 'Suporte', inboxId: 9, service: 'baileys-suporte', configuredMode: 'active' },
  ]);
});

test('extractJsonObject accepts fenced model output', () => {
  assert.deepEqual(extractJsonObject('```json\n{"suggested_reply":"Olá"}\n```'), { suggested_reply: 'Olá' });
});

test('normalizeText removes control characters and limits length', () => {
  assert.equal(normalizeText('  olá\u0000 mundo  ', 8), 'olá mund');
});

test('renderTranscript excludes private notes and caps content', () => {
  const transcript = renderTranscript({ payload: [
    { message_type: 0, content: 'Preciso de energia', private: false },
    { message_type: 1, content: 'nota secreta', private: true },
    { message_type: 1, content: 'Posso ajudar', private: false, sender: { name: 'Ana' } },
  ] });
  assert.match(transcript, /Cliente: Preciso de energia/);
  assert.match(transcript, /Atendente \(Ana\): Posso ajudar/);
  assert.doesNotMatch(transcript, /nota secreta/);
});

test('buildZylooPayload uses the documented request format and output limit', () => {
  const messages = [{ role: 'user', content: 'Olá' }];
  const payload = buildZylooPayload(messages);
  assert.deepEqual(payload.messages, messages);
  assert.equal(payload.model, 'zyloo/gpt-4.1');
  assert.equal(payload.max_tokens, 700);
  assert.deepEqual(Object.keys(payload).sort(), ['max_tokens', 'messages', 'model']);
});

test('buildOpenAiPayload uses a small output budget and low reasoning', () => {
  const messages = [{ role: 'user', content: 'Olá' }];
  const payload = buildOpenAiPayload(messages, 'gpt-5.6-luna');
  assert.equal(payload.model, 'gpt-5.6-luna');
  assert.equal(payload.max_completion_tokens, 450);
  assert.equal(payload.reasoning_effort, 'low');
  assert.deepEqual(payload.messages, messages);
});

test('chooseZylooModel migrates the retired free alias', () => {
  assert.equal(
    chooseZylooModel('zyloo/gpt-4.1-free', ['zyloo/gpt-4.1', 'zyloo/gpt-4o']),
    'zyloo/gpt-4.1'
  );
});

test('chooseZylooModel preserves a configured model that is available', () => {
  assert.equal(
    chooseZylooModel('zyloo/gpt-5.6-terra', ['zyloo/gpt-4.1', 'zyloo/gpt-5.6-terra']),
    'zyloo/gpt-5.6-terra'
  );
});

test('catalog questions fall back to approved price rows when the model omits them', () => {
  const context = '- Plano 6 GB: R$ 39,99.\n- Plano 15 GB: R$ 54,99.\n- Plano 20 GB: R$ 59,99.';
  assert.equal(
    needsCatalogPriceFallback('Quais os planos e valores?', context, 'Os valores mensais são:'),
    true,
  );
  const results = [
    { documentId: 'vivo', heading: 'Planos', text: context },
    { documentId: 'vivo', heading: 'Planos', text: 'Valores válidos até o fim do mês.' },
    { documentId: 'limites', heading: 'Limites', text: 'Validar disponibilidade.' },
  ];
  assert.match(catalogPriceFallback(results), /R\$ 39,99/);
  assert.match(catalogPriceFallback(results), /fim do mês/);
  assert.doesNotMatch(catalogPriceFallback(results), /Validar disponibilidade/);
});
