import assert from 'node:assert/strict';
import {
  extractEnergyInvoice,
  normalizeInvoiceExtraction,
  parseGeminiApiKeys,
} from '../src/energy-invoice.js';

assert.deepEqual(parseGeminiApiKeys('key-a, key-b\nkey-a'), ['key-a', 'key-b']);

assert.deepEqual(normalizeInvoiceExtraction({
  readable: true,
  confidence: 0.95,
  unitId: '123',
  state: 'ba',
  holderType: 'company',
  consumptions: [{ month: 'jul/26', kwh: 812 }, { month: 'jun/26', kwh: 958 }],
  billTotal: 1207.15,
  invoiceItemsTotal: null,
  publicLighting: 145.58,
  pisRate: 1.22,
  cofinsRate: 5.62,
  hasNis: false,
  lowIncome: false,
  warnings: [],
}), {
  readable: true,
  confidence: 0.95,
  unitId: '123',
  state: 'BA',
  holderType: 'company',
  consumptionMonths: [{ month: 'jul/26', kwh: 812 }, { month: 'jun/26', kwh: 958 }],
  consumptions: [812, 958],
  billTotal: 1207.15,
  publicLighting: 145.58,
  pisRate: 1.22,
  cofinsRate: 5.62,
  hasNis: false,
  lowIncome: false,
  warnings: [],
});

const zeroHeaderTotal = normalizeInvoiceExtraction({
  readable: true,
  confidence: 0.96,
  unitId: '20218587',
  state: 'BA',
  holderType: 'person',
  consumptions: [{ month: 'ago/26', kwh: 2466 }],
  billTotal: 0,
  invoiceItemsTotal: 3003.56,
  publicLighting: 60,
  pisRate: 0.98,
  cofinsRate: 4.54,
  hasNis: false,
  lowIncome: false,
  warnings: [],
});
assert.equal(zeroHeaderTotal.billTotal, 3003.56);
assert.match(zeroHeaderTotal.warnings[0], /TOTAL A PAGAR estava zerado/);

const requests = [];
const extracted = await extractEnergyInvoice({
  buffer: Buffer.from('fake-image'),
  mimeType: 'image/jpeg',
  apiKeys: ['exhausted', 'working'],
  fetchImpl: async (_url, options) => {
    requests.push(options);
    if (requests.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        readable: true,
        confidence: 0.9,
        unitId: 'UC-2',
        state: 'PE',
        holderType: 'person',
        consumptions: [{ month: 'ago/26', kwh: 500 }],
        billTotal: 600,
        invoiceItemsTotal: 600,
        publicLighting: 50,
        pisRate: null,
        cofinsRate: null,
        hasNis: false,
        lowIncome: false,
        warnings: [],
      }) }] } }],
    }), { status: 200 });
  },
});
assert.equal(requests.length, 2);
assert.equal(requests[0].headers['x-goog-api-key'], 'exhausted');
assert.equal(requests[1].headers['x-goog-api-key'], 'working');
assert.equal(extracted.state, 'PE');
assert.equal(extracted.keySlot, 2);

console.log('energy-invoice: ok');
