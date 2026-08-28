import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const STOP_WORDS = new Set([
  'a', 'ao', 'aos', 'as', 'com', 'como', 'da', 'das', 'de', 'do', 'dos', 'e', 'em',
  'essa', 'esse', 'esta', 'este', 'eu', 'foi', 'mais', 'mas', 'na', 'nas', 'no', 'nos',
  'o', 'os', 'ou', 'para', 'por', 'que', 'se', 'sem', 'ser', 'um', 'uma', 'voce',
]);

function clean(value, maxLength = 4000) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, maxLength);
}

function fold(value) {
  return clean(value, 20000)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function tokens(value) {
  return fold(value)
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !STOP_WORDS.has(token));
}

function list(value) {
  return clean(value, 1000).split(',').map(item => item.trim()).filter(Boolean);
}

export function parseKnowledgeDocument(source, filename = 'documento.md') {
  const text = String(source || '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) throw new Error(`${filename}: metadados YAML ausentes`);
  const closing = text.indexOf('\n---\n', 4);
  if (closing < 0) throw new Error(`${filename}: metadados YAML incompletos`);
  const metadata = {};
  for (const line of text.slice(4, closing).split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  const id = clean(metadata.id || path.basename(filename, '.md'), 100);
  const title = clean(metadata.title, 180);
  const version = clean(metadata.version || '1.0.0', 30);
  const status = clean(metadata.status || 'draft', 20).toLowerCase();
  if (!id || !title) throw new Error(`${filename}: id e title são obrigatórios`);
  return {
    id,
    title,
    version,
    status,
    updatedAt: clean(metadata.updated_at, 20),
    validFrom: clean(metadata.valid_from, 20),
    validUntil: clean(metadata.valid_until, 20),
    sourcePeriod: clean(metadata.source_period, 30),
    products: list(metadata.products),
    states: list(metadata.states).map(value => value.toUpperCase()),
    tags: list(metadata.tags),
    body: text.slice(closing + 5).trim(),
    filename,
  };
}

function validDate(value) {
  return !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function knowledgeDocumentState(document, today = new Date().toISOString().slice(0, 10)) {
  if (document.status !== 'active') return 'draft';
  if (!validDate(document.validFrom) || !validDate(document.validUntil)) return 'invalid';
  if (document.validFrom && today < document.validFrom) return 'scheduled';
  if (document.validUntil && today > document.validUntil) return 'expired';
  return 'current';
}

function newestDocument(left, right) {
  const leftKey = `${left.updatedAt || ''}|${left.version || ''}|${left.filename}`;
  const rightKey = `${right.updatedAt || ''}|${right.version || ''}|${right.filename}`;
  return leftKey.localeCompare(rightKey) >= 0 ? left : right;
}

function splitDocument(document, maxChars = 1400) {
  const sections = [];
  let heading = document.title;
  let buffer = [];
  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) sections.push({ heading, body });
    buffer = [];
  };
  for (const line of document.body.split('\n')) {
    const match = line.match(/^#{1,4}\s+(.+)$/);
    if (match) {
      flush();
      heading = clean(match[1], 180);
      continue;
    }
    if (buffer.join('\n').length + line.length > maxChars) flush();
    buffer.push(line);
  }
  flush();
  return sections.map((section, index) => ({
    id: `${document.id}#${index + 1}`,
    documentId: document.id,
    title: document.title,
    heading: section.heading,
    version: document.version,
    products: document.products,
    states: document.states,
    tags: document.tags,
    text: section.body,
    filename: document.filename,
  }));
}

export function rankKnowledgeChunks(chunks, query, { maxResults = 5, maxChars = 6000 } = {}) {
  const queryTerms = [...new Set(tokens(query))].slice(0, 80);
  if (!queryTerms.length) return [];
  const ranked = chunks.map(chunk => {
    const body = fold(chunk.text);
    const heading = fold(`${chunk.title} ${chunk.heading}`);
    const labels = fold(`${chunk.products.join(' ')} ${chunk.states.join(' ')} ${chunk.tags.join(' ')}`);
    let score = 0;
    for (const term of queryTerms) {
      if (body.includes(term)) score += 1;
      if (heading.includes(term)) score += 3;
      if (labels.includes(term)) score += 4;
    }
    return { ...chunk, score };
  }).filter(chunk => chunk.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const selected = [];
  let usedChars = 0;
  for (const chunk of ranked) {
    if (selected.length >= maxResults || usedChars + chunk.text.length > maxChars) continue;
    selected.push(chunk);
    usedChars += chunk.text.length;
  }
  return selected;
}

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(target));
    else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_')) files.push(target);
  }
  return files.sort();
}

export function createKnowledgeBase({ directory, cacheMs = 30000, today = () => new Date().toISOString().slice(0, 10) } = {}) {
  let cache = { loadedAt: 0, documents: [], chunks: [], errors: [], ignored: {} };

  async function load(force = false) {
    if (!force && Date.now() - cache.loadedAt < cacheMs) return cache;
    const candidates = [];
    const errors = [];
    const ignored = { draft: 0, expired: 0, scheduled: 0, superseded: 0, invalid: 0 };
    try {
      for (const filename of await markdownFiles(directory)) {
        try {
          const document = parseKnowledgeDocument(await readFile(filename, 'utf8'), path.relative(directory, filename));
          const state = knowledgeDocumentState(document, today());
          if (state === 'current') candidates.push(document);
          else {
            ignored[state] += 1;
            if (state === 'invalid') errors.push(`${document.filename}: validade deve usar AAAA-MM-DD`);
          }
        } catch (error) {
          errors.push(clean(error.message, 300));
        }
      }
    } catch (error) {
      errors.push(`Base indisponível: ${clean(error.message, 240)}`);
    }
    const byId = new Map();
    for (const document of candidates) {
      if (!byId.has(document.id)) byId.set(document.id, document);
      else {
        byId.set(document.id, newestDocument(byId.get(document.id), document));
        ignored.superseded += 1;
      }
    }
    const documents = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    cache = {
      loadedAt: Date.now(),
      documents,
      chunks: documents.flatMap(document => splitDocument(document)),
      errors,
      ignored,
    };
    return cache;
  }

  return {
    async search(query, options) {
      const current = await load();
      return rankKnowledgeChunks(current.chunks, query, options);
    },
    async status() {
      const current = await load();
      let lastModified = null;
      try {
        const details = await stat(directory);
        lastModified = details.mtime.toISOString();
      } catch {}
      return {
        available: current.documents.length > 0,
        documents: current.documents.length,
        chunks: current.chunks.length,
        errors: current.errors,
        ignored: current.ignored,
        lastModified,
      };
    },
    reload() { return load(true); },
  };
}

export function formatKnowledgeContext(results) {
  if (!results.length) return 'Nenhum trecho relevante foi encontrado na base aprovada.';
  return results.map((item, index) => [
    `[FONTE ${index + 1}: ${item.title} | seção: ${item.heading} | versão: ${item.version}]`,
    item.text,
  ].join('\n')).join('\n\n');
}

export function knowledgeSources(results) {
  const unique = new Map();
  for (const item of results) {
    unique.set(item.documentId, {
      id: item.documentId,
      title: item.title,
      version: item.version,
    });
  }
  return [...unique.values()];
}
