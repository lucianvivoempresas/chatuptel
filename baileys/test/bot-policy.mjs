import assert from 'node:assert/strict';
import {
  hasHumanAgentMessage,
  markHumanManaged,
  suppressQualificationBot,
} from '../src/bot-policy.js';

assert.equal(suppressQualificationBot({}), false);
assert.equal(suppressQualificationBot({ humanManaged: true }), true);
assert.equal(suppressQualificationBot({ bot: { handoff: true } }), true);

const chat = { bot: { stage: 'name', handoff: false } };
markHumanManaged(chat, '2026-07-29T12:00:00.000Z');
assert.equal(chat.humanManaged, true);
assert.equal(chat.bot.handoff, true);
assert.equal(chat.bot.stage, 'human');

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
