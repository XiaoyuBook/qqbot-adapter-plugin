import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureIncomingCard } from '../src/card-capture.js';

const message = [{ type: 'json', data: JSON.stringify({ fields: { url: 'https://example.test/card?token=private' } }) }];
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-card-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, now: () => 1000 };
}
async function request(f, value = { requestedAt: 1000, expiresAt: 301000 }) {
  await fs.writeFile(path.join(f.directory, 'card-diagnostic-request.json'), JSON.stringify(value));
}

test('card capture is disabled by default and rejects invalid or expired requests', async t => {
  const f = await fixture(t);
  assert.equal(await captureIncomingCard(message, '', f), false);
  for (const value of [{}, { requestedAt: 1001, expiresAt: 2000 }, { requestedAt: 0, expiresAt: 1000 }, { requestedAt: 1000, expiresAt: 301001 }, { requestedAt: 1000, expiresAt: '2000' }]) {
    await request(f, value); assert.equal(await captureIncomingCard(message, '', f), false);
  }
  assert.deepEqual((await fs.readdir(f.directory)), ['card-diagnostic-request.json']);
});

test('one requested card is written exclusively without message identities or overwriting later samples', async t => {
  const f = await fixture(t); await request(f);
  const input = [{ type: 'at', qq: 123456 }, ...message];
  const outcomes = await Promise.all(Array.from({ length: 4 }, () => captureIncomingCard(input, 'body', f)));
  assert.equal(outcomes.filter(Boolean).length, 1);
  const target = path.join(f.directory, 'card-diagnostic-result.json');
  const result = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.deepEqual(result, { capturedAt: 1000, content: 'body', cards: [JSON.parse(message[0].data)] });
  assert.equal(JSON.stringify(result).includes('123456'), false);
  if (process.platform !== 'win32') assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  assert.equal(await captureIncomingCard(message, 'next', f), false);
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), result);
});

test('oversized and malformed samples and request files cannot create snapshots', async t => {
  const f = await fixture(t); await request(f);
  assert.equal(await captureIncomingCard(message, 'x'.repeat(64001), f), false);
  assert.equal(await captureIncomingCard([{ type: 'json', data: 'x'.repeat(64001) }], '', f), false);
  assert.equal(await captureIncomingCard([{ type: 'json', data: 'invalid JSON' }], '', f), false);
  assert.equal(await captureIncomingCard([], '', f), false);
  await fs.writeFile(path.join(f.directory, 'card-diagnostic-request.json'), 'x'.repeat(1025));
  assert.equal(await captureIncomingCard(message, '', f), false);
});

test('sample strings are copied before asynchronous IO so consumers may mutate their own message array', async t => {
  const f = await fixture(t); await request(f);
  const parts = message.map(part => ({ ...part }));
  const pending = captureIncomingCard(parts, '', f); parts[0].data = 'changed'; parts.length = 0;
  assert.equal(await pending, true);
  const result = JSON.parse(await fs.readFile(path.join(f.directory, 'card-diagnostic-result.json'), 'utf8'));
  assert.deepEqual(result.cards, [JSON.parse(message[0].data)]);
});
