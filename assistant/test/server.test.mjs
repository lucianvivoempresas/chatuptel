import test from 'node:test';
import assert from 'node:assert/strict';
import { buildZylooPayload, chooseZylooModel, extractJsonObject, normalizeText, renderTranscript } from '../src/server.js';

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

test('buildZylooPayload uses the documented minimal request format', () => {
  const messages = [{ role: 'user', content: 'Olá' }];
  const payload = buildZylooPayload(messages);
  assert.deepEqual(payload.messages, messages);
  assert.equal(payload.model, 'zyloo/gpt-4.1');
  assert.deepEqual(Object.keys(payload).sort(), ['messages', 'model']);
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
