import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, payload, png, FakeTimers } from './helpers.js';
import { validateConfig } from '../src/config.js';
import { AdapterError } from '../src/errors.js';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { OfficialApi } from '../src/api.js';

const messages = f => f.api.calls.filter(call => call.method === 'POST' && call.route.endsWith('/messages'));
function enabled(options) { const f = fixture({}, options); f.cfg.mentionBeforeImage = true; return f; }

test('default configuration enables mention above the group reply image', () => {
  assert.equal(validateConfig({}).mentionBeforeImage, true);
});

test('a group image reply is one verified Markdown message with mention before image and temporary material released', async t => {
  const f = enabled(); t.after(() => f.registry.dispose());
  const e = await f.mapper.dispatch(payload());
  const result = await e.reply({ type: 'image', file: png });
  assert.ok(result.message_id); const sent = messages(f);
  assert.equal(sent.length, 1); assert.equal(sent[0].body.msg_type, 2);
  assert.match(sent[0].body.markdown.content, /^<qqbot-at-user id="12345678901234567890123456789012" \/>\n!\[图片\]\(qqbot-media:\/\/image\/v1\//);
  assert.equal(sent[0].body.markdown.force_verify_image_resource, true);
  assert.equal(sent[0].body.msg_id, 'trigger-id'); assert.equal(sent[0].body.msg_seq, 1);
  assert.equal(sent[0].body.media, undefined); assert.equal(f.api.uploads[0].contentType, 'image/png');
  const deletion = f.api.calls.find(call => call.method === 'DELETE');
  assert.match(deletion.route, /^\/v2\/media-images\/.+\/delete$/);
  assert.ok(f.api.calls.indexOf(deletion) > f.api.calls.indexOf(sent[0])); assert.equal(f.api.materials.size, 0);
});

test('caption, quote and recall stay on the same ordered image message', async t => {
  const timers = new FakeTimers(), f = enabled({ timers }); t.after(() => f.registry.dispose());
  const e = await f.mapper.dispatch(payload('group', { message_scene: { ext: ['msg_idx=REFIDX_image=='] } }));
  const result = await e.reply([{ type: 'at', qq: e.user_id }, '说明 *文字*', { type: 'image', file: png }], true, { recallMsg: 10 });
  assert.ok(result.message_id); const sent = messages(f);
  assert.equal(sent.length, 1); assert.equal(sent[0].body.msg_type, 2); assert.match(sent[0].body.markdown.content, /^<qqbot-at-user[^\n]+\n说明 \\\*文字\\\*\n!\[图片\]/);
  assert.equal(sent[0].body.message_reference.message_id, 'REFIDX_image==');
  await timers.tick(10000);
  assert.equal(f.api.calls.filter(call => call.method === 'DELETE' && call.route.includes('/messages/')).length, 1);
});

test('public image URL uses the same ordered Markdown without local upload or extra @ bubble', async t => {
  const f = enabled(); t.after(() => f.registry.dispose()); const e = await f.mapper.dispatch(payload());
  await e.reply({ type: 'image', file: 'https://example.test/chart(1).png' });
  const sent = messages(f); assert.equal(sent.length, 1); assert.equal(sent[0].body.msg_type, 2);
  assert.match(sent[0].body.markdown.content, /!\[图片\]\(https:\/\/example.test\/chart%281%29.png\)$/);
  assert.equal(f.api.calls.length, 1); assert.equal(f.api.uploads.length, 0);
});

test('private images, explicit opt-out and proactive images retain native media behavior', async t => {
  const f = enabled(); t.after(() => f.registry.dispose());
  const privateEvent = await f.mapper.dispatch(payload('c2c')); await privateEvent.reply(png);
  const groupEvent = await f.mapper.dispatch(payload()); await groupEvent.reply(png, false, { at: false });
  f.cfg.allowProactive = true; await groupEvent.bot.sendGroupMsg(groupEvent.group_id, png);
  assert.equal(messages(f).length, 3); assert.ok(messages(f).every(call => call.body.msg_type === 7));
  assert.equal(f.api.calls.some(call => call.route.startsWith('/v2/media-images')), false);
});

test('ambiguous image-message delivery never retries and delays temporary material cleanup', async t => {
  const timers = new FakeTimers(), f = enabled({ timers }); t.after(() => f.registry.dispose());
  const original = f.api.request;
  f.api.request = async (...args) => { const result = await original(...args); if (args[1].endsWith('/messages')) throw new AdapterError('API_NETWORK'); return result; };
  const e = await f.mapper.dispatch(payload()); assert.equal(await e.reply(png), false);
  assert.equal(e.qqbot.lastError.code, 'API_NETWORK'); assert.equal(messages(f).length, 1);
  assert.equal(f.api.calls.filter(call => call.method === 'DELETE').length, 0);
  await timers.tick(300000);
  assert.equal(f.api.calls.filter(call => call.method === 'DELETE').length, 1); assert.equal(messages(f).length, 1);
});

test('actual HTTP flow sends one ordered image message, accepts string inventory count and cleans up with empty DELETE', async t => {
  const requests = [], md5 = createHash('md5').update(png).digest('hex');
  const server = http.createServer(async (request, response) => {
    const buffers = []; for await (const buffer of request) buffers.push(buffer);
    const bytes = Buffer.concat(buffers);
    if (request.method === 'PUT') {
      requests.push({ method: 'PUT', route: request.url, bytes, auth: request.headers.authorization, mime: request.headers['content-type'] });
      response.setHeader('ETag', `"${md5}"`); response.end(); return;
    }
    const body = bytes.length ? JSON.parse(bytes.toString()) : undefined;
    requests.push({ method: request.method, route: request.url, body, auth: request.headers.authorization });
    if (request.method === 'DELETE') { response.statusCode = 204; response.end(); return; }
    response.setHeader('Content-Type', 'application/json');
    const result = request.url === '/app/getAppAccessToken' ? { access_token: 'IMAGE_WIRE_FAKE_TOKEN', expires_in: 7200 }
      : request.url === '/v2/media-images' ? { images: [], next_cursor: '', total: '0' }
      : request.url === '/v2/media-images/prepare' ? { upload_id: 'wire-upload', presigned_url: 'https://unit.myqcloud.com/signed-upload' }
      : request.url === '/v2/media-images/complete' ? { image_id: 'WIRE_image', url: 'qqbot-media://image/v1/WIRE_ref', ttl: 7776000 }
      : { id: 'WIRE_sent_image', timestamp: new Date().toISOString() };
    response.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, f = enabled();
  const api = new OfficialApi({ config: f.cfg, appSecret: 'IMAGE_WIRE_FAKE_SECRET', fetchImpl: (url, init) => { const parsed = new URL(url); return fetch(origin + parsed.pathname + parsed.search, init); } });
  t.after(async () => { f.registry.dispose(); api.close(); await new Promise(resolve => server.close(resolve)); });
  f.mapper.api = api; f.registry.bindApi(api);
  const e = await f.mapper.dispatch(payload()); assert.ok((await e.reply(png)).message_id);
  const sent = requests.filter(request => request.route.endsWith('/messages'));
  assert.equal(sent.length, 1); assert.equal(sent[0].body.msg_type, 2);
  assert.match(sent[0].body.markdown.content, /^<qqbot-at-user[^\n]+\n!\[图片\]\(qqbot-media:\/\/image\/v1\/WIRE_ref\)$/);
  const upload = requests.find(request => request.method === 'PUT');
  assert.deepEqual(upload.bytes, png); assert.equal(upload.mime, 'image/png'); assert.equal(upload.auth, undefined);
  assert.equal(requests.filter(request => request.method === 'DELETE').length, 1);
  assert.equal(requests.find(request => request.method === 'DELETE').route, '/v2/media-images/WIRE_image/delete');
  assert.ok(requests.filter(request => request.route !== '/app/getAppAccessToken' && request.method !== 'PUT').every(request => request.auth === 'QQBot IMAGE_WIRE_FAKE_TOKEN'));
});
