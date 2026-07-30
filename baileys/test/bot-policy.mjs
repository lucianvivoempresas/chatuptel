import assert from 'node:assert/strict';
import {
  assignedHumanAgentId,
  hasHumanAgentMessage,
  hasPersistentHumanMarker,
  humanAgentIdFromMessage,
  isBotAuthoredMessage,
  isOutgoingMessage,
  markHumanManaged,
  suppressQualificationBot,
} from '../src/bot-policy.js';

assert.equal(suppressQualificationBot({}), false);
assert.equal(suppressQualificationBot({ humanManaged: true }), true);
assert.equal(suppressQualificationBot({ bot: { handoff: true } }), true);
assert.equal(isOutgoingMessage({ message_type: 'outgoing' }), true);
assert.equal(isOutgoingMessage({ message_type: 1 }), true);
assert.equal(hasPersistentHumanMarker({ custom_attributes: {} }), false);
assert.equal(
  hasPersistentHumanMarker({ custom_attributes: { atendimento_humano_ativo: true } }),
  true,
);
assert.equal(
  assignedHumanAgentId({ meta: { assignee: { id: 7, type: 'User' } } }, 22),
  7,
);
assert.equal(
  assignedHumanAgentId({ meta: { assignee: { id: 22, type: 'User' } } }, 22),
  null,
);
assert.equal(
  hasPersistentHumanMarker(
    {
      custom_attributes: {},
      meta: { assignee: { id: 7, type: 'User', name: 'Yasmin Magalhaes' } },
    },
    22,
  ),
  true,
);
assert.equal(
  humanAgentIdFromMessage({
    message_type: 'outgoing',
    private: false,
    sender: { id: 7, type: 'User', name: 'Lucian Oliveira' },
    content_attributes: {},
  }),
  7,
);
assert.equal(
  humanAgentIdFromMessage(
    {
      message_type: 'outgoing',
      private: false,
      sender: { id: 22, type: 'User', name: 'Assistente Uptel Conecta' },
      content_attributes: {},
    },
    22,
  ),
  null,
);

const chat = { bot: { stage: 'name', handoff: false } };
markHumanManaged(chat, '2026-07-29T12:00:00.000Z');
assert.equal(chat.humanManaged, true);
assert.equal(chat.bot.handoff, true);
assert.equal(chat.bot.stage, 'human');
assert.equal(
  isBotAuthoredMessage({
    sender: { id: 22, type: 'User', name: 'Assistente Uptel Conecta' },
    content_attributes: {},
  }),
  true,
);
assert.equal(
  isBotAuthoredMessage(
    {
      sender: { id: 22, type: 'User', name: 'Outro nome' },
      content_attributes: {},
    },
    22,
  ),
  true,
);

assert.equal(
  hasHumanAgentMessage([
    {
      message_type: 'outgoing',
      private: false,
      sender: { type: 'User' },
      content_attributes: {},
    },
  ]),
  true,
);
assert.equal(
  hasHumanAgentMessage([
    {
      message_type: 1,
      private: false,
      sender: { type: 'User' },
      content_attributes: { baileys_bot: true },
    },
    {
      message_type: 1,
      private: false,
      sender: { type: 'User' },
      content_attributes: { baileys_history_import: true },
    },
    {
      message_type: 'incoming',
      private: false,
      sender: { type: 'Contact' },
      content_attributes: {},
    },
  ]),
  false,
);

console.log('bot-policy: ok');
