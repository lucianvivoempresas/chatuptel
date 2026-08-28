import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactTranscript,
  economicConversationContext,
  estimateTokenEnvelope,
} from '../src/economic-context.js';

test('economic context keeps structured memory and only the latest messages', () => {
  const conversation = {
    meta: { sender: {
      name: 'Maria',
      phone_number: '+5571000000000',
      custom_attributes: {
        produto_interesse: 'Energia',
        razao_social: 'Empresa Exemplo',
        campo_irrelevante: 'não deve entrar',
      },
    } },
    custom_attributes: {
      status_lead: 'Em qualificação',
      resumo_atendimento: 'Simulação concluída',
      segredo_interno: 'não deve entrar',
    },
  };
  const messages = { payload: Array.from({ length: 10 }, (_, index) => ({
    message_type: index % 2,
    content: `mensagem ${index}`,
    private: false,
  })) };
  const context = economicConversationContext(conversation, messages, { maxMessages: 4, maxMessageChars: 40 });
  assert.match(context, /Produto: Energia/);
  assert.match(context, /Resumo persistente: Simulação concluída/);
  assert.doesNotMatch(context, /campo_irrelevante|segredo_interno|mensagem 5/);
  assert.match(context, /mensagem 6/);
  assert.equal(compactTranscript(messages, { maxMessages: 2 }).split('\n').length, 2);
  assert.ok(estimateTokenEnvelope(context) < 300);
});
