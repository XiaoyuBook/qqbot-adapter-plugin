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
  assert.deepEqual(f.api.calls.map(c => c.route.split('/').at(-1)), ['files', 'messages']);
  assert.equal(f.api.calls[0].body.srv_send_msg, false); assert.equal(f.api.calls[0].body.file_data, png.toString('base64'));
  assert.deepEqual(f.api.calls[1].body, { msg_type: 7, content: 'textmore', media: { file_info: 'fake-file-info' }, msg_id: 'trigger-id', msg_seq: 1 });
  assert.deepEqual(result.message_ids, ['sent-2']); assert.equal(result.message_id, 'sent-2');
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
test('boolean quote uses passive context, third options still guarded after Miao wrapper', async () => {
  const f = fixture(); const e = await f.mapper.dispatch(payload()); const original = e.reply;
  e.reply = async (message, quote, _data = {}) => original(message, quote);
  const quoted = await e.reply('quote', true); assert.ok(quoted.message_id); assert.deepEqual(quoted.warnings, ['quote_display_unavailable']);
  assert.equal(await e.reply('button', false, { button: [] }), false); assert.equal(await e.reply('recall', false, { recallMsg: 1 }), false);
  assert.equal(f.api.calls.length, 2); assert.equal(e.qqbot.lastError.code, 'UNSUPPORTED_OPTIONS');
  const ok = await e.reply('plain', false, {}); assert.ok(ok.message_id); assert.equal(f.api.calls.at(-1).body.content, 'plain');
});
test('legacy self mention works in private and group passive replies; unrelated/all mentions fail', async () => {
  for (const scope of ['c2c', 'group']) {
    const f = fixture(); const e = await f.mapper.dispatch(payload(scope));
    const result = await e.reply([{ type: 'at', qq: 0, id: e.user_id }, 'QR', { type: 'image', file: png }]);
    assert.ok(result.message_id); assert.deepEqual(result.warnings, [`${scope === 'group' ? 'group' : 'private'}_self_mention_omitted`]);
    assert.equal(f.api.calls[1].body.content, 'QR'); assert.equal(f.api.calls[1].body.msg_id, 'trigger-id');
    assert.equal(await e.reply([{ type: 'at', qq: 'other-user' }, 'no']), false);
    assert.equal(await e.reply([{ type: 'at', qq: 'all' }, 'no']), false);
  }
});
test('delayed recall returns false with diagnostics and no extra passive slot or timer throw', async () => {
  const f = fixture(); const e = await f.mapper.dispatch(payload('c2c'));
  assert.equal(await e.friend.recallMsg('sent-id'), false); assert.equal(e.qqbot.lastError.code, 'UNSUPPORTED_API');
  assert.equal(f.api.calls.length, 0); assert.match(e.qqbot.lastError.message, /未实现此能力/);
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
  for (const fn of [() => e.getAvatarUrl(), () => e.group.muteMember(), () => e.group.getMemberMap(), () => e.member.getChatHistory(), () => e.bot.sendGroupMsg(e.group_id, 'proactive')]) assert.throws(fn, error => ['UNSUPPORTED_API', 'PASSIVE_ONLY'].includes(error.code));
});
