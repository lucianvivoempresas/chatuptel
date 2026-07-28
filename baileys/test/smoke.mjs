import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const testDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'voltconect-baileys-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, ['src/server.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    BAILEYS_ADMIN_TOKEN: 'test-token',
    CHATWOOT_ACCOUNT_ID: '1',
    CHATWOOT_INBOX_ID: '1',
    CHATWOOT_API_TOKEN: 'test-api-token',
    BAILEYS_AUTH_DIR: path.join(testDirectory, 'auth'),
    BAILEYS_STATE_FILE: path.join(testDirectory, 'state.json'),
    BAILEYS_AUDIT_DIR: path.join(testDirectory, 'audit'),
    PORT: String(port),
    LOG_LEVEL: 'fatal',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  let health;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Gateway encerrou durante o teste:\n${output}`);
    }
    try {
      health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  assert.equal(health?.ok, true, output);

  const unauthorized = await fetch(`http://127.0.0.1:${port}/status`);
  assert.equal(unauthorized.status, 401);

  const status = await fetch(`http://127.0.0.1:${port}/status?token=test-token`);
  assert.equal(status.status, 200);
  assert.equal(typeof (await status.json()).status, 'string');

  const operations = await fetch(
    `http://127.0.0.1:${port}/operations/status?token=test-token`,
  );
  assert.equal(operations.status, 200);
  const operationsBody = await operations.json();
  assert.equal(operationsBody.pendingOutbound, 0);
  assert.equal(operationsBody.rateLimits.globalPerMinute, 60);
} finally {
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await fs.rm(testDirectory, { recursive: true, force: true });
}
