import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject, normalizeText, renderTranscript } from '../src/server.js';

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
