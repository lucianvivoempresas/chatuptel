import { createKnowledgeBase } from './knowledge-base.js';
import { fileURLToPath } from 'node:url';

const directory = process.env.KNOWLEDGE_BASE_DIR || fileURLToPath(new URL('../../knowledge', import.meta.url));
const base = createKnowledgeBase({ directory, cacheMs: 0 });
const status = await base.status();

console.log(JSON.stringify({ directory, ...status }, null, 2));
if (!status.available || status.errors.length) process.exitCode = 1;
