import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { imageSource, PassiveReply } from '../src/reply.js';
import { AdapterError } from '../src/errors.js';
import { fixture, payload, png, fakeApi, config, quietLogger } from './helpers.js';

test('text, native segment array, Buffer image upload, srv_send_msg=false and linked msg_seq', async () => {
  const f = fixture(); const e = await f.mapper.dispatch(payload());
  const result = await e.reply(['text', { type: 'text', text: 'more' }, { type: 'image', file: png }]);
  assert.deepEqual(f.api.calls.map(c => c.route.split('/').at(-1)), ['messages', 'files', 'messages']);
  assert.equal(f.api.calls[0].body.content, 'textmore'); assert.equal(f.api.calls[1].body.srv_send_msg, false); assert.equal(f.api.calls[1].body.file_data, png.toString('base64'));
  assert.deepEqual(f.api.calls[2].body, { msg_type: 7, content: ' ', media: { file_info: 'fake-file-info' }, msg_id: 'trigger-id', msg_seq: 2 });
  assert.deepEqual(result.message_ids, ['sent-1', 'sent-3']); assert.equal(result.message_id, 'sent-3');
});
test('HTTPS image URL passes to platform without local fetching; local/base64/file:// accepted', async t => {
  assert.deepEqual(await imageSource('https://example.test/a.png', 1000), { url: 'https://example.test/a.png' });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-images-')); t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const filename = path.join(dir, 'image.png'); await fs.writeFile(filename, png);
  for (const source of [png, new Uint8Array(png), `base64://${png.toString('base64')}`, filename, pathToFileURL(filename).href]) assert.deepEqual(await imageSource(source, 1000), { file_data: png.toString('base64') });
});
test('reject non-image local data, oversized images, invalid URL and arbitrary objects', async () => {
  for (const source of [Buffer.from('{"appSecret":"FAKE_SECRET"}'), 'http://example.test/a.png', 'https://user:pass@example.test/a.png', 'https://127.0.0.1/a', 'base64://???', {}, undefined]) await assert.rejects(imageSource(source, 1000), { code: 'IMAGE_INVALID' });
  await assert.rejects(imageSource(png, 1), { code: 'IMAGE_TOO_LARGE' });
});
test('unsupported mixed arrays preflight before sending text; one honest feedback and false', async () => {
  const f = fixture(); const e = await f.mapper.dispatch(payload());
  for (const message of [['should-not-send', { type: 'video', file: 'anything' }], { type: 'node', data: [] }, { type: 'at', qq: '123' }, { type: 'button', data: [] }]) assert.equal(await e.reply(message), false);
  assert.equal(f.api.calls.length, 1); assert.match(f.api.calls[0].body.content, /仅支持文本和图片/); assert.equal(e.qqbot.lastError.code, 'UNSUPPORTED_MESSAGE');
});
test('quote and third options guarded even after Miao-style reply wrapper discards them', async () => {
  const f = fixture(); const e = await f.mapper.dispatch(payload()); const original = e.reply;
  e.reply = async (message, quote, _data = {}) => original(message, quote);
  assert.equal(await e.reply('quote', true), false); assert.equal(await e.reply('button', false, { button: [] }), false); assert.equal(await e.reply('recall', false, { recallMsg: 1 }), false);
  assert.equal(f.api.calls.length, 1); assert.equal(e.qqbot.lastError.code, 'UNSUPPORTED_OPTIONS');
  const ok = await e.reply('plain', false, {}); assert.ok(ok.message_id); assert.equal(f.api.calls.at(-1).body.content, 'plain');
});
test('concurrent replies serialize same trigger seq, no retry after ambiguous delivery', async () => {
  const f = fixture(); const e = await f.mapper.dispatch(payload('c2c')); await Promise.all([e.reply('one'), e.friend.sendMsg('two'), e.reply('three')]);
  assert.deepEqual(f.api.calls.map(c => c.body.msg_seq), [1, 2, 3]);
  let attempts = 0; f.api.request = async () => { attempts++; throw new Error('FAKE_SECRET PRIVATE_CHAT'); };
  assert.equal(await e.reply('four'), false); assert.equal(attempts, 1); assert.equal(f.logger.records.join().includes('FAKE_SECRET'), false); assert.equal(e.qqbot.lastError.code, 'API_RESPONSE');
});
test('expiry, offline and per-trigger reply ceiling have no fabricated success', async () => {
  let now = 0; const api = fakeApi(); const errors = [];
  const reply = new PassiveReply({ api, config: config({ maxReplies: 1 }), scope: 'c2c', target: 'openid', messageId: 'trigger', createdAt: 0, now: () => now, onError: e => errors.push(e), logger: quietLogger() });
  await reply.send('first'); assert.equal(await reply.send('second'), false); assert.equal(errors.at(-1).code, 'REPLY_LIMIT'); assert.equal(api.calls.length, 1);
  const expired = new PassiveReply({ api, config: config(), scope: 'group', target: 'g', messageId: 'x', createdAt: 0, now: () => now, onError: e => errors.push(e) });
  now = 240001; assert.equal(await expired.send('expired'), false); assert.equal(errors.at(-1).code, 'REPLY_EXPIRED');
  const offline = new PassiveReply({ api, config: config(), online: () => false, onError: e => errors.push(e) });
  assert.equal(await offline.send('offline'), false); assert.equal(errors.at(-1).code, 'OFFLINE');
});
test('Unicode text split preserves codepoints and rejects excess before any POST', async () => {
  const f = fixture(); const e = await f.mapper.dispatch(payload());
  const text = '😀'.repeat(1501); await e.reply(text); assert.equal(f.api.calls[0].body.content, '😀'.repeat(1500)); assert.equal(f.api.calls[1].body.content, '😀');
  const count = f.api.calls.length; assert.equal(await e.reply('x'.repeat(6000)), false); assert.equal(f.api.calls.length, count); assert.equal(e.qqbot.lastError.code, 'REPLY_LIMIT');
});
test('missing upload result or platform failure never claims image success or auto-retries', async () => {
  const f = fixture(); const e = await f.mapper.dispatch(payload()); f.api.request = async () => ({});
  assert.equal(await e.reply({ type: 'image', file: png }), false); assert.equal(e.qqbot.lastError.code, 'API_RESPONSE');
  f.api.request = async () => { throw new AdapterError('API_REJECTED', { status: 403, platformCode: 123 }); };
  assert.equal(await e.reply('text'), false); assert.equal(e.qqbot.lastError.status, 403); assert.equal(e.qqbot.lastError.platformCode, 123);
});
test('unsupported contact APIs raise explicit safe errors', async () => {
  const f = fixture(); const e = await f.mapper.dispatch(payload());
  for (const fn of [() => e.getAvatarUrl(), () => e.group.muteMember(), () => e.group.recallMsg(), () => e.group.getMemberMap(), () => e.member.getChatHistory(), () => e.bot.sendGroupMsg(e.group_id, 'proactive')]) assert.throws(fn, error => ['UNSUPPORTED_API', 'PASSIVE_ONLY'].includes(error.code));
});
