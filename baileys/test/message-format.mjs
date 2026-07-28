import assert from 'node:assert/strict';
import { agentNameFromPayload, formatAgentMessage } from '../src/message-format.js';

const payload = {
  sender: {
    id: 7,
    name: 'Lucian Oliveira',
    type: 'user',
  },
};

assert.equal(agentNameFromPayload(payload), 'Lucian Oliveira');
assert.equal(
  formatAgentMessage('Olá! Como posso ajudar?', payload),
  '*Lucian Oliveira:*\nOlá! Como posso ajudar?',
);
assert.equal(formatAgentMessage('Mensagem sem prefixo', payload, false), 'Mensagem sem prefixo');
assert.equal(
  formatAgentMessage('*Lucian Oliveira:*\nMensagem pronta', payload),
  '*Lucian Oliveira:*\nMensagem pronta',
);
assert.equal(formatAgentMessage('Mensagem automática', {}), 'Mensagem automática');
assert.equal(
  formatAgentMessage('Teste', { sender: { name: '*Agente* _Teste_' } }),
  '*Agente Teste:*\nTeste',
);

console.log('Formatação do nome do agente validada.');
