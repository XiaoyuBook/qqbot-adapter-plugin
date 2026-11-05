import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureIncomingCard } from '../src/card-capture.js';

const payload = () => ({ op: 0, s: 7, t: 'GROUP_MESSAGE_CREATE', id: 'event-test', d: {
  id: 'message-test', group_openid: 'group-test', author: { member_openid: 'user-test' }, message_type: 3,
  content: 'card summary', ark_data: { fields: { title: 'title', preview: 'https://example.test/cover' } },
  provider_extension: { original: { target: 'https://example.test/watch?id=video' } },
  message_scene: { ext: ['msg_idx=index-test', 'auth_token=credential-test'] }
} });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-card-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, now: () => 1000 };
}
async function request(f, value = { mode: 'gateway-card', requestedAt: 1000, expiresAt: 86401000 }) {
  await fs.writeFile(path.join(f.directory, 'card-diagnostic-request.json'), JSON.stringify(value));
}
async function snapshot(f) { return JSON.parse(await fs.readFile(path.join(f.directory, 'card-diagnostic-result.json'), 'utf8')); }

test('raw card capture requires explicit gateway opt-in and a bounded unexpired request', async t => {
  const f = await fixture(t);
  assert.equal(await captureIncomingCard(payload(), f), false);
  for (const value of [{}, { requestedAt: 1000, expiresAt: 2000 },
    { mode: 'gateway-card', requestedAt: 1001, expiresAt: 2000 },
    { mode: 'gateway-card', requestedAt: 0, expiresAt: 1000 },
    { mode: 'gateway-card', requestedAt: 1000, expiresAt: 86401001 },
    { mode: 'gateway-card', requestedAt: 1000, expiresAt: '2000' }]) {
    await request(f, value); assert.equal(await captureIncomingCard(payload(), f), false);
  }
  assert.deepEqual(await fs.readdir(f.directory), ['card-diagnostic-request.json']);
});

test('one private pre-mapping envelope retains every field and cannot be overwritten by concurrent events', async t => {
  const f = await fixture(t); await request(f);
  const input = payload();
  const outcomes = await Promise.all(Array.from({ length: 4 }, () => captureIncomingCard(input, f)));
  assert.equal(outcomes.filter(Boolean).length, 1);
  const result = await snapshot(f);
  assert.deepEqual(result, { schemaVersion: 2, capturedAt: 1000, stage: 'gateway-before-mapping', payload: input });
  const target = path.join(f.directory, 'card-diagnostic-result.json');
  if (process.platform !== 'win32') assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(f.directory), ['card-diagnostic-result.json']);
  await request(f); assert.equal(await captureIncomingCard({ ...payload(), s: 8 }, f), false);
  assert.deepEqual(await snapshot(f), result);
});

test('gateway envelope is copied synchronously before downstream code mutates raw fields', async t => {
  const f = await fixture(t); await request(f);
  const input = payload(), expected = structuredClone(input);
  const pending = captureIncomingCard(input, f);
  input.d.provider_extension.original.target = 'changed'; delete input.d.ark_data; input.d.message_scene.ext.length = 0;
  assert.equal(await pending, true);
  assert.deepEqual((await snapshot(f)).payload, expected);
});

test('raw capture observes cards in alternate current-message carriers without needing a successful mapping', async t => {
  for (const d of [
    { message_type: 3, content: 'not a JSON object' },
    { content: '', embeds: [{ url: 'https://example.test/target' }] },
    { content: '', message: [{ type: 'json', data: '{"url":"https://example.test/target"}' }] },
    { message_type: 101, msg_elements: [{ message_type: 3, ark_data: { fields: {} } }] },
    { parallel_message: { msg_nodes: [{ message_type: 3, ark_data: { fields: {} } }] } }
  ]) {
    const f = await fixture(t); await request(f); const input = { ...payload(), d };
    assert.equal(await captureIncomingCard(input, f), true);
    assert.deepEqual((await snapshot(f)).payload, input);
  }
});

test('non-message events, bot messages, ordinary text, references and history do not consume a request', async t => {
  const f = await fixture(t); await request(f);
  for (const input of [null, { ...payload(), t: 'READY' }, { ...payload(), t: 'INTERACTION_CREATE' },
    { ...payload(), d: { ...payload().d, author: { bot: true } } },
    { ...payload(), d: { content: 'ordinary text' } },
    { ...payload(), d: { message_type: 103, msg_elements: [{ message_type: 3 }] } },
    { ...payload(), d: { message_type: 102, msg_elements: [{ message_type: 3 }] } }
  ]) assert.equal(await captureIncomingCard(input, f), false);
  assert.deepEqual(await fs.readdir(f.directory), ['card-diagnostic-request.json']);
});

test('oversized, cyclic and invalid request data fail without writing a snapshot', async t => {
  const f = await fixture(t); await request(f);
  const big = payload(); big.d.content = 'x'.repeat(1048576);
  assert.equal(await captureIncomingCard(big, f), false);
  const cyclic = payload(); cyclic.d.extra = cyclic;
  assert.equal(await captureIncomingCard(cyclic, f), false);
  await fs.writeFile(path.join(f.directory, 'card-diagnostic-request.json'), 'x'.repeat(1025));
  assert.equal(await captureIncomingCard(payload(), f), false);
  await fs.writeFile(path.join(f.directory, 'card-diagnostic-request.json'), 'invalid JSON');
  assert.equal(await captureIncomingCard(payload(), f), false);
  assert.deepEqual(await fs.readdir(f.directory), ['card-diagnostic-request.json']);
});

test('an armed window permits a delayed test and stays disarmed after its captured file is removed', async t => {
  const f = await fixture(t); await request(f); f.now = () => 1000 + 35 * 60 * 1000;
  assert.equal(await captureIncomingCard(payload(), f), true);
  await fs.unlink(path.join(f.directory, 'card-diagnostic-result.json'));
  assert.equal(await captureIncomingCard(payload(), f), false);
});
