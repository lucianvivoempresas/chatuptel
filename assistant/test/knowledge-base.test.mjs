import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKnowledgeBase,
  formatKnowledgeContext,
  knowledgeSources,
  knowledgeDocumentState,
  parseKnowledgeDocument,
  rankKnowledgeChunks,
} from '../src/knowledge-base.js';

const repositoryKnowledge = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../knowledge',
);

const document = parseKnowledgeDocument(`---
id: energia-regras
title: Regras de Energia
version: 2.1.0
status: active
updated_at: 2026-08-28
products: energia
states: BA, PE
tags: desconto, fatura
---
# Desconto

Na Bahia, a faixa informada aplica desconto de dezoito por cento.
`, 'energia.md');

test('parseKnowledgeDocument reads approved metadata without external dependencies', () => {
  assert.equal(document.id, 'energia-regras');
  assert.equal(document.status, 'active');
  assert.deepEqual(document.states, ['BA', 'PE']);
});

test('rankKnowledgeChunks prioritizes title, tags and relevant text', () => {
  const results = rankKnowledgeChunks([
    {
      id: 'energia#1', documentId: 'energia-regras', title: document.title,
      heading: 'Desconto', version: document.version, products: document.products,
      states: document.states, tags: document.tags, text: document.body, filename: 'energia.md',
    },
    {
      id: 'internet#1', documentId: 'internet', title: 'Internet', heading: 'Instalação',
      version: '1.0.0', products: ['internet'], states: [], tags: ['fibra'],
      text: 'Consulte a cobertura antes de oferecer.', filename: 'internet.md',
    },
  ], 'qual desconto de energia para cliente da Bahia?');
  assert.equal(results[0].documentId, 'energia-regras');
  assert.equal(results.length, 1);
});

test('formatKnowledgeContext identifies sources and versions', () => {
  const results = [{
    id: 'energia#1', documentId: 'energia-regras', title: 'Regras de Energia',
    heading: 'Desconto', version: '2.1.0', products: ['energia'], states: ['BA'],
    tags: ['desconto'], text: 'Aplicar a tabela aprovada.', filename: 'energia.md', score: 8,
  }];
  assert.match(formatKnowledgeContext(results), /FONTE 1: Regras de Energia/);
  assert.deepEqual(knowledgeSources(results), [{
    id: 'energia-regras', title: 'Regras de Energia', version: '2.1.0',
  }]);
});

test('draft documents remain distinguishable for the loader to ignore', () => {
  const draft = parseKnowledgeDocument(`---
id: oferta-futura
title: Oferta futura
status: draft
---
Não aprovado.
`);
  assert.equal(draft.status, 'draft');
});

test('monthly documents are used only inside their validity window', () => {
  const monthly = parseKnowledgeDocument(`---
id: vivo-ofertas
title: Ofertas Vivo
status: active
valid_from: 2026-08-01
valid_until: 2026-08-31
---
Oferta mensal.
`);
  assert.equal(knowledgeDocumentState(monthly, '2026-08-28'), 'current');
  assert.equal(knowledgeDocumentState(monthly, '2026-09-01'), 'expired');
});

test('versioned repository knowledge loads without errors and ignores template drafts', async () => {
  const base = createKnowledgeBase({ directory: repositoryKnowledge, cacheMs: 0 });
  const status = await base.status();
  assert.equal(status.available, true);
  assert.equal(status.documents, 7);
  assert.equal(status.ignored.draft, 0);
  assert.deepEqual(status.errors, []);
  const results = await base.search('Qual desconto para 5200 kWh em Pernambuco?');
  assert.equal(results[0].documentId, 'energia-origo-regras');
  assert.match(results[0].text, /30%/);
});
