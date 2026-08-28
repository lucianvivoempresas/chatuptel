import assert from 'node:assert/strict';
import {
  canUseSdrAi,
  recordSdrAiUsage,
  refreshSdrMemory,
  sdrMemoryStats,
} from '../src/sdr-memory.js';

const bot = {
  stage: 'energy_more',
  answers: {
    contactName: 'Maria',
    productKey: 'energy',
    productName: 'Energia',
    city: 'Salvador/BA',
    energyUnits: [{ id: 'UC-1', state: 'BA', billTotal: 3000, consumptions: [2000, 2100, 2200, 2300, 2400, 2500, 9999] }],
  },
};
const memory = refreshSdrMemory(bot, new Date('2026-08-28T12:00:00Z'));
assert.equal(memory.facts.product, 'energy');
assert.deepEqual(memory.facts.energyUnits[0].consumptions, [2000, 2100, 2200, 2300, 2400, 2500]);
assert.match(memory.summary, /Salvador\/BA/);
assert.equal(JSON.stringify(memory).includes('PDF'), false);

assert.equal(canUseSdrAi(memory, { maxCalls: 1 }).allowed, true);
recordSdrAiUsage(memory, { promptTokens: 1000, completionTokens: 200, estimatedCostUsd: 0.001 });
assert.deepEqual(canUseSdrAi(memory, { maxCalls: 1 }), { allowed: false, reason: 'call_limit' });

const stats = sdrMemoryStats({ a: { bot }, b: {} });
assert.equal(stats.customers, 1);
assert.equal(stats.aiCalls, 1);
console.log('sdr-memory: ok');
